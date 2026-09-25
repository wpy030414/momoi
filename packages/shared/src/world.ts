// ============================================================
// world.ts — 世界模拟的地形协议面
//
// ⚠️ 本文件被 **服务端** 与 **浏览器** 同时 import（@momoi/shared 是 TS 源码直引）：
//      - 服务端用它做参数校验与生成地形摘要（注入 Agent 提示词）
//      - 浏览器用它把同一份 TerrainSpec 建成网格
//    两端共用这一份实现，才可能对同一份参数得出**逐位相同**的地形。
//
//    因此这里绝不允许出现 document / window / node: 前缀 API，也不允许
//    import three。文件保持纯算术，副作用为零 —— 这同时也是「将来可以把
//    buildTerrain 挪进 Web Worker」的前提（低端机首帧卡顿的备选修法）。
// ============================================================

import { fbm, fnv1a, mulberry32, ridgedFbm } from './noise.js'

// ---------------------------------------------------------------
// 类型
// ---------------------------------------------------------------

export type TerrainStyle = 'mountains' | 'hills' | 'plains' | 'plateau' | 'islands' | 'mixed'
export type WaterKind = 'none' | 'ocean' | 'lakes' | 'toxic'
export type SkyPreset = 'day' | 'dusk' | 'night' | 'eternal_night' | 'blood' | 'void'
export type MarkKind = 'peak' | 'lake' | 'ruin' | 'crater' | 'tower' | 'gate'

/** 单条生物群系规则。按数组顺序**首次命中**判定，故靠前的规则优先级更高。 */
export interface BiomeRule {
  id: string
  color: string // '#RRGGBB'
  minHeight?: number // −1..1
  maxHeight?: number
  maxSlope?: number // 0..1
  minMoisture?: number // 0..1
  forestDensity?: number // 0..1；> 0 时客户端撒树
}

export interface TerrainSpec {
  version: 1
  seed: number
  terrain: {
    style: TerrainStyle
    amplitude: number // 0..1 起伏强度
    roughness: number // 0..1 基础频率倍率
    octaves: number // 1..8
    warp: number // 0..1 域扭曲强度
    seaLevel: number // −1..1 归一化海平面
    water: WaterKind
  }
  /** 1..6 条，按序优先匹配；末项必须无条件（校验层保证） */
  biomes: BiomeRule[]
  sky: { preset: SkyPreset; fog?: number }
  marks?: Array<{ name: string; x: number; z: number; kind: MarkKind }>
  /** 一句自然语言概括 —— 注入 Agent 提示词用，绝不把 JSON 倒进提示词 */
  summary: string
  /** 降级可见性：LLM 产出 or 关键词兜底 */
  generated_by: 'llm' | 'fallback'
}

/**
 * 地形改造补丁（Phase 3 用）。Phase 1 恒为空数组，但 `buildTerrain` 从第一天起
 * 就接受并 fold 它 —— 这是「地形规则不可修改」与「Agent 可以改造世界」能够共存的关键：
 * 补丁是叠加层，永远不写回 TerrainSpec。
 */
export interface TerrainPatch {
  op: 'raise' | 'lower' | 'flatten' | 'paint' | 'flood' | 'carve'
  center: [number, number] // 归一化坐标 [x, z]，各自 −1..1
  radius: number // 归一化半径，0..1
  strength: number // 0..1
  biome?: string
}

export interface TerrainData {
  segments: number
  /** 归一化高度，长度 (segments+1)²，行主序 k = iz·(N+1) + ix */
  heights: Float32Array
  moisture: Float32Array
  /** spec.biomes 的下标 */
  biomes: Uint8Array
  seaLevel: number
  /** 是否被水淹没的辅助阈值（seaLevel 的别名，供渲染层直接使用） */
  waterY: number
}

// ---------------------------------------------------------------
// 常量与词表
// ---------------------------------------------------------------

export const WORLD_LIMITS = {
  maxPromptLength: 2000,
  maxLawsLength: 2000,
  minAgents: 1,
  /** 沙盘边长（世界单位）—— 有限面积 */
  terrainSize: 512,
  /** 归一化高度 → 世界单位高度的缩放（相对沙盘半边长） */
  heightScale: 0.4,
  /** 渲染分段数（仅影响渲染精度，不影响地形本身） */
  segmentsDesktop: 96,
  segmentsMobile: 64,
  segmentsSoftware: 48,
  generationTimeoutMs: 20_000,
  /** Agent 落点间的归一化最小间距 */
  spawnSpacing: 0.22,
} as const

export const TERRAIN_ENUMS = {
  style: ['mountains', 'hills', 'plains', 'plateau', 'islands', 'mixed'] as TerrainStyle[],
  water: ['none', 'ocean', 'lakes', 'toxic'] as WaterKind[],
  sky: ['day', 'dusk', 'night', 'eternal_night', 'blood', 'void'] as SkyPreset[],
  mark: ['peak', 'lake', 'ruin', 'crater', 'tower', 'gate'] as MarkKind[],
  biomeId: [
    'ocean', 'beach', 'grass', 'jungle', 'forest', 'scrub',
    'swamp', 'tundra', 'sand', 'rock', 'ash', 'lava', 'crystal', 'snow',
  ],
  /** 数值区间 —— 生成器提示词直接从这里拼，故提示词与校验器无从漂移 */
  range: {
    amplitude: [0, 1],
    roughness: [0, 1],
    octaves: [1, 8],
    warp: [0, 1],
    seaLevel: [-1, 1],
    fog: [0, 1],
    forestDensity: [0, 1],
    minHeight: [-1, 1],
    maxHeight: [-1, 1],
    maxSlope: [0, 1],
    minMoisture: [0, 1],
  },
} as const

