/**
 * 上游模型目录聚合：管理端 Agent 表单「模型」下拉的数据源。
 *
 * 三种上游各有来源：
 * - custom    : GET {api_endpoint}/models（OpenAI 兼容端点）
 * - workbuddy : WorkBuddy 云端模型目录（需已登录，见 workbuddy/models.ts）
 * - doubao    : 静态预设（豆包网页端没有可编程的目录接口）
 *
 * 拉取失败一律降级为「空列表 + warning」，绝不 500：模型永远允许管理员
 * 在表单里选「自定义」手动填写，下拉只是便利，不能成为保存 Agent 的前置条件。
 */

import type { AppConfig, GatewayModelList, GatewayModelOption } from '@momoi/shared/types'
import { listDoubaoModels } from './doubao/config.js'
import { fetchWorkBuddyModels } from './workbuddy/models.js'
import { getStatus as getWorkBuddyStatus } from './workbuddy/token-manager.js'

const CATALOG_TIMEOUT_MS = 10_000

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout 抛出的是 TimeoutError（message 为英文长句）
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return `请求超时（${CATALOG_TIMEOUT_MS / 1000}s）`
    return err.message
  }
  return String(err)
}

/**
 * 归一化 OpenAI 兼容端点的模型列表：
 * 标准形态是 `{ data: [{ id, owned_by }] }`，也容忍 `{ models: [...] }` 与字符串项。
 */
function normalizeModelList(list: unknown[]): GatewayModelOption[] {
  const seen = new Set<string>()
  const out: GatewayModelOption[] = []
  for (const raw of list) {
    let id = ''
    let name = ''
    let vendor = ''

    if (typeof raw === 'string') {
      id = raw.trim()
    } else if (raw && typeof raw === 'object') {
      const item = raw as Record<string, unknown>
      // 个别网关只给 name 不给 id；name 即调用时使用的模型名
      id = typeof item.id === 'string' ? item.id.trim() : typeof item.name === 'string' ? item.name.trim() : ''
      name = typeof item.name === 'string' ? item.name.trim() : ''
      vendor = typeof item.owned_by === 'string' ? item.owned_by.trim() : ''
      if (!vendor && typeof item.vendor === 'string') vendor = item.vendor.trim()
      // 与 WorkBuddy 目录同规则：文生图模型不是对话模型，不进下拉
      if (Array.isArray(item.tags) && item.tags.includes('text-to-image')) continue
    }

    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: name && name !== id ? name : undefined, vendor: vendor || undefined })
  }
  return out
}

async function fetchOpenAICompatibleModels(config: AppConfig): Promise<GatewayModelOption[]> {
  const endpoint = config.api_endpoint.trim().replace(/\/+$/, '')
  if (!endpoint) throw new Error('未配置 API 地址')

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.api_key) headers['Authorization'] = `Bearer ${config.api_key}`

  const response = await fetch(`${endpoint}/models`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const json = (await response.json()) as Record<string, unknown>
  const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : null
  if (!list) throw new Error('模型列表格式异常：data 缺失')
  return normalizeModelList(list)
}

/** 当前上游派发的模型目录；任何异常都降级为空列表 + warning */
export async function listGatewayModels(config: AppConfig): Promise<GatewayModelList> {
  if (config.gateway_source === 'doubao') {
    return { source: 'doubao', models: listDoubaoModels() }
  }

  if (config.gateway_source === 'workbuddy') {
    // 先看凭证：未登录时不必发起注定失败的目录请求，直接给出可操作的提示
    const status = await getWorkBuddyStatus()
    if (!status.logged_in) return { source: 'workbuddy', models: [], warning: 'not_logged_in' }
    try {
      return { source: 'workbuddy', models: await fetchWorkBuddyModels() }
    } catch (err) {
      return { source: 'workbuddy', models: [], warning: 'upstream_error', detail: errMessage(err) }
    }
  }

  try {
    return { source: 'custom', models: await fetchOpenAICompatibleModels(config) }
  } catch (err) {
    return { source: 'custom', models: [], warning: 'upstream_error', detail: errMessage(err) }
  }
}
