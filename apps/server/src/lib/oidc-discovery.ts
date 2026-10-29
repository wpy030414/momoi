/**
 * OIDC Discovery 文档拉取与缓存。
 *
 * 参考 Provider：../oidc-dingtalk。
 * 端点约定：`${issuer}/.well-known/openid-configuration`。
 *
 * 缓存策略：
 * - 进程内 Map<issuer, { doc, fetchedAt }>，TTL 1 小时。
 * - 校验 `doc.issuer === 配置的 issuer`：防止 discovery 被中间人换成别的 issuer。
 * - 失败抛错，由调用方转成 `OIDC_PROVIDER_ERROR`。
 *
 * 为什么不落库：discovery 是纯派生的远端元数据，落库会在多实例部署时
 * 产生陈旧副本；进程内缓存 + TTL 足够（非 OIDC Provider 走覆盖项，根本不拉）。
 */

export interface OidcDiscoveryDoc {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri?: string
  id_token_signing_alg_values_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  scopes_supported?: string[]
}

interface CacheEntry {
  doc: OidcDiscoveryDoc
  fetchedAt: number
}

const CACHE_TTL_MS = 60 * 60 * 1000
const cache = new Map<string, CacheEntry>()

function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
}

/** 清空缓存（测试用；也供管理员改配置后强制刷新） */
export function clearDiscoveryCache(): void {
  cache.clear()
}

/**
 * 拉取并校验一个 issuer 的 discovery 文档。
 * @throws 当网络失败、HTTP 非 2xx、JSON 非法、或 `doc.issuer` 与配置不符时抛错
 */
export async function fetchDiscovery(issuer: string): Promise<OidcDiscoveryDoc> {
  const cached = cache.get(issuer)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.doc

  const url = discoveryUrl(issuer)
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`discovery fetch failed: ${res.status} ${url}`)
  }

  const doc = (await res.json()) as OidcDiscoveryDoc
  if (typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string') {
    throw new Error(`discovery doc missing required endpoints: ${url}`)
  }
  // 反代场景下 Provider 可能从 X-Forwarded-Proto 推导 issuer，
  // 与管理员填写的不一致时直接拒绝——宁可报错也不要静默用错误的 issuer 验签。
  const normalizedConfigured = issuer.replace(/\/+$/, '')
  const normalizedDoc = typeof doc.issuer === 'string' ? doc.issuer.replace(/\/+$/, '') : ''
  if (normalizedDoc !== normalizedConfigured) {
    throw new Error(`discovery issuer mismatch: doc=${doc.issuer} configured=${issuer}`)
  }

  cache.set(issuer, { doc, fetchedAt: Date.now() })
  return doc
}

export interface ResolvedEndpoints {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string | null
  jwks_uri: string | null
  signingAlgs: string[]
  tokenAuthMethods: string[]
}

/**
 * 解析 Provider 的实际端点：手动覆盖项优先，缺什么拉什么。
 *
 * 覆盖项全填（三个 URL）时不发 discovery 请求——这是非 OIDC Provider 的逃生舱。
 * 否则拉 discovery，把缺的字段补上。
 */
export async function resolveEndpoints(provider: {
  issuer: string
  authorize_url?: string
  token_url?: string
  userinfo_url?: string
}): Promise<ResolvedEndpoints> {
  const hasAllOverrides = !!(provider.authorize_url && provider.token_url)
  const doc = hasAllOverrides ? null : await fetchDiscovery(provider.issuer)

  return {
    authorization_endpoint: provider.authorize_url || doc!.authorization_endpoint,
    token_endpoint: provider.token_url || doc!.token_endpoint,
    userinfo_endpoint: provider.userinfo_url || doc?.userinfo_endpoint || null,
    jwks_uri: doc?.jwks_uri ?? null,
    signingAlgs: doc?.id_token_signing_alg_values_supported ?? ['HS256'],
    tokenAuthMethods: doc?.token_endpoint_auth_methods_supported ?? ['client_secret_post'],
  }
}