/** 生物群系调色板与植被密度 */
export const BIOME_PALETTE: Record<string, { color: string; forestDensity?: number }> = {
  ocean: { color: '#1d3b5c' },
  beach: { color: '#d9cba3' },
  grass: { color: '#6f9e52', forestDensity: 0.06 },
  jungle: { color: '#3f7a3a', forestDensity: 0.35 },
  forest: { color: '#3d6b3a', forestDensity: 0.45 },
  scrub: { color: '#8f8f5a', forestDensity: 0.08 },
  swamp: { color: '#4a5c3a', forestDensity: 0.18 },
  tundra: { color: '#9aa88f', forestDensity: 0.04 },
  sand: { color: '#e0cf9a' },
  rock: { color: '#7d7a73' },
  ash: { color: '#4a4642' },
  lava: { color: '#a8452a' },
  crystal: { color: '#8fb8c8' },
  snow: { color: '#eef1f4' },
}

const STYLE_LABEL: Record<TerrainStyle, string> = {
  mountains: '山地',
  hills: '丘陵',
  plains: '平原',
  plateau: '高原',
  islands: '群岛',
  mixed: '地貌错落',
}

const WATER_LABEL: Record<WaterKind, string> = {
  none: '几乎没有水体',
  ocean: '被海洋环绕',
  lakes: '散布着湖泊',
  toxic: '水体有毒',
}

const SKY_LABEL: Record<SkyPreset, string> = {
  day: '天光照常',
  dusk: '天色常驻黄昏',
  night: '天空是深沉的夜',
  eternal_night: '天空处于永夜',
  blood: '天穹浸着血色',
  void: '天穹是一片虚空',
}

// ---------------------------------------------------------------
// 地形场
// ---------------------------------------------------------------

/** 归一化高度场：坐标 x,z ∈ [−1,1]，返回归一化高度 ∈ 约 [−1,1] */
function heightAt(spec: TerrainSpec, x: number, z: number): number {
  const t = spec.terrain

  // 域扭曲 —— 让地形看起来像地质而成，而不是一团团肉瘤
  let sx = x
  let sz = z
  if (t.warp > 0) {
    const wx = fbm(x + 11.3, z + 5.7, 3, spec.seed + 7717)
    const wz = fbm(x - 7.1, z + 3.3, 3, spec.seed + 3313)
    sx = x + t.warp * (wx - 0.5) * 0.5
    sz = z + t.warp * (wz - 0.5) * 0.5
  }

  const freq = 1.2 + t.roughness * 4.0
  // 山地用脊状 fBm（尖锐山脊），其余用普通 fBm。脊化必须发生在八度累加之内，
  // 详见 noise.ts 的 ridgedFbm 注释 —— 事后脊化会把山变成一片惨白。
  const n =
    t.style === 'mountains'
      ? ridgedFbm(sx * freq, sz * freq, t.octaves, spec.seed)
      : fbm(sx * freq, sz * freq, t.octaves, spec.seed)
  return (applyStyle(spec, n, x, z) - 0.5) * 2 * t.amplitude
}

function applyStyle(spec: TerrainSpec, n: number, x: number, z: number): number {
  switch (spec.terrain.style) {
    case 'plains':
      return 0.5 + (n - 0.5) * 0.25
    case 'plateau':
      // smoothstep 锐化 + 台地量化
      return quantize(smoothstep(n), 5)
    case 'islands': {
      // ⚠️ 返回值必须与其它分支同量纲：heightAt 随后要减 0.5，而本处掩膜若
      //    直接以 [0,1] 低均值返回（例如均值 0.19），整片沙盘会被推到海面以下
      //    —— 群岛 100% 是水。故此处以「深海基座 0.15 + 岛体 0.7」抬回中位附近。
      const r = Math.max(Math.abs(x), Math.abs(z)) // 方形淡出：沙盘是方的，径向淡出会浪费四角
      const edge = 1 - smoothstep(clamp01((r - 0.72) / 0.28)) // r ≤ 0.72 → 1；r ≥ 1 → 0
      const blobs = fbm(x * 1.6 + 6.1, z * 1.6 - 3.7, 3, spec.seed + 4441)
      // 阈值 0.5 / 除数 0.18：组合场均值恰为 0.5，故约 20~25% 面积成岛。
      // ⚠️ 除数不可放大 —— 除数 0.3 会把饱和点推到 1.08，物理上不可达，
      //    land 永远到不了 1，群岛会整片沉在海面以下。
      const land = clamp01((blobs * 0.55 + n * 0.45 - 0.5) / 0.18)
      const base = 0.15 + 0.7 * land
      return clamp01((base + 0.25 * (n - 0.5)) * edge)
    }
    case 'mixed': {
      // 低频振幅调制：均值保持 ~1.0，故不改变整体高度区间
      const mod = fbm(x * 0.6 - 4.2, z * 0.6 + 2.9, 2, spec.seed + 9187)
      return n * (0.55 + 0.9 * mod)
    }
    case 'mountains':
    case 'hills':
    default:
      return n
  }
}

