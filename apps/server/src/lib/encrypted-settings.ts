/**
 * settings 表上的加密值读写（AES-256-GCM，信封自描述）。
 *
 * 密钥是与库同存的随机 32 字节（由调用方指定 storeKey 键名）——本项目的
 * api_key 本就明文存库，加密在此处的意义是「凭证不以可读形式出现在表、
 * 备份与 SQL 查询结果里」，而非抵御拿到整库的攻击者。信封格式
 * `aesgcm:v1:<iv>:<tag>:<ciphertext>`（base64url）自描述，将来换密钥形态
 * 可平滑迁移。
 *
 * 由 WorkBuddy（refresh token）与 Doubao（网页 Cookie）两类上游凭证共用；
 * 读写各自独立的 valueKey / storeKey，互不影响。
 */

import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, settings } from '../db/index.js'

const ENVELOPE_PREFIX = 'aesgcm:v1:'

function encrypt(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${ENVELOPE_PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`
}

function decrypt(blob: string, key: Buffer): string {
  const [ivB64, tagB64, ctB64] = blob.slice(ENVELOPE_PREFIX.length).split(':')
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('凭证信封格式不合法')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'), { authTagLength: 16 })
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8')
}

/** 读取或生成存储密钥（首次使用时生成并落库） */
async function getStoreKey(storeKey: string): Promise<Buffer> {
  const existing = await db.select().from(settings).where(eq(settings.key, storeKey)).get()
  if (existing?.value) return crypto.createHash('sha256').update(existing.value, 'utf8').digest()

  const generated = crypto.randomBytes(32).toString('hex')
  await db.insert(settings).values({ key: storeKey, value: generated }).onConflictDoNothing().run()
  const row = await db.select().from(settings).where(eq(settings.key, storeKey)).get()
  return crypto.createHash('sha256').update(row?.value || generated, 'utf8').digest()
}

/** 读取并解密；不存在返回 null。兼容早期明文写入的行。 */
export async function readEncryptedSetting(valueKey: string, storeKey: string): Promise<string | null> {
  const row = await db.select().from(settings).where(eq(settings.key, valueKey)).get()
  if (!row?.value) return null
  if (!row.value.startsWith(ENVELOPE_PREFIX)) return row.value
  return decrypt(row.value, await getStoreKey(storeKey))
}

/** 加密写入（整包替换） */
export async function writeEncryptedSetting(valueKey: string, storeKey: string, plain: string): Promise<void> {
  const blob = encrypt(plain, await getStoreKey(storeKey))
  const existing = await db.select().from(settings).where(eq(settings.key, valueKey)).get()
  if (existing) {
    await db.update(settings).set({ value: blob }).where(eq(settings.key, valueKey)).run()
  } else {
    await db.insert(settings).values({ key: valueKey, value: blob }).run()
  }
}

/** 删除设置行（退出登录） */
export async function deleteSettingValue(valueKey: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, valueKey)).run()
}
