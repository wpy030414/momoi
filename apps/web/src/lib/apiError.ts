// 客户端业务错误——服务端 { code, params } 信封的解析与承载。
// code 为 string（而非 ErrCode）：容忍比本地注册表新/旧的未知码，
// 展示兜底由 errT()（i18n）处理。

import type { ErrParams } from '@momoi/shared/errors'

export class ApiError extends Error {
  readonly code: string
  readonly params?: ErrParams
  readonly status: number
  /** 完整响应体（保留 prompts targets 等附加字段供调用方读取） */
  readonly body?: unknown

  constructor(code: string, status: number, params?: ErrParams, body?: unknown) {
    super(code)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.params = params
    this.body = body
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

/** 从 SSE error 事件等 {code, params} 信封构造（无 HTTP status，名义 0） */
export function errFromEnvelope(env: { code: string; params?: ErrParams }): ApiError {
  return new ApiError(env.code, 0, env.params)
}

/**
 * 任意非 2xx Response → ApiError。
 * 非 JSON / 旧形状 / 缺 code 时兜底为 UNKNOWN + statusText（防遗漏与反代注入）。
 */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  const env = (body ?? {}) as { code?: unknown; params?: unknown }
  if (typeof env.code === 'string' && env.code) {
    const params =
      env.params && typeof env.params === 'object' && !Array.isArray(env.params)
        ? (env.params as ErrParams)
        : undefined
    return new ApiError(env.code, res.status, params, body)
  }
  return new ApiError('UNKNOWN', res.status, { detail: res.statusText || `HTTP ${res.status}` })
}