function moistureAt(spec: TerrainSpec, x: number, z: number): number {
  return fbm(x * 0.8 + 3.1, z * 0.8 - 2.4, 3, (spec.seed ^ 0x9e3779b9) >>> 0)
}

/** 各水体类型对应的基础水位分位（占地形高度分布的比例） */
const WATER_BASE_QUANTILE: Record<WaterKind, number> = {
  none: 0,
  ocean: 0.7,
  lakes: 0.2,
  toxic: 0.42,
}

/**
 * islands 地貌自带环绕的海，水位至少到这里。
 * 高群岛是「深海海底 + 岛体」的**双峰**分布，若沿用 0.55 这类中位分位，水位会恰好
 * 落在海底平台上 —— 海平面等于海底深度，群岛看起来像一片悬空的台地而非岛屿。
 */
const ISLANDS_MIN_QUANTILE = 0.68

/** `waterLevel` 的记忆化缓存：同一 spec 对象只算一次分位数 */
const waterLevelCache = new WeakMap<TerrainSpec, number>()

/**
 * 水面高度（归一化坐标）。
 *
 * ⚠️ 刻意**不是**一个绝对值。高度场的实际取值范围随 style 与 amplitude 剧烈变化
 *    （'plains' 实测只有 ±0.04，'mountains' 可达 ±0.7）。若把 seaLevel 当绝对值用，
 *    低起伏地貌会把模型/兜底给的任何水位整个越过 —— 实测表现就是「提示词写了湖泊，
 *    水面占比 0%」。
 *
 * 改为取**地形自身高度分布的分位数**：水体类型决定基础分位（海洋淹得多、湖泊淹得少），
 *    spec 里的 `seaLevel` 降级为微调量。判定源仍然是唯一的 `heightAt`，故服务端与
 *    客户端、逐点采样与网格采样必然一致。
 *
 * `water === 'none'` 返回 −Infinity：整片沙盘不存在水面。
 */
export function waterLevel(spec: TerrainSpec): number {
  if (spec.terrain.water === 'none') return -Infinity
  const cached = waterLevelCache.get(spec)
  if (cached !== undefined) return cached

  // 固定 33×33 探针估计分位数：确定性、与 buildTerrain 同一 heightAt，
  // 频率量级（1.2~5.2）远低于探针密度，故足够代表整体分布。
  const probe: number[] = []
  for (let i = 0; i < 33; i++) {
    for (let j = 0; j < 33; j++) {
      probe.push(heightAt(spec, (i / 32) * 2 - 1, (j / 32) * 2 - 1))
    }
  }
  probe.sort((a, b) => a - b)

  const base = Math.max(
    WATER_BASE_QUANTILE[spec.terrain.water],
    spec.terrain.style === 'islands' ? ISLANDS_MIN_QUANTILE : 0,
  )
  const q = clamp01(base + spec.terrain.seaLevel * 0.25)
  const idx = Math.min(probe.length - 1, Math.max(0, Math.round(q * (probe.length - 1))))
  const level = probe[idx]
  waterLevelCache.set(spec, level)
  return level
}

/** 单点归一化高度 —— Agent 落点与「此处是什么地形」判定用 */
export function sampleHeight(spec: TerrainSpec, x: number, z: number): number {
  return heightAt(spec, x, z)
}

export function sampleBiome(spec: TerrainSpec, x: number, z: number): BiomeRule {
  const h = heightAt(spec, x, z)
  const moisture = moistureAt(spec, x, z)
  const i = classifyBiome(spec, h, moisture, 0)
  return spec.biomes[i] ?? spec.biomes[spec.biomes.length - 1]
}

export function isWater(spec: TerrainSpec, x: number, z: number): boolean {
  return heightAt(spec, x, z) <= waterLevel(spec)
}

function classifyBiome(spec: TerrainSpec, h: number, moisture: number, slope: number): number {
  const rules = spec.biomes
  for (let i = 0; i < rules.length; i++) {
    const b = rules[i]
    if (b.minHeight !== undefined && h < b.minHeight) continue
    if (b.maxHeight !== undefined && h > b.maxHeight) continue
    if (b.maxSlope !== undefined && slope > b.maxSlope) continue
    if (b.minMoisture !== undefined && moisture < b.minMoisture) continue
    return i
  }
  // 校验层保证末项无条件，故此处不可达；仍然兜底以防 spec 被外部篡改
  return Math.max(0, rules.length - 1)
}

/**
 * 把 TerrainSpec 铺成顶点网格。
 *
 * 顶点顺序与 three.js `PlaneGeometry(w, h, N, N)` 经 `rotateX(−π/2)` 之后**逐位对应**
 * （行主序、ix 变化最快、iz 自 −1 递增到 +1），故渲染层只需 `pos.setY(k, h[k]·S·scale)`。
 */
