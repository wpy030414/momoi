// ============================================================
// OrbitControls 渲染循环守卫
// ============================================================
// 运行：pnpm --filter @momoi/web orbit-guard
//
// 钉死一个非常隐蔽、且只在**真正拖动时**才爆的陷阱：
//
//   OrbitControls 的 update() 在**派发 change 事件之后**才记录 _lastPosition
//   （源码顺序：this.dispatchEvent(_changeEvent) → this._lastPosition.copy(...)）。
//   因此若把 update() 放进 change 监听器（「渲染函数里顺手 update 一下」），
//   重入的那次看到的是**尚未更新**的 _lastPosition，判定「相机又动了」→ 再派发
//   → 再调 update() → 无限递归：
//       RangeError: Maximum call stack size exceeded
//   现象是「一拖动/一缩放就报错，且完全拖不动」。
//
// 正确写法：change 监听器**只负责画**；update() 由输入的各个处理器自己调用
// （旋转/缩放/平移分支末尾），应用侧只需在初始化时显式调一次。
//
// 本测试用 DOM 存根直接驱动真实的 OrbitControls，两种写法各跑一遍 ——
// 前一种必须复现 RangeError，后一种必须恰好渲染一次。若将来 three 改了
// update() 的内部顺序（使这个陷阱消失），本测试会失败并提醒重新评估。

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

// OrbitControls.connect 只用得到这几样（see OrbitControls.js connect()）
function makeStubElement() {
  const noop = () => {}
  return {
    addEventListener: noop,
    removeEventListener: noop,
    style: {},
    clientWidth: 800,
    clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getRootNode: () => ({ addEventListener: noop, removeEventListener: noop }),
    ownerDocument: { addEventListener: noop, removeEventListener: noop },
    setPointerCapture: noop,
    releasePointerCapture: noop,
  }
}

function makeControls() {
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 1000)
  camera.position.set(0, 120, 160)
  camera.lookAt(0, 0, 0)
  const controls = new OrbitControls(camera, makeStubElement())
  controls.enableDamping = false
  controls.update() // 初始化 _lastPosition
  return controls
}

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    fail++
    console.log(`  ❌ ${label}  ${detail}`)
  }
}

console.log('【1】反面：change 监听器里调 update() —— 必须复现无限递归')
{
  const controls = makeControls()
  let depth = 0
  let maxDepth = 0
  let err = null
  controls.addEventListener('change', function onchange() {
    depth++
    maxDepth = Math.max(maxDepth, depth)
    try {
      controls.update() // ← 曾经的错误写法
    } finally {
      depth--
    }
  })
  try {
    controls.rotateLeft(0.2)
    controls.update() // 模拟输入处理器调用
  } catch (e) {
    err = e
  }
  check(
    '复现 RangeError（证明该陷阱真实存在）',
    err instanceof RangeError && /call stack/i.test(err.message),
    err ? `${err.constructor.name}: ${err.message}` : '未抛错——陷阱可能已消失，需重新评估',
  )
  check('递归深度确实失控（> 100 层）', maxDepth > 100, `maxDepth=${maxDepth}`)
}

console.log('\n【2】正面：change 监听器只负责渲染 —— 必须恰好一次且不递归')
{
  const controls = makeControls()
  let renders = 0
  controls.addEventListener('change', () => {
    renders++
  })
  controls.rotateLeft(0.2)
  controls.update() // 旋转后由更新驱动一次
  const afterRotate = renders
  check('一次相机变化触发一次渲染', afterRotate === 1, `renders=${renders}`)
  controls.update() // 没有新变化，不应再触发
  check('无变化的 update 不触发多余渲染', renders === 1, `renders=${renders}`)
}

console.log('\n【3】缩放路径同样只触发一次')
{
  const controls = makeControls()
  let renders = 0
  controls.addEventListener('change', () => {
    renders++
  })
  controls.dollyIn(1.1)
  controls.update()
  check('一次缩放触发一次渲染', renders === 1, `renders=${renders}`)
}

console.log(`\n${'='.repeat(52)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(52)}`)
process.exit(fail > 0 ? 1 : 0)
