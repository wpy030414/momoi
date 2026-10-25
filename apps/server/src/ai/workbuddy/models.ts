/**
 * WorkBuddy 云端模型目录（`/v2/enterprises/personal/models`）。
 *
 * 目录随账号套餐变化，管理端 Agent 表单用它渲染模型下拉；这里只做拉取与
 * 归一化，不做缓存——下拉在每次打开表单时刷新，避免展示已被套餐移除的模型。
 * 401/403 与对话转发同语义：强制续期后重试一次。
 */

import type { GatewayModelOption } from '@momoi/shared/types'
import { workbuddyConfig as cfg } from './config.js'
import { forceRefresh, getAccessToken } from './token-manager.js'
import { gatewayHeaders } from './headers.js'
import type { WorkBuddyCredential } from './credentials.js'

const CATALOG_TIMEOUT_MS = 15_000

function requestCatalog(credential: WorkBuddyCredential): Promise<Response> {
  return fetch(`${cfg.baseUrl}${cfg.modelsPath}`, {
    method: 'GET',
    headers: gatewayHeaders(credential, { accept: 'application/json' }),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  })
}

/** 目录项归一化：丢弃无 id / 重复项与文生图模型，保留展示名与供应商 */
function normalize(list: unknown[]): GatewayModelOption[] {
  const seen = new Set<string>()
  const out: GatewayModelOption[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || seen.has(id)) continue
    const tags = Array.isArray(item.tags) ? item.tags : []
    if (tags.includes('text-to-image')) continue
    seen.add(id)
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const vendor = typeof item.vendor === 'string' ? item.vendor.trim() : ''
    out.push({ id, name: name && name !== id ? name : undefined, vendor: vendor || undefined })
  }
  return out
}

/** 拉取模型目录；未登录 / 上游异常时抛错，由调用方降级为「手动填写」 */
export async function fetchWorkBuddyModels(): Promise<GatewayModelOption[]> {
  let credential = await getAccessToken()
  let response = await requestCatalog(credential)
  if (response.status === 401 || response.status === 403) {
    credential = await forceRefresh()
    response = await requestCatalog(credential)
  }
  if (!response.ok) throw new Error(`模型目录拉取失败：HTTP ${response.status}`)

  const json = (await response.json()) as { data?: { models?: unknown } }
  const list = json?.data?.models
  if (!Array.isArray(list)) throw new Error('模型目录格式异常：data.models 缺失')
  return normalize(list)
}
