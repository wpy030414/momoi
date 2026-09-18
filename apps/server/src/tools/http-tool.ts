// ============================================================
// HTTP Tool — Outbound HTTP requests with SSRF protection
// ============================================================

import dns from 'dns/promises'
import type { ToolModule, ToolResult } from './types.js'

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5 MB
const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_SEC = 30
const MAX_TIMEOUT_SEC = 120

/**
 * Check if an IP address is in a private/reserved range (SSRF protection).
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  if (ip.includes('.')) {
    const parts = ip.split('.').map(Number)
    // 0.0.0.0/8
    if (parts[0] === 0) return true
    // 10.0.0.0/8
    if (parts[0] === 10) return true
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true
    // 169.254.0.0/16 (link-local, cloud metadata)
    if (parts[0] === 169 && parts[1] === 254) return true
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true
    // 224.0.0.0/4 (multicast)
    if (parts[0] >= 224 && parts[0] <= 239) return true
    // 240.0.0.0/4 (reserved)
    if (parts[0] >= 240) return true
    return false
  }

  // IPv6
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  // fc00::/7 (unique local)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  // fe80::/10 (link-local)
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
  // ff00::/8 (multicast)
  if (lower.startsWith('ff')) return true

  return false
}

/** Resolve hostname to IP and check for private ranges */
async function resolveAndValidate(url: URL): Promise<void> {
  const hostname = url.hostname
  // If hostname is already an IP, validate directly
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || hostname.includes(':')) {
    if (isPrivateIP(hostname)) {
      throw new Error(`SSRF blocked: private IP address ${hostname}`)
    }
    return
  }

  // DNS resolve
  try {
    const results = await dns.lookup(hostname, { all: true })
    for (const result of results) {
      if (isPrivateIP(result.address)) {
        throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${result.address}`)
      }
    }
  } catch (err: any) {
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
      throw new Error(`DNS resolution failed for ${hostname}`)
    }
    throw err
  }
}

export const httpTool: ToolModule = {
  definition: {
    name: 'http_request',
    description: 'Make an outbound HTTP request. Returns the response body. Supports GET, POST, PUT, DELETE, PATCH, HEAD.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to request (http or https only)' },
        method: { type: 'string', description: 'HTTP method (default: GET)' },
        headers: { type: 'string', description: 'JSON object of request headers' },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30, max: 120)' },
      },
      required: ['url'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const urlStr = String(input.url)
    const method = String(input.method || 'GET').toUpperCase()
    const timeoutSec = Math.min(Number(input.timeout) || DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC)

    // Validate URL scheme
    let url: URL
    try {
      url = new URL(urlStr)
    } catch {
      return { summary: `Invalid URL: ${urlStr}`, error: true }
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { summary: `Blocked: only http and https schemes allowed`, error: true }
    }

    // SSRF protection: resolve hostname and check IP
    try {
      await resolveAndValidate(url)
    } catch (err) {
      return { summary: (err as Error).message, error: true }
    }

    // Parse headers
    let headers: Record<string, string> = {}
    if (input.headers) {
      try {
        headers = JSON.parse(String(input.headers))
      } catch {
        return { summary: 'Invalid headers JSON', error: true }
      }
    }

    // Build fetch options
    const fetchOptions: RequestInit = {
      method,
      headers,
      redirect: 'manual', // Handle redirects manually for SSRF re-validation
      signal: ctx.signal,
    }

    // Add body for methods that support it
    if (input.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOptions.body = String(input.body)
    }

    // Execute with timeout and redirect following
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000)
    if (ctx.signal) {
      ctx.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    fetchOptions.signal = controller.signal

    let currentUrl = url
    let response: Response | undefined

    try {
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        try {
          response = await fetch(currentUrl.toString(), fetchOptions)
        } catch (err: any) {
          if (err.name === 'AbortError') {
            return { summary: `Request timed out after ${timeoutSec}s`, error: true }
          }
          throw err
        }

        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          if (!location) break

          const nextUrl = new URL(location, currentUrl)
          // Re-validate redirect target for SSRF
          if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
            return { summary: `Blocked redirect to non-http scheme: ${nextUrl.protocol}`, error: true }
          }
          try {
            await resolveAndValidate(nextUrl)
          } catch (err) {
            return { summary: `Redirect blocked: ${(err as Error).message}`, error: true }
          }
          currentUrl = nextUrl
          continue
        }

        break
      }

      if (!response) {
        return { summary: `Too many redirects (max ${MAX_REDIRECTS})`, error: true }
      }

      // Read response body
      const contentType = response.headers.get('content-type') || ''
      const contentLength = Number(response.headers.get('content-length')) || 0

      if (contentLength > MAX_RESPONSE_SIZE) {
        return {
          summary: `Response too large: ${contentLength} bytes (limit: ${MAX_RESPONSE_SIZE})`,
          error: true,
        }
      }

      // Read as text for text-like responses, base64 for binary
      const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|\+json|\+xml)/.test(contentType)
        || contentType === ''

      let body: string
      let encoding: string

      if (isText) {
        const text = await response.text()
        if (text.length > MAX_RESPONSE_SIZE) {
          body = text.slice(0, MAX_RESPONSE_SIZE)
          encoding = `utf-8 (truncated, total ${text.length} chars)`
        } else {
          body = text
          encoding = 'utf-8'
        }
      } else {
        const buffer = await response.arrayBuffer()
        if (buffer.byteLength > MAX_RESPONSE_SIZE) {
          return { summary: `Response body exceeds ${MAX_RESPONSE_SIZE} bytes`, error: true }
        }
        body = Buffer.from(buffer).toString('base64')
        encoding = 'base64'
      }

      return {
        summary: `HTTP ${response.status} ${response.statusText}, ${body.length} chars (${contentType || 'unknown type'})`,
        data: {
          status: response.status,
          statusText: response.statusText,
          url: currentUrl.toString(),
          contentType,
          encoding,
          body,
          headers: Object.fromEntries(response.headers.entries()),
        },
      }
    } finally {
      clearTimeout(timeoutId)
    }
  },
}
