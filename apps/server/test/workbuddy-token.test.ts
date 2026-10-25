// ============================================================
// WorkBuddy 凭证与轮换的门禁测试
// ============================================================
//
// 覆盖三件必须成立的事：
//   1. 凭证落库是密文（表里搜不到 token 明文），读回后内容一致；
//   2. access token 临近/已过期时用 refresh token 续期，且轮换后的
//      refresh token 立即写回（否则进程重启就拿着已失效的旧票）；
//   3. 无凭证时给出可读的「未登录」提示，而不是抛上游错误。
//
// 与 auth-ban 测试同构：真实 temp node:sqlite（initSqlite 注入口）+ mock 掉
// db/index.js，避免顶层 await 建开发库；fetch 用 stubGlobal 拦截。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const h = vi.hoisted(() => ({
  mod: {} as Record<string, unknown>,
}))

vi.mock('../src/db/index.js', () =>
  new Proxy(
    {},
    {
      get: (_t, prop: string) => h.mod[prop],
      has: (_t, prop: string) => prop in h.mod,
    },
  ),
)

let dbPath = ''

beforeAll(async () => {
  dbPath = join(tmpdir(), `momoi_wb_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)
  const { initSqlite } = await import('../src/db/sqlite.js')
  const { db, schema } = await initSqlite(dbPath)
  Object.assign(h.mod, { db, ...schema })
})

afterAll(() => {
  try { rmSync(dbPath, { force: true }) } catch { /* Windows 句柄锁 */ }
})

const store = await import('../src/ai/workbuddy/credentials.js')
const manager = await import('../src/ai/workbuddy/token-manager.js')
const wechatQr = await import('../src/ai/workbuddy/wechat-qr.js')

function credential(overrides: Partial<Parameters<typeof store.writeCredential>[0]> = {}) {
  return {
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    uid: 'u-1',
    domain: 'www.workbuddy.cn',
    nickname: '训练员',
    expiresAt: Date.now() - 60_000,
    refreshExpiresAt: Date.now() + 30 * 24 * 3600_000,
    savedAt: Date.now(),
    ...overrides,
  }
}

beforeEach(async () => {
  await manager.logout()
})

afterEach(() => {
  vi.unstubAllGlobals()
})


describe('wechat-qr — 登录页微信二维码捕获', () => {
  const TINY_BYTES = Buffer.from('mock-jpeg-bytes')

  function fakeBrowser(emitQr: boolean) {
    const state = { closed: false }
    let handler: ((res: any) => unknown) | null = null
    const context = {
      on: (event: string, h: (res: any) => unknown) => {
        if (event === 'response') handler = h
      },
      newPage: async () => ({
        goto: async () => {
          if (!emitQr) return
          handler?.({
            url: () => 'https://open.weixin.qq.com/connect/qrcode/mock',
            headers: () => ({ 'content-type': 'image/jpeg' }),
            body: async () => TINY_BYTES,
          })
          // 微信扫码长轮询：404 = 已扫码待确认
          handler?.({
            url: () => 'https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=mock',
            headers: () => ({ 'content-type': 'text/plain' }),
            text: async () => 'window.wx_errcode=404;',
          })
          await new Promise((r) => setTimeout(r, 10))
        },
      }),
    }
    const browser = {
      newContext: async () => context,
      close: async () => {
        state.closed = true
      },
    }
    return { browser, state }
  }

  it('截获微信二维码图片并转成 data URL，close 关闭浏览器', async () => {
    const fake = fakeBrowser(true)
    const session = await wechatQr.openWechatQrLogin('https://www.workbuddy.cn/login?state=x', {
      launchBrowser: async () => fake.browser as never,
      timeoutMs: 500,
    })
    expect(session).not.toBeNull()
    expect(session!.getQr()).toBe(`data:image/jpeg;base64,${TINY_BYTES.toString('base64')}`)
    expect(session!.getStatus()).toBe('scanned')
    await session!.close()
    expect(fake.state.closed).toBe(true)
  })

  it('浏览器未产出二维码时超时返回 null，并关闭浏览器', async () => {
    const fake = fakeBrowser(false)
    const session = await wechatQr.openWechatQrLogin('https://www.workbuddy.cn/login?state=x', {
      launchBrowser: async () => fake.browser as never,
      timeoutMs: 30,
    })
    expect(session).toBeNull()
    expect(fake.state.closed).toBe(true)
  })
})

describe('credentials — 加密落库', () => {
  it('落库是密文信封，读取可完整还原', async () => {
    await store.writeCredential(credential())

    const raw = await h.mod.db.select().from(h.mod.settings).where((await import('drizzle-orm')).eq(h.mod.settings.key, 'workbuddy_credential')).get()
    expect(raw.value.startsWith('aesgcm:v1:')).toBe(true)
    expect(raw.value).not.toContain('access-old')
    expect(raw.value).not.toContain('refresh-old')

    const back = await store.readCredential()
    expect(back?.accessToken).toBe('access-old')
    expect(back?.refreshToken).toBe('refresh-old')
    expect(back?.uid).toBe('u-1')
  })

  it('clearCredential 之后读回 null', async () => {
    await store.writeCredential(credential())
    await store.clearCredential()
    expect(await store.readCredential()).toBeNull()
  })
})

describe('token-manager — 轮换', () => {
  it('凭证已过期时续期，并把轮换后的 refresh token 写回', async () => {
    await store.writeCredential(credential())

    const seen: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      seen.push({ url: String(url), headers: init.headers })
      return new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    const got = await manager.getAccessToken()
    expect(got.accessToken).toBe('access-new')

    // 请求用旧 refresh token 发出，且发到续期端点
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toContain('/v2/plugin/auth/token/refresh')
    expect(seen[0].headers['X-Refresh-Token']).toBe('refresh-old')

    // 轮换结果立即持久化（进程重启也不会拿旧票）
    const persisted = await store.readCredential()
    expect(persisted?.accessToken).toBe('access-new')
    expect(persisted?.refreshToken).toBe('refresh-new')
  })

  it('有效凭证命中缓存，不发起网络请求', async () => {
    await store.writeCredential(credential({ expiresAt: Date.now() + 3600_000 }))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const got = await manager.getAccessToken()
    expect(got.accessToken).toBe('access-old')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('无凭证时抛出可读的未登录提示', async () => {
    expect(await manager.getStatus()).toEqual({ logged_in: false, auto_refresh: true })
    await expect(manager.getAccessToken()).rejects.toThrow(/未登录/)
  })
})
