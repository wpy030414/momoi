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


describe('wechat-qr — 登录页微信二维码（纯 HTTP 链路）', () => {
  const TINY_BYTES = Buffer.from('mock-jpeg-bytes')
  const AUTH_URL = 'https://www.workbuddy.cn/login?platform=workbuddy&state=x'
  const QRCONNECT =
    'https://open.weixin.qq.com/connect/qrconnect?scope=snsapi_login' +
    '&appid=wx31d4d71eb5f8c69e&state=wx-state&login_type=jssdk'

  /** 按 URL 分派的假 fetch；overrides 可替换某一跳的行为 */
  function stubFetch(overrides: Record<string, (url: string) => Response | Promise<Response>> = {}) {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        calls.push(url)
        for (const [marker, handler] of Object.entries(overrides)) {
          if (url.includes(marker)) return handler(url)
        }
        if (url.includes('/protocol/openid-connect/auth')) {
          return new Response('', {
            status: 200,
            headers: [['set-cookie', 'AUTH_SESSION_ID=sess-1; Path=/'], ['set-cookie', 'KC_RESTART=restart-1; Path=/']],
          })
        }
        if (url.includes('/console/auth/wechat-url')) return Response.json({ url: QRCONNECT })
        if (url.includes('open.weixin.qq.com/connect/qrconnect')) {
          return new Response('<img src="https://open.weixin.qq.com/connect/qrcode/abc123XYZ">', { status: 200 })
        }
        if (url.includes('/connect/qrcode/')) {
          return new Response(TINY_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } })
        }
        if (url.includes('/connect/l/qrconnect')) {
          return new Response('window.wx_errcode=408;window.wx_code=\'\';', { status: 200 })
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
    return calls
  }

  it('全链路纯 HTTP：建会话 → 取授权地址 → 提取 uuid → 下载二维码', async () => {
    const calls = stubFetch()
    const session = await wechatQr.openWechatQrLogin(AUTH_URL, { timeoutMs: 1000 })

    expect(session.getQr()).toBe(`data:image/jpeg;base64,${TINY_BYTES.toString('base64')}`)
    expect(session.getQrSourceUrl()).toBe('https://open.weixin.qq.com/connect/qrcode/abc123XYZ')
    expect(session.getStatus()).toBe('new')
    // 会话 Cookie 必须带上，否则 wechat-url 返回 502
    const wechatCall = calls.findIndex((u) => u.includes('/console/auth/wechat-url'))
    expect(wechatCall).toBeGreaterThan(0)
    await session.close()
  })

  it('扫码状态轮询映射：408 → new、404 → scanned、405 → confirmed', async () => {
    stubFetch({
      '/connect/l/qrconnect': () => new Response('window.wx_errcode=404;window.wx_code=\'\';'),
    })
    const session = await wechatQr.openWechatQrLogin(AUTH_URL, { timeoutMs: 1000 })
    expect(await session.pollScan()).toBe('scanned')

    stubFetch({
      '/connect/l/qrconnect': () => new Response('window.wx_errcode=405;window.wx_code=\'abc\';'),
    })
    const confirmed = await wechatQr.openWechatQrLogin(AUTH_URL, { timeoutMs: 1000 })
    expect(await confirmed.pollScan()).toBe('confirmed')
  })

  it('二维码失效（402）标记 isExpired，供面板提示刷新', async () => {
    stubFetch({
      '/connect/l/qrconnect': () => new Response('window.wx_errcode=402;window.wx_code=\'\';'),
    })
    const session = await wechatQr.openWechatQrLogin(AUTH_URL, { timeoutMs: 1000 })
    await session.pollScan()
    expect(session.isExpired()).toBe(true)
  })

  it('网络抖动时保持上一次状态，不抛错', async () => {
    stubFetch({
      '/connect/l/qrconnect': () => {
        throw new Error('ECONNRESET')
      },
    })
    const session = await wechatQr.openWechatQrLogin(AUTH_URL, { timeoutMs: 1000 })
    expect(await session.pollScan()).toBe('new')
    expect(session.isExpired()).toBe(false)
  })

  it('wechat-url 未返回地址时抛错，交由上层回退为复制登录页链接', async () => {
    stubFetch({
      '/console/auth/wechat-url': () => new Response(JSON.stringify({ message: 'failed to create wechat authorization url' }), { status: 502 }),
    })
    await expect(wechatQr.openWechatQrLogin(AUTH_URL, { timeoutMs: 1000 })).rejects.toThrow(/failed to create wechat authorization url/)
  })

  it('二维码图片始终从 open.weixin.qq.com 拉取，不跟随页面里的第三方地址', async () => {
    const calls = stubFetch({
      'open.weixin.qq.com/connect/qrconnect': () =>
        new Response('<img src="https://evil.example.com/connect/qrcode/abc123XYZ">', { status: 200 }),
    })
    const session = await wechatQr.openWechatQrLogin(AUTH_URL, { timeoutMs: 1000 })
    expect(session.getQrSourceUrl()).toBe('https://open.weixin.qq.com/connect/qrcode/abc123XYZ')
    expect(calls.some((u) => u.includes('evil.example.com'))).toBe(false)
  })

  it('qrconnect 页面不含 uuid 时抛错', async () => {
    stubFetch({
      'open.weixin.qq.com/connect/qrconnect': () => new Response('<html>no qr here</html>', { status: 200 }),
    })
    await expect(wechatQr.openWechatQrLogin(AUTH_URL, { timeoutMs: 1000 })).rejects.toThrow(/未包含二维码标识/)
  })

  it('qrconnect 地址指向非微信域名时直接拒绝', async () => {
    stubFetch({
      '/console/auth/wechat-url': () => Response.json({ url: 'https://evil.example.com/connect/qrconnect' }),
    })
    await expect(wechatQr.openWechatQrLogin(AUTH_URL, { timeoutMs: 1000 })).rejects.toThrow(/不在允许的来源内/)
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
