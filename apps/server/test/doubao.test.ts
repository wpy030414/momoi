// ============================================================
// Doubao（豆包网页）上游门禁测试
// ============================================================
//
// 覆盖四件必须成立的事：
//   1. 扫码登录状态机：二维码 → new → scanned → confirmed → 会话 Cookie 与账号；
//   2. 凭证落库是密文（表里搜不到 sessionid 明文），读取可完整还原；
//   3. 对话适配：文本/思考增量、usage、关闭思考、主端点失败回退 /samantha；
//   4. 错误映射：登录失效 / 风控分别给出可读提示，风控标记可由管理端清除。
//
// fetch 用 stubGlobal 转发给一个进程内 Hono mock（真实 Headers / Set-Cookie
// 语义）；DB 用 temp node:sqlite + mock db/index.js，避免污染开发库。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'

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

// 配置在模块导入时读取环境变量——必须在动态 import 之前设置
process.env.DOUBAO_BASE_URL = 'https://doubao.test'
process.env.DOUBAO_AUTH_BASE_URL = 'https://doubao.test'
process.env.DOUBAO_LOGIN_POLL_MS = '10'
process.env.DOUBAO_LOGIN_TIMEOUT_MS = '5000'
// 测试环境不拉起 Playwright：用纯 HTTP 豆包扫码链路验证登录状态机
process.env.DOUBAO_LOGIN_FLOW = 'doubao'

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII='

type ChatBehavior = 'ok' | 'legacyOnly' | 'http401' | 'risk' | 'thinkingBlock'

interface MockState {
  qrPolls: number
  accountChecks: number
  chatBehavior: ChatBehavior
  chatRequests: Array<{ url: string; cookie: string; body: Record<string, any> }>
  legacyRequests: Array<{ url: string; cookie: string; body: Record<string, any> }>
  uploadRequests: Array<{ kind: 'prepare' | 'apply' | 'commit' | 'tos' | 'preHandle'; body?: any; headers?: Record<string, string>; url: string }>
  cleanupRequests: Array<{ body: any; contentType: string }>
}

