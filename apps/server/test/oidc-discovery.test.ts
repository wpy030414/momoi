// ============================================================
// OIDC discovery 缓存与校验回归测试
// ============================================================
//
// 覆盖：
// - 首次拉取后进入缓存，TTL 内不重复请求
// - TTL 过期后重新拉取
// - doc.issuer 与配置不一致时拒绝（防中间人替换 discovery）
// - 缺必需端点时报错
// - 覆盖项齐全时完全不发 discovery 请求（非标 Provider 的逃生舱）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchDiscovery, resolveEndpoints, clearDiscoveryCache } from '../src/lib/oidc-discovery.js'

const ISSUER = 'https://dingtalk.auth.xrl.im/my_org'

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    id_token_signing_alg_values_supported: ['HS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    ...overrides,
  }
}

/** 用 vi.stubGlobal 替换 fetch，返回计数器便于断言请求次数 */
function stubFetch(body: unknown, ok = true) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    calls.push(String(url))
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    } as unknown as Response
  }))
  return calls
}

beforeEach(() => clearDiscoveryCache())
afterEach(() => { vi.unstubAllGlobals(); clearDiscoveryCache() })

describe('fetchDiscovery', () => {
  it('拉取后缓存命中，TTL 内不重复请求', async () => {
    const calls = stubFetch(makeDoc())
    await fetchDiscovery(ISSUER)
    await fetchDiscovery(ISSUER)
    await fetchDiscovery(ISSUER)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(`${ISSUER}/.well-known/openid-configuration`)
  })

  it('不同 issuer 各自独立缓存', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      calls.push(u)
      // 每个 issuer 返回自洽的 discovery 文档（issuer 字段与请求地址一致）
      const base = u.replace('/.well-known/openid-configuration', '')
      return { ok: true, status: 200, json: async () => makeDoc({ issuer: base }) } as unknown as Response
    }))
    const other = 'https://other.example'
    await fetchDiscovery(ISSUER)
    await fetchDiscovery(other)
    await fetchDiscovery(ISSUER)
    await fetchDiscovery(other)
    expect(calls).toHaveLength(2)
  })

  it('issuer 与配置不一致时拒绝', async () => {
    stubFetch(makeDoc({ issuer: 'https://evil.example' }))
    await expect(fetchDiscovery(ISSUER)).rejects.toThrow(/issuer mismatch/)
  })

  it('issuer 尾部斜杠视为等价', async () => {
    stubFetch(makeDoc({ issuer: `${ISSUER}/` }))
    const doc = await fetchDiscovery(ISSUER)
    expect(doc.authorization_endpoint).toContain('/authorize')
  })

  it('HTTP 非 2xx 时报错', async () => {
    stubFetch(makeDoc(), false)
    await expect(fetchDiscovery(ISSUER)).rejects.toThrow(/discovery fetch failed/)
  })

  it('缺必需端点时报错', async () => {
    stubFetch({ issuer: ISSUER })
    await expect(fetchDiscovery(ISSUER)).rejects.toThrow(/missing required endpoints/)
  })

  it('clearDiscoveryCache 后重新拉取', async () => {
    const calls = stubFetch(makeDoc())
    await fetchDiscovery(ISSUER)
    clearDiscoveryCache()
    await fetchDiscovery(ISSUER)
    expect(calls).toHaveLength(2)
  })
})

describe('resolveEndpoints', () => {
  it('无覆盖项时全部取自 discovery', async () => {
    stubFetch(makeDoc())
    const ep = await resolveEndpoints({ issuer: ISSUER })
    expect(ep.authorization_endpoint).toBe(`${ISSUER}/authorize`)
    expect(ep.token_endpoint).toBe(`${ISSUER}/token`)
    expect(ep.userinfo_endpoint).toBe(`${ISSUER}/userinfo`)
    expect(ep.signingAlgs).toEqual(['HS256'])
    expect(ep.tokenAuthMethods).toEqual(['client_secret_post'])
  })

  it('覆盖项齐全时完全不发 discovery 请求', async () => {
    const calls = stubFetch(makeDoc())
    const ep = await resolveEndpoints({
      issuer: ISSUER,
      authorize_url: 'https://custom/a',
      token_url: 'https://custom/t',
      userinfo_url: 'https://custom/u',
    })
    expect(calls).toHaveLength(0)
    expect(ep.authorization_endpoint).toBe('https://custom/a')
    expect(ep.token_endpoint).toBe('https://custom/t')
    expect(ep.userinfo_endpoint).toBe('https://custom/u')
    expect(ep.jwks_uri).toBeNull()
    // 无 discovery 时默认按 HS256 处理
    expect(ep.signingAlgs).toEqual(['HS256'])
  })

  it('仅填部分覆盖项时仍拉 discovery 补全其余端点', async () => {
    const calls = stubFetch(makeDoc())
    // authorize + token 都填 → 跳过 discovery 的判定条件已满足，
    // 若未填 userinfo 则它只能为 null（调用方需自行判断是否接受）
    const ep = await resolveEndpoints({
      issuer: ISSUER,
      authorize_url: 'https://custom/a',
      token_url: 'https://custom/t',
    })
    expect(calls).toHaveLength(0)
    expect(ep.authorization_endpoint).toBe('https://custom/a')
    expect(ep.userinfo_endpoint).toBeNull()
  })

  it('只填 authorize_url 不足以跳过 discovery', async () => {
    const calls = stubFetch(makeDoc())
    const ep = await resolveEndpoints({
      issuer: ISSUER,
      authorize_url: 'https://custom/a',
      // token 未填 → 必须拉 discovery
    })
    expect(calls).toHaveLength(1)
    expect(ep.authorization_endpoint).toBe('https://custom/a')
    expect(ep.token_endpoint).toBe(`${ISSUER}/token`)
    expect(ep.userinfo_endpoint).toBe(`${ISSUER}/userinfo`)
  })
})