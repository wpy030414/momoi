/**
 * 业务错误（ApiError）—— 路由层错误的唯一抛出形式
 *
 * 序列化收口在 app.onError（index.ts）：wire 上只有 { code, params }，
 * 人类可读细节（log）与完整堆栈（cause）只进服务端日志，绝不上 wire。
 *
 * 用法：throw new ApiError(ErrCode.CONV_NOT_FOUND)
 *      throw new ApiError(ErrCode.UPLOAD_FAILED, { detail: err.message }, { log: '上传失败', cause: err })
 *      throw new ApiError(ErrCode.CONV_NOT_FOUND, undefined, { status: 403 })  // 覆盖默认 status
 */

import { ERR_REGISTRY, ErrCode, type ErrParams } from '@momoi/shared/errors'

export interface ApiErrorOptions {
  /** 覆盖注册表默认 HTTP status（仅语义确需不同的调用点使用） */
  status?: number
  /** 服务端日志用的人类可读细节（不上 wire） */
  log?: string
  /** 原始异常，保留堆栈用于日志 */
  cause?: unknown
}

export class ApiError extends Error {
  readonly code: ErrCode
  readonly params?: ErrParams
  readonly status: number
  readonly log?: string

  constructor(code: ErrCode, params?: ErrParams, opts?: ApiErrorOptions) {
    super(opts?.log ?? code, opts?.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'ApiError'
    this.code = code
    this.params = params
    this.status = opts?.status ?? ERR_REGISTRY[code].status
    this.log = opts?.log
  }
}
