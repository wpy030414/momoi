// 地形自检：用 ASCII 等高线直观看地形，并验证确定性 / 落点 / 校验层。
// 运行：pnpm --filter @momoi/server terrain:check
//
// 存在的理由：地形是「同一份参数在服务端与客户端必须得出逐位相同结果」的协议面，
// 而它的失效方式大多是**视觉的、静默的**（雪线够不到 → 山变成一片白；岛群掩膜
// 饱和点不可达 → 群岛全沉到海面以下）。这些不会让任何类型检查或运行时断言报错。
import {
  buildTerrain,
  defaultTerrainSpec,
  normalizeTerrainSpec,
  sampleHeight,
  spawnPoints,
  TERRAIN_ENUMS,
  terrainKeywords,
  terrainSummary,
  WORLD_LIMITS,
} from '../../../packages/shared/src/world.js'

const TERRAIN_ENUMS_STYLE = TERRAIN_ENUMS.style as readonly string[]
const CHARS = ' .:-=+*#%@'

function render(spec: ReturnType<typeof defaultTerrainSpec>, n = 48) {
  const d = buildTerrain(spec, { segments: n })
  const size = n + 1
  let min = Infinity
  let max = -Infinity
  let water = 0
  const biomeHist = new Map<number, number>()

  for (let k = 0; k < d.heights.length; k++) {
    min = Math.min(min, d.heights[k])
    max = Math.max(max, d.heights[k])
    if (spec.terrain.water !== 'none' && d.heights[k] <= d.seaLevel) water++
    biomeHist.set(d.biomes[k], (biomeHist.get(d.biomes[k]) ?? 0) + 1)
  }

  // 高度剖面（每 2 行取 1，每 1 列取 1），水面用 ~ 标出
  const step = 2
  const lines: string[] = []
  for (let iz = 0; iz <= n; iz += step) {
    let line = ''
    for (let ix = 0; ix <= n; ix++) {
      const k = iz * size + ix
      const h = d.heights[k]
      if (spec.terrain.water !== 'none' && h <= d.seaLevel) {
        line += '~'
        continue
      }
      const t = max > min ? (h - min) / (max - min) : 0.5
      line += CHARS[Math.min(CHARS.length - 1, Math.max(0, Math.round(t * (CHARS.length - 1))))]
    }
    lines.push(line)
  }

  const total = d.heights.length
  const hist = [...biomeHist.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([i, c]) => `${spec.biomes[i]?.id ?? '?'} ${((c / total) * 100).toFixed(0)}%`)
    .join('  ')

  console.log(lines.join('\n'))
  console.log(`  高度 [${min.toFixed(3)}, ${max.toFixed(3)}]  水面占比 ${((water / total) * 100).toFixed(0)}%`)
  console.log(`  群系分布  ${hist}`)
}

function checkDeterminism(spec: ReturnType<typeof defaultTerrainSpec>) {
  const a = buildTerrain(spec, { segments: 32 })
  const b = buildTerrain(spec, { segments: 32 })
  let same = true
  for (let i = 0; i < a.heights.length; i++) {
    if (a.heights[i] !== b.heights[i] || a.biomes[i] !== b.biomes[i]) {
      same = false
      break
    }
  }
  // sampleHeight 与网格采样必须一致（两端协议的核心断言）。
  // 注意：网格高度存在 Float32Array 里，故与 float64 采样器只差 float32 舍入
  // （约 1e-8），不是算法分歧 —— 用容差比较。
  const k = 17 * 33 + 17
  const nx = (17 / 32) * 2 - 1
  const nz = (17 / 32) * 2 - 1
  const meshH = a.heights[k]
  const directH = sampleHeight(spec, nx, nz)
  const close = Math.abs(meshH - directH) < 1e-6
  console.log(`  两次构建逐位一致: ${same ? '✅' : '❌'}`)
  console.log(`  sampleHeight 与网格采样一致（float32 容差）: ${close ? '✅' : `❌ ${meshH} vs ${directH}`}`)
}

const cases: Array<[string, string]> = [
  ['自然地形（未提及地形）', '这里是一片宁静的土地，愿众生安好'],
  ['山地 + 森林', '连绵的黑色山脉，山脚是茂密的针叶林，谷底有散发着酸味的湖泊'],
  ['永夜 + 毒水 + 致命伤害', '永夜笼罩一切；所有的水都有毒；一切落在 Agent 身上的伤害都是致命的'],
  ['群岛', '散落在无尽之海上的群岛，每座岛都很小'],
  ['沙漠废土', '干旱的沙漠与废土，寸草不生，没有水'],
  ['冰封', '永冻的冰原，到处是雪与冰川，天光昏暗'],
  ['火山', '活火山群岛，岩浆与灰烬，天穹浸着血色'],
]