function createMockApp() {
  const state: MockState = {
    qrPolls: 0,
    accountChecks: 0,
    chatBehavior: 'ok',
    chatRequests: [],
    legacyRequests: [],
    uploadRequests: [],
    cleanupRequests: [],
  }
  const app = new Hono()

  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } })

  const sse = (events: string[]) => {
    const enc = new TextEncoder()
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const ev of events) controller.enqueue(enc.encode(ev))
          controller.close()
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    )
  }

  app.get('/', () => {
    const res = new Response(null, { status: 302, headers: { Location: '/chat/' } })
    res.headers.append('Set-Cookie', 'ttwid=mock-ttwid; Path=/; HttpOnly')
    return res
  })
  app.get('/chat/', (c) => c.html('<html><body>mock chat</body></html>'))

  app.get('/passport/safe/csrf_token/', () =>
    json({ data: { passport_csrf_token: 'mock-csrf' }, message: 'success' }, 200, {
      'Set-Cookie': 'passport_csrf_token=mock-csrf; Path=/',
    }),
  )

  app.get('/passport/web/get_qrcode/', (c) => {
    if (c.req.query('aid') !== '497858') {
      return json({ data: { error_code: 1, description: 'bad aid' }, message: 'error' })
    }
    return json({
      data: {
        error_code: 0,
        token: 'mock-qr-token',
        qrcode: `data:image/png;base64,${TINY_PNG_BASE64}`,
        expire_time: Math.floor(Date.now() / 1000) + 120,
      },
      message: 'success',
    })
  })

  app.get('/passport/web/check_qrconnect/', () => {
    state.qrPolls += 1
    if (state.qrPolls === 1) return json({ data: { error_code: 0, status: 'new' }, message: 'success' })
    if (state.qrPolls === 2) return json({ data: { error_code: 0, status: 'scanned' }, message: 'success' })
    return json({
      data: { error_code: 0, status: 'confirmed', redirect_url: '/passport/web/web_login_success' },
      message: 'success',
    })
  })

  app.get('/passport/web/web_login_success', () => {
    const res = new Response(null, { status: 302, headers: { Location: '/chat/' } })
    res.headers.append('Set-Cookie', 'sessionid=mock-session; Path=/; HttpOnly')
    res.headers.append('Set-Cookie', 'uid_tt=12345; Path=/')
    return res
  })

  app.get('/passport/account/info/v2/', (c) => {
    state.accountChecks += 1
    if ((c.req.header('cookie') || '').includes('sessionid=mock-session')) {
      const res = json({ data: { user_id: 12345, user_name: '测试用户' }, message: 'success' })
      // 模拟上游在账号请求里轮换设备 Cookie（巡检 / 对话都要吸收）
      res.headers.append('Set-Cookie', `ttwid=rotated-${state.accountChecks}; Path=/`)
      return res
    }
    return json({ data: { error_code: 710012001, description: '登录已过期' }, message: 'error' })
  })

  // ---- ImageX 附件上传（prepare → Apply → TOS → Commit → pre_handle）----
  app.post('/alice/resource/prepare_upload', async (c) => {
    const body = await c.req.json().catch(() => null)
    state.uploadRequests.push({ kind: 'prepare', body, url: c.req.url })
    return json({
      code: 0,
      data: {
        service_id: 'svc-mock',
        upload_host: 'doubao.test',
        upload_auth_token: { access_key: 'ak-mock', secret_key: 'sk-mock', session_token: 'st-mock' },
      },
    })
  })

  app.get('/top/v1', (c) => {
    if (c.req.query('Action') === 'ApplyImageUpload') {
      state.uploadRequests.push({ kind: 'apply', url: c.req.url, headers: c.req.header() })
      return json({
        Result: {
          UploadAddress: {
            StoreInfos: [{ StoreUri: 'tos-cn-i-mock/hash.png', Auth: 'SpaceKey mock', UploadID: 'up-mock' }],
            UploadHosts: ['doubao.test'],
          },
        },
      })
    }
    return json({ msg: 'unknown action' }, 404)
  })

  app.post('/top/v1', async (c) => {
    const body = await c.req.json().catch(() => null)
    state.uploadRequests.push({ kind: 'commit', body, url: c.req.url, headers: c.req.header() })
    return json({
      Result: {
        PluginResult: [{ ImageWidth: 1, ImageHeight: 1, ImageFormat: 'png', ImageSize: 68, ImageMd5: 'mock-md5' }],
      },
    })
  })

  app.post('/upload/v1/*', async (c) => {
    state.uploadRequests.push({ kind: 'tos', url: c.req.url, headers: c.req.header() })
    return json({ code: 2000 })
  })

  app.post('/alice/message/pre_handle_v2_without_conv', async (c) => {
    const body = await c.req.json().catch(() => null)
    state.uploadRequests.push({ kind: 'preHandle', body, url: c.req.url })
    return json({ code: 0, data: { pre_generate_id: 'pre-mock' } })
  })

  // ---- 每轮会话清理 ----
  app.post('/im/conversation/batch_del_user_conv', async (c) => {
    const body = await c.req.json().catch(() => null)
    state.cleanupRequests.push({ body, contentType: c.req.header('content-type') || '' })
    return json({ cmd: 4171, status_code: 0, status_desc: 'OK' })
  })

  app.post('/chat/completion', async (c) => {
    let body: any = null
    try {
      body = await c.req.json()
    } catch {
      body = null
    }
    state.chatRequests.push({ url: c.req.url, cookie: c.req.header('cookie') || '', body })
    if (state.chatBehavior === 'legacyOnly') return json({ code: 404, msg: 'not found' }, 404)
    if (state.chatBehavior === 'http401') return json({ code: 710012001, msg: '登录已过期' }, 401)
    if (state.chatBehavior === 'risk') {
      return sse([
        'event: STREAM_ERROR\n',
        'data: {"error_code":710022004,"error_msg":"rate limited","extra":{"decision":"{\\"type\\":\\"verify\\"}"}}\n\n',
      ])
    }
    if (state.chatBehavior === 'thinkingBlock') {
      // 新协议：10040 携带 thinking_block（步骤标题）→ reasoning；CHUNK_DELTA → 正文
      return sse([
        'event: SSE_ACK\n',
        'data: {"ack_client_meta":{"conversation_id":"conv-thinking"}}\n\n',
        'event: FULL_MSG_NOTIFY\n',
        'data: {"message":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"用户消息回显"}}}]}}\n\n',
        'event: STREAM_MSG_NOTIFY\n',
        'data: {"content":{"content_block":[{"block_type":10040,"content":{"thinking_block":{"finish_title":"步骤一"}}}]}}\n\n',
        'event: STREAM_MSG_NOTIFY\n',
        'data: {"content":{"content_block":[{"block_type":10040,"content":{"thinking_block":{"streaming_title":"步骤二"}}}]}}\n\n',
        'event: STREAM_CHUNK\n',
        'data: {"patch_op":[{"patch_value":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"答案"}}}]}}]}\n\n',
        'event: CHUNK_DELTA\n',
        'data: {"text":"完整"}\n\n',
        'data: {"usage":{"prompt_tokens":5,"completion_tokens":6,"total_tokens":11}}\n\n',
        'event: SSE_REPLY_END\n',
        'data: {"end_type":1}\n\n',
      ])
    }
    const res = sse([
      ': heartbeat\n\n',
      'event: SSE_ACK\n',
      'data: {"ack_client_meta":{"conversation_id":"conv-mock"}}\n\n',
      'event: FULL_MSG_NOTIFY\n',
      'data: {"message":{"content_block":[{"block_type":10000,"content":{"text_block":{"text":"用户消息回显"}}}]}}\n\n',
      'data: {"content_block":[{"block_type":10040,"content":{}}]}\n\n',
      'data: {"content_block":[{"block_type":10000,"content":{"text_block":{"text":"思考中"}}}]}\n\n',
      'data: {"content_block":[{"block_type":10040,"content":{}}]}\n\n',
      'data: {"content_block":[{"block_type":10000,"content":{"text_block":{"text":"你好"}}}]}\n\n',
      'data: {"content_block":[{"block_type":10000,"content":{"text_block":{"text":"，世界"}}}]}\n\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
      'event: SSE_REPLY_END\n',
      'data: {"end_type":1}\n\n',
    ])
    // 模拟上游在对话响应里轮换 Cookie：客户端必须写回凭证
    res.headers.append('Set-Cookie', 'ttwid=chat-rotated; Path=/')
    return res
  })

  app.post('/samantha/chat/completion', async (c) => {
    let body: any = null
    try {
      body = await c.req.json()
    } catch {
      body = null
    }
    state.legacyRequests.push({ url: c.req.url, cookie: c.req.header('cookie') || '', body })
    return sse([
      'event: message\n',
      'data: {"event_type":2001,"event_data":{"message":{"content_type":2008,"content":"{\\"think\\":\\"先想一下\\"}"}}}\n\n',
      'event: message\n',
      'data: {"event_type":2001,"event_data":{"message":{"content_type":2001,"content":"{\\"text\\":\\"回退回答\\"}"}}}\n\n',
      'event: message\n',
      'data: {"event_type":2003,"event_data":{}}\n\n',
    ])
  })

  return { app, state }
}

