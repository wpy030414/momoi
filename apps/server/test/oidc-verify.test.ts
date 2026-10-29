// ============================================================
// OIDC id_token 验签回归测试
// ============================================================
//
// 覆盖 verifyIdToken 的安全契约：
// - HS256：正确 clientSecret 通过；错误密钥拒绝
// - iss / aud 不匹配拒绝（防 issuer 混用与 audience 混用）
// - 过期 token 拒绝
// - 算法降级（alg: none）拒绝——这是最容易被忽略也最致命的
// - 非对称算法缺 jwks_uri 时报错而非静默放行

import { describe, it, expect } from 'vitest'
import { SignJWT } from 'jose'
import { verifyIdToken, OidcVerifyError } from '../src/lib/oidc-verify.js'

const ISSUER = 'https://dingtalk.auth.xrl.im/my_org'
const CLIENT_ID = 'ding12345'
const CLIENT_SECRET = 'test-secret-for-oidc-verify-suite'
const NOW = Math.floor(Date.now() / 1000)

/** 用 HS256 签一个 id_token；secret 默认取 CLIENT_SECRET */
async function signIdToken(
  claims: Record<string, unknown> = {},
  opts: { secret?: string; issuer?: string; audience?: string; exp?: number; alg?: string } = {},
): Promise<string> {
  const secret = new TextEncoder().encode(opts.secret ?? CLIENT_SECRET)
  return new SignJWT({ name: '肉桂', picture: 'https://a/b.png', ...claims })
    .setProtectedHeader({ alg: opts.alg ?? 'HS256', typ: 'JWT' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setSubject('user-123')
    .setAudience(opts.audience ?? CLIENT_ID)
    .setIssuedAt(NOW)
    .setExpirationTime(opts.exp ?? NOW + 3600)
    .sign(secret)
}

const baseOpts = {
  clientSecret: CLIENT_SECRET,
  issuer: ISSUER,
  clientId: CLIENT_ID,
  signingAlgs: ['HS256'],
}

describe('verifyIdToken — HS256', () => {
  it('合法 token 返回 sub / name / picture', async () => {
    const idToken = await signIdToken()
    const claims = await verifyIdToken({ ...baseOpts, idToken })
    expect(claims.sub).toBe('user-123')
    expect(claims.name).toBe('肉桂')
    expect(claims.picture).toBe('https://a/b.png')
  })

  it('错误 clientSecret 拒绝', async () => {
    const idToken = await signIdToken({}, { secret: 'wrong-secret' })
    await expect(verifyIdToken({ ...baseOpts, idToken })).rejects.toThrow(OidcVerifyError)
  })

  it('issuer 不匹配拒绝', async () => {
    const idToken = await signIdToken({}, { issuer: 'https://evil.example' })
    await expect(verifyIdToken({ ...baseOpts, idToken })).rejects.toThrow(OidcVerifyError)
  })

  it('audience 不匹配拒绝', async () => {
    const idToken = await signIdToken({}, { audience: 'other-client' })
    await expect(verifyIdToken({ ...baseOpts, idToken })).rejects.toThrow(OidcVerifyError)
  })

  it('过期 token 拒绝', async () => {
    // exp 需早于「现在 - clockTolerance(30s)」才会被判过期
    const idToken = await signIdToken({}, { exp: NOW - 120 })
    await expect(verifyIdToken({ ...baseOpts, idToken })).rejects.toThrow(OidcVerifyError)
  })

  it('时钟偏差 30s 内的过期 token 仍接受', async () => {
    const idToken = await signIdToken({}, { exp: NOW - 10 })
    const claims = await verifyIdToken({ ...baseOpts, idToken })
    expect(claims.sub).toBe('user-123')
  })

  it('缺少 sub 拒绝', async () => {
    const secret = new TextEncoder().encode(CLIENT_SECRET)
    const idToken = await new SignJWT({ name: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 3600)
      .sign(secret)
    await expect(verifyIdToken({ ...baseOpts, idToken })).rejects.toThrow(/no sub/)
  })

  it('算法降级（HS512 但声明只接受 HS256）拒绝', async () => {
    const idToken = await signIdToken({}, { alg: 'HS512' })
    await expect(verifyIdToken({ ...baseOpts, idToken })).rejects.toThrow(OidcVerifyError)
  })

  it('clientSecret 为空时报错而非放行', async () => {
    const idToken = await signIdToken()
    await expect(verifyIdToken({ ...baseOpts, clientSecret: '', idToken })).rejects.toThrow(/client_secret/)
  })
})

describe('verifyIdToken — 非对称算法', () => {
  it('声明 RS256 但缺 jwks_uri 时明确报错', async () => {
    const idToken = await signIdToken()
    await expect(
      verifyIdToken({ ...baseOpts, signingAlgs: ['RS256'], jwksUri: null, idToken }),
    ).rejects.toThrow(/jwks_uri/)
  })

  it('未指定算法时默认按 HS256 处理', async () => {
    const idToken = await signIdToken()
    const claims = await verifyIdToken({
      clientSecret: CLIENT_SECRET,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      idToken,
    })
    expect(claims.sub).toBe('user-123')
  })
})