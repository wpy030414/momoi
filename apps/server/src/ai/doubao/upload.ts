/**
 * 豆包附件上传（ImageX）与消息附件块构造。
 *
 * 实测链路（2026-10-25，登录态）：
 *   1. POST /alice/resource/prepare_upload {tenant_id, scene_id, resource_type}
 *        image → resource_type=2；file → resource_type=1
 *        返回 STS（access_key / secret_key / session_token）、service_id、upload_host
 *   2. GET  /top/v1?Action=ApplyImageUpload&... （SigV4，签名头 x-amz-date;x-amz-security-token）
 *        返回 StoreUri / Auth / UploadID / UploadHosts
 *   3. POST https://<upload_host>/upload/v1/<StoreUri>（Authorization: SpaceKey/...，Content-CRC32）
 *   4. POST /top/v1?Action=CommitImageUpload（SigV4，SessionKey 为 base64 JSON）
 *        返回宽高 / 格式 / 大小
 *   5. POST /alice/message/pre_handle_v2_without_conv
 *        返回 pre_generate_id（服务端解析附件）
 *
 * 移植自参考实现 xrp-doubao 的 doubaoUpload.ts（协议细节见该项目的
 * docs/DOUBAO_REVERSE.md 第 5.3 节）。不生成 a_bogus。
 */

import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import { doubaoConfig as cfg } from './config.js'
import type { CookieJar } from './cookie-jar.js'
import type { DeviceIdentity } from './device.js'
import { chatHeaders, toQuery, webParams } from './security-params.js'
import { AUTH_CODES } from './error-codes.js'

export type AttachmentKind = 'image' | 'file'

export interface RawAttachment {
  kind: AttachmentKind
  name: string
  mime: string
  source: { type: 'data'; base64: string } | { type: 'url'; url: string }
  /** 已知大小时用于在下载前做限制 */
  declaredSize?: number
}

export interface UploadedAttachment {
  kind: AttachmentKind
  identifier: string
  storeUri: string
  name: string
  size: number
  mime: string
  width?: number
  height?: number
  format?: string
}

export interface UploadBatch {
  /** 附件消息的 local_message_id；同一批附件共用 */
  localMessageId: string
  attachments: UploadedAttachment[]
}

export interface UploadContext {
  baseUrl: string
  jar: CookieJar
  device: DeviceIdentity
  uid: string
  signal?: AbortSignal
}

export class UploadError extends Error {
  readonly kind: 'unsupported' | 'auth' | 'risk' | 'upstream'
  readonly status?: number
  readonly code?: number
  readonly needsCaptcha?: boolean
  readonly detail?: unknown

  constructor(
    kind: 'unsupported' | 'auth' | 'risk' | 'upstream',
    message: string,
    opts: { status?: number; code?: number; needsCaptcha?: boolean; detail?: unknown } = {},
  ) {
    super(message)
    this.name = 'UploadError'
    this.kind = kind
    this.status = opts.status
    this.code = opts.code
    this.needsCaptcha = opts.needsCaptcha
    this.detail = opts.detail
  }
}

const RISK_RE = /71002200\d|verify|captcha|rate limited|风控|验证码|人机验证/i

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/html': 'html',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime]),
)

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function md5Hex(data: Buffer): string {
  return crypto.createHash('md5').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest()
}

