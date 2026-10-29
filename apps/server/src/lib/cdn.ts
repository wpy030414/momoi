import { randomUUID } from 'crypto'

/**
 * 外部图床（免费 CDN）。协议与容错语义对齐 `xat:upload-img` 技能的实测结论。
 *
 * 同一套接口在三个域名下都存在，但只有 cloudflareimg.cdn.sn 在本项目运行网络里
 * 全链路可用：
 *   - img.scdn.io     整站不可达（TCP 443 直接超时，要等约 20s 才失败）；
 *   - img.cdn1.vip    /api 前有验证码 WAF（返回 _guard/html.js），传不上去；
 *   - cloudflareimg.cdn.sn  接口与 /i/ 静态资源都 200，唯一可用。
 *
 * 三个域名共享同一份 /i/<file> 路径，因此服务端即便返回 img.cdn1.vip 的链接，
 * 把 host 改写为 cloudflareimg.cdn.sn 后实测同样 200。
 */
export const CDN_HOST = 'cloudflareimg.cdn.sn'
const CDN_ENDPOINT = `https://${CDN_HOST}/api/v1.php`

/** 域名不可达类错误：网络层问题，重试同域名仍有意义但成本低（兜抖动）。
 *  undici（Node 内置 fetch）的连不上类错误码带 UND_ERR_ 前缀，必须一并归入，
 *  否则会被当成「确定性失败」而不重试。 */
const NET_ERROR_CODES = new Set([
  'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN',
  'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_ABORTED', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
])

/** 建连超时：默认 fetch 的 10s 对跨洋免费图床偏紧，放宽到 30s（与总超时分离）。 */
const CONNECT_TIMEOUT_MS = 30_000
const TOTAL_TIMEOUT_MS = 45_000

/** 服务端限流 5 次 / 5 秒、120 次 / 60 秒。逐张间隔 1s 是最省事的安全值。 */
const GAP_MS = 1000
const RETRY_MS = 1500

/** 带出 `error` 的上传失败：区分「网络不可达」与「服务端确定性拒绝」，便于调用方决定是否回退。 */
export class CdnUploadError extends Error {
  readonly status?: number
  readonly net: boolean
  constructor(message: string, opts: { status?: number; net?: boolean } = {}) {
    super(message)
    this.name = 'CdnUploadError'
    this.status = opts.status
    this.net = opts.net ?? false
  }
}

// 简单节流：保证两次请求之间至少间隔 GAP_MS（跨图片连续上传时生效）。
let lastRequestTime = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Decode a base64 data URL (e.g. "data:image/png;base64,...") into a Buffer and MIME type.
 */
export function base64ToBuffer(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) throw new Error('Invalid data URL format')
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  }
}

/** 服务端会返回 http://img.cdn1.vip/...：http 先吃一次 301，统一升 https；
 *  host 换成 CDN_HOST —— 三域名共享同一份 /i/ 路径，换 host 安全。 */
export function normalizeCdnUrl(url: string): string {
  return url.replace(/^http:\/\//i, 'https://').replace(/^https:\/\/[^/]+/i, `https://${CDN_HOST}`)
}

function buildMultipart(buffer: Buffer): { boundary: string; body: Buffer } {
  const boundary = randomUUID()
  const body = Buffer.concat([
    // 文件名固定为 upload：图床按内容嗅探格式，不依赖扩展名与 MIME。
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="image"; filename="upload"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
    buffer,
    Buffer.from('\r\n'),
    // 显式声明想要的 CDN 域名。服务端目前不据此改返回链接（本地 normalize 兜住），
    // 但把「要哪个域名」表达在协议层，服务端哪天支持了即自动生效。
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="cdn_name"\r\n\r\n' +
        `${CDN_HOST}\r\n`,
    ),
    Buffer.from(`--${boundary}--\r\n`),
  ])
  return { boundary, body }
}

type AttemptResult =
  | { kind: 'ok'; url: string }
  | { kind: 'fatal'; error: CdnUploadError }
  | { kind: 'retryable'; error: CdnUploadError }

async function postOnce(buffer: Buffer): Promise<AttemptResult> {
  const { boundary, body } = buildMultipart(buffer)
  let res: Response
  try {
    res = await fetch(CDN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
      // Node 18+ 的 undici 专用选项：默认建连超时 10s，跨洋免费图床易踩线
      ...({ connectTimeout: CONNECT_TIMEOUT_MS } as object),
    })
  } catch (err) {
    const code = (err as { cause?: { code?: string }; name?: string })
    const netCode = code.cause?.code || code.name || 'ERROR'
    const net = code.name === 'TimeoutError' || code.name === 'AbortError' || NET_ERROR_CODES.has(netCode)
    return { kind: net ? 'retryable' : 'fatal', error: new CdnUploadError(`图床不可达：${netCode}`, { net }) }
  }

  const text = await res.text().catch(() => '')
  let json: { success?: boolean; data?: { url?: string }; url?: string; error?: string; message?: string } | null = null
  try {
    json = JSON.parse(text)
  } catch {
    // 非 JSON 响应（如 WAF 验证码页）：保留状态码判定
  }

  if (res.status === 200 && json?.success) {
    const url = json.data?.url || json.url
    if (url) return { kind: 'ok', url }
  }

  const reason = json?.error || json?.message
  if (res.status >= 400 && res.status < 500) {
    // 4xx 是确定性拒绝（体积过大 / 图片无法解码 / 参数错），重试无用；
    // 服务端原因本就是中文人话，原样带出。
    const msg = reason ? `${reason}（HTTP ${res.status}）` : `图床拒绝上传（HTTP ${res.status}）`
    return { kind: 'fatal', error: new CdnUploadError(msg, { status: res.status }) }
  }

  // 5xx 多为上游压缩 API 抖动，再试一次常有救。
  const msg = reason ? `${reason}（HTTP ${res.status}）` : `图床服务异常（HTTP ${res.status}）`
  return { kind: 'retryable', error: new CdnUploadError(msg, { status: res.status }) }
}

/**
 * 上传一张图片到 CDN，返回公共 URL（host 已归一为 CDN_HOST）。
 * 失败抛 CdnUploadError：5xx / 网络错误自动重试一次，4xx 不重试。
 */
export async function uploadToCdn(buffer: Buffer, _filename?: string, _mimeType?: string): Promise<string> {
  const wait = Math.max(0, GAP_MS - (Date.now() - lastRequestTime))
  if (wait > 0) await sleep(wait)
  lastRequestTime = Date.now()

  let last: CdnUploadError | null = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await postOnce(buffer)
    if (r.kind === 'ok') return normalizeCdnUrl(r.url)
    last = r.error
    if (r.kind === 'fatal') break
    if (attempt === 1) await sleep(RETRY_MS)
  }
  throw last ?? new CdnUploadError('图床上传失败')
}