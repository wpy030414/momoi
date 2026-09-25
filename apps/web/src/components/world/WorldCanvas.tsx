// ============================================================
// WorldCanvas — 世界模拟的三维沙盘
// ============================================================
// **全仓唯一 import three 的模块**。它是 React.lazy 的加载边界，故必须是一个
// 组件模块（而非库命名空间）——仓库既有的重依赖范式见 MessageContent.tsx 对
// markdown 的懒加载：Rolldown 构建下裸动态导入库命名空间会坏。
//
// 场景刻意极简：一块位移网格 + 一片水面 + 若干名牌。没有 Sky shader、没有环境
// 贴图、没有 HDR、没有后处理。水的意义是**可读性**（让海平面与「有毒」看得见），
// 不是炫技。
//
// 性能取向：**按需重绘**，不跑常驻 requestAnimationFrame。Phase 1 没有动画，
// 唯一需要重绘的契机是相机变化或尺寸变化。代价是必须 enableDamping=false
// （阻尼需要连续循环才能收敛）。收益在移动端是实的：读法则时没有 60fps 的
// 持续 GPU 唤醒与发热。

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildTerrain, sampleHeight, spawnPoints, waterLevel, WORLD_LIMITS } from '@momoi/shared/world'
import type { TerrainSpec } from '@momoi/shared/world'
import type { GLSupport } from '../../lib/webgl'

export interface WorldAgent {
  id: string
  name: string
  avatar: string
}

interface WorldCanvasProps {
  spec: TerrainSpec
  agents: WorldAgent[]
  quality: GLSupport
  /** WebGL 上下文丢失时回调（钉钉 WebView 切后台会丢），交由上层切降级视图 */
  onContextLost?: () => void
}

/** 归一化坐标 → 场景坐标的缩放。沙盘边长 terrainSize，半边长即此值。 */
const S = WORLD_LIMITS.terrainSize / 2
/** 归一化高度 → 场景高度 */
const Y_SCALE = S * WORLD_LIMITS.heightScale

const SKY_COLOR: Record<string, string> = {
  day: '#9dc4e8',
  dusk: '#8a6a7a',
  night: '#0d1424',
  eternal_night: '#06080f',
  blood: '#3a1417',
  void: '#050508',
}

