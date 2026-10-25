/**
 * 最小可持久化 Cookie 罐（豆包网页上游专用）。
 *
 * 豆包网页登录与对话都依赖 Cookie（sessionid / ttwid / passport_csrf_token …）。
 * Node 的 fetch 不会自动保存 Cookie，因此这里实现：
 *   - Set-Cookie 解析（Domain / Path / Max-Age / Expires / Secure / HttpOnly）
 *   - 按 domain + path + secure + 过期时间筛选并生成 Cookie 头
 *   - JSON 序列化，随凭证一起加密落盘
 */

export interface CookieRecord {
  name: string
  value: string
  domain: string
  path: string
  /** 毫秒时间戳；缺省表示会话 Cookie */
  expiresAt?: number
  secure?: boolean
  httpOnly?: boolean
  hostOnly?: boolean
  sameSite?: string
}

function isExpired(c: CookieRecord, now = Date.now()): boolean {
  return typeof c.expiresAt === 'number' && c.expiresAt <= now
}

function domainMatches(host: string, cookie: CookieRecord): boolean {
  const h = host.toLowerCase()
  const d = cookie.domain.toLowerCase().replace(/^\./, '')
  if (cookie.hostOnly) return h === d
  return h === d || h.endsWith(`.${d}`)
}

function pathMatches(pathname: string, cookiePath: string): boolean {
  if (!cookiePath.startsWith('/')) return false
  if (pathname === cookiePath) return true
  if (!pathname.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || pathname[cookiePath.length] === '/'
}

function defaultPath(url: URL): string {
  const p = url.pathname || '/'
  if (!p.startsWith('/')) return '/'
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

function parseSetCookie(raw: string, requestUrl: string): CookieRecord | null {
  const parts = raw.split(';')
  const first = parts.shift()?.trim() || ''
  const eq = first.indexOf('=')
  if (eq <= 0) return null
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  if (!name) return null

  const url = new URL(requestUrl)
  let domain = url.hostname.toLowerCase()
  let hostOnly = true
  let path = defaultPath(url)
  let expiresAt: number | undefined
  let secure = false
  let httpOnly = false
  let sameSite: string | undefined
  let maxAge: number | undefined
  let expiresRaw: string | undefined

  for (const attr of parts) {
    const [k, ...rest] = attr.trim().split('=')
    const key = k.toLowerCase()
    const val = rest.join('=').trim()
    if (key === 'domain' && val) {
      domain = val.toLowerCase().replace(/^\./, '')
      hostOnly = false
    } else if (key === 'path' && val.startsWith('/')) {
      path = val
    } else if (key === 'max-age' && val) {
      const n = Number(val)
      if (Number.isFinite(n)) maxAge = n
    } else if (key === 'expires' && val) {
      expiresRaw = val
    } else if (key === 'secure') {
      secure = true
    } else if (key === 'httponly') {
      httpOnly = true
    } else if (key === 'samesite' && val) {
      sameSite = val
    }
  }

  if (maxAge !== undefined) {
    expiresAt = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000
  } else if (expiresRaw) {
    const t = Date.parse(expiresRaw)
    if (Number.isFinite(t)) expiresAt = t
  }

  return { name, value, domain, path, expiresAt, secure, httpOnly, hostOnly, sameSite }
}

export class CookieJar {
  private cookies: CookieRecord[] = []

  static fromJSON(records: unknown): CookieJar {
    const jar = new CookieJar()
    if (Array.isArray(records)) {
      jar.cookies = records
        .filter((c): c is CookieRecord => Boolean(c) && typeof (c as CookieRecord).name === 'string' && typeof (c as CookieRecord).value === 'string')
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: typeof c.domain === 'string' ? c.domain : '',
          path: typeof c.path === 'string' ? c.path : '/',
          expiresAt: typeof c.expiresAt === 'number' ? c.expiresAt : undefined,
          secure: c.secure === true,
          httpOnly: c.httpOnly === true,
          hostOnly: c.hostOnly === true,
          sameSite: typeof c.sameSite === 'string' ? c.sameSite : undefined,
        }))
    }
    return jar
  }

  toJSON(): CookieRecord[] {
    return this.cookies.map((c) => ({ ...c }))
  }

  size(): number {
    return this.cookies.filter((c) => !isExpired(c)).length
  }

  names(): string[] {
    return [...new Set(this.cookies.filter((c) => !isExpired(c)).map((c) => c.name))].sort()
  }

  set(record: CookieRecord): void {
    const idx = this.cookies.findIndex(
      (c) => c.name === record.name && c.domain.toLowerCase() === record.domain.toLowerCase() && c.path === record.path,
    )
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      if (idx >= 0) this.cookies.splice(idx, 1)
      return
    }
    if (idx >= 0) this.cookies[idx] = record
    else this.cookies.push(record)
  }

  /** 解析单条 Set-Cookie 并写入（过期/删除语义也在这里处理） */
  setCookie(raw: string, requestUrl: string): void {
    const record = parseSetCookie(raw, requestUrl)
    if (!record) return
    this.set(record)
  }

  /** 吸收响应里的全部 Set-Cookie */
  absorb(headers: Headers, requestUrl: string): void {
    const anyHeaders = headers as Headers & { getSetCookie?: () => string[] }
    let list: string[] = []
    if (typeof anyHeaders.getSetCookie === 'function') {
      list = anyHeaders.getSetCookie()
    } else {
      const single = headers.get('set-cookie')
      if (single) list = [single]
    }
    for (const raw of list) this.setCookie(raw, requestUrl)
  }

  /** 从 `a=1; b=2` 形式的 Cookie 头播种（用于 DOUBAO_COOKIES 灾备） */
  seedCookieHeader(header: string, url = 'https://www.doubao.com/'): void {
    for (const part of header.split(';')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const name = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (!name) continue
      const u = new URL(url)
      this.set({
        name,
        value,
        domain: u.hostname.toLowerCase(),
        path: '/',
        hostOnly: false,
        secure: u.protocol === 'https:',
        httpOnly: false,
      })
    }
  }

  get(name: string): string | undefined {
    const now = Date.now()
    const candidates = this.cookies
      .filter((c) => c.name === name && !isExpired(c, now))
      .sort((a, b) => b.path.length - a.path.length)
    return candidates[0]?.value
  }

  has(name: string): boolean {
    return this.get(name) !== undefined
  }

  /** 为指定 URL 生成 Cookie 请求头 */
  getCookieHeader(url: string): string {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return ''
    }
    const now = Date.now()
    const host = u.hostname.toLowerCase()
    const pathname = u.pathname || '/'
    const isHttps = u.protocol === 'https:'
    const matched = this.cookies
      .filter(
        (c) =>
          !isExpired(c, now) &&
          domainMatches(host, c) &&
          pathMatches(pathname, c.path) &&
          (!c.secure || isHttps),
      )
      .sort((a, b) => b.path.length - a.path.length)
    return matched.map((c) => `${c.name}=${c.value}`).join('; ')
  }

  /** 供日志/诊断使用：只输出名称与长度，不泄露值 */
  describe(): Array<{ name: string; domain: string; length: number; expiresAt?: string }> {
    const now = Date.now()
    return this.cookies
      .filter((c) => !isExpired(c, now))
      .map((c) => ({
        name: c.name,
        domain: c.domain,
        length: c.value.length,
        expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : undefined,
      }))
  }
}
