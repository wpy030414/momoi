// ============================================================
// WebGL 能力探测
// ============================================================
// ⚠️ **只接受 WebGL2**。three.js 自 r163 起移除了 WebGL1 支持，
//    `WebGLRenderer` 是 WebGL2-only —— 放行一个「有 WebGL1」的设备，
//    结果要么构造时抛错，要么渲染出一片垃圾。仅 WebGL1 的设备等同于 `none`。
//
// 探测必须在**懒加载模块之外**求值：WorldPanel 据此分派，`none` 的设备因此
// 根本不会去请求 three 那个 chunk（约 150KB gzip）。
//
// 探测结果缓存在模块变量里：它会分配一个**真实的 GL 上下文**（稀缺资源，
// 钉钉 Android 上尤其有限），不缓存的话每次面板渲染都会再分配一个。

export type GLSupport =
  /** 硬件加速的 WebGL2 —— 全画质 */
  | 'webgl2'
  /** 有 WebGL2 但可能是软件实现（如 SwiftShader）—— 降画质渲染，而不是拒之门外 */
  | 'software'
  /** 无可用 WebGL2 —— 走二维地图降级 */
  | 'none'

let cached: GLSupport | null = null

export function detectWebGL(): GLSupport {
  if (cached) return cached
  try {
    const canvas = document.createElement('canvas')
    // 严格探测：显式拒绝软件渲染。软件 GL 上的三维沙盘会变成幻灯片，
    // 降画质也救不回来 —— 那种设备更适合二维地图。
    if (canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true })) {
      cached = 'webgl2'
      return cached
    }
    // 宽松探测：有 WebGL2 但可能是软件实现 → 允许渲染，由调用方降画质
    cached = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false })
      ? 'software'
      : 'none'
  } catch {
    // 某些 WebView 在创建 canvas / 取上下文时直接抛错，而不是返回 null
    cached = 'none'
  }
  return cached
}
