/**
 * 通用 Server-Sent Events 解析器。
 *
 * 只做协议层解析：按空行分发事件，支持 event / data / id / retry / 注释行。
 * 上层的豆包事件语义在 client.ts 中处理。
 */

export interface SseEvent {
  event: string
  data: string
  id?: string
  retry?: number
}

export async function* iterateSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  let id: string | undefined
  let retry: number | undefined

  const dispatch = (): SseEvent | null => {
    if (dataLines.length === 0 && !eventName) return null
    const ev: SseEvent = {
      event: eventName || 'message',
      data: dataLines.join('\n'),
      ...(id !== undefined ? { id } : {}),
      ...(retry !== undefined ? { retry } : {}),
    }
    eventName = ''
    dataLines = []
    id = undefined
    retry = undefined
    return ev
  }

  const processLine = (line: string): SseEvent | null => {
    if (line === '') return dispatch()
    if (line.startsWith(':')) return null
    const idx = line.indexOf(':')
    const field = idx >= 0 ? line.slice(0, idx) : line
    let value = idx >= 0 ? line.slice(idx + 1) : ''
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'event':
        eventName = value
        break
      case 'data':
        dataLines.push(value)
        break
      case 'id':
        id = value
        break
      case 'retry': {
        const n = Number(value)
        if (Number.isFinite(n)) retry = n
        break
      }
      default:
        break
    }
    return null
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        const ev = processLine(line)
        if (ev) yield ev
      }
    }
    buffer += decoder.decode()
    // 尾行（没有换行）也要处理
    if (buffer.length > 0) {
      let line = buffer
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const ev = processLine(line)
      if (ev) yield ev
    }
    const ev = dispatch()
    if (ev) yield ev
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* noop */
    }
  }
}