export function buildTerrain(
  spec: TerrainSpec,
  opts: { segments: number; patches?: TerrainPatch[] },
): TerrainData {
  const N = Math.max(4, Math.min(512, Math.round(opts.segments)))
  const size = N + 1
  const heights = new Float32Array(size * size)
  const moisture = new Float32Array(size * size)
  const biomes = new Uint8Array(size * size)

  for (let iz = 0; iz <= N; iz++) {
    const nz = (iz / N) * 2 - 1
    for (let ix = 0; ix <= N; ix++) {
      const nx = (ix / N) * 2 - 1
      const k = iz * size + ix
      heights[k] = heightAt(spec, nx, nz)
      moisture[k] = moistureAt(spec, nx, nz)
    }
  }

  // 补丁（Phase 3 的接缝；Phase 1 恒为 []）
  if (opts.patches && opts.patches.length > 0) {
    applyPatches(heights, N, opts.patches)
  }

  // 群系分类依赖最终高度（需算坡度），故排在补丁之后
  const step = 2 / N
  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      const k = iz * size + ix
      const l = iz * size + Math.max(0, ix - 1)
      const r = iz * size + Math.min(N, ix + 1)
      const u = Math.max(0, iz - 1) * size + ix
      const d = Math.min(N, iz + 1) * size + ix
      const dx = (heights[r] - heights[l]) / (2 * step)
      const dz = (heights[d] - heights[u]) / (2 * step)
      const slope = clamp01(Math.hypot(dx, dz) / 8)
      biomes[k] = classifyBiome(spec, heights[k], moisture[k], slope)
    }
  }

  return {
    segments: N,
    heights,
    moisture,
    biomes,
    seaLevel: waterLevel(spec),
    waterY: waterLevel(spec),
  }
}

function applyPatches(heights: Float32Array, N: number, patches: TerrainPatch[]): void {
  const size = N + 1
  for (const p of patches) {
    const [cx, cz] = p.center
    const radius = Math.max(0.01, p.radius)
    const strength = clamp01(p.strength)
    for (let iz = 0; iz <= N; iz++) {
      const nz = (iz / N) * 2 - 1
      for (let ix = 0; ix <= N; ix++) {
        const nx = (ix / N) * 2 - 1
        const dist = Math.hypot(nx - cx, nz - cz)
        if (dist > radius) continue
        // 径向平滑衰减：中心最强，边缘归零
        const falloff = 1 - dist / radius
        const w = falloff * falloff * (3 - 2 * falloff) * strength
        const k = iz * size + ix
        if (p.op === 'raise') heights[k] += w * 0.5
        else if (p.op === 'lower' || p.op === 'carve') heights[k] -= w * 0.5
        else if (p.op === 'flatten') heights[k] *= 1 - w
        else if (p.op === 'flood') heights[k] -= w * 0.3
        // 'paint' 不改高度（材质由渲染层按 biome 覆盖处理）
      }
    }
  }
}

// ---------------------------------------------------------------
// Agent 落点（确定性）
// ---------------------------------------------------------------

/**
 * 为每个 Agent 算一个**确定性**落点：同一 (spec.seed, agentId) 永远得到同一坐标。
 *
 * 这使 Phase 1 无需建表就能让 Agent 站在世界里，而 Phase 2 引入 world_entities 时
 * 只要用同一函数做初始播种，位置语义就连续。
 */
export function spawnPoints(
  spec: TerrainSpec,
  agentIds: string[],
): Array<{ id: string; x: number; z: number }> {
  const out: Array<{ id: string; x: number; z: number }> = []
  // 陆地判定：严格高于水位（水位本身由地形分位数决定，与渲染层同源）
  const level = waterLevel(spec)

  for (const id of agentIds) {
    const rng = mulberry32((spec.seed ^ fnv1a(id)) >>> 0)
    let picked: { x: number; z: number } | null = null

    // 首选：陆地 + 与其他落点保持间距
    for (let attempt = 0; attempt < 240 && !picked; attempt++) {
      const x = rng() * 2 - 1
      const z = rng() * 2 - 1
      if (heightAt(spec, x, z) <= level) continue
      if (out.some((p) => Math.hypot(p.x - x, p.z - z) < WORLD_LIMITS.spawnSpacing)) continue
      picked = { x, z }
    }
    // 退让：放宽间距，只要求陆地
    for (let attempt = 0; attempt < 240 && !picked; attempt++) {
      const x = rng() * 2 - 1
      const z = rng() * 2 - 1
      if (heightAt(spec, x, z) > level) picked = { x, z }
    }
    // 极端情形（整个世界都是水面）：落在世界中心，仍是合法坐标
    if (!picked) picked = { x: 0, z: 0 }

    out.push({ id, x: picked.x, z: picked.z })
  }
  return out
}

// ---------------------------------------------------------------
// 关键词推导（兜底路径 + 生成器提示词的 few-shot 共用）
// ---------------------------------------------------------------

