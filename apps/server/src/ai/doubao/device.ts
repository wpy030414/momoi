/**
 * 豆包网页请求所需的伪设备标识。
 *
 * 网页端在每次请求的 query 中携带 device_id / web_id / tea_uuid / fp。
 * 这些值不是登录凭证，但与风控相关；登录时生成一次，随凭证持久化，
 * 使同一账号在本机的请求指纹保持稳定。
 */

import crypto from 'node:crypto'

export interface DeviceIdentity {
  deviceId: string
  webId: string
  fp: string
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomAlnum(length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += ALNUM[crypto.randomInt(0, ALNUM.length)]
  return s
}

/** 19 位数字，首位固定 7，接近网页端观测到的格式 */
function randomNineteenDigits(): string {
  let s = '7'
  for (let i = 1; i < 19; i++) s += String(crypto.randomInt(0, 10))
  return s
}

export function generateDeviceIdentity(): DeviceIdentity {
  const webId = randomNineteenDigits()
  return {
    deviceId: randomNineteenDigits(),
    webId,
    fp: `verify_${randomAlnum(8)}_${randomAlnum(4)}_${randomAlnum(4)}_${randomAlnum(4)}_${randomAlnum(12)}`,
  }
}

export function normalizeDeviceIdentity(input: Partial<DeviceIdentity> | undefined | null): DeviceIdentity {
  const base = generateDeviceIdentity()
  return {
    deviceId: typeof input?.deviceId === 'string' && input.deviceId.trim() ? input.deviceId.trim() : base.deviceId,
    webId: typeof input?.webId === 'string' && input.webId.trim() ? input.webId.trim() : base.webId,
    fp: typeof input?.fp === 'string' && input.fp.trim() ? input.fp.trim() : base.fp,
  }
}
