/**
 * 豆包上游登录链路的公共契约。
 *
 * 两条链路共享「取二维码 → 轮询 → 拿会话」的状态机形状：
 *   douyin（默认）= 无头浏览器走豆包登录弹窗 → 抖音官方授权页，二维码是抖音授权码；
 *   doubao        = 纯 HTTP 豆包自助扫码，无浏览器依赖，作为灾备链路。
 */

import type { DoubaoSession } from './credentials.js'

export interface QrCodePayload {
  token: string
  /** 二维码 PNG data URL */
  qrDataUrl: string
  /** 毫秒时间戳；未知时缺省（抖音授权页的二维码有效期由页面自己管理） */
  expireAt?: number
}

export type QrPollStatus = 'new' | 'scanned' | 'confirmed' | 'expired' | 'refused' | 'error'

export interface QrPollResult {
  status: QrPollStatus
  message: string
  /** 仅 status='confirmed' 时存在 */
  session?: DoubaoSession
  /** 页面可能自行刷新二维码；存在时管理端用新图替换旧图 */
  qr?: QrCodePayload
}

export type LoginFlowKind = 'douyin' | 'doubao'

export interface LoginFlowDriver {
  readonly kind: LoginFlowKind
  /** 启动登录准备并返回二维码（抖音链路会拉起无头浏览器） */
  begin(): Promise<QrCodePayload>
  /** 轮询一次状态；可在 await begin() 之后重复调用 */
  poll(): Promise<QrPollResult>
  /** 关闭浏览器 / 释放资源（幂等） */
  close(): Promise<void>
}
