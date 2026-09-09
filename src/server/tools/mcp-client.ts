// ============================================================
// MCP Client — HTTP+SSE transport for Model Context Protocol
// ============================================================
//
// 设计原则：
// 1. 通过 HTTP POST 发送 JSON-RPC 2.0 请求，不依赖 @modelcontextprotocol/sdk
// 2. 从 DB 读取 enabled 的 MCP 服务器配置，逐个初始化并拉取工具列表
// 3. 模块级缓存（5 分钟 TTL），工具列表按需刷新
// 4. MCP 服务器不可用时优雅降级，跳过该服务器继续其他工具
// 5. 工具名冲突处理：{serverName}/{toolName} 前缀
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

// ---- Cache ----

interface CacheEntry {
  servers: McpServerTools[]
  fetchedAt: number
}

let cache: CacheEntry | null = null
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ---- McpClient ----

class McpClient {
  private url: string
  private sessionId: string | null = null
  private requestId = 0

  constructor(url: string) {
    // Normalize: ensure no trailing slash
    this.url = url.replace(/\/+$/, '')
  }

  private async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId
    const req: McpJsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
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

    const body = (await response.json()) as McpJsonRpcResponse

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

    // Send initialized notification (no response expected)
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
    const result = await this.send<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }>('tools/call', { name, arguments: args })
    return result
  }
}

// ---- Public API ----

async function connectToServer(
  serverId: string,
  serverName: string,
  url: string,
): Promise<McpServerTools | null> {
  try {
    const client = new McpClient(url)
    await client.initialize()
    const tools = await client.listTools()
    console.log(`[mcp] Server "${serverName}" → ${tools.length} tools: ${tools.map((t) => t.name).join(', ') || '(none)'}`)
    return { serverId, serverName, serverUrl: url, tools }
  } catch (err) {
    console.warn(`[mcp] Failed to connect to "${serverName}" (${url}): ${(err as Error).message}`)
    return null
  }
}

async function refreshCache(): Promise<void> {
  const servers = await listMcpServers()
  const enabled = servers.filter((s) => s.enabled)

  if (enabled.length === 0) {
    cache = { servers: [], fetchedAt: Date.now() }
    return
  }

  console.log(`[mcp] Refreshing tool cache from ${enabled.length} server(s)...`)
  const results = await Promise.all(
    enabled.map((s) => connectToServer(s.id, s.name, s.url)),
  )

  cache = {
    servers: results.filter((r): r is McpServerTools => r !== null),
    fetchedAt: Date.now(),
  }
}

/**
 * Get all MCP tools from enabled servers, refreshing cache if stale.
 * Each tool name is prefixed with the server name to avoid collisions.
 */
export async function getMcpTools(): Promise<McpServerTools[]> {
  if (!cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
    await refreshCache()
  }
  return cache?.servers ?? []
}

/**
 * Call an MCP tool by its prefixed name (serverName/toolName).
 */
export async function callMcpTool(
  serverId: string,
  serverName: string,
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = new McpClient(serverUrl)
  await client.initialize()
  return client.callTool(toolName, args)
}

/**
 * Force refresh the MCP tool cache (e.g., after admin changes).
 */
export async function refreshMcpTools(): Promise<void> {
  await refreshCache()
}