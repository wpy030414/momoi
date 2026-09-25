// ============================================================
// WorldFallback — 无 WebGL2 时的二维俯视地图
// ============================================================
// ⚠️ 这不是「道歉页」，而是一个**真正有用**的产物：它就是一张地图。
//    钉钉 Android 内置内核是首要部署目标，而它可能没有可用的 WebGL2
//    （three 自 r163 起只支持 WebGL2），所以对这个功能而言，二维降级不是
//    退路，它可能是多数用户唯一的渲染路径 —— 必须先建、先验。
//
// 与三维视图消费**完全相同的 buildTerrain 产物**，所以两者不会各说各话。

import { useEffect, useMemo, useRef } from 'react'
import { buildTerrain, spawnPoints, waterLevel } from '@momoi/shared/world'
import type { TerrainSpec } from '@momoi/shared/world'
import type { WorldAgent } from './WorldCanvas'

interface WorldFallbackProps {
  spec: TerrainSpec
  agents: WorldAgent[]
}

/** 俯视地图的边长（像素）。256² 采样一次约 10ms，肉眼已足够细腻。 */
const MAP_SIZE = 256
const MAP_SEGMENTS = 255

export function WorldFallback({ spec, agents }: WorldFallbackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const markers = useMemo(() => spawnPoints(spec, agents.map((a) => a.id)), [spec, agents])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 用较小的采样密度建网格，再放大到地图尺寸绘制（避免 256² 顶点的插值开销）
    const data = buildTerrain(spec, { segments: MAP_SEGMENTS })
    const size = MAP_SEGMENTS + 1
    const level = waterLevel(spec)
    const img = ctx.createImageData(MAP_SIZE, MAP_SIZE)
    const colors = spec.biomes.map((b) => hexToRgb(b.color))

    for (let py = 0; py < MAP_SIZE; py++) {
      for (let px = 0; px < MAP_SIZE; px++) {
        const k = Math.min(size * size - 1, Math.round(py * size + px))
        const h = data.heights[k]
        const idx = py * MAP_SIZE + px
        let [r, g, b] = colors[data.biomes[k]] ?? [125, 122, 115]
        if (h <= level) {
          // 水体：按水深压暗并偏蓝，让地形起伏在平面图上也读得出来
          const depth = Math.min(1, (level - h) / Math.max(1e-6, Math.abs(level) + 0.3))
          r = Math.round(r * (1 - depth) + 30 * depth * 0.4)
          g = Math.round(g * (1 - depth) + 90 * depth * 0.4)
          b = Math.round(b * (1 - depth) + 150 * depth * 0.4)
        } else {
          // 陆地：用高度做明暗浮雕，读得出山脊与谷地
          const shade = 0.75 + 0.5 * Math.min(1, Math.max(0, h * 1.4 + 0.4))
          r = Math.min(255, Math.round(r * shade))
          g = Math.min(255, Math.round(g * shade))
          b = Math.min(255, Math.round(b * shade))
        }
        img.data[idx * 4] = r
        img.data[idx * 4 + 1] = g
        img.data[idx * 4 + 2] = b
        img.data[idx * 4 + 3] = 255
      }
    }

    ctx.putImageData(img, 0, 0)

    // Agent 落点：归一化坐标 [-1,1] → 像素
    for (const point of markers) {
      const agent = agents.find((a) => a.id === point.id)
      if (!agent) continue
      const px = (point.x + 1) / 2 * MAP_SIZE
      const py = (point.z + 1) / 2 * MAP_SIZE
      ctx.beginPath()
      ctx.arc(px, py, 5, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#1a1a1a'
      ctx.stroke()
      ctx.font = 'bold 11px sans-serif'
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = 'rgba(0,0,0,0.75)'
      ctx.lineWidth = 3
      ctx.strokeText(agent.name, px + 8, py + 4)
      ctx.fillText(agent.name, px + 8, py + 4)
    }
  }, [spec, agents, markers])

  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-hidden p-4">
      <div className="w-full max-w-[min(70vh,560px)]">
        <canvas
          ref={canvasRef}
          width={MAP_SIZE}
          height={MAP_SIZE}
          className="w-full rounded-lg border border-border shadow-lg"
          style={{ imageRendering: 'auto', aspectRatio: '1 / 1' }}
        />
      </div>
    </div>
  )
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [125, 122, 115]
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}