export interface TerrainHints {
  style: TerrainStyle
  water: WaterKind
  sky: SkyPreset
  biomes: string[]
}

const STYLE_KEYWORDS: Array<[RegExp, TerrainStyle]> = [
  [/山脉|群山|山峰|山脊|丘陵|山峦|mountain|peak|ridge|hills?/i, 'mountains'],
  [/群岛|岛屿|海岛|island|archipelago/i, 'islands'],
  [/高原|台地|plateau|mesa/i, 'plateau'],
  [/平原|旷野|草原|苔原|plains|prairie|tundra/i, 'plains'],
  [/错落|多样|混杂|mixed|varied/i, 'mixed'],
]

const SKY_KEYWORDS: Array<[RegExp, SkyPreset]> = [
  [/永夜|永远的夜|永恒的黑夜|永不天明|eternal night|endless night/i, 'eternal_night'],
  [/黑夜|夜晚|深夜|午夜|night|midnight/i, 'night'],
  [/黄昏|暮色|日落|傍晚|昏暗|晦暗|阴沉|黯淡|dusk|twilight|sunset|gloom|dim|murk/i, 'dusk'],
  [/血|猩红|赤色|blood|crimson|scarlet/i, 'blood'],
  [/虚空|虚无|混沌|无光|void|abyss|chaos/i, 'void'],
]

const WATER_WORDS = /水|海|湖|河|洋|沼|潮|water|lake|sea|river|ocean|swamp|tide/i
const TOXIC_WORDS = /毒|酸|腐蚀|污染|toxic|acid|poison|corrupt/i
const ARID_WORDS = /干旱|无水|荒漠|寸草不生|arid|drought|barren|no water/i

/** 从自由文本中扫出地形倾向。纯函数、无 I/O。 */
export function terrainKeywords(text: string): TerrainHints {
  const style = STYLE_KEYWORDS.find(([re]) => re.test(text))?.[1] ?? 'hills'

  let water: WaterKind = 'lakes'
  if (TOXIC_WORDS.test(text) && WATER_WORDS.test(text)) water = 'toxic'
  else if (/海|ocean|sea\b/i.test(text)) water = 'ocean'
  else if (ARID_WORDS.test(text)) water = 'none'
  else if (!WATER_WORDS.test(text)) water = 'lakes'

  const sky = SKY_KEYWORDS.find(([re]) => re.test(text))?.[1] ?? 'day'

  const biomed: string[] = []
  if (/雪|冰|霜|冻|snow|ice|glaci|frost/i.test(text)) biomed.push('snow')
  if (/火山|熔岩|岩浆|灰烬|废土|lava|volcan|ash|magma/i.test(text)) biomed.push('ash')
  if (/晶|结晶|琉璃|crystal/i.test(text)) biomed.push('crystal')
  if (/沙漠|沙丘|戈壁|desert|dune/i.test(text)) biomed.push('sand')
  if (/雨林|丛林|热带|jungle|tropic/i.test(text)) biomed.push('jungle')
  if (/沼泽|湿地|泥沼|swamp|marsh|bog/i.test(text)) biomed.push('swamp')

  return { style, water, sky, biomes: biomed }
}

// ---------------------------------------------------------------
// 默认自然地形（兜底）
// ---------------------------------------------------------------

/**
 * 由提示词文本**确定性地**推导一份自然地形参数 —— 不发起任何 LLM 调用。
 *
 * 这是失败开放路径：LLM 超时 / 报错 / 吐不出可解析 JSON 时，世界照样创生成功，
 * 只是地形由关键词推导而来（`generated_by: 'fallback'`，UI 可见）。
 * 同一 (prompt, laws) 永远得到同一种子，故被重启打断的生成重跑也得到同一世界。
 */
export function defaultTerrainSpec(prompt: string, laws = ''): TerrainSpec {
  const hints = terrainKeywords(`${prompt}\n${laws}`)
  const seed = fnv1a(`${prompt}｜${laws}`) >>> 0

  const spec: TerrainSpec = {
    version: 1,
    seed,
    terrain: {
      style: hints.style,
      amplitude: hints.style === 'plains' ? 0.35 : 0.8,
      roughness: hints.style === 'mountains' ? 0.55 : 0.4,
      octaves: hints.style === 'mountains' ? 6 : 4,
      warp: hints.style === 'mountains' ? 0.45 : 0.25,
      // seaLevel 只是水位分位的**微调量**（见 waterLevel）：0 即「按水体类型的默认分位」，
      // 正值抬高分位（水更多），负值降低（水更少）。实际水位由地形自身分布决定。
      seaLevel: 0,
      water: hints.water,
    },
    biomes: naturalBiomes(hints.biomes, hints.water),
    sky: { preset: hints.sky, fog: hints.sky === 'void' || hints.sky === 'eternal_night' ? 0.4 : 0.15 },
    summary: '',
    generated_by: 'fallback',
  }
  spec.summary = terrainSummary(spec)
  return spec
}

