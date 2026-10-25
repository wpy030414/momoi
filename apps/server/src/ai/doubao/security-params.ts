/**
 * 豆包网页接口的公共 query 与请求头。
 *
 * 参数结构来自对 www.doubao.com 网页端的实测（移植自 xrp-doubao 的
 * docs/DOUBAO_REVERSE.md）。这里不生成 a_bogus：登录 Cookie + 完整设备参数
 * 在纯 HTTP 下可用；若上游风控升级，/chat/completion 会自动回退到
 * /samantha/chat/completion。
 */

import crypto from 'node:crypto'
import { doubaoConfig as cfg } from './config.js'
import type { CookieJar } from './cookie-jar.js'
import type { DeviceIdentity } from './device.js'

export function traceparent(): string {
  const traceId = crypto.randomBytes(16).toString('hex')
  const spanId = crypto.randomBytes(8).toString('hex')
  return `00-${traceId}-${spanId}-01`
}

function csrfFrom(jar: CookieJar): string {
  return jar.get('passport_csrf_token') || jar.get('passport_csrf_token_default') || ''
}

/** 网页端 /chat/completion 使用的 query 参数 */
export function webParams(device: DeviceIdentity, jar: CookieJar, extra: Record<string, string> = {}): Record<string, string> {
  const params: Record<string, string> = {
    aid: cfg.aid,
    real_aid: cfg.aid,
    device_id: device.deviceId,
    tea_uuid: device.webId,
    web_id: device.webId,
    device_platform: 'web',
    doubao_device_platform: 'web',
    pc_version: cfg.pcVersion,
    doubao_pc_version: cfg.pcVersion,
    pkg_type: 'release_version',
    version_code: '20800',
    language: 'zh',
    region: 'CN',
    sys_region: 'CN',
    samantha_web: '1',
    web_platform: 'browser',
    'use-olympus-account': '1',
    fp: device.fp,
    web_tab_id: crypto.randomUUID(),
    tz_name: 'Asia/Shanghai',
  }
  const msToken = jar.get('msToken')
  if (msToken) params.msToken = msToken
  return { ...params, ...extra }
}

/** 旧版 /samantha 端点使用的桌面端 query 参数（社区实测组合） */
export function desktopParams(device: DeviceIdentity, jar: CookieJar, extra: Record<string, string> = {}): Record<string, string> {
  const params: Record<string, string> = {
    aid: cfg.desktopAid,
    real_aid: cfg.desktopAid,
    device_id: device.deviceId,
    tea_uuid: device.webId,
    web_id: device.webId,
    device_platform: 'web',
    language: 'zh',
    region: 'CN',
    sys_region: 'CN',
    pkg_type: 'release_version',
    version_code: '20800',
    pc_version: '2.1.7',
    chromium_version: '147.0.7727.149',
    client_platform: 'pc_client',
    runtime: 'web',
    runtime_version: '3.5.4',
    samantha_web: '1',
    'use-olympus-account': '1',
    fp: device.fp,
    web_tab_id: crypto.randomUUID(),
  }
  const msToken = jar.get('msToken')
  if (msToken) params.msToken = msToken
  return { ...params, ...extra }
}

/** /passport/account/info/v2/ 等账号接口的 query 参数 */
export function accountParams(extra: Record<string, string> = {}): Record<string, string> {
  return {
    pc_version: cfg.pcVersion,
    version_code: '20800',
    language: 'zh',
    device_platform: 'web',
    aid: cfg.aid,
    real_aid: cfg.aid,
    pkg_type: 'release_version',
    'use-olympus-account': '1',
    region: '',
    sys_region: '',
    account_sdk_source: 'web',
    sdk_version: '2.2.10',
    doubao_from: 'inject_html',
    ...extra,
  }
}

export function loginHeaders(jar: CookieJar, csrf?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent': cfg.userAgent,
    'Referer': `${cfg.authBaseUrl}/chat/login`,
    'Origin': cfg.authBaseUrl,
    'x-requested-with': 'XMLHttpRequest',
  }
  const token = csrf || csrfFrom(jar)
  if (token) h['x-tt-passport-csrf-token'] = token
  const cookie = jar.getCookieHeader(`${cfg.authBaseUrl}/`)
  if (cookie) h.Cookie = cookie
  return h
}

export function chatHeaders(jar: CookieJar, opts: { stream: boolean; legacy?: boolean }): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': opts.stream ? 'text/event-stream' : 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/json',
    'Origin': cfg.baseUrl,
    'Referer': `${cfg.baseUrl}/chat/`,
    'User-Agent': cfg.userAgent,
    'agw-js-conv': 'str',
    'x-flow-trace': traceparent(),
    'sec-ch-ua': '"Chromium";v="147", "Not.A/Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  }
  if (opts.legacy) h['Agw-Js-Conv'] = 'str'
  const csrf = csrfFrom(jar)
  if (csrf) h['x-tt-passport-csrf-token'] = csrf
  const cookie = jar.getCookieHeader(`${cfg.baseUrl}/`)
  if (cookie) h.Cookie = cookie
  return h
}

export function toQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}
