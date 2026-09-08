// ============================================================
// DingTalk Token Tool — Server-side OAuth2 access token management
// ============================================================
// 设计原则：
// 1. 从 process.env 读取 DINGTALK_APP_KEY / DINGTALK_APP_SECRET（不暴露给 LLM/bash）
// 2. 调用钉钉 /v1.0/oauth2/accessToken 获取 token
// 3. 内存 + 磁盘双层缓存，提前 60s 刷新
// 4. Token 放在 data 字段返回给 LLM，summary 不暴露原始值
// ============================================================

import fs from 'fs'
import path from 'path'
import type { ToolModule, ToolResult } from './types.js'

const DINGTALK_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const TOKEN_CACHE_FILE = path.resolve('data', 'dingtalk-token.json')
const REFRESH_BUFFER_MS = 60_000 // 提前 60s 刷新
const REQUEST_TIMEOUT_MS = 15_000

interface TokenCache {
  accessToken: string
  expireTime: number // Date.now() + expireIn * 1000
}

/** 内存缓存：进程内快速读取 */
let memoryCache: TokenCache | null = null

/** 读取磁盘缓存 */
function loadDiskCache(): TokenCache | null {
  try {
    if (!fs.existsSync(TOKEN_CACHE_FILE)) return null
    const raw = fs.readFileSync(TOKEN_CACHE_FILE, 'utf-8')
    const data = JSON.parse(raw) as TokenCache
    if (!data.accessToken || typeof data.expireTime !== 'number') return null
    return data
  } catch {
    return null
  }
}

/** 写入磁盘缓存（权限 0o600，仅当前用户可读写） */
function saveDiskCache(cache: TokenCache): void {
  try {
    const dir = path.dirname(TOKEN_CACHE_FILE)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache), { mode: 0o600 })
  } catch (err) {
    console.warn('Failed to write dingtalk token cache:', (err as Error).message)
  }
}

/** 判断缓存是否有效 */
function isCacheValid(cache: TokenCache): boolean {
  return Date.now() < cache.expireTime - REFRESH_BUFFER_MS
}

/** 获取 access token：内存 → 磁盘 → API */
async function getAccessToken(): Promise<{ accessToken: string; cached: boolean }> {
  // 1. 内存缓存
  if (memoryCache && isCacheValid(memoryCache)) {
    return { accessToken: memoryCache.accessToken, cached: true }
  }

  // 2. 磁盘缓存
  const diskCache = loadDiskCache()
  if (diskCache && isCacheValid(diskCache)) {
    memoryCache = diskCache
    return { accessToken: diskCache.accessToken, cached: true }
  }

  // 3. 调用钉钉 API
  const appKey = process.env.DINGTALK_APP_KEY
  const appSecret = process.env.DINGTALK_APP_SECRET

  if (!appKey || !appSecret) {
    throw new Error(
      'DINGTALK_APP_KEY 或 DINGTALK_APP_SECRET 未配置。请在 .env 中设置这两个环境变量。'
    )
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(DINGTALK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey, appSecret }),
      signal: controller.signal,
    })
  } catch (err: any) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      throw new Error('获取钉钉 access token 超时（15s），请检查网络连接')
    }
    throw new Error(`无法连接钉钉 API: ${err.message}`)
  }
  clearTimeout(timeoutId)

  const body = await response.json() as Record<string, unknown>

  if (!response.ok || !body.accessToken) {
    const errMsg = body.message || body.errmsg || `HTTP ${response.status}`
    throw new Error(`钉钉 token 获取失败: ${errMsg}`)
  }

  const expireIn = (typeof body.expireIn === 'number' ? body.expireIn : 7200) as number
  const cache: TokenCache = {
    accessToken: body.accessToken as string,
    expireTime: Date.now() + expireIn * 1000,
  }

  memoryCache = cache
  saveDiskCache(cache)

  return { accessToken: cache.accessToken, cached: false }
}

export const dingtalkToken: ToolModule = {
  definition: {
    name: 'dingtalk_token',
    description:
      '获取钉钉开放平台 access token，用于后续通过 http_request 调用钉钉 API 时的认证。' +
      '返回的 token 需作为 x-acs-dingtalk-access-token 请求头传入。' +
      'token 有效期 7200 秒，工具自动缓存，仅在过期时重新获取。',
    input_schema: {
      type: 'object',
      properties: {
        force_refresh: {
          type: 'boolean',
          description: '是否强制刷新 token（忽略缓存，默认 false）',
        },
      },
      required: [],
    },
  },
  async execute(input): Promise<ToolResult> {
    const forceRefresh = input.force_refresh === true

    if (forceRefresh) {
      memoryCache = null
    }

    try {
      const { accessToken, cached } = await getAccessToken()

      // 对 token 做脱敏处理：仅显示前后各 4 位
      const masked = accessToken.length > 8
        ? `${accessToken.slice(0, 4)}…${accessToken.slice(-4)}`
        : '****'

      return {
        summary: `钉钉 access token ${cached ? '（缓存命中）' : '（新获取）'}: ${masked}`,
        data: { access_token: accessToken, cached },
      }
    } catch (err) {
      return {
        summary: `Error: ${(err as Error).message}`,
        error: true,
      }
    }
  },
}