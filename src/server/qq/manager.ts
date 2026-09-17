/**
 * QQ 网关连接注册表（per-user 生命周期管理）。
 * 每 Momoi 用户最多一条连接（1 用户 : 1 机器人 : 1 会话模型）。
 * 启动时 initQqBots() 从 qq_bindings 恢复全部连接；凭证变更经
 * restartBotForUser 换连接（per-user 锁串行化，防双连接双事件）。
 */
import { db, qqBindings } from '../db.js'
import { eq } from 'drizzle-orm'
import { QQGatewayConnection } from './gateway.js'
import { handleQqMessage } from './chat.js'
import { withNamedLock } from '../im/locks.js'

interface ManagedConn {
  conn: QQGatewayConnection
  appId: string
  ready: boolean
}

const conns = new Map<string, ManagedConn>()

function lockKey(userId: string): string {
  return `qq-restart:${userId}`
}

export function isBotReady(userId: string): boolean {
  return conns.get(userId)?.ready ?? false
}

export function getBotAppId(userId: string): string | undefined {
  return conns.get(userId)?.appId
}

/** 读取绑定行；无行或凭证为空返回 null */
async function loadBinding(userId: string) {
  const row = await db.select().from(qqBindings)
    .where(eq(qqBindings.user_id, userId)).get()
  if (!row || !row.app_id || !row.app_secret) return null
  return row
}

/** 连接回调里写 DB 前的新鲜度守卫：行仍在且凭证未换才允许写 */
async function freshRow(userId: string, appId: string) {
  const row = await loadBinding(userId)
  return row && row.app_id.trim() === appId ? row : null
}

async function markStatus(userId: string, appId: string, status: string, error: string): Promise<void> {
  const row = await freshRow(userId, appId)
  if (!row) return
  await db.update(qqBindings)
    .set({ status, error, updated_at: Math.floor(Date.now() / 1000) })
    .where(eq(qqBindings.user_id, userId)).run()
}

async function startBotInner(userId: string): Promise<void> {
  const existing = conns.get(userId)
  const row = await loadBinding(userId)

  // 幂等：已有连接且 appId 未变 → 跳过（防 initQqBots 与绑定并发双起）
  if (existing && row && existing.appId === row.app_id.trim()) return
  if (existing) {
    existing.conn.stop()
    conns.delete(userId)
  }
  if (!row) return

  const appId = row.app_id.trim()
  const creds = { appId, appSecret: row.app_secret }
  const conn = new QQGatewayConnection({
    userId,
    creds,
    onMessage: (msg) => {
      void handleQqMessage({
        userId,
        appId,
        openid: msg.openid,
        msgId: msg.messageId,
        text: msg.content,
        messageId: msg.messageId,
      }).catch((e) => {
        console.error(`[qq:${userId}] message handling failed:`, e instanceof Error ? e.message : e)
      })
    },
    onReady: () => {
      const entry = conns.get(userId)
      if (entry) entry.ready = true
      // 若此前落过 error 态（如 token 暂时取不到），恢复后清除
      void markStatus(userId, appId, 'connected', '')
    },
    onError: (message) => {
      const entry = conns.get(userId)
      if (entry) entry.ready = false
      console.error(`[qq:${userId}] connection error: ${message}`)
      void markStatus(userId, appId, 'error', `连接失败: ${message}`)
    },
    onFatal: (reason) => {
      console.error(`[qq:${userId}] fatal: ${reason}`)
      const entry = conns.get(userId)
      if (entry && entry.conn === conn) conns.delete(userId)
      void markStatus(userId, appId, 'error', reason)
    },
  })

  conns.set(userId, { conn, appId, ready: false })
  conn.start()
}

/** 为用户启动连接（幂等；per-user 锁串行化） */
export async function startBotForUser(userId: string): Promise<void> {
  await withNamedLock(lockKey(userId), () => startBotInner(userId))
}

/** 停止并移除用户连接（同步、幂等） */
export function stopBotForUser(userId: string): void {
  const entry = conns.get(userId)
  if (entry) {
    entry.conn.stop()
    conns.delete(userId)
  }
}

/** 停止后重启（凭证变更 / 改名换 key 用；per-user 锁串行化防双连接） */
export async function restartBotForUser(userId: string): Promise<void> {
  await withNamedLock(lockKey(userId), async () => {
    stopBotForUser(userId)
    await startBotInner(userId)
  })
}

/** 服务启动恢复：拉起所有已绑定用户的连接（单个失败不影响其余） */
export async function initQqBots(): Promise<void> {
  const rows = await db.select().from(qqBindings).all()
  const results = await Promise.allSettled(rows.map((row: any) => startBotForUser(row.user_id)))
  const failed = results.filter((r) => r.status === 'rejected').length
  if (rows.length > 0) {
    console.log(`[qq] restored ${rows.length - failed}/${rows.length} bot connection(s)`)
  }
}
