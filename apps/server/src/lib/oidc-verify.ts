/**
 * id_token 验签。
 *
 * 两条路径，由 discovery 的 `id_token_signing_alg_values_supported` 决定：
 * - **HS256 等对称算法**：密钥 = `client_secret`（参考项目 oidc-dingtalk 就是这样签的）。
 * - **RS256 / ES256 等非对称算法**：从 `jwks_uri` 拉公钥（`createRemoteJWKSet` 自带缓存）。
 *
 * 安全要点：
 * - 必须传 `algorithms` 白名单，否则攻击者可以把 header 改成 `alg: none` 绕过验签。
 * - `issuer` 与 `audience` 由 jose 在 `jwtVerify` 内校验，失败即抛。
 * - **不校验 nonce**：oidc-dingtalk 无状态，无法把 nonce 绑进 id_token
 *   （其 README 明确声明）；state 防 CSRF 已由回调侧独立承担。
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyResult } from 'jose'

/** 对称签名算法族（密钥是共享 secret 而非公钥） */
const SYMMETRIC_ALGS = new Set(['HS256', 'HS384', 'HS512'])

export interface OidcClaims {
  sub: string
  name?: string
  picture?: string
  email?: string
}

export interface VerifyIdTokenOptions {
  idToken: string
  clientSecret: string
  issuer: string
  clientId: string
  /** discovery 给出的支持算法；缺省按 HS256 */
  signingAlgs?: string[]
  jwksUri?: string | null
}

export class OidcVerifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OidcVerifyError'
  }
}

/**
 * 验签 id_token 并返回身份声明。
 * @throws OidcVerifyError 当算法不可用、缺 jwks_uri、或 jwtVerify 失败时
 */
export async function verifyIdToken(opts: VerifyIdTokenOptions): Promise<OidcClaims> {
  const algs = opts.signingAlgs?.length ? opts.signingAlgs : ['HS256']

  // 只要候选算法里有一个对称算法，就用 client_secret 做密钥。
  // 理由：对称签名的 Provider 不会暴露 jwks_uri，没有别的选择；
  // 而混用两种算法的 Provider 极小，取第一个可满足的即可。
  const symmetricAlg = algs.find((a) => SYMMETRIC_ALGS.has(a))

  let key: Uint8Array | ReturnType<typeof createRemoteJWKSet>
  if (symmetricAlg) {
    if (!opts.clientSecret) {
      throw new OidcVerifyError('symmetric id_token signing requires client_secret')
    }
    key = new TextEncoder().encode(opts.clientSecret)
  } else {
    if (!opts.jwksUri) {
      throw new OidcVerifyError('asymmetric id_token signing requires jwks_uri from discovery')
    }
    key = createRemoteJWKSet(new URL(opts.jwksUri))
  }

  let result: JWTVerifyResult
  try {
    result = await jwtVerify(opts.idToken, key, {
      issuer: opts.issuer,
      audience: opts.clientId,
      // 白名单：禁止算法降级
      algorithms: algs,
      // 允许 30s 时钟偏差（跨机部署常见）
      clockTolerance: 30,
    })
  } catch (err) {
    throw new OidcVerifyError(err instanceof Error ? err.message : String(err))
  }

  const { payload } = result
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new OidcVerifyError('id_token has no sub')
  }

  return {
    sub: payload.sub,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  }
}