function crc32Hex(buf: Buffer): string {
  let c = 0xffffffff
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function canonicalQuery(raw: string): string {
  const pairs: Array<[string, string]> = []
  for (const part of raw.split('&')) {
    if (!part) continue
    const idx = part.indexOf('=')
    const key = idx >= 0 ? part.slice(0, idx) : part
    const value = idx >= 0 ? part.slice(idx + 1) : ''
    pairs.push([decodeURIComponent(key), decodeURIComponent(value)])
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
  return pairs.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&')
}

function amzDate(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function signV4(opts: {
  method: string
  url: URL
  body: Buffer
  headers: Record<string, string>
  accessKey: string
  secretKey: string
  sessionToken: string
  signedHeaders: string[]
}): Record<string, string> {
  const { method, url, body, headers, accessKey, secretKey, sessionToken, signedHeaders } = opts
  const date = amzDate()
  const day = date.slice(0, 8)
  const region = 'cn-north-1'
  const service = 'imagex'
  const payloadHash = sha256Hex(body)
  const h: Record<string, string> = {
    ...headers,
    'x-amz-date': date,
    'x-amz-security-token': sessionToken,
  }
  if (method !== 'GET') h['x-amz-content-sha256'] = payloadHash
  const signed = signedHeaders.join(';')
  const canonicalHeaders = signedHeaders.map((key) => `${key}:${String(h[key] ?? '').trim()}\n`).join('')
  const canonicalRequest = [method, url.pathname, canonicalQuery(url.searchParams.toString()), canonicalHeaders, signed, payloadHash].join('\n')
  const scope = `${day}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${secretKey}`, day)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  h.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`
  return h
}

function randomS(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 11; i++) out += chars[crypto.randomInt(0, chars.length)]
  return out
}

function extensionOf(name: string): string {
  const m = (name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/)
  return m ? m[1] : ''
}

function extensionFor(name: string, mime: string): string {
  return extensionOf(name) || MIME_EXT[(mime || '').toLowerCase()] || 'bin'
}

function mimeFor(name: string, mime: string): string {
  if (mime) return mime
  const ext = extensionOf(name)
  return EXT_MIME[ext] || 'application/octet-stream'
}

function sanitizeName(input: string, fallback: string): string {
  const base = (input || '').split(/[\\/]/).pop() || ''
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]+/g, '_').trim().slice(0, 180)
  return cleaned || fallback
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (/^fe[89ab]/.test(lower)) return true
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1])
    return false
  }
  return true
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (cfg.allowPrivateUrls) return
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new UploadError('unsupported', `拒绝访问本机/内网地址：${host}`)
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new UploadError('unsupported', `拒绝访问内网地址：${host}`)
    return
  }
  let records: Array<{ address: string }>
  try {
    records = await dns.lookup(host, { all: true })
  } catch (e) {
    throw new UploadError('upstream', `附件下载失败：无法解析 ${host}（${(e as Error).message}）`)
  }
  if (records.some((r) => isPrivateIp(r.address))) {
    throw new UploadError('unsupported', `拒绝访问内网地址：${host}`)
  }
}

const MAX_REDIRECTS = 3

/** 流式读取远程附件，超过限制立即中断，避免被超大响应拖垮 */
async function readBoundedBody(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > max) {
        try {
          await reader.cancel()
        } catch {
          /* 已关闭 */
        }
        throw new UploadError('unsupported', `附件超过 ${Math.round(max / 1024 / 1024)} MB 限制`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* noop */
    }
  }
  return Buffer.concat(chunks)
}

function combineSignal(signal?: AbortSignal, timeoutMs = cfg.uploadTimeoutMs): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  if (typeof (AbortSignal as any).any === 'function') return (AbortSignal as any).any([signal, timeout])
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  timeout.addEventListener('abort', onAbort, { once: true })
  return ac.signal
}

async function fetchRemote(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mime: string; name: string }> {
  let current = new URL(url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!/^https?:$/.test(current.protocol)) {
      throw new UploadError('unsupported', '只支持 http/https 图片或文件 URL')
    }
    await assertPublicUrl(current)
    const combined = combineSignal(signal)
    let res: Response
    try {
      res = await fetch(current, { redirect: 'manual', signal: combined, headers: { 'User-Agent': cfg.userAgent } })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e
      throw new UploadError('upstream', `附件下载失败：${(e as Error).message}`)
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      try {
        await res.body?.cancel()
      } catch {
        /* 已关闭 */
      }
      if (!location) throw new UploadError('upstream', `附件下载失败：HTTP ${res.status} 无跳转地址`)
      const next = new URL(location, current)
      if (next.protocol !== current.protocol && !/^https?:$/.test(next.protocol)) {
        throw new UploadError('unsupported', '附件跳转到了不支持的协议')
      }
      current = next
      continue
    }
    if (!res.ok) {
      throw new UploadError('upstream', `附件下载失败：HTTP ${res.status}`, { status: res.status })
    }
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > cfg.maxAttachmentBytes) {
      throw new UploadError('unsupported', `附件超过 ${Math.round(cfg.maxAttachmentBytes / 1024 / 1024)} MB 限制`)
    }
    const bytes = await readBoundedBody(res, cfg.maxAttachmentBytes)
    if (bytes.length > cfg.maxAttachmentBytes) {
      throw new UploadError('unsupported', `附件超过 ${Math.round(cfg.maxAttachmentBytes / 1024 / 1024)} MB 限制`)
    }
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const urlName = decodeURIComponent(current.pathname.split('/').pop() || '')
    const disposition = res.headers.get('content-disposition') || ''
    const dispName = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] || ''
    return { bytes, mime, name: dispName || urlName }
  }
  throw new UploadError('upstream', '附件下载跳转次数过多')
}

async function materialize(raw: RawAttachment, signal?: AbortSignal): Promise<{ bytes: Buffer; name: string; mime: string }> {
  if (raw.declaredSize && raw.declaredSize > cfg.maxAttachmentBytes) {
    throw new UploadError('unsupported', `附件超过 ${Math.round(cfg.maxAttachmentBytes / 1024 / 1024)} MB 限制`)
  }
  if (raw.source.type === 'data') {
    const bytes = Buffer.from(raw.source.base64, 'base64')
    if (bytes.length === 0 && raw.source.base64.trim()) {
      throw new UploadError('unsupported', '附件 base64 无效')
    }
    if (bytes.length > cfg.maxAttachmentBytes) {
      throw new UploadError('unsupported', `附件超过 ${Math.round(cfg.maxAttachmentBytes / 1024 / 1024)} MB 限制`)
    }
    const fallback = raw.kind === 'image' ? 'image.png' : 'file.bin'
    const name = sanitizeName(raw.name, fallback)
    return { bytes, name, mime: mimeFor(name, raw.mime) }
  }
  const remote = await fetchRemote(raw.source.url, signal)
  const fallback = raw.kind === 'image' ? 'image.png' : 'file.bin'
  const name = sanitizeName(raw.name || remote.name, fallback)
  return { bytes: remote.bytes, name, mime: mimeFor(name, raw.mime || remote.mime) }
}

function classifyFailure(status: number, text: string, json: any): UploadError {
  const code = Number(
    json?.code ?? json?.error_code ?? json?.data?.error_code ?? json?.ResponseMetadata?.Error?.Code ?? NaN,
  )
  const message = String(
    json?.msg ?? json?.message ?? json?.description ?? json?.data?.description ?? json?.ResponseMetadata?.Error?.Message ?? text.slice(0, 300) ?? '',
  )
  const detail = json ?? text.slice(0, 2000)
  if (status === 401 || status === 403 || (Number.isFinite(code) && AUTH_CODES.has(code))) {
    return new UploadError('auth', `豆包登录态失效：${message || `HTTP ${status}`}`, { status, code: Number.isFinite(code) ? code : undefined, detail })
  }
  if ((Number.isFinite(code) && /^71002200\d$/.test(String(code))) || RISK_RE.test(`${message} ${JSON.stringify(detail)}`)) {
    return new UploadError('risk', `豆包触发风控/验证：${message || `HTTP ${status}`}`, {
      status,
      code: Number.isFinite(code) ? code : undefined,
      needsCaptcha: true,
      detail,
    })
  }
  return new UploadError('upstream', `豆包上传失败：${message || `HTTP ${status}`}`, {
    status,
    code: Number.isFinite(code) ? code : undefined,
    detail,
  })
}

async function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; text: string; json: any }> {
  const combined = combineSignal(signal)
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: combined })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    throw new UploadError('upstream', `豆包上传请求失败：${(e as Error).message}`)
  }
  const text = await res.text().catch(() => '')
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, text, json }
}

function assertSuccess(status: number, text: string, json: any): void {
  if (status < 200 || status >= 300) throw classifyFailure(status, text, json)
  const err = json?.ResponseMetadata?.Error
  if (err) {
    throw new UploadError('upstream', `豆包上传失败：${err.Code || ''} ${err.Message || ''}`.trim(), { status, detail: err })
  }
  const code = json?.code ?? json?.status_code
  if (code !== undefined && code !== null && Number(code) !== 0) {
    throw classifyFailure(status, text, json)
  }
}

function queryOf(ctx: UploadContext): string {
  return toQuery(webParams(ctx.device, ctx.jar))
}

async function prepareUpload(
  ctx: UploadContext,
  kind: AttachmentKind,
): Promise<{ serviceId: string; uploadHost: string; token: { access_key: string; secret_key: string; session_token: string } }> {
  const url = `${ctx.baseUrl}${cfg.prepareUploadPath}?${queryOf(ctx)}`
  const body = JSON.stringify({
    tenant_id: cfg.uploadTenantId,
    scene_id: cfg.uploadSceneId,
    resource_type: kind === 'image' ? 2 : 1,
  })
  const r = await request(
    url,
    { method: 'POST', headers: chatHeaders(ctx.jar, { stream: false }), body },
    ctx.signal,
  )
  assertSuccess(r.status, r.text, r.json)
  const data = r.json?.data
  const token = data?.upload_auth_token
  if (!data?.service_id || !token?.access_key || !token?.secret_key || !token?.session_token) {
    throw new UploadError('upstream', '豆包上传初始化失败：缺少 STS 或 service_id', { status: r.status, detail: r.json })
  }
  return {
    serviceId: String(data.service_id),
    uploadHost: String(data.upload_host || ''),
    token: {
      access_key: String(token.access_key),
      secret_key: String(token.secret_key),
      session_token: String(token.session_token),
    },
  }
}

async function applyImageUpload(
  ctx: UploadContext,
  prep: Awaited<ReturnType<typeof prepareUpload>>,
  bytes: Buffer,
  extension: string,
): Promise<{ storeUri: string; auth: string; uploadId: string; uploadHost: string }> {
  const url = new URL(
    `${ctx.baseUrl}${cfg.topPath}?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${encodeURIComponent(prep.serviceId)}` +
      `&NeedFallback=true&FileSize=${bytes.length}&FileExtension=${encodeURIComponent(`.${extension}`)}&s=${randomS()}`,
  )
  const headers = signV4({
    method: 'GET',
    url,
    body: Buffer.alloc(0),
    headers: { Referer: `${ctx.baseUrl}/chat/`, 'User-Agent': cfg.userAgent },
    accessKey: prep.token.access_key,
    secretKey: prep.token.secret_key,
    sessionToken: prep.token.session_token,
    signedHeaders: ['x-amz-date', 'x-amz-security-token'],
  })
  const r = await request(url.toString(), { method: 'GET', headers }, ctx.signal)
  assertSuccess(r.status, r.text, r.json)
  const address = r.json?.Result?.UploadAddress
  const info = address?.StoreInfos?.[0]
  if (!info?.StoreUri || !info?.Auth) {
    throw new UploadError('upstream', '豆包上传失败：ApplyImageUpload 未返回 StoreUri/Auth', { status: r.status, detail: r.json })
  }
  return {
    storeUri: String(info.StoreUri),
    auth: String(info.Auth),
    uploadId: String(info.UploadID || ''),
    uploadHost: String(address?.UploadHosts?.[0] || prep.uploadHost),
  }
}

async function tosUpload(
  ctx: UploadContext,
  info: { storeUri: string; auth: string; uploadHost: string },
  bytes: Buffer,
  name: string,
): Promise<void> {
  const scheme = new URL(ctx.baseUrl).protocol
  const path = info.storeUri.split('/').map((s) => encodeURIComponent(s)).join('/')
  const url = `${scheme}//${info.uploadHost}/upload/v1/${path}`
  const headers: Record<string, string> = {
    Authorization: info.auth,
    'Content-Type': 'application/octet-stream',
    'Content-CRC32': crc32Hex(bytes),
    'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
    'X-Storage-U': ctx.uid,
    Referer: `${ctx.baseUrl}/`,
    'User-Agent': cfg.userAgent,
  }
  const r = await request(url, { method: 'POST', headers, body: bytes as unknown as BodyInit }, ctx.signal)
  if (r.status < 200 || r.status >= 300) throw classifyFailure(r.status, r.text, r.json)
  if (!r.json) {
    throw new UploadError('upstream', '豆包对象存储上传失败：非 JSON 响应', {
      status: r.status,
      detail: r.text.slice(0, 500),
    })
  }
  if (Number(r.json.code) !== 2000) {
    throw new UploadError('upstream', `豆包对象存储上传失败：code=${r.json.code} ${r.json.message || ''}`.trim(), {
      status: r.status,
      code: Number(r.json.code),
      detail: r.json,
    })
  }
}

async function commitImageUpload(
  ctx: UploadContext,
  prep: Awaited<ReturnType<typeof prepareUpload>>,
  kind: AttachmentKind,
  info: { storeUri: string; auth: string; uploadId: string; uploadHost: string },
): Promise<{ width: number; height: number; format: string; size: number; md5: string }> {
  const sessionKey =
    kind === 'image'
      ? {
          accountType: 'ImageX',
          appId: '',
          bizType: '',
          fileType: 'image',
          legal: '',
          storeInfos: JSON.stringify([
            { StoreUri: info.storeUri, Auth: info.auth, UploadID: info.uploadId, UploadHeader: null, StorageHeader: null },
          ]),
          uploadHost: info.uploadHost,
          uri: info.storeUri,
          userId: '',
        }
      : { accountType: 'ImageX', appId: '', bizType: '', fileType: 'object', legal: '', uri: info.storeUri, userId: '' }
  const body = Buffer.from(JSON.stringify({ SessionKey: Buffer.from(JSON.stringify(sessionKey)).toString('base64') }))
  const url = new URL(
    `${ctx.baseUrl}${cfg.topPath}?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${encodeURIComponent(prep.serviceId)}`,
  )
  const headers = signV4({
    method: 'POST',
    url,
    body,
    headers: { 'Content-Type': 'application/json', Referer: `${ctx.baseUrl}/chat/`, 'User-Agent': cfg.userAgent },
    accessKey: prep.token.access_key,
    secretKey: prep.token.secret_key,
    sessionToken: prep.token.session_token,
    signedHeaders: ['x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token'],
  })
  const r = await request(url.toString(), { method: 'POST', headers, body: body as unknown as BodyInit }, ctx.signal)
  assertSuccess(r.status, r.text, r.json)
  const plugin = r.json?.Result?.PluginResult?.[0]
  if (!plugin) {
    throw new UploadError('upstream', '豆包上传失败：CommitImageUpload 未返回 PluginResult', { status: r.status, detail: r.json })
  }
  return {
    width: Number(plugin.ImageWidth || 0),
    height: Number(plugin.ImageHeight || 0),
    format: String(plugin.ImageFormat || ''),
    size: Number(plugin.ImageSize || 0),
    md5: String(plugin.ImageMd5 || ''),
  }
}

async function preHandle(
  ctx: UploadContext,
  kind: AttachmentKind,
  localMessageId: string,
  identifier: string,
  info: { name: string; storeUri: string; size: number; bytes: Buffer },
): Promise<void> {
  const url = `${ctx.baseUrl}${cfg.preHandlePath}?${queryOf(ctx)}`
  const entity =
    kind === 'image'
      ? {
          entity_type: 2,
          entity_content: { image: { key: info.storeUri } },
          identifier,
        }
      : {
          entity_type: 1,
          entity_content: {
            file: {
              file_name: info.name,
              key: info.storeUri,
              md5: md5Hex(info.bytes),
              file_type: 1,
              image: { key: info.storeUri },
              size: info.size,
            },
          },
          identifier,
        }
  const body = JSON.stringify({
    uplink_entity: entity,
    bot_id: cfg.botId,
    local_message_id: localMessageId,
  })
  const r = await request(url, { method: 'POST', headers: chatHeaders(ctx.jar, { stream: false }), body }, ctx.signal)
  assertSuccess(r.status, r.text, r.json)
}

/**
 * 上传一批附件。附件消息共用一个 local_message_id（与网页端一致），
 * 每个附件有自己的 identifier。
 */
export async function uploadAttachments(ctx: UploadContext, raws: RawAttachment[]): Promise<UploadBatch> {
  if (!cfg.uploadEnabled) {
    throw new UploadError('unsupported', '附件上传已禁用（DOUBAO_UPLOAD=0）')
  }
  if (!ctx.uid) {
    throw new UploadError('auth', '缺少账号 uid，无法上传附件；请重新登录豆包账号')
  }
  if (raws.length === 0) return { localMessageId: '', attachments: [] }
  if (raws.length > cfg.maxAttachments) {
    throw new UploadError('unsupported', `一次最多上传 ${cfg.maxAttachments} 个附件`)
  }
  const localMessageId = uuid()
  const attachments: UploadedAttachment[] = []
  for (const raw of raws) {
    const { bytes, name, mime } = await materialize(raw, ctx.signal)
    const extension = extensionFor(name, mime)
    const identifier = uuid()
    const prep = await prepareUpload(ctx, raw.kind)
    const applied = await applyImageUpload(ctx, prep, bytes, extension)
    await tosUpload(ctx, applied, bytes, name)
    const committed = await commitImageUpload(ctx, prep, raw.kind, applied)
    await preHandle(ctx, raw.kind, localMessageId, identifier, {
      name,
      storeUri: applied.storeUri,
      size: bytes.length,
      bytes,
    })
    attachments.push({
      kind: raw.kind,
      identifier,
      storeUri: applied.storeUri,
      name,
      size: bytes.length,
      mime,
      width: committed.width || undefined,
      height: committed.height || undefined,
      format: committed.format || extension,
    })
  }
  return { localMessageId, attachments }
}

/** 构造 10052 attachment_block 内容块 */
export function buildAttachmentBlock(batch: UploadBatch): any {
  const attachments = batch.attachments.map((item) => {
    const base = {
      type: item.kind === 'image' ? 1 : 3,
      identifier: item.identifier,
      parse_state: 0,
      review_state: 1,
      upload_status: 1,
      progress: 100,
      src: '',
    }
    if (item.kind === 'image') {
      return {
        ...base,
        image: {
          name: item.name,
          uri: item.storeUri,
          image_ori: {
            url: '',
            width: item.width || 0,
            height: item.height || 0,
            format: item.format || extensionFor(item.name, item.mime),
            url_formats: {},
          },
        },
      }
    }
    return {
      ...base,
      file: {
        uri: item.storeUri,
        url: '',
        file_type: 0,
        name: item.name,
        size: item.size,
      },
    }
  })
  return {
    block_type: 10052,
    content: { attachment_block: { attachments }, pc_event_block: '' },
    block_id: uuid(),
    parent_id: '',
    meta_info: [],
    extra_info: {},
    append_fields: [],
  }
}
