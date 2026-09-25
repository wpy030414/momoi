// ============================================================
// noise.ts — 确定性噪声原语（世界模拟的地形地基）
//
// ⚠️ 本文件被 **服务端** 与 **浏览器** 同时 import（@momoi/shared 是 TS 源码直引）。
//    因此：
//    1) 绝不允许出现 document / window / node: 前缀的任何 API —— 只能有纯算术；
//    2) 绝不允许使用 Math.random() 或 crypto —— 那会破坏可复现性；
//    3) 绝不允许使用 Math.sin 系哈希 —— 不同 JS 引擎的对数/三角函数实现存在
//       ulp 级差异，会让两端算出不同地形，且**静默**不一致（无报错、无堆栈）。
//
// 全部哈希一律 Math.imul + >>> 0：32 位量级的整数若用普通 `*`，在 float64 下
// 会丢精度，同样导致跨端不一致。
// ============================================================

/** 五次淡入 t³(t(6t−15)+10)。值噪声的「方块感」来自线性插值，用它消除。 */
function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * mulberry32 —— 32 位确定性 PRNG。返回一个产出 [0,1) 的函数。
 * 用于「需要一串随机数」的场合（如 Agent 落点抖动），不用于地形场本身。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 二维格点整型哈希 → [0,1)。地形场的唯一随机源。
 * 同一 (ix, iz, seed) 在任何 JS 引擎上都得到同一个值。
 */
export function hash2i(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** 值噪声：四角格点值 + 五次淡入的双线性插值。输出 [0,1]。 */
export function valueNoise2D(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x)
  const z0 = Math.floor(z)
  const ux = quintic(x - x0)
  const uz = quintic(z - z0)

  const v00 = hash2i(x0, z0, seed)
  const v10 = hash2i(x0 + 1, z0, seed)
  const v01 = hash2i(x0, z0 + 1, seed)
  const v11 = hash2i(x0 + 1, z0 + 1, seed)

  const a = v00 + (v10 - v00) * ux
  const b = v01 + (v11 - v01) * ux
  return a + (b - a) * uz
}

/**
 * 分形布朗运动：多八度值噪声按总振幅归一化。
 * 每个八度用独立 seed 偏移（+ i·1013），避免各八度的格点对齐产生网格状伪影。
 * 输出 [0,1]。
 */
export function fbm(
  x: number,
  z: number,
  octaves: number,
  seed: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  const n = Math.max(1, Math.min(12, Math.round(octaves)))
  for (let i = 0; i < n; i++) {
    sum += amp * valueNoise2D(x * freq, z * freq, seed + i * 1013)
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

/** 脊状分形：1 − |2n − 1|。把 fBm 的浑圆起伏转成尖锐山脊。输出 [0,1]。 */
export function ridged(value: number): number {
  return 1 - Math.abs(2 * value - 1)
}

/**
 * 脊状分形布朗运动：**在每个八度内部**做脊化再累加。
 *
 * ⚠️ 不可改为「先 fbm、后对结果施以 ridged」——那样会把整片高度的均值从 0.5
 *    推到接近 1（因为 v 集中在 0.5 附近时 ridged(v) ≈ 1），于是山地世界几乎
 *    全部越过雪线，长成一片惨白。脊化必须进入累加之内，均值才留得住中位。
 *
 * 输出 [0,1]，均值约 0.5。
 */
export function ridgedFbm(
  x: number,
  z: number,
  octaves: number,
  seed: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  const n = Math.max(1, Math.min(12, Math.round(octaves)))
  for (let i = 0; i < n; i++) {
    sum += amp * ridged(valueNoise2D(x * freq, z * freq, seed + i * 1013))
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

/** FNV-1a 字符串哈希 → 32 位无符号整数。用于「同一段提示词 ⇒ 同一种子」。 */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
