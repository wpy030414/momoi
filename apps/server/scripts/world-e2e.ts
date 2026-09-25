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

/**
 * 发起一次上帝行动并读完 SSE 流。
 * 流里每行是 `data: {json}`（event 名恒为 'message'，判别靠 data 里的 type）。
 */
async function actStream(
  convId: string,
  content: string,
): Promise<{ status: number; messages: any[] }> {
  const res = await fetch(`${BASE}/api/worlds/${convId}/act`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    return { status: res.status, messages: [], text } as never
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const messages: any[] = []
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try { messages.push(JSON.parse(line.slice(6))) } catch { /* 保活注释等 */ }
    }
  }
  return { status: res.status, messages }
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

console.log('\n【10】实体播种（Phase 2）')
const snap1 = await call('GET', `/api/worlds/${convId}`)
const ents1: any[] = snap1.data?.entities ?? []
check('实体已播种', ents1.length === 1, JSON.stringify(ents1))
check('kind=agent 且关联了 agent_id', ents1[0]?.kind === 'agent' && ents1[0]?.agent_id === agent.id)
check('状态为 alive', ents1[0]?.status === 'alive')
check('落在世界范围内（±1）', Math.abs(ents1[0]?.x) <= 1 && Math.abs(ents1[0]?.z) <= 1,
  `(${ents1[0]?.x}, ${ents1[0]?.z})`)
check('快照含 events 数组', Array.isArray(snap1.data?.events))
const seededPos = { x: ents1[0]?.x, z: ents1[0]?.z }

console.log('\n【11】上帝行动 → 一个回合')
const godAction = '我在天空中降下一道雷，劈向东边的山脊。'
const stream = await actStream(convId, godAction)
check('SSE 200', stream.status === 200, String(stream.status))
const types = stream.messages.map((m) => m.type)
check('有 world_turn_start', types.includes('world_turn_start'))
check('有 world_agent_start', types.includes('world_agent_start'))
check('有 world_event', types.includes('world_event'))
check('有 world_agent_done', types.includes('world_agent_done'))
check('有 world_turn_end', types.includes('world_turn_end'))
check('回合序号为 1', stream.messages.find((m) => m.type === 'world_turn_start')?.turn === 1)

const evs: any[] = stream.messages.filter((m) => m.type === 'world_event').map((m) => m.event)
check('至少产生了事件', evs.length > 0, `events=${evs.length}`)
check('首条是上帝的行动', evs[0]?.actor_kind === 'god' && evs[0]?.content === godAction,
  JSON.stringify(evs[0]?.content))
check('事件按 (turn, seq) 稠密递增', evs.every((e, i) => e.seq === i + 1), JSON.stringify(evs.map((e) => e.seq)))
check('事件都归属回合 1', evs.every((e) => e.turn === 1))
check('事件 kind 在词表内', evs.every((e) => ['act', 'speak', 'move', 'die', 'law', 'narration'].includes(e.kind)),
  JSON.stringify(evs.map((e) => e.kind)))
console.log('  事件内容：')
for (const e of evs) console.log(`    · [${e.actor_name}/${e.kind}] ${String(e.content).slice(0, 70)}`)

console.log('\n【12】回合后的世界状态')
const snap2 = await call('GET', `/api/worlds/${convId}`)
check('world.turn == 1', snap2.data?.world?.turn === 1, String(snap2.data?.world?.turn))
// 只数**本回合**的事件：快照里还包含更早的回合（例如改法则产生的 turn 0 事件）
const turn1Events = (snap2.data?.events ?? []).filter((e: any) => e.turn === 1)
check('本回合事件已持久化', turn1Events.length === evs.length,
  `snapshot(turn1)=${turn1Events.length} stream=${evs.length}`)
check('实体位置在合理范围内', (snap2.data?.entities ?? []).every((e: any) => Math.abs(e.x) <= 1 && Math.abs(e.z) <= 1))
const moved = (snap2.data?.entities ?? []).some((e: any) => e.x !== seededPos.x || e.z !== seededPos.z)
console.log(`  实体${moved ? '发生了移动' : '本回合未移动'}（由 Agent 自行决定，两种情况都合法）`)

