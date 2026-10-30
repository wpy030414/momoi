/**
 * WorkBuddy 凭证存储：落 SQLite settings 表，AES-256-GCM 静态加密。
 *
 * 加密实现见 lib/encrypted-settings.ts；本模块只负责
 * WorkBuddy 凭证的形态校验。密钥键 `workbuddy_store_key`、值键
 * `workbuddy_credential` 均保持不变，存量凭证可原样读取。
 */

import {
  deleteSettingValue,
  readEncryptedSetting,
  writeEncryptedSetting,
} from '../../lib/encrypted-settings.js'

const CREDENTIAL_KEY = 'workbuddy_credential'
const STORE_KEY_KEY = 'workbuddy_store_key'

/** 落库的凭证精简形态（不存原始响应，避免把上游回包整包写进配置表） */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  uid: string
  domain: string
  nickname?: string
  expiresAt: number
  refreshExpiresAt?: number
  savedAt: number
}

/** 读取凭证；不存在或解不开返回 null（调用方按「未登录」处理） */
export async function readCredential(): Promise<WorkBuddyCredential | null> {
  try {
    const plain = await readEncryptedSetting(CREDENTIAL_KEY, STORE_KEY_KEY)
    if (!plain) return null
    const parsed = JSON.parse(plain) as WorkBuddyCredential
    if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null
    return parsed
  } catch (err) {
    console.warn(`[workbuddy] 读取本地凭证失败：${(err as Error).message}`)
    return null
  }
}

/** 写入凭证（整包替换）。refresh token 会轮换，因此每次续期都要写回。 */
export async function writeCredential(credential: WorkBuddyCredential): Promise<void> {
  await writeEncryptedSetting(CREDENTIAL_KEY, STORE_KEY_KEY, JSON.stringify(credential))
}

/** 清除凭证（退出登录） */
export async function clearCredential(): Promise<void> {
  await deleteSettingValue(CREDENTIAL_KEY)
}