/**
 * 自然地形群系阶梯：由沿海到山顶逐级抬升。
 *
 * 阈值的绝对值按「amplitude ≈ 0.8 时高度绝大多数落在 ±0.45 内」来标定 ——
 * fBm 的输出集中在 0.5 附近，`(n−0.5)·2·amplitude` 的实际分布比理论上限窄得多，
 * 阈值若按理论上限 ±amplitude 标定，雪线将永远够不到，山峰会全是岩石。
 *
 * 两个易错点（都已在实测中触发过）：
 *  1. `water === 'none'` 时必须**整条去掉 ocean 群系**，否则无水世界的低地会被判成
 *     海洋群系，渲染成一片深蓝。
 *  2. 相邻同 id 的段必须**合并**（冻土世界的低地/中段都是 tundra），否则同一群系
 *     在规则表里出现两次，靠前那条会永久遮蔽靠后那条。
 */
function naturalBiomes(hints: string[], water: WaterKind): BiomeRule[] {
  const has = (id: string) => hints.includes(id)
  const desert = has('sand')
  const frozen = has('snow')
  const volcanic = has('ash')
  const band = (id: string, extra: Partial<BiomeRule> = {}): BiomeRule => {
    const p = BIOME_PALETTE[id] ?? BIOME_PALETTE.rock
    return { id, color: p.color, forestDensity: p.forestDensity, ...extra }
  }

  const low = desert
    ? band('sand', { maxHeight: 0.2 })
    : frozen
      ? band('tundra', { maxHeight: 0.12 })
      : volcanic
        ? band('ash', { maxHeight: 0.14 })
        : band('grass', { maxHeight: 0.15 })

  const mid = has('jungle')
    ? band('jungle', { maxHeight: 0.3, minMoisture: 0.35 })
    : has('swamp')
      ? band('swamp', { maxHeight: 0.14, minMoisture: 0.5 })
      : frozen
        ? band('tundra', { maxHeight: 0.26 })
        : volcanic
          ? band('ash', { maxHeight: 0.26 })
          : desert
            ? band('sand', { maxHeight: 0.26 })
            : band('forest', { maxHeight: 0.28, minMoisture: 0.42 })

  const high = volcanic
    ? band('ash', { maxHeight: 0.42 })
    : frozen
      ? band('snow', { maxHeight: 0.34 })
      : has('crystal')
        ? band('crystal', { maxHeight: 0.4 })
        : band('rock', { maxHeight: 0.4 })

  // 峰顶：火山世界的尖峰是熔岩，沙漠世界是裸岩，其余是雪
  const top = volcanic ? band('lava') : desert ? band('rock') : band('snow')

  const raw: BiomeRule[] = []
  // 无水世界不设 ocean 群系 —— 否则低地会渲染成海洋色
  if (water !== 'none') raw.push(band('ocean', { maxHeight: -0.02 }))
  raw.push(desert ? band('sand', { maxHeight: 0.06 }) : band('beach', { maxHeight: 0.06 }))
  raw.push(low, mid, high, top)

  return mergeAdjacentBiomes(raw)
}

/** 合并相邻的同 id 段：保留靠后那条（阈值更宽），使同一群系只出现一次。 */
function mergeAdjacentBiomes(rules: BiomeRule[]): BiomeRule[] {
  const out: BiomeRule[] = []
  for (const r of rules) {
    const prev = out[out.length - 1]
    if (prev && prev.id === r.id) out[out.length - 1] = r
    else out.push(r)
  }
  return out
}

// ---------------------------------------------------------------
// 校验与钳制
// ---------------------------------------------------------------

export interface NormalizeResult {
  spec: TerrainSpec
  repairs: string[]
}

/**
 * 把 LLM 产出（或任何来源）的对象洗成合法 TerrainSpec。**永不抛异常。**
 * `repairs` 是提示词需要调优的信号，调用方应打 console.warn。
 */
export function normalizeTerrainSpec(raw: unknown, prompt = ''): NormalizeResult {
  const repairs: string[] = []
  const fallback = defaultTerrainSpec(prompt)

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { spec: fallback, repairs: ['根节点不是对象，整体回退默认地形'] }
  }
  const r = raw as Record<string, unknown>
  const rt = (r.terrain ?? {}) as Record<string, unknown>

  const terrain = {
    style: pickEnum(rt.style, TERRAIN_ENUMS.style, fallback.terrain.style, 'terrain.style', repairs),
    amplitude: num(rt.amplitude, 0, 1, fallback.terrain.amplitude, 'terrain.amplitude', repairs),
    roughness: num(rt.roughness, 0, 1, fallback.terrain.roughness, 'terrain.roughness', repairs),
    octaves: Math.round(num(rt.octaves, 1, 8, fallback.terrain.octaves, 'terrain.octaves', repairs)),
    warp: num(rt.warp, 0, 1, fallback.terrain.warp, 'terrain.warp', repairs),
    seaLevel: num(rt.seaLevel, -1, 1, fallback.terrain.seaLevel, 'terrain.seaLevel', repairs),
    water: pickEnum(rt.water, TERRAIN_ENUMS.water, fallback.terrain.water, 'terrain.water', repairs),
  }

  // 法则里说了有毒而模型没给 —— 以用户明确写的为准
  if (terrain.water === 'none') {
    const hinted = terrainKeywords(prompt).water
    if (hinted === 'toxic') {
      terrain.water = 'toxic'
      repairs.push('terrain.water 被提示词中的「有毒」覆盖')
    }
  }

  const biomes = normalizeBiomes(r.biomes, fallback.biomes, repairs)

  const skyRaw = (r.sky ?? {}) as Record<string, unknown>
  const sky = {
    preset: pickEnum(skyRaw.preset, TERRAIN_ENUMS.sky, fallback.sky.preset, 'sky.preset', repairs),
    fog: num(skyRaw.fog, 0, 1, fallback.sky.fog ?? 0.15, 'sky.fog', repairs),
  }

  const marks = normalizeMarks(r.marks, repairs)

  const spec: TerrainSpec = {
    version: 1,
    seed: Math.round(num(r.seed, 0, 4294967295, fallback.seed, 'seed', repairs)) >>> 0,
    terrain,
    biomes,
    sky,
    summary: '',
    generated_by: 'llm',
  }
  if (marks.length > 0) spec.marks = marks
  spec.summary = typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim().slice(0, 80) : terrainSummary(spec)
  return { spec, repairs }
}

