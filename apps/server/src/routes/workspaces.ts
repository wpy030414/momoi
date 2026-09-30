// ============================================================
// Workspace Routes — 会话分组工作区（文件夹语义）
// ============================================================
// 与「会话文件沙箱」（tools/workspace.ts SandboxFS、routes/files.ts）
// 是两个概念：本路由只管分组文件夹的 CRUD。
//
// 核心不变量（docs/specs/module-workspace.md）：
//   conversations.workspace_id 创建时锁定、永不 UPDATE。
//   删除工作区 = 删本表一行；成员会话的 workspace_id 悬空，
//   前端按未分组渲染；沙箱仍锚定 data/workspaces/ws-<id>，磁盘永不删。

import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { ErrCode } from '@momoi/shared/errors'
import { db, workspaces } from '../db/index.js'
import { eq, and, asc } from 'drizzle-orm'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { ApiError } from '../lib/apiError.js'
import { broadcastConversationSync } from '../lib/realtime.js'
import { trackUserActivity } from './user.js'

function getUserId(c: any): string {
  return c.get('userId') || ''
}

/** 工作区名称上限（超出截断，与 conversations.title 同宽） */
const MAX_NAME_LENGTH = 40

export const workspacesRoute = new Hono()
workspacesRoute.use('*', userAuthMiddleware)

/** 校验并归一化名称：trim 后为空 → 400；否则截断到上限 */
function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new ApiError(ErrCode.WS_NAME_REQUIRED)
  return name.slice(0, MAX_NAME_LENGTH)
}

/** 读取工作区行（含归属校验：不存在 / 他人所有统一 404，防探测） */
async function findWorkspace(id: string, userId: string) {
  const row = await db.select().from(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.user_id, userId)))
    .get()
  return row ?? null
}

/** 校验 workspace_id 归属并返回锚定值 —— 供会话创建链路复用
 *  （POST /api/chat 首条消息落库、POST /api/worlds、POST /api/conversations）。
 *  null / 空串 / undefined → null（未分组，独享会话级沙箱）；
 *  非空但不存在或非本人所有 → 404 WS_NOT_FOUND（防探测）。 */
export async function resolveWorkspaceAnchor(
  workspaceId: string | null | undefined,
  userId: string,
): Promise<string | null> {
  if (!workspaceId) return null
  const row = await db.select({ id: workspaces.id }).from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.user_id, userId)))
    .get()
  if (!row) throw new ApiError(ErrCode.WS_NOT_FOUND)
  return row.id
}

// 列表（created_at asc —— 侧边栏稳定顺序）
workspacesRoute.get('/', async (c) => {
  const userId = getUserId(c)
  if (!userId) throw new ApiError(ErrCode.UNAUTHORIZED)

  const list = await db.select().from(workspaces)
    .where(eq(workspaces.user_id, userId))
    .orderBy(asc(workspaces.created_at))
    .all()
  return c.json({ workspaces: list })
})

// 新建工作区
workspacesRoute.post('/', async (c) => {
  const userId = getUserId(c)
  if (!userId) throw new ApiError(ErrCode.UNAUTHORIZED)

  const body = await c.req.json<{ name?: string }>()
  const name = normalizeName(body.name)

  const ws = {
    id: randomUUID(),
    user_id: userId,
    name,
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  }
  await db.insert(workspaces).values(ws).run()

  broadcastConversationSync(userId)
  trackUserActivity(userId).catch(() => {})

  return c.json({ workspace: ws }, 201)
})

// 重命名（工作区唯一的可变项）
workspacesRoute.patch('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) throw new ApiError(ErrCode.UNAUTHORIZED)

  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string }>()
  const name = normalizeName(body.name)

  const existing = await findWorkspace(id, userId)
  if (!existing) throw new ApiError(ErrCode.WS_NOT_FOUND)

  await db.update(workspaces)
    .set({ name, updated_at: Math.floor(Date.now() / 1000) })
    .where(and(eq(workspaces.id, id), eq(workspaces.user_id, userId)))
    .run()

  const ws = await findWorkspace(id, userId)
  return c.json({ workspace: ws })
})

// 删除工作区 —— 单行 DELETE：成员会话的 workspace_id 悬空（前端按未分组渲染），
// 磁盘目录 data/workspaces/ws-<id> 保留（文件永不迁移/删除，历史附件 URL 照旧可用）。
workspacesRoute.delete('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) throw new ApiError(ErrCode.UNAUTHORIZED)

  const id = c.req.param('id')
  const existing = await findWorkspace(id, userId)
  if (!existing) throw new ApiError(ErrCode.WS_NOT_FOUND)

  await db.delete(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.user_id, userId)))
    .run()

  broadcastConversationSync(userId)
  trackUserActivity(userId).catch(() => {})

  return c.json({ success: true })
})
