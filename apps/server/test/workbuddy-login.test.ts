// ============================================================
// WorkBuddy 登录状态机：二维码阶段
// ============================================================
//
// 面板的按钮与回退链接由服务端下发的 qr_state 驱动：
//   loading     → 按钮保持「正在启动登录浏览器」，不显示任何外链
//   ready       → 展示二维码，按钮变为「刷新二维码」
//   unavailable → 才下发 auth_url，面板提供「在浏览器中打开登录页」最终回退
//
// 这里 mock 掉浏览器截获与凭证存储，只验证状态机的对外契约。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const qr = vi.hoisted(() => ({ open: vi.fn() }))
const store = vi.hoisted(() => ({ cred: null as any }))

vi.mock('../src/ai/workbuddy/wechat-qr.js', () => ({ openWechatQrLogin: qr.open }))
vi.mock('../src/ai/workbuddy/credentials.js', () => ({
  readCredential: async () => store.cred,
  writeCredential: async (credential: any) => {
    store.cred = credential
  },
  clearCredential: async () => {
    store.cred = null
  },
}))

// 配置在模块导入时读取环境变量——必须在动态 import 之前设置
process.env.WORKBUDDY_LOGIN_POLL_MS = '10'

const manager = await import('../src/ai/workbuddy/token-manager.js')

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('waitFor timeout')
}

beforeEach(() => {
  store.cred = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/v2/plugin/auth/state')) {
        return json({ code: 0, data: { state: 'state-mock', authUrl: 'https://www.workbuddy.cn/login?state=state-mock' } })
      }
      // 换票端点：始终 pending，登录会话不会自行结束
      return json({ code: 11217, msg: 'pending' })
    }),
  )
})

afterEach(async () => {
  await manager.logout()
  qr.open.mockReset()
  vi.unstubAllGlobals()
})

describe('token-manager — 登录二维码阶段', () => {
  it('二维码就绪前 qr_state=loading；就绪后 ready，且不下发登录页地址', async () => {
    let release!: (value: unknown) => void
    qr.open.mockReturnValue(new Promise((resolve) => {
      release = resolve
    }))

    await manager.beginLogin()

    const loading = await manager.getLoginStatus()
    expect(loading.status).toBe('pending')
    expect(loading.qr_state).toBe('loading')
    expect(loading.qr_data_url).toBeUndefined()
    // 正常流程不提供任何外链：只有确认拿不到二维码才回退
    expect(loading.auth_url).toBeUndefined()

    release({ getQr: () => 'data:image/jpeg;base64,qq==', getStatus: () => 'new', close: async () => {} })
    await waitFor(async () => (await manager.getLoginStatus()).qr_state === 'ready')

    const ready = await manager.getLoginStatus()
    expect(ready.qr_state).toBe('ready')
    expect(ready.qr_data_url).toBe('data:image/jpeg;base64,qq==')
    expect(ready.auth_url).toBeUndefined()
  })

  it('二维码捕获失败时 qr_state=unavailable，并下发登录页地址作为最终回退', async () => {
    qr.open.mockResolvedValue(null)
    await manager.beginLogin()

    await waitFor(async () => (await manager.getLoginStatus()).qr_state === 'unavailable')
    const status = await manager.getLoginStatus()
    expect(status.status).toBe('pending')
    expect(status.qr_state).toBe('unavailable')
    expect(status.qr_data_url).toBeUndefined()
    expect(status.auth_url).toBe('https://www.workbuddy.cn/login?state=state-mock')
  })
})