/**
 * 生物群系 id 的同义词表。
 *
 * 模型很爱自造 id（'toxic'、'mountain'、'ice'…）。若不映射回闭合词表，后果有二：
 *   1) 英文 id 会漏进中文摘要 —— 实测出现过「生物群系：toxic、…、biome5」；
 *   2) 拿不到 BIOME_PALETTE 的配色，整条群系变成一块默认灰。
 * 词表闭合是 TERRAIN_ENUMS 存在的意义，故这里必须收口。
 */
const BIOME_ALIASES: Record<string, string> = {
  water: 'ocean', sea: 'ocean', lake: 'ocean', river: 'ocean', deep: 'ocean', ocean_floor: 'ocean',
  toxic: 'swamp', poison: 'swamp', acid: 'swamp', acid_pool: 'swamp', bog: 'swamp',
  marsh: 'swamp', wetland: 'swamp',
  tree: 'forest', woods: 'forest', woodland: 'forest', pine: 'forest', conifer: 'forest',
  mountain: 'rock', mountains: 'rock', stone: 'rock', cliff: 'rock', peak: 'rock',
  rocky: 'rock', highland: 'rock', barren: 'rock',
  desert: 'sand', dune: 'sand', dunes: 'sand', beach_sand: 'sand',
  ice: 'snow', glacier: 'snow', frost: 'snow', snowcap: 'snow',
  frozen: 'tundra', permafrost: 'tundra', cold: 'tundra',
  meadow: 'grass', plain: 'grass', plains: 'grass', grassland: 'grass', prairie: 'grass',
  volcanic: 'lava', magma: 'lava', fire: 'lava', molten: 'lava',
  ash_land: 'ash', wasteland: 'ash', scorched: 'ash', burnt: 'ash',
  crystal_field: 'crystal', crystals: 'crystal', glass: 'crystal',
  rainforest: 'jungle', tropical: 'jungle', tropic: 'jungle',
  bush: 'scrub', bushes: 'scrub', shrub: 'scrub', shrubland: 'scrub', steppe: 'scrub',
}

/** 把任意字符串解析为词表内的 id；词表已用尽则返回 null（该条规则被丢弃）。 */
function resolveBiomeId(raw: string, used: Set<string>): string | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  const vocab = TERRAIN_ENUMS.biomeId as readonly string[]
  if (key && vocab.includes(key)) return used.has(key) ? firstUnusedBiomeId(used) : key
  const alias = key ? BIOME_ALIASES[key] : undefined
  if (alias && !used.has(alias)) return alias
  // 模糊匹配：'dark_forest' → forest，'snowy_peak' → snow
  for (const candidate of vocab) {
    if (key.includes(candidate) && !used.has(candidate)) return candidate
  }
  return firstUnusedBiomeId(used)
}

function firstUnusedBiomeId(used: Set<string>): string | null {
  return (TERRAIN_ENUMS.biomeId as readonly string[]).find((id) => !used.has(id)) ?? null
}

