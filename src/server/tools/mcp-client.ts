// ============================================================
// MCP Client — HTTP+SSE transport for Model Context Protocol
// ============================================================
//
// 设计原则：
// 1. 通过 HTTP POST 发送 JSON-RPC 2.0 请求，不依赖 @modelcontextprotocol/sdk
// 2. 严格遵循 MCP Streamable HTTP Transport (2024-11-05) 规范
// 3. 每次无 Mcp-Session-Id header 的请求即发起新会话
// 4. 从 DB 读取 enabled 的 MCP 服务器配置，逐个初始化并拉取工具列表
// 5. 模块级缓存持有持久会话（McpClient 实例 + 工具列表），按 TTL 刷新
// 6. 工具调用复用已建立的会话
// 7. MCP 服务器不可用时优雅降级，跳过该服务器继续其他工具
// 8. 工具名冲突处理：{serverName}/{toolName} 前缀
//
// ============================================================

import { listMcpServers } from '../config.js'

// ---- Types ----

interface McpJsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

interface McpJsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, { type: string; description?: string; items?: { type: string } }>
    required?: string[]
  }
}

interface McpServerTools {
  serverId: string
  serverName: string
  serverUrl: string
  tools: McpToolDefinition[]
}

// ---- McpClient ----

class McpClient {
  private url: string
  private sessionId: string | null = null
  private requestId = 0

  constructor(url: string) {
    this.url = url.replace(/\/+$/, '')
  }

  private async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId
    const req: McpJsonRpcRequest = { jsonrpc: '2.0', id, method, params }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15_000)

    let response: Response
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    // Extract session ID from response header
    const sid = response.headers.get('Mcp-Session-Id')
    if (sid) {
      this.sessionId = sid
    }

    const contentType = response.headers.get('Content-Type') || ''

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`)
    }

    let body: McpJsonRpcResponse

    if (contentType.includes('text/event-stream')) {
      const sseText = await response.text()
      const dataMatch = sseText.match(/^data:\s*(.+)$/m)
      if (!dataMatch) {
        throw new Error(`MCP SSE parse error: no data field in response`)
      }
      body = JSON.parse(dataMatch[1]) as McpJsonRpcResponse
    } else {
      body = (await response.json()) as McpJsonRpcResponse
    }

    if (body.error) {
      throw new Error(`MCP error ${body.error.code}: ${body.error.message}`)
    }

    return body.result as T
  }

  async initialize(): Promise<void> {
    const result = await this.send<{
      protocolVersion: string
      capabilities: Record<string, unknown>
      serverInfo?: { name: string; version: string }
    }>('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'momoi', version: '1.0.0' },
    })

    // Send initialized notification (optional per spec)
    try {
      await this.send('notifications/initialized')
    } catch {
      // Some servers don't support this; ignore
    }

    console.log(`[mcp] Initialized ${this.url}: ${result.serverInfo?.name || 'unknown'} v${result.protocolVersion}`)
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.send<{ tools: McpToolDefinition[] }>('tools/list')
    return result.tools || []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.send<{
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
      isError?: boolean
    }>('tools/call', { name, arguments: args })
    return result
  }
}

// ---- Persistent Session Cache ----

interface SessionEntry {
  client: McpClient
  servers: McpServerTools
  fetchedAt: number
}

/** key = `${serverId}:${serverUrl}` */
const sessions = new Map<string, SessionEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000

function sessionKey(serverId: string, url: string): string {
  return `${serverId}:${url}`
}

// ---- Public API ----

async function connectToServer(
  serverId: string,
  serverName: string,
  url: string,
): Promise<SessionEntry | null> {
  const key = sessionKey(serverId, url)

  // 复用已有会话（未过期）
  const existing = sessions.get(key)
  if (existing && Date.now() - existing.fetchedAt <= CACHE_TTL_MS) {
    try {
      const tools = await existing.client.listTools()
      existing.servers.tools = tools
      existing.fetchedAt = Date.now()
      console.log(`[mcp] Server "${serverName}" (reused session) → ${tools.length} tools`)
      return existing
    } catch {
      console.warn(`[mcp] Server "${serverName}" session expired, reconnecting...`)
      sessions.delete(key)
    }
  }

  try {
    const client = new McpClient(url)
    await client.initialize()
    const tools = await client.listTools()
    console.log(`[mcp] Server "${serverName}" → ${tools.length} tools: ${tools.map((t) => t.name).join(', ') || '(none)'}`)

    const entry: SessionEntry = {
      client,
      servers: { serverId, serverName, serverUrl: url, tools },
      fetchedAt: Date.now(),
    }
    sessions.set(key, entry)
    return entry
  } catch (err) {
    console.warn(`[mcp] Failed to connect to "${serverName}" (${url}): ${(err as Error).message}`)
    return null
  }
}

async function refreshCache(): Promise<void> {
  const servers = await listMcpServers()
  const enabled = servers.filter((s) => s.enabled)

  for (const s of enabled) {
    await connectToServer(s.id, s.name, s.url)
  }

  // 清理已不在配置中的旧会话
  for (const [key] of sessions) {
    const stillEnabled = enabled.some((s) => key === sessionKey(s.id, s.url))
    if (!stillEnabled) {
      sessions.delete(key)
    }
  }
}

export async function getMcpTools(): Promise<McpServerTools[]> {
  const result: McpServerTools[] = []
  for (const [, entry] of sessions) {
    if (Date.now() - entry.fetchedAt <= CACHE_TTL_MS) {
      result.push(entry.servers)
    }
  }

  if (result.length === 0) {
    await refreshCache()
    for (const [, entry] of sessions) {
      result.push(entry.servers)
    }
  }

  // 后台异步刷新过期条目
  const needsRefresh = [...sessions.values()].some(
    (e) => Date.now() - e.fetchedAt > CACHE_TTL_MS,
  )
  if (needsRefresh) {
    refreshCache().catch((err) =>
      console.warn('[mcp] Background refresh failed:', (err as Error).message),
    )
  }

  return result
}

export async function callMcpTool(
  serverId: string,
  serverName: string,
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const key = sessionKey(serverId, serverUrl)
  let entry = sessions.get(key)

  if (!entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    const result = await connectToServer(serverId, serverName, serverUrl)
    if (!result) {
      throw new Error(`MCP server "${serverName}" is unavailable`)
    }
    entry = result
  }

  return entry.client.callTool(toolName, args)
}

export async function refreshMcpTools(): Promise<void> {
  sessions.clear()
  await refreshCache()
}