console.log('\n【13】改法则 → 产生一条 law 事件')
const lawRes = await call('PATCH', `/api/worlds/${convId}`, { laws: '新增法则：这片大地上的雷声会唤醒沉睡者。' })
check('PATCH 200', lawRes.status === 200, String(lawRes.status))
const snap3 = await call('GET', `/api/worlds/${convId}`)
// 【4】也改过一次法则，故这里会有多条 law 事件 —— 取最后一条断言本次改动
const lawEvents = (snap3.data?.events ?? []).filter((e: any) => e.kind === 'law')
check('事件日志里出现 law 事件', lawEvents.length >= 1, `count=${lawEvents.length}`)
const latestLaw = lawEvents[lawEvents.length - 1]
check('law 事件由上帝发起', latestLaw?.actor_kind === 'god')
check('最后一条 law 事件含本次新法则', String(latestLaw?.content ?? '').includes('唤醒沉睡者'),
  JSON.stringify(latestLaw?.content))

console.log('\n【14】回合并发守卫与边界')
const [a, b] = await Promise.all([
  actStream(convId, '我吹起一阵风。'),
  actStream(convId, '我抖动大地。'),
])
const codes = [a.status, b.status].sort()
check('两个并发回合中恰好一个被拒（409）', codes.includes(200) && codes.includes(409), JSON.stringify(codes))
check('空行动 → 400', (await call('POST', `/api/worlds/${convId}/act`, { content: '   ' })).status === 400)
check('不存在世界的行动 → 404',
  (await call('POST', `/api/worlds/${missing}/act`, { content: 'x' })).status === 404)

console.log('\n【16】上帝化身（Phase 3）')
const god1 = await call('POST', `/api/worlds/${convId}/god`, { x: 0.25, z: -0.4 })
check('放置 200', god1.status === 200, JSON.stringify(god1.data))
check('kind=god', god1.data?.entity?.kind === 'god', god1.data?.entity?.kind)
check('坐标为所放之处', god1.data?.entity?.x === 0.25 && god1.data?.entity?.z === -0.4)
const godId = god1.data?.entity?.id
const snapGod = await call('GET', `/api/worlds/${convId}`)
check('快照里出现上帝实体', (snapGod.data?.entities ?? []).some((e: any) => e.kind === 'god'))
const god2 = await call('POST', `/api/worlds/${convId}/god`, { x: -0.5, z: 0.5 })
check('再次放置是**移动**而非新增（同一 id）', god2.data?.entity?.id === godId, `${godId} vs ${god2.data?.entity?.id}`)
const snapGod2 = await call('GET', `/api/worlds/${convId}`)
check('上帝实体只有一个', (snapGod2.data?.entities ?? []).filter((e: any) => e.kind === 'god').length === 1)
check('坐标已更新', (snapGod2.data?.entities ?? []).find((e: any) => e.kind === 'god')?.x === -0.5)
check('越界坐标被钳制', (await call('POST', `/api/worlds/${convId}/god`, { x: 99, z: -99 })).data?.entity?.x === 1)
check('非数值坐标 → 400', (await call('POST', `/api/worlds/${convId}/god`, { x: 'abc', z: 0 })).status === 400)
check('不存在世界 → 404', (await call('POST', `/api/worlds/${missing}/god`, { x: 0, z: 0 })).status === 404)

console.log('\n【17】改造补丁字段')
check('快照含 patches 数组', Array.isArray(snapGod2.data?.patches))
console.log(`  当前补丁数：${(snapGod2.data?.patches ?? []).length}（由 Agent 自行决定是否改造）`)

console.log('\n【18】自动演算开关')
const on = await call('POST', `/api/worlds/${convId}/auto-tick`, { enabled: true })
check('开启 200', on.status === 200, JSON.stringify(on.data))
check('返回 enabled:true', on.data?.enabled === true)
const snapOn = await call('GET', `/api/worlds/${convId}`)
check('快照 auto_tick 为 true', snapOn.data?.auto_tick === true)
const off = await call('POST', `/api/worlds/${convId}/auto-tick`, { enabled: false })
check('关闭 200', off.status === 200 && off.data?.enabled === false)
const snapOff = await call('GET', `/api/worlds/${convId}`)
check('快照 auto_tick 为 false', snapOff.data?.auto_tick === false)
check('不存在的世界 → 404', (await call('POST', `/api/worlds/${missing}/auto-tick`, { enabled: true })).status === 404)

console.log('\n【19】软删除后世界不可访问')
check('删除会话 200', (await call('DELETE', `/api/conversations/${convId}`)).status === 200)
check('软删后 GET 世界 → 404', (await call('GET', `/api/worlds/${convId}`)).status === 404)

console.log(`\n${'='.repeat(56)}\n通过 ${ok} 项，失败 ${failed} 项\n${'='.repeat(56)}`)
process.exit(failed > 0 ? 1 : 0)