function normalizeBiomes(raw: unknown, fallback: BiomeRule[], repairs: string[]): BiomeRule[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    repairs.push('biomes 缺失或为空，注入自然群系阶梯')
    return fallback
  }
  const seen = new Set<string>()
  const out: BiomeRule[] = []
  for (const entry of raw.slice(0, 6)) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const rawId = typeof e.id === 'string' ? e.id.trim().slice(0, 24) : ''
    const id = resolveBiomeId(rawId, seen)
    if (!id) {
      repairs.push(`biomes 词表已用尽，丢弃第 ${out.length + 1} 条（原 id "${rawId}"）`)
      continue
    }
    if (id !== rawId) repairs.push(`biomes.id "${rawId}" 不在词表内，映射为 "${id}"`)
    seen.add(id)

    const hex = typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color.trim())
      ? e.color.trim().toLowerCase()
      : BIOME_PALETTE[id]?.color ?? '#7d7a73'
    if (typeof e.color !== 'string' || !/^#[0-9a-f]{6}$/i.test((e.color ?? '').trim())) {
      repairs.push(`biomes[${id}].color 非法，改用默认色`)
    }

    const rule: BiomeRule = { id, color: hex }
    const minH = optNum(e.minHeight, -1, 1, `biomes[${id}].minHeight`, repairs)
    if (minH !== undefined) rule.minHeight = minH
    const maxH = optNum(e.maxHeight, -1, 1, `biomes[${id}].maxHeight`, repairs)
    if (maxH !== undefined) rule.maxHeight = maxH
    const maxS = optNum(e.maxSlope, 0, 1, `biomes[${id}].maxSlope`, repairs)
    if (maxS !== undefined) rule.maxSlope = maxS
    const minM = optNum(e.minMoisture, 0, 1, `biomes[${id}].minMoisture`, repairs)
    if (minM !== undefined) rule.minMoisture = minM
    const fd = BIOME_PALETTE[id]?.forestDensity
    if (e.forestDensity !== undefined) rule.forestDensity = num(e.forestDensity, 0, 1, fd ?? 0, `biomes[${id}].forestDensity`, repairs)
    else if (fd !== undefined) rule.forestDensity = fd
    out.push(rule)
  }

  if (out.length === 0) {
    repairs.push('biomes 全部非法，注入自然群系阶梯')
    return fallback
  }
  // 末项必须无条件，否则分类不是全函数
  const last = out[out.length - 1]
  if (last.minHeight !== undefined || last.maxHeight !== undefined || last.maxSlope !== undefined || last.minMoisture !== undefined) {
    delete last.minHeight
    delete last.maxHeight
    delete last.maxSlope
    delete last.minMoisture
    repairs.push(`biomes 末项（${last.id}）带条件，已清除条件使其成为兜底`)
  }
  return out
}

function normalizeMarks(raw: unknown, repairs: string[]): Array<{ name: string; x: number; z: number; kind: MarkKind }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ name: string; x: number; z: number; kind: MarkKind }> = []
  for (const entry of raw.slice(0, 12)) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const name = typeof e.name === 'string' ? e.name.trim().slice(0, 32) : ''
    if (!name) continue
    out.push({
      name,
      x: num(e.x, -1, 1, 0, 'marks[].x', repairs),
      z: num(e.z, -1, 1, 0, 'marks[].z', repairs),
      kind: pickEnum(e.kind, TERRAIN_ENUMS.mark, 'ruin', 'marks[].kind', repairs),
    })
  }
  return out
}

function num(raw: unknown, min: number, max: number, fallback: number, field: string, repairs: string[]): number {
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(v)) {
    if (raw !== undefined) repairs.push(`${field} 非数值，取默认 ${fallback}`)
    return fallback
  }
  if (v < min || v > max) {
    repairs.push(`${field}=${v} 越界，钳制到 [${min}, ${max}]`)
    return Math.min(max, Math.max(min, v))
  }
  return v
}

/** 可选数值字段：缺失即返回 undefined（表示「该条件不参与判定」），非法则忽略并记录。 */
function optNum(raw: unknown, min: number, max: number, field: string, repairs: string[]): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const v = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(v)) {
    repairs.push(`${field} 非数值，已忽略该条件`)
    return undefined
  }
  if (v < min || v > max) {
    repairs.push(`${field}=${v} 越界，钳制到 [${min}, ${max}]`)
    return Math.min(max, Math.max(min, v))
  }
  return v
}

function pickEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T, field: string, repairs: string[]): T {
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T
  if (raw !== undefined) repairs.push(`${field}=${JSON.stringify(raw)} 不在词表内，取默认 ${fallback}`)
  return fallback
}

// ---------------------------------------------------------------
// 自然语言摘要
// ---------------------------------------------------------------

/** 把 TerrainSpec 概括成一句话 —— 注入 Agent 提示词，绝不倒 JSON。 */
export function terrainSummary(spec: TerrainSpec): string {
  const names = spec.biomes
    .filter((b) => b.id !== 'ocean')
    .map((b) => BIOME_NAME[b.id] ?? b.id)
    .filter((v, i, a) => a.indexOf(v) === i)

  const parts = [
    `一片${STYLE_LABEL[spec.terrain.style]}地貌的有限沙盘`,
    WATER_LABEL[spec.terrain.water],
    SKY_LABEL[spec.sky.preset],
  ]
  let s = parts.join('，') + '。'
  if (names.length > 0) s += `生物群系：${names.join('、')}。`
  if (spec.marks && spec.marks.length > 0) {
    s += `地标：${spec.marks.map((m) => m.name).join('、')}。`
  }
  return s
}

const BIOME_NAME: Record<string, string> = {
  ocean: '海洋',
  beach: '滩涂',
  grass: '草原',
  jungle: '雨林',
  forest: '森林',
  scrub: '灌木',
  swamp: '沼泽',
  tundra: '苔原',
  sand: '沙地',
  rock: '岩地',
  ash: '灰烬',
  lava: '熔岩',
  crystal: '晶簇',
  snow: '雪原',
}

// ---------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

function quantize(v: number, steps: number): number {
  return Math.round(v * steps) / steps
}
