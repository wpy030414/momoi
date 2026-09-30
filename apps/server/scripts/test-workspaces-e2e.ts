// 一次性内存级 E2E：workspaces CRUD + 会话创建注入 + search。
// 运行：npx tsx scripts/test-workspaces-e2e.ts --stand-alone
// 不触发 persist（不 sleep / 不发信号），测试数据随进程退出蒸发，不落盘。
import { Hono } from 'hono'
import { workspacesRoute, resolveWorkspaceAnchor } from '../src/routes/workspaces.js'
import { conversationsRoute } from '../src/routes/conversations.js'
import { registerErrorHandlers } from '../src/lib/errorHandler.js'
import { db, conversations, messages } from '../src/db/index.js'

// 子路由实例需要自己挂错误收口（正式挂载在主 app 的 onError 不在此实例上）
registerErrorHandlers(workspacesRoute as unknown as Hono)
registerErrorHandlers(conversationsRoute as unknown as Hono)

const JSONHeaders = { 'content-type': 'application/json' }
let passed = 0, failed = 0

async function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : '') }
}

// ---- workspaces CRUD ----
console.log('[workspaces CRUD]')
let r = await workspacesRoute.request('/', { method: 'POST', body: JSON.stringify({ name: '  项目A  ' }), headers: JSONHeaders })
check('POST 建「项目A」（trim）→ 201', r.status === 201, r.status)
const wsA = (await r.json()).workspace
check('名称已 trim', wsA.name === '项目A', wsA.name)

r = await workspacesRoute.request('/', { method: 'POST', body: JSON.stringify({ name: '项目B' }), headers: JSONHeaders })
const wsB = (await r.json()).workspace

r = await workspacesRoute.request('/', { method: 'POST', body: JSON.stringify({ name: '   ' }), headers: JSONHeaders })
const emptyNameBody = await r.json()
check('POST 空名 → 400 WS_NAME_REQUIRED', r.status === 400 && emptyNameBody.code === 'WS_NAME_REQUIRED', { status: r.status, body: emptyNameBody })

r = await workspacesRoute.request('/', { method: 'GET' })
let list = (await r.json()).workspaces
check('GET 列表 → 2 个（created_at asc）', list.length === 2 && list[0].name === '项目A', list.map((w: any) => w.name))

r = await workspacesRoute.request(`/${wsA.id}`, { method: 'PATCH', body: JSON.stringify({ name: '项目A改' }), headers: JSONHeaders })
check('PATCH 改名 → 200 + 新名', r.status === 200 && (await r.json()).workspace.name === '项目A改', r.status)

r = await workspacesRoute.request('/00000000-0000-0000-0000-000000000000', { method: 'PATCH', body: JSON.stringify({ name: 'x' }), headers: JSONHeaders })
check('PATCH 不存在 → 404 WS_NOT_FOUND', r.status === 404 && (await r.json()).code === 'WS_NOT_FOUND', r.status)

// ---- 会话创建注入 workspace_id ----
console.log('[会话创建注入]')
r = await conversationsRoute.request('/', { method: 'POST', body: JSON.stringify({ title: '锁定A的会话', workspace_id: wsA.id }), headers: JSONHeaders })
check('POST /api/conversations 带 workspace_id → 201', r.status === 201, r.status)
const conv1 = (await r.json()).conversation
check('conversation.workspace_id 已锁定', conv1.workspace_id === wsA.id, conv1.workspace_id)

r = await conversationsRoute.request('/', { method: 'POST', body: JSON.stringify({ title: '未分组会话' }), headers: JSONHeaders })
const conv2 = (await r.json()).conversation
check('不带 workspace_id → null', conv2.workspace_id == null, conv2.workspace_id)

r = await conversationsRoute.request('/', { method: 'POST', body: JSON.stringify({ title: 'x', workspace_id: 'forgery-id' }), headers: JSONHeaders })
check('伪造 workspace_id → 404 WS_NOT_FOUND（防探测）', r.status === 404 && (await r.json()).code === 'WS_NOT_FOUND', r.status)

r = await conversationsRoute.request('/', { method: 'GET' })
const convList = (await r.json()).conversations
check('GET 列表含 workspace_id 字段', convList.every((c: any) => 'workspace_id' in c))

// ---- search ----
console.log('[search]')
// 造内容命中数据：conv2（未分组）里放一条含关键词的消息
const now = Math.floor(Date.now() / 1000)
await db.insert(messages).values({
  conversation_id: conv2.id, role: 'user',
  content: `这段话里有独特关键词ZK搜索测试喵，前后再垫一些文字让片段更长一点。`,
  created_at: now,
}).run()

r = await conversationsRoute.request('/search?q=%E9%94%81%E5%AE%9AA')  // 「锁定A」URL 编码
let results = (await r.json()).results
check('标题命中（锁定A）→ matched:title', results.length === 1 && results[0].matched === 'title' && results[0].conversation.id === conv1.id, results)

r = await conversationsRoute.request('/search?q=ZK%E6%90%9C%E7%B4%A2%E6%B5%8B%E8%AF%95')  // 「ZK搜索测试」
results = (await r.json()).results
check('内容命中 → matched:content + snippet', results.length === 1 && results[0].matched === 'content' && !!results[0].snippet?.includes('ZK搜索测试'), results[0])

r = await conversationsRoute.request('/search?q=')
check('空 q → 空结果', (await r.json()).results.length === 0)

r = await conversationsRoute.request(`/search?q=${encodeURIComponent('100%_会命中吗')}`)
results = (await r.json()).results
check('%/_ 通配符已转义（无命中）', results.length === 0, results)

r = await conversationsRoute.request('/search?q=xxx')
check('无命中 → 空', (await r.json()).results.length === 0)

// ---- 删除工作区 → 会话悬空 ----
console.log('[删除工作区 → 悬空]')
r = await workspacesRoute.request(`/${wsA.id}`, { method: 'DELETE' })
check('DELETE → success', r.status === 200 && (await r.json()).success === true)

r = await workspacesRoute.request('/', { method: 'GET' })
list = (await r.json()).workspaces
check('列表只剩 1 个', list.length === 1 && list[0].id === wsB.id)

r = await conversationsRoute.request('/', { method: 'GET' })
const afterDelete = (await r.json()).conversations.find((c: any) => c.id === conv1.id)
check('成员会话 workspace_id 悬空（原样保留，由前端按未分组渲染）', afterDelete?.workspace_id === wsA.id, afterDelete?.workspace_id)

// resolveWorkspaceAnchor 单测（悬空后不再可指定）
const anchor = await resolveWorkspaceAnchor(wsA.id, 'admin').then(v => v, (e: any) => e)
check('悬空工作区不可再被新会话锁定 → WS_NOT_FOUND', anchor?.code === 'WS_NOT_FOUND' || anchor instanceof Error ? (anchor as any)?.code === 'WS_NOT_FOUND' : false, String(anchor))

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
// 测试数据仅存于本进程内存（未触发 persist / 未发信号），随退出蒸发，不落盘
process.exit(failed > 0 ? 1 : 0)