export function WorldCanvas({ spec, agents, quality, onContextLost }: WorldCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const onContextLostRef = useRef(onContextLost)
  onContextLostRef.current = onContextLost

  // 分段数只影响渲染精度，不影响地形本身（同一 heightAt 采样）。
  // 96 是拐点：约 3.7 万顶点、总采样耗时 10~30ms；再往上收益在典型相机距离下
  // 看不出来，代价却是手机上 100~200ms 的主线程阻塞。
  const segments = useMemo(() => {
    if (quality === 'software') return WORLD_LIMITS.segmentsSoftware
    const mobile = typeof window !== 'undefined' && window.innerWidth < 768
    return mobile ? WORLD_LIMITS.segmentsMobile : WORLD_LIMITS.segmentsDesktop
  }, [quality])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const bg = new THREE.Color(SKY_COLOR[spec.sky.preset] ?? SKY_COLOR.day)
    const scene = new THREE.Scene()
    scene.background = bg
    if (spec.sky.fog && spec.sky.fog > 0) {
      scene.fog = new THREE.Fog(bg.getHex(), S * 0.8, S * 2.6)
    }

    const camera = new THREE.PerspectiveCamera(50, 1, 0.5, S * 8)
    camera.position.set(0, S * 0.95, S * 1.2)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: quality === 'webgl2', powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'software' ? 1 : 2))
    host.appendChild(renderer.domElement)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    // ⚠️ 必需：没有它浏览器会滚动/缩放**页面**而不是把触摸事件喂给画布。
    // 这是 WebGL 视图最常见的触屏 bug，在这里尤甚 —— 画布位于 app 的主滚动区内。
    renderer.domElement.style.touchAction = 'none'
    renderer.domElement.oncontextmenu = () => false

    // ---- 地形网格 ----
    const data = buildTerrain(spec, { segments })
    const geo = new THREE.PlaneGeometry(2 * S, 2 * S, segments, segments)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(pos.count * 3)
    const color = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, data.heights[i] * Y_SCALE)
      // 顶点色而非贴图/自定义 shader：buildTerrain 已经返回逐顶点群系下标，
      // 顶点色是白捡的。setStyle 会做 sRGB→线性转换，正是顶点色所需的色彩空间。
      color.setStyle(spec.biomes[data.biomes[i]]?.color ?? '#7d7a73')
      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 })
    const terrain = new THREE.Mesh(geo, terrainMat)
    scene.add(terrain)

    // ---- 有限沙盘的「厚度」：让边界看起来是一块被切出来的地，而不是无限延伸的地面 ----
    let minY = Infinity
    for (let i = 0; i < data.heights.length; i++) minY = Math.min(minY, data.heights[i] * Y_SCALE)
    const slabGeo = new THREE.BoxGeometry(2 * S, Math.max(4, Math.abs(minY) * 0.5), 2 * S)
    const slabMat = new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 1, metalness: 0 })
    const slab = new THREE.Mesh(slabGeo, slabMat)
    slab.position.y = minY - slabGeo.parameters.height / 2
    scene.add(slab)

    // ---- 水面 ----
    let waterGeo: THREE.BufferGeometry | null = null
    let waterMat: THREE.Material | null = null
    if (spec.terrain.water !== 'none') {
      const toxic = spec.terrain.water === 'toxic'
      waterGeo = new THREE.PlaneGeometry(2 * S, 2 * S, 1, 1)
      waterGeo.rotateX(-Math.PI / 2)
      waterMat = new THREE.MeshStandardMaterial({
        color: toxic ? '#7fa03a' : '#2a6a9a',
        transparent: true,
        opacity: toxic ? 0.82 : 0.72,
        roughness: 0.15,
        metalness: 0.1,
        side: THREE.DoubleSide,
      })
      const water = new THREE.Mesh(waterGeo, waterMat)
      water.position.y = waterLevel(spec) * Y_SCALE
      scene.add(water)
    }

    // ---- 光 ----
    const dark = spec.sky.preset === 'eternal_night' || spec.sky.preset === 'void'
    scene.add(new THREE.HemisphereLight(bg.getHex(), 0x2b2620, dark ? 0.35 : 0.9))
    const sun = new THREE.DirectionalLight(0xffffff, dark ? 0.18 : 1.05)
    sun.position.set(S * 0.6, S * 1.2, S * 0.4)
    scene.add(sun)

    // ---- Agent 名牌（Phase 1 仅展示，不交互）----
    const markerDisposables: Array<{ dispose: () => void }> = []
    const markers = spawnPoints(spec, agents.map((a) => a.id))
    for (const point of markers) {
      const agent = agents.find((a) => a.id === point.id)
      if (!agent) continue
      const x = point.x * S
      const z = point.z * S
      const y = sampleHeight(spec, point.x, point.z) * Y_SCALE

      // 底座小柱：让名牌不至于悬浮
      const pinGeo = new THREE.CylinderGeometry(1.6, 1.6, S * 0.06, 10)
      const pinMat = new THREE.MeshStandardMaterial({ color: '#f0e6d2', roughness: 0.6, metalness: 0.1 })
      const pin = new THREE.Mesh(pinGeo, pinMat)
      pin.position.set(x, y + S * 0.03, z)
      scene.add(pin)
      markerDisposables.push(pinGeo, pinMat)

      const label = makeLabelSprite(agent)
      label.sprite.position.set(x, y + S * 0.085, z)
      scene.add(label.sprite)
      markerDisposables.push(label.sprite.material, label.texture)
    }

    // ---- 相机控制：只旋转 + 缩放，不平移 ----
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableRotate = true
    controls.enableZoom = true
    controls.enablePan = false // ← 需求本身：只要旋转与缩放
    controls.enableDamping = false // ← 按需渲染策略的前提（阻尼需要连续循环）
    controls.rotateSpeed = 0.7
    controls.zoomSpeed = 0.8
    controls.minDistance = S * 0.5
    controls.maxDistance = S * 2.8
    controls.minPolarAngle = THREE.MathUtils.degToRad(12) // 绝不降到地平面以下
    controls.maxPolarAngle = THREE.MathUtils.degToRad(78) // 保留可读的俯角
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: null, RIGHT: null }
    // 双指既是捏合缩放、也是扭转旋转；单指滑动旋转。这正是需求描述的手势。
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE }
    controls.target.set(0, 0, 0)
    // 不调 listenToKeyEvents：键盘平移/缩放不是要的能力

    // ---- 尺寸与渲染循环 ----
    const resize = () => {
      const w = host.clientWidth || 1
      const h = host.clientHeight || 1
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
      render()
    }
    function render() {
      controls.update()
      renderer.render(scene, camera)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    controls.addEventListener('change', render)
    resize()

    // 上下文丢失：钉钉 Android WebView 切后台时会丢，冻结成黑屏不如切降级视图
    const onLost = (e: Event) => {
      e.preventDefault()
      onContextLostRef.current?.()
    }
    renderer.domElement.addEventListener('webglcontextlost', onLost)

    // ---- 拆卸：WebGL 代码就是在这里泄漏的，必须逐项 dispose ----
    return () => {
      ro.disconnect()
      controls.removeEventListener('change', render)
      controls.dispose()
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      for (const d of markerDisposables) d.dispose()
      geo.dispose()
      terrainMat.dispose()
      slabGeo.dispose()
      slabMat.dispose()
      waterGeo?.dispose()
      waterMat?.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement)
    }
  }, [spec, agents, quality, segments])

  return <div ref={hostRef} className="absolute inset-0" />
}

/**
 * 生成一张名牌精灵：圆底 + 名字，有头像时把头像裁进圆里。
 * 用 CanvasTexture 而非图片加载流程（头像本身也是 data URL，异步重绘即可）。
 */
function makeLabelSprite(agent: WorldAgent): { sprite: THREE.Sprite; texture: THREE.CanvasTexture } {
  const W = 256
  const H = 96
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  const draw = (avatar: HTMLImageElement | null) => {
    ctx.clearRect(0, 0, W, H)
    // 圆底
    ctx.beginPath()
    ctx.arc(48, H / 2, 34, 0, Math.PI * 2)
    ctx.fillStyle = avatar ? '#f0e6d2' : '#6f9e52'
    ctx.fill()
    if (avatar) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(48, H / 2, 32, 0, Math.PI * 2)
      ctx.clip()
      ctx.drawImage(avatar, 48 - 32, H / 2 - 32, 64, 64)
      ctx.restore()
    } else {
      ctx.fillStyle = '#22301c'
      ctx.font = 'bold 34px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(agent.name.slice(0, 1), 48, H / 2 + 2)
    }
    // 名字
    ctx.font = 'bold 30px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const text = agent.name.slice(0, 8)
    const w = ctx.measureText(text).width
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    roundRect(ctx, 90, H / 2 - 22, w + 20, 44, 10)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(text, 100, H / 2 + 1)
  }

  draw(null)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(S * 0.22, S * 0.22 * (H / W), 1)

  if (agent.avatar) {
    const img = new Image()
    img.onload = () => {
      draw(img)
      texture.needsUpdate = true
    }
    img.src = agent.avatar
  }

  return { sprite, texture }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
