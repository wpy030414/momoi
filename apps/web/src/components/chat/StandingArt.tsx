import { useEffect, useRef, useState, type CSSProperties } from 'react'

interface StandingArtProps {
  src: string
  /** 无障碍名称（智能体名） */
  alt: string
  /** 小屏不画地线——立绘区被压缩后地线会挤在消息首行附近，反而干扰 */
  isMobile: boolean
  className?: string
  /** 外层定位样式（立绘按整个聊天区高度排版，由 ChatPanel 注入） */
  style?: CSSProperties
}

/** 非透明像素的包围盒（相对图片原始像素） */
interface ContentBox {
  top: number
  bottom: number
  /** 图片原始宽高，用于换算比例 */
  width: number
  height: number
}

/**
 * 扫描图片 alpha 通道，求非透明像素的最小包围盒。
 *
 * 立绘通常四周带透明留白，若直接按整张图做 cover 裁切，人物头顶会悬空。
 * 这里把「非空像素团」的真实边界找出来，供布局把它的上下沿贴齐容器。
 *
 * 失败时（跨域污染画布、解码异常）返回 null，调用方退化为整图 cover。
 */
async function measureContent(src: string): Promise<ContentBox | null> {
  try {
    // 不设 crossOrigin：图床（cloudflareimg.cdn.sn）不返回 CORS 头，带上它会让图片
    // 直接加载失败。不带时图片可正常显示，跨域画布会被「污染」——此时 getImageData
    // 抛 SecurityError，由下方 catch 降级为整图布局（见调用方注释）。
    const img = new Image()
    img.src = src
    await img.decode()

    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!w || !h) return null

    // 大图先等比缩小采样：包围盒精度足够，且避免一次性分配几十 MB 像素缓冲
    const MAX = 512
    const scale = Math.min(1, MAX / Math.max(w, h))
    const sw = Math.max(1, Math.round(w * scale))
    const sh = Math.max(1, Math.round(h * scale))

    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, sw, sh)
    const { data } = ctx.getImageData(0, 0, sw, sh)

    let top = sh
    let bottom = -1
    // 阈值取 16（约 6% 不透明度）：抗锯齿与极淡的渐变边缘不应被当成内容，
    // 否则包围盒会被撑大，人物被缩小、上下留空。
    const ALPHA_MIN = 16
    for (let y = 0; y < sh; y++) {
      const rowStart = y * sw * 4
      for (let x = 0; x < sw; x++) {
        if (data[rowStart + x * 4 + 3] > ALPHA_MIN) {
          if (y < top) top = y
          if (y > bottom) bottom = y
          break // 该行已确认非空，跳到下一行
        }
      }
    }
    // 整张全透明（或完全没扫到）：没有可对齐的内容，按整图处理
    if (bottom < 0) return null

    return {
      top: (top / sh) * h,
      bottom: ((bottom + 1) / sh) * h, // +1 把最后一行像素计入
      width: w,
      height: h,
    }
  } catch {
    return null
  }
}

/**
 * 智能体立绘：按 cover 填满容器，并把图片中「非空像素团」的顶部对齐容器顶部、
 * 底部对齐容器底部——人物完整撑满上半屏且不会悬空或露出画布留白。
 *
 * 实现上用 transform 缩放/平移而非 object-fit：object-fit 只能居中裁切，
 * 无法按透明像素的真实边界定位。缩放比与偏移均由容器实测尺寸算出。
 *
 * 加载失败时渲染 null（等价「未配置」）——但**占位层仍由 ChatPanel 保留**，
 * 以避免图片加载中/失败时布局来回跳变。
 */
export function StandingArt({ src, alt, isMobile, className, style }: StandingArtProps) {
  const [failed, setFailed] = useState(false)
  const [box, setBox] = useState<ContentBox | null>(null)
  const [geom, setGeom] = useState<{ scale: number; x: number; y: number } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const holderRef = useRef<HTMLDivElement>(null)
  const imgElRef = useRef<HTMLImageElement>(null)

  // 切换单聊对象（src 变化）时重置状态，否则一次 404 会让后续所有立绘都不显示
  useEffect(() => {
    setFailed(false)
    setBox(null)
    setGeom(null)
    setLoaded(false)
  }, [src])

  // 测量非透明包围盒（同源图片/图床需允许 CORS，失败则退化为整图）
  useEffect(() => {
    if (!src) return
    let alive = true
    measureContent(src).then((b) => { if (alive) setBox(b) })
    return () => { alive = false }
  }, [src])

  // 依据容器实测尺寸计算 cover 缩放与偏移。
  // 没有包围盒时按整图（top=0, bottom=height）处理，等价于 object-fit: cover + 顶部对齐。
  useEffect(() => {
    const el = holderRef.current
    if (!el || !src) return

    const compute = () => {
      const rect = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      // 容器带 pt-[60px]（避让顶部悬浮 bar）。图片是 absolute 定位，绘制区右下
      // 以 padding box 为准，但上/左应从 padding 内侧算起——否则内容会窜出顶部。
      const padTop = parseFloat(cs.paddingTop) || 0
      const padLeft = parseFloat(cs.paddingLeft) || 0
      const padRight = parseFloat(cs.paddingRight) || 0
      const cw = rect.width - padLeft - padRight
      const ch = rect.height - padTop
      if (cw <= 0 || ch <= 0) return

      // 未测量出包围盒（跨域污染 / 解码失败）时退化为「整图 cover + 顶部对齐」。
      // 此时必须用图片真实尺寸，否则缩放会以 1×1 计算而完全失真。
      const imgW = box?.width ?? imgElRef.current?.naturalWidth ?? 0
      const imgH = box?.height ?? imgElRef.current?.naturalHeight ?? 0
      if (!imgW || !imgH) return
      const contentTop = box?.top ?? 0
      const contentBottom = box?.bottom ?? imgH
      const contentH = Math.max(1, contentBottom - contentTop)

      // 缩放：
      //  - 测到内容盒：以「内容可见高度 = 容器高度」为准，上下沿精确贴齐（宽度由
      //    overflow 裁切）。这是需求要求的对齐方式。
      //  - 未测到（跨域污染）：退化为标准 cover —— 取宽高缩放比的较大者铺满容器。
      const scale = box ? ch / contentH : Math.max(cw / imgW, ch / imgH)
      // 水平居中：测到内容时按内容居中，降级时按整图居中。
      // 垂直：测到内容则把内容顶边对齐容器顶部（底边自然贴底）；降级时整图垂直居中裁切。
      const x = padLeft + (cw - imgW * scale) / 2
      const y = box ? padTop - contentTop * scale : padTop + (ch - imgH * scale) / 2

      setGeom({ scale, x, y })
    }

    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [src, box, loaded])

  if (!src || failed) return null

  return (
    <div ref={holderRef} className={`standing-art-layer relative overflow-hidden ${className ?? ''}`} style={style}>
      <img
        ref={imgElRef}
        src={src}
        alt={alt}
        draggable={false}
        decoding="async"
        onError={() => setFailed(true)}
        // 图片解码完成后触发重算：测量失败（跨域污染）时几何依赖 naturalWidth/Height，
        // 而这些值只有加载完才可用。
        onLoad={() => setLoaded(true)}
        style={geom
          ? {
              // 以图片左上角为原点缩放，再用 translate 定位到内容顶边
              transform: `translate(${geom.x}px, ${geom.y}px) scale(${geom.scale})`,
              transformOrigin: '0 0',
            }
          : { visibility: 'hidden' }}
        className="absolute left-0 top-0 max-w-none select-none"
      />
      {!isMobile && <div className="standing-art-ground" />}
    </div>
  )
}