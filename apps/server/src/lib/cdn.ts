import { randomUUID } from 'crypto'

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

// Simple rate limiter: ensure at least 1200ms between requests (safe under 5/5s limit)
let lastRequestTime = 0

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Upload an image buffer to img.scdn.io CDN.
 * Returns the public CDN URL.
 * Throws on failure.
 */
export async function uploadToCdn(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
  // Rate limit: wait until at least 1200ms since last request
  const now = Date.now()
  const wait = Math.max(0, 1200 - (now - lastRequestTime))
  if (wait > 0) await sleep(wait)
  lastRequestTime = Date.now()

  const boundary = randomUUID()
  const ext = (filename || 'image.png').split('.').pop() || 'png'
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="image"; filename="upload.${ext}"`,
    `Content-Type: ${mimeType || 'application/octet-stream'}`,
    '',
    '',
  ].join('\r\n')
  const footer = `\r\n--${boundary}--\r\n`
  const body = Buffer.concat([
    Buffer.from(header, 'utf-8'),
    buffer,
    Buffer.from(footer, 'utf-8'),
  ])

  const res = await fetch('https://img.scdn.io/api/v1.php', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  })

  if (res.status === 429) {
    // Rate limited — wait and retry once
    await sleep(5000)
    lastRequestTime = Date.now()
    return uploadToCdn(buffer, filename, mimeType)
  }

  if (res.status !== 200) {
    const text = await res.text().catch(() => '')
    throw new Error(`CDN upload failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`)
  }

  const json = await res.json() as { success: boolean; data?: { url?: string }; error?: string }
  if (!json.success || !json.data?.url) {
    throw new Error(`CDN upload failed: ${json.error || 'No URL in response'}`)
  }

  return json.data.url
}