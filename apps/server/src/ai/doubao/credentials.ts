/**
 * Doubao 凭证存储：落 SQLite settings 表，AES-256-GCM 静态加密
 * （加密实现见 lib/encrypted-settings.ts，与 WorkBuddy 凭证共用）。
 *
 * 豆包登录没有 refresh token；sessionid 等 Cookie 即会话本身，失效只能重新扫码。
 * Cookie 只以密文形态出现在表、备份与 SQL 查询结果里，日志与接口均不回传明文。
 */

import { deleteSettingValue, readEncryptedSetting, writeEncryptedSetting } from '../../lib/encrypted-settings.js'
import { normalizeDeviceIdentity, type DeviceIdentity } from './device.js'
import type { CookieRecord } from './cookie-jar.js'

const CREDENTIAL_KEY = 'doubao_credential'
const STORE_KEY_KEY = 'doubao_store_key'

/** 加密落库的会话形态 */
export interface DoubaoSession {
  cookies: CookieRecord[]
  device: DeviceIdentity
  uid: string
  nickname: string
  savedAt: number
}

function normalizeSession(input: unknown): DoubaoSession | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<DoubaoSession>
  if (!Array.isArray(raw.cookies) || raw.cookies.length === 0) return null
  const cookies = raw.cookies.filter(
    (c): c is CookieRecord => Boolean(c) && typeof (c as CookieRecord).name === 'string' && typeof (c as CookieRecord).value === 'string',
  )
  if (cookies.length === 0) return null
  return {
    cookies,
    device: normalizeDeviceIdentity(raw.device),
    uid: typeof raw.uid === 'string' ? raw.uid : '',
    nickname: typeof raw.nickname === 'string' ? raw.nickname : '',
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : Date.now(),
  }
}

/** 读取凭证；不存在或损坏返回 null（调用方按「未登录」处理） */
export async function readSession(): Promise<DoubaoSession | null> {
  try {
    const plain = await readEncryptedSetting(CREDENTIAL_KEY, STORE_KEY_KEY)
    if (!plain) return null
    return normalizeSession(JSON.parse(plain))
  } catch (err) {
    console.warn(`[doubao] 读取本地凭证失败：${(err as Error).message}`)
    return null
  }
}

/** 写入凭证（整包替换） */
export async function writeSession(session: DoubaoSession): Promise<void> {
  const normalized = normalizeSession(session)
  if (!normalized) throw new Error('豆包凭证缺少 Cookie，拒绝写入')
  await writeEncryptedSetting(CREDENTIAL_KEY, STORE_KEY_KEY, JSON.stringify(normalized))
}

/** 清除凭证（退出登录） */
export async function clearSession(): Promise<void> {
  await deleteSettingValue(CREDENTIAL_KEY)
}
