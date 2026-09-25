// ============================================================
// 世界模拟 HTTP 端到端验收
// ============================================================
// 需要**已在运行的服务端**。默认打本机 11408，可用 WORLD_E2E_BASE 覆盖：
//   pnpm --filter @momoi/server world:e2e
//   WORLD_E2E_BASE=http://localhost:11500 pnpm --filter @momoi/server world:e2e
//
// 覆盖创生 → 生成 → 法则编辑 → 各处必须拒绝的旁路 → 软删除。
// 结尾会删除自己创建的会话，可重复运行。
//
// 之所以把它留下来：Phase 2/3 会改动世界路由，而这里的多数断言是**语义性**的
// （地形规则不可变、旁路必须被拒、软删后不可访问），类型检查与构建都抓不到它们的回归。

const BASE = process.env.WORLD_E2E_BASE || 'http://localhost:11408'
const PROMPT =
  '永夜笼罩一切；所有的水都有毒；连绵的黑色山脉，山脚是针叶林；一切落在 Agent 身上的伤害都是致命的'

const VOCAB = new Set([
  'ocean', 'beach', 'grass', 'jungle', 'forest', 'scrub',
  'swamp', 'tundra', 'sand', 'rock', 'ash', 'lava', 'crystal', 'snow',
])

let ok = 0
let failed = 0

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    ok++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}  ${detail}`)
  }
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, data: text ? JSON.parse(text) : null }
  } catch {
    return { status: res.status, data: text }
  }
}

// ---- 取一个可用 Agent（排除中立 Agent）----
const appInfo = await call('GET', '/api/app-name')
const agent = (appInfo.data?.agents ?? []).find((a: any) => a.id !== 'neutral-agent')
if (!agent) {
  console.error('没有可用的非中立 Agent，无法测试')
  process.exit(1)
}
console.log(`base=${BASE}  agent=${agent.name}(${agent.id})\n`)

console.log('【1】创生世界')
const t0 = Date.now()
const created = await call('POST', '/api/worlds', { prompt: PROMPT, agent_ids: [agent.id] })
const elapsed = Date.now() - t0
check('201 Created', created.status === 201, JSON.stringify(created.data))
const convId: string = created.data?.conversation?.id
check('type == world', created.data?.conversation?.type === 'world', created.data?.conversation?.type)
check('标题取自提示词前 40 字', created.data?.conversation?.title === PROMPT.slice(0, 40))
check('terrain_prompt 原样保存', created.data?.world?.terrain_prompt === PROMPT)
check('status == generating', created.data?.world?.status === 'generating')
check(`POST 立即返回（${elapsed}ms < 2s，未阻塞等 LLM）`, elapsed < 2000, `${elapsed}ms`)
console.log(`     conversation_id = ${convId}`)

console.log('\n【2】生成中读取')
const mid = await call('GET', `/api/worlds/${convId}`)
check('200', mid.status === 200, String(mid.status))
check('terrain_spec 生成中为 null', mid.data?.world?.terrain_spec === null)
check('agents 返回成员列表', (mid.data?.agents ?? []).some((a: any) => a.id === agent.id))

console.log('\n【3】等待生成完成（轮询）')
let world: any = null
const deadline = Date.now() + 120_000
while (Date.now() < deadline) {
  const r = await call('GET', `/api/worlds/${convId}`)
  world = r.data?.world
  if (world?.status !== 'generating') break
  await new Promise((r2) => setTimeout(r2, 2000))
}
check('转入 ready', world?.status === 'ready', world?.status)
const spec = world?.terrain_spec
check('terrain_spec 已落库且可解析', !!spec)
console.log(`     summary = ${spec?.summary}`)
console.log(
  `     style=${spec?.terrain?.style} water=${spec?.terrain?.water} sky=${spec?.sky?.preset} ` +
    `biomes=${spec?.biomes?.length} generated_by=${spec?.generated_by}`,
)
console.log(`     laws = ${JSON.stringify(world?.laws)}`)
check('法则被原文誊写（含「永夜」）', String(world?.laws ?? '').includes('永夜'), String(world?.laws))
check('法则含「致命」', String(world?.laws ?? '').includes('致命'), String(world?.laws))
check(
  '词表闭合：群系 id 全在词表内',
  (spec?.biomes ?? []).every((b: any) => VOCAB.has(b.id)),
  JSON.stringify((spec?.biomes ?? []).map((b: any) => b.id)),
)

console.log('\n【4】法则可改')
const patched = await call('PATCH', `/api/worlds/${convId}`, { laws: '改为：白昼；一切伤害都无法杀死 Agent。' })
check('200', patched.status === 200, JSON.stringify(patched.data))
check('法则已更新', String(patched.data?.world?.laws ?? '').startsWith('改为：'))
const reread = await call('GET', `/api/worlds/${convId}`)
check('刷新后仍是新值', String(reread.data?.world?.laws ?? '').startsWith('改为：'))

console.log('\n【5】地形规则不可修改（服务端拒绝，而非界面藏起输入框）')
const badPatch = await call('PATCH', `/api/worlds/${convId}`, { terrain_prompt: '换成海洋' })
check('400', badPatch.status === 400, JSON.stringify(badPatch.data))
check('错误信息指明不可变', JSON.stringify(badPatch.data).includes('immutable'))
const aliasPatch = await call('PATCH', `/api/worlds/${convId}`, { prompt: '换成海洋' })
check('别名 prompt 同样拒绝', aliasPatch.status === 400, String(aliasPatch.status))
const after = await call('GET', `/api/worlds/${convId}`)
check('地形规则确实未被改动', after.data?.world?.terrain_prompt === PROMPT)

console.log('\n【6】必须拒绝的旁路')
const byConv = await call('POST', '/api/conversations', { type: 'world' })
check('POST /api/conversations type=world → 400', byConv.status === 400, JSON.stringify(byConv.data))
const byChat = await call('POST', '/api/chat', { message: 'hi', conversation_type: 'world', conversation_id: convId })
check('POST /api/chat conversation_type=world → 400', byChat.status === 400, JSON.stringify(byChat.data))

console.log('\n【7】校验边界')
const emptyPrompt = await call('POST', '/api/worlds', { prompt: '   ', agent_ids: [agent.id] })
check('空提示词 → 400', emptyPrompt.status === 400, String(emptyPrompt.status))
const noAgent = await call('POST', '/api/worlds', { prompt: '有提示词', agent_ids: [] })
check('零 Agent → 400', noAgent.status === 400, String(noAgent.status))
const onlyNeutral = await call('POST', '/api/worlds', { prompt: '有提示词', agent_ids: ['neutral-agent'] })
check('只有中立 Agent → 400（过滤后为空）', onlyNeutral.status === 400, String(onlyNeutral.status))

console.log('\n【8】会话列表与详情')
const list = await call('GET', '/api/conversations')
const row = (list.data?.conversations ?? []).find((c: any) => c.id === convId)
check('出现在会话列表', !!row)
check('agent_count == 1', row?.agent_count === 1, JSON.stringify(row))
const detail = await call('GET', `/api/conversations/${convId}`)
check('会话详情返回 agents（世界同样需要）', (detail.data?.agents ?? []).length > 0)

console.log('\n【9】不存在的世界 → 404')
const missing = '00000000-0000-0000-0000-000000000000'
check('GET 404', (await call('GET', `/api/worlds/${missing}`)).status === 404)
check('PATCH 404', (await call('PATCH', `/api/worlds/${missing}`, { laws: 'x' })).status === 404)

console.log('\n【10】软删除后世界不可访问')
check('删除会话 200', (await call('DELETE', `/api/conversations/${convId}`)).status === 200)
check('软删后 GET 世界 → 404', (await call('GET', `/api/worlds/${convId}`)).status === 404)

console.log(`\n${'='.repeat(56)}\n通过 ${ok} 项，失败 ${failed} 项\n${'='.repeat(56)}`)
process.exit(failed > 0 ? 1 : 0)
