// ============================================================
// Admin — 提示词目录与预览（挂在 /api/admin/prompts 下，走管理员鉴权）
// ============================================================
// 「所有的提示词都可以在里面被找到」的运行时入口：
//   GET  /           配方清单 + 片段目录（id / 目标 / 层 / 优先级 / 来源 / 说明）
//   GET  /fragment   单个片段的元信息与当前渲染文本（?id=chat/skills）
//   POST /preview    按配方组装并逐段溯源（context 白名单归化后使用）
//
// 说明：运行时「管理」操作（覆盖 / 禁用 / 调优先级）由引擎 API 在启动期或
// 扩展加载期完成（promptEngine.register / override / disable）；HTTP 层的
// 持久化改写不在本版范围内（见 docs/DECISIONS.md）。
// ============================================================

import { Hono } from 'hono'
import { promptEngine, normalizePreviewContext, seedToolDescriptions } from '../prompts/index.js'
import { getAllTools } from '../ai/tools.js'

// 工具描述目录播种：管理端要能列出/预览工具描述（幂等；服务端本就在启动期加载工具系统）
seedToolDescriptions(getAllTools())

export const promptsRoute = new Hono()

// 目录：所有配方 + 所有片段
promptsRoute.get('/', (c) => {
  return c.json({
    targets: promptEngine.listTargets(),
    fragments: promptEngine.list(),
  })
})

// 单个片段：元信息 + 当前渲染文本（按 id 查询，id 含 `/`，故用 query 而非路径参数）
promptsRoute.get('/fragment', (c) => {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'id is required' }, 400)
  const fragment = promptEngine.list().find((f) => f.id === id)
  if (!fragment) return c.json({ error: `Fragment not found: ${id}` }, 404)
  return c.json({ fragment, text: promptEngine.render(id) })
})

// 预览：按配方组装（context 经白名单归化），返回 text 与逐段来源
promptsRoute.post('/preview', async (c) => {
  const body = await c.req.json<{ target?: string; context?: Record<string, unknown> }>()
    .catch(() => ({} as { target?: string; context?: Record<string, unknown> }))
  const target = body.target
  if (!target) return c.json({ error: 'target is required' }, 400)
  if (!promptEngine.hasTarget(target)) {
    return c.json({
      error: `Unknown target: ${target}`,
      targets: promptEngine.listTargets().map((t) => t.target),
    }, 404)
  }
  const context = normalizePreviewContext(target, body.context ?? {})
  const assembled = promptEngine.assemble(target, context)
  return c.json({ ...assembled, context })
})