for (const [label, prompt] of cases) {
  const spec = defaultTerrainSpec(prompt, '')
  console.log(`\n${'='.repeat(60)}\n【${label}】`)
  console.log(`  prompt: ${prompt}`)
  console.log(`  推导: style=${spec.terrain.style} water=${spec.terrain.water} sky=${spec.sky.preset} seed=${spec.seed}`)
  console.log(`  keywords: ${JSON.stringify(terrainKeywords(prompt))}`)
  console.log(`  摘要: ${terrainSummary(spec)}`)
  render(spec)
}

console.log(`\n${'='.repeat(60)}\n【确定性与落点】`)
const spec = defaultTerrainSpec('连绵的山脉与森林', '')
checkDeterminism(spec)

const ids = ['agent-alpha', 'agent-beta', 'agent-gamma']
const p1 = spawnPoints(spec, ids)
const p2 = spawnPoints(spec, ids)
console.log(`  落点可复现: ${JSON.stringify(p1) === JSON.stringify(p2) ? '✅' : '❌'}`)
for (const p of p1) {
  const h = sampleHeight(spec, p.x, p.z)
  const onLand = h > spec.terrain.seaLevel + 0.03
  console.log(
    `  ${p.id}: (${p.x.toFixed(3)}, ${p.z.toFixed(3)}) h=${h.toFixed(3)} ${onLand ? '陆地 ✅' : '水面 ❌'}`,
  )
}
const minGap = Math.min(
  ...p1.flatMap((a, i) => p1.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.z - b.z))),
)
console.log(`  最小间距 ${minGap.toFixed(3)}（阈值 ${WORLD_LIMITS.spawnSpacing}）`)

console.log(`\n${'='.repeat(60)}\n【改造补丁：网格与逐点采样必须一致】`)
{
  const sp = defaultTerrainSpec('连绵的山脉与森林', '')
  const patches = [
    { op: 'raise' as const, center: [0.1, -0.2] as [number, number], radius: 0.4, strength: 0.9 },
    { op: 'carve' as const, center: [-0.3, 0.2] as [number, number], radius: 0.3, strength: 0.7 },
    { op: 'flatten' as const, center: [0.5, 0.5] as [number, number], radius: 0.5, strength: 0.4 },
  ]
  const N = 32
  const d = buildTerrain(sp, { segments: N, patches })
  let maxDiff = 0
  for (const [ix, iz] of [[8, 24], [16, 16], [24, 8], [5, 5], [28, 28]]) {
    const nx = (ix / N) * 2 - 1
    const nz = (iz / N) * 2 - 1
    const mesh = d.heights[iz * (N + 1) + ix]
    const sampled = sampleHeight(sp, nx, nz, patches)
    maxDiff = Math.max(maxDiff, Math.abs(mesh - sampled))
  }
  console.log(`  网格 vs 采样 最大偏差 ${maxDiff.toExponential(2)}  ${maxDiff < 1e-6 ? '✅' : '❌'}`)
  // 补丁确实改变了地形
  const withOut = buildTerrain(sp, { segments: N })
  let changed = 0
  for (let i = 0; i < d.heights.length; i++) if (Math.abs(d.heights[i] - withOut.heights[i]) > 1e-6) changed++
  console.log(`  补丁实际改变了 ${((changed / d.heights.length) * 100).toFixed(0)}% 的顶点 ${changed > 0 ? '✅' : '❌'}`)
  // 补丁范围之外不受影响
  const farIdx = (31 * (N + 1)) + 31   // (1,1) 角落，三个补丁都够不到
  console.log(`  补丁范围外不受影响 ${Math.abs(d.heights[farIdx] - withOut.heights[farIdx]) < 1e-9 ? '✅' : '❌'}`)
}

console.log(`\n${'='.repeat(60)}\n【校验层：垃圾输入】`)
const garbage = [
  { seed: 'NaN', terrain: { style: 'nonsense', amplitude: 99, octaves: 3.7, water: 'lava' }, biomes: [] },
  { terrain: null, biomes: [{ id: 'x', color: 'red' }] },
  'not an object',
  { biomes: [{ id: 'a', color: '#AABBCC' }, { id: 'a', color: '#112233' }, { id: 'b', color: '#000000', maxHeight: 0.5 }] },
]
for (const g of garbage) {
  const { spec: s, repairs } = normalizeTerrainSpec(g as unknown, '山地')
  const legal =
    TERRAIN_ENUMS_STYLE.includes(s.terrain.style) &&
    s.biomes.length >= 1 &&
    s.biomes.length <= 6 &&
    s.terrain.amplitude >= 0 && s.terrain.amplitude <= 1 &&
    Number.isInteger(s.terrain.octaves) &&
    /^#[0-9a-f]{6}$/i.test(s.biomes[s.biomes.length - 1].color) &&
    s.biomes[s.biomes.length - 1].maxHeight === undefined
  console.log(`  ${legal ? '✅' : '❌'} repairs=${JSON.stringify(repairs)}`)
}