const mock = createMockApp()

let dbPath = ''

beforeAll(async () => {
  dbPath = join(tmpdir(), `momoi_doubao_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)
  const { initSqlite } = await import('../src/db/sqlite.js')
  const { db, schema } = await initSqlite(dbPath)
  Object.assign(h.mod, { db, ...schema })
})

afterAll(() => {
  try {
    rmSync(dbPath, { force: true })
  } catch {
    /* Windows 句柄锁 */
  }
})

const credentials = await import('../src/ai/doubao/credentials.js')
const sessionModule = await import('../src/ai/doubao/session.js')
const chatModule = await import('../src/ai/doubao/chat.js')
const { DoubaoWebLogin } = await import('../src/ai/doubao/web-login.js')
const { DouyinQrLogin } = await import('../src/ai/doubao/douyin-login.js')
const { generateDeviceIdentity } = await import('../src/ai/doubao/device.js')

function makeSession(overrides: Partial<Parameters<typeof credentials.writeSession>[0]> = {}) {
  return {
    cookies: [
      {
        name: 'sessionid',
        value: 'mock-session',
        domain: 'doubao.test',
        path: '/',
        hostOnly: true,
      },
    ],
    device: generateDeviceIdentity(),
    uid: '12345',
    nickname: '测试用户',
    savedAt: Date.now(),
    ...overrides,
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('waitFor timeout')
}

async function collect(iterable: AsyncGenerator<import('../src/ai/provider.js').StreamEvent>) {
  const events: import('../src/ai/provider.js').StreamEvent[] = []
  for await (const ev of iterable) events.push(ev)
  return events
}

beforeEach(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
    mock.app.request(typeof input === 'string' ? input : input.toString(), init),
  )
  mock.state.qrPolls = 0
  mock.state.accountChecks = 0
  mock.state.chatBehavior = 'ok'
  mock.state.chatRequests = []
  mock.state.legacyRequests = []
  mock.state.uploadRequests = []
  mock.state.cleanupRequests = []
  await sessionModule.logout()
  sessionModule.resetCaptcha()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web-login — 扫码状态机', () => {
  it('new → scanned → confirmed，收集会话 Cookie 与账号信息', async () => {
    const flow = new DoubaoWebLogin({
      baseUrl: 'https://doubao.test',
      authBaseUrl: 'https://doubao.test',
      aid: '497858',
    })
    const qr = await flow.begin()
    expect(qr.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(qr.token).toBe('mock-qr-token')

    expect((await flow.poll()).status).toBe('new')
    expect((await flow.poll()).status).toBe('scanned')
    const confirmed = await flow.poll()
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.session?.uid).toBe('12345')
    expect(confirmed.session?.nickname).toBe('测试用户')
    expect(
      confirmed.session?.cookies.some((c) => c.name === 'sessionid' && c.value === 'mock-session'),
    ).toBe(true)
    // CSRF 与 ttwid 也应在登录过程中被吸收
    expect(confirmed.session?.cookies.some((c) => c.name === 'ttwid')).toBe(true)
  })
})


// ---- 抖音授权链路：用假浏览器验证二维码拦截与会话提取 ----

function createFakeBrowser() {
  const state = {
    cookies: [] as Array<Record<string, unknown>>,
    handlers: [] as Array<(res: any) => unknown>,
    clicks: [] as string[],
    closed: false,
  }

  const emit = async (url: string, body: unknown) => {
    const res = { url: () => url, json: async () => body }
    for (const h of state.handlers) await h(res)
  }

  const locatorFor = (text: string) => {
    const loc = {
      first: () => loc,
      count: async () => 0,
      waitFor: async () => {},
      click: async () => {
        state.clicks.push(text)
        if (text === '抖音一键登录') {
          await emit('https://open.douyin.com/oauth/get_qrcode/?aid=1128', {
            data: { error_code: 0, qrcode: TINY_PNG_BASE64, token: 'douyin-qr-token' },
            message: 'success',
          })
        }
      },
    }
    return loc
  }

  const page = {
    goto: async () => {},
    waitForTimeout: async () => {},
    getByText: (text: string) => locatorFor(text),
    locator: (sel: string) => locatorFor(sel),
  }

  const context = {
    on: (event: string, handler: (res: any) => unknown) => {
      if (event === 'response') state.handlers.push(handler)
    },
    cookies: async () => state.cookies,
    newPage: async () => page,
  }

  const browser = {
    newContext: async () => context,
    close: async () => {
      state.closed = true
    },
  }

  return { browser, state, emit }
}

describe('douyin-login — 抖音官方授权二维码', () => {
  it('拦截授权页二维码，扫码后从浏览器 Cookie 建立会话', async () => {
    const fake = createFakeBrowser()
    const flow = new DouyinQrLogin({
      launchBrowser: async () => fake.browser as unknown as import('playwright-core').Browser,
    })

    const qr = await flow.begin()
    expect(qr.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(qr.token).toBe('douyin-qr-token')
    // 走的是「登录 → 抖音一键登录」链路，而不是豆包自助扫码
    expect(fake.state.clicks).toContain('登录')
    expect(fake.state.clicks).toContain('抖音一键登录')

    await fake.emit('https://open.douyin.com/oauth/check_qrcode/?token=x', {
      data: { status: 'scanned' },
    })
    expect((await flow.poll()).status).toBe('scanned')

    // 抖音回跳豆包 callback 后，浏览器上下文出现豆包会话 Cookie
    fake.state.cookies = [
      { name: 'sessionid', value: 'mock-session', domain: '.doubao.test', path: '/', expires: -1, secure: true, httpOnly: true },
      { name: 'uid_tt', value: '12345', domain: '.doubao.test', path: '/', expires: -1 },
    ]
    const confirmed = await flow.poll()
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.session?.uid).toBe('12345')
    expect(confirmed.session?.nickname).toBe('测试用户')
    expect(confirmed.session?.cookies.some((c) => c.name === 'sessionid')).toBe(true)
    expect(fake.state.closed).toBe(true)
  })
})

describe('session — 服务端登录编排与凭证落库', () => {
  it('扫码成功后凭证加密落库，状态不含明文 Cookie', async () => {
    const begin = await sessionModule.beginLogin()
    expect(begin.status).toBe('pending')
    expect(begin.qr_data_url).toContain('data:image/png;base64,')

    await waitFor(async () => (await sessionModule.getLoginStatus()).status === 'success')

    const status = await sessionModule.getLoginStatus()
    expect(status.status).toBe('success')
    expect(status.credential?.logged_in).toBe(true)
    expect(status.credential?.uid).toBe('12345')
    expect(status.credential?.nickname).toBe('测试用户')
    expect(status.credential?.source).toBe('store')
    // 登录成功后不再下发二维码
    expect(status.qr_data_url).toBeUndefined()

    const raw = await (h.mod.db as any)
      .select()
      .from(h.mod.settings)
      .where((await import('drizzle-orm')).eq(h.mod.settings.key, 'doubao_credential'))
      .get()
    expect(raw.value.startsWith('aesgcm:v1:')).toBe(true)
    expect(raw.value).not.toContain('mock-session')

    const back = await credentials.readSession()
    expect(back?.cookies.some((c) => c.value === 'mock-session')).toBe(true)
  })

  it('无凭证时对话给出可读的未登录提示', async () => {
    const events = chatModule.streamDoubaoChat(
      'doubao-fast',
      [{ role: 'user', content: '你好' }],
      false,
      new AbortController().signal,
    )
    await expect(collect(events)).rejects.toThrow(/未登录/)
  })

  it('后台巡检：有效会话吸收上游轮换的 Cookie 并写回', async () => {
    await credentials.writeSession(makeSession())
    await sessionModule.runKeepaliveCheck()

    const status = await sessionModule.getStatus()
    expect(status.keepalive?.last_result).toBe('ok')
    expect(status.invalid).toBeUndefined()

    const stored = await credentials.readSession()
    expect(stored?.cookies.some((c) => c.name === 'ttwid' && c.value.startsWith('rotated-'))).toBe(true)
  })

  it('后台巡检：上游判定失效时标记 invalid，提示重新扫码', async () => {
    await credentials.writeSession(
      makeSession({
        cookies: [{ name: 'sessionid', value: 'expired-session', domain: 'doubao.test', path: '/', hostOnly: true }],
      }),
    )
    await sessionModule.runKeepaliveCheck()

    const status = await sessionModule.getStatus()
    expect(status.keepalive?.last_result).toBe('auth')
    expect(status.invalid).toBe(true)
  })
})

describe('chat — 协议适配', () => {
  beforeEach(async () => {
    await credentials.writeSession(makeSession())
  })

  it('思考与正文分流转发，流尾携带 usage', async () => {
    const events = await collect(
      chatModule.streamDoubaoChat(
        'doubao-expert',
        [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: '你好' },
        ],
        true,
        new AbortController().signal,
      ),
    )

    expect(events.filter((e) => e.type === 'thinking').map((e) => e.text).join('')).toBe('思考中')
    expect(events.filter((e) => e.type === 'token').map((e) => e.text).join('')).toBe('你好，世界')
    const finish = events.find((e) => e.type === 'finish')
    expect(finish?.usage).toEqual({ promptTokens: 3, completionTokens: 4 })

    const req = mock.state.chatRequests[0]
    expect(req.url).toContain('/chat/completion?')
    expect(req.url).toContain('aid=497858')
    expect(req.cookie).toContain('sessionid=mock-session')
    // system 被压平进同一条用户消息
    const prompt = req.body.messages[0].content_block[0].content.text_block.text as string
    expect(prompt).toContain('你是助手')
    expect(prompt).toContain('你好')
    expect(req.body.option.need_deep_think).toBe(3)
    expect(req.body.ext.use_deep_think).toBe('3')
    expect(req.body.option.conversation_init_ext.model_item_key).toBe('3')
  })

  it('关闭思考时不申请深度思考，也不产出 thinking 事件', async () => {
    const events = await collect(
      chatModule.streamDoubaoChat(
        'doubao-expert',
        [{ role: 'user', content: '你好' }],
        false,
        new AbortController().signal,
      ),
    )
    expect(events.some((e) => e.type === 'thinking')).toBe(false)
    const req = mock.state.chatRequests[0]
    expect(req.body.option.need_deep_think).toBe(0)
    expect(req.body.option.conversation_init_ext.reasoning_effort).toBe('3')
    expect(events.filter((e) => e.type === 'token').map((e) => e.text).join('')).toBe('你好，世界')
  })

  it('工作任务模型以 menu_type 作为思考参数并携带窗口参数', async () => {
    await collect(
      chatModule.streamDoubaoChat(
        'doubao-work',
        [{ role: 'user', content: '你好' }],
        true,
        new AbortController().signal,
      ),
    )
    const req = mock.state.chatRequests[0]
    expect(req.body.option.need_deep_think).toBe(9)
    expect(req.body.ext.use_deep_think).toBe('9')
    expect(req.body.option.model_config.model_extra_params).toEqual({ total_window_size: '256000' })
  })

  it('主端点 404 时自动回退 /samantha，语义不变', async () => {
    mock.state.chatBehavior = 'legacyOnly'
    const events = await collect(
      chatModule.streamDoubaoChat(
        'doubao-fast',
        [{ role: 'user', content: '你好' }],
        true,
        new AbortController().signal,
      ),
    )
    expect(events.filter((e) => e.type === 'thinking').map((e) => e.text).join('')).toBe('先想一下')
    expect(events.filter((e) => e.type === 'token').map((e) => e.text).join('')).toBe('回退回答')
    expect(mock.state.legacyRequests).toHaveLength(1)
    expect(mock.state.legacyRequests[0].url).toContain('/samantha/chat/completion?')
  })

  it('登录失效映射为可读提示', async () => {
    mock.state.chatBehavior = 'http401'
    const events = chatModule.streamDoubaoChat(
      'doubao-fast',
      [{ role: 'user', content: '你好' }],
      false,
      new AbortController().signal,
    )
    await expect(collect(events)).rejects.toThrow(/登录态失效/)
  })

  it('风控错误置位 needs_captcha，管理端可清除', async () => {
    mock.state.chatBehavior = 'risk'
    const events = chatModule.streamDoubaoChat(
      'doubao-fast',
      [{ role: 'user', content: '你好' }],
      false,
      new AbortController().signal,
    )
    await expect(collect(events)).rejects.toThrow(/风控/)

    expect((await sessionModule.getStatus()).needs_captcha).toBe(true)
    sessionModule.resetCaptcha()
    expect((await sessionModule.getStatus()).needs_captcha).toBe(false)
  })

  it('图片输入走 ImageX 上传，附件与文本分属两个 message', async () => {
    const events = await collect(
      chatModule.streamDoubaoChat(
        'doubao-fast',
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看图' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } },
            ],
          },
        ],
        false,
        new AbortController().signal,
      ),
    )
    expect(events.filter((e) => e.type === 'token').map((e) => e.text).join('')).toBe('你好，世界')

    // 五步上传链路顺序：prepare → apply → tos → commit → preHandle
    expect(mock.state.uploadRequests.map((r) => r.kind)).toEqual(['prepare', 'apply', 'tos', 'commit', 'preHandle'])
    expect(mock.state.uploadRequests[0].body).toMatchObject({ tenant_id: '5', scene_id: '5', resource_type: 2 })
    expect(mock.state.uploadRequests[2].headers?.['x-storage-u']).toBe('12345')
    expect(mock.state.uploadRequests[2].headers?.['content-crc32']).toMatch(/^[0-9a-f]{8}$/)
    expect(mock.state.uploadRequests[4].body).toMatchObject({
      uplink_entity: { entity_type: 2, entity_content: { image: { key: 'tos-cn-i-mock/hash.png' } } },
    })

    const req = mock.state.chatRequests[0]
    // messages[0] = 10052 附件块；messages[1] = 文本块
    expect(req.body.messages).toHaveLength(2)
    const attachmentBlock = req.body.messages[0].content_block[0]
    expect(attachmentBlock.block_type).toBe(10052)
    expect(attachmentBlock.content.attachment_block.attachments[0]).toMatchObject({
      type: 1,
      image: { name: 'image.png', uri: 'tos-cn-i-mock/hash.png', image_ori: { width: 1, height: 1, format: 'png' } },
    })
    expect(req.body.messages[1].content_block[0].content.text_block.text).toContain('看图')
  })

  it('带附件的请求不上 /samantha 回退（避免静默丢附件）', async () => {
    mock.state.chatBehavior = 'legacyOnly'
    const events = chatModule.streamDoubaoChat(
      'doubao-fast',
      [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } }],
        },
      ],
      false,
      new AbortController().signal,
    )
    await expect(collect(events)).rejects.toThrow(/404|not found/)
    expect(mock.state.legacyRequests).toHaveLength(0)
  })

  it('新协议 thinking_block 步骤标题映射为思考增量，CHUNK_DELTA 为正文', async () => {
    mock.state.chatBehavior = 'thinkingBlock'
    const events = await collect(
      chatModule.streamDoubaoChat(
        'doubao-fast',
        [{ role: 'user', content: '你好' }],
        true,
        new AbortController().signal,
      ),
    )
    expect(events.filter((e) => e.type === 'thinking').map((e) => e.text).join('')).toBe('步骤一\n步骤二\n')
    expect(events.filter((e) => e.type === 'token').map((e) => e.text).join('')).toBe('答案完整')
    const finish = events.find((e) => e.type === 'finish')
    expect(finish?.usage).toEqual({ promptTokens: 5, completionTokens: 6 })
  })

  it('流结束后异步删除本轮会话（cmd 4171）', async () => {
    await collect(
      chatModule.streamDoubaoChat(
        'doubao-fast',
        [{ role: 'user', content: '你好' }],
        false,
        new AbortController().signal,
      ),
    )
    await waitFor(async () => mock.state.cleanupRequests.length > 0)
    const cleanup = mock.state.cleanupRequests[0]
    expect(cleanup.contentType).toContain('encoding=utf-8')
    expect(cleanup.body).toMatchObject({
      cmd: 4171,
      uplink_body: {
        batch_delete_user_conversation_uplink_body: {
          conversation_id: ['conv-mock'],
          delete_all: false,
          conversation_type: 3,
        },
      },
    })
  })

  it('退出登录后凭证被删除', async () => {
    await sessionModule.logout()
    expect(await credentials.readSession()).toBeNull()
    expect((await sessionModule.getStatus()).logged_in).toBe(false)
  })

  it('对话响应里轮换的 Cookie 写回加密存储', async () => {
    await collect(
      chatModule.streamDoubaoChat(
        'doubao-fast',
        [{ role: 'user', content: '你好' }],
        false,
        new AbortController().signal,
      ),
    )
    const stored = await credentials.readSession()
    expect(stored?.cookies.some((c) => c.name === 'ttwid' && c.value === 'chat-rotated')).toBe(true)
  })

  it('对话成功后清除「凭证已失效」标记', async () => {
    sessionModule.markAuthError()
    expect((await sessionModule.getStatus()).invalid).toBe(true)

    await collect(
      chatModule.streamDoubaoChat(
        'doubao-fast',
        [{ role: 'user', content: '你好' }],
        false,
        new AbortController().signal,
      ),
    )
    expect((await sessionModule.getStatus()).invalid).toBeUndefined()
  })
})
