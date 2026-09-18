/**
 * QQ 网关连接注册表（per-agent 生命周期管理）。
 * 每 Momoi Agent 最多一条连接（1 用户 : N Agent : N 机器人 : N 会话）。
 * 启动时 initQqBots() 从 qq_bindings 恢复全部连接；凭证变更经
 * restartBotForUser 换连接（per-agent 锁串行化，防双连接双事件）。
 */
import { db, qqBindings } from '../db.js'
import { eq, and } from 'drizzle-orm'
import { QQGatewayConnection } from './gateway.js'
import { handleQqMessage, handleQqGroupMessage } from './chat.js'
import { withNamedLock } from '../im/locks.js'

interface ManagedConn {
  conn: QQGatewayConnection
  appId: string
  ready: boolean
}

/** key = `${userId}:${agentId}` */
const conns = new Map<string, ManagedConn>()

function connKey(userId: string, agentId: string): string {
  return `${userId}:${agentId}`
}

function lockKey(userId: string, agentId: string): string {
  return `qq-restart:${userId}:${agentId}`
}

export function isBotReady(userId: string, agentId: string): boolean {
  return conns.get(connKey(userId, agentId))?.ready ?? false
}

export function getBotAppId(userId: string, agentId: string): string | undefined {
  return conns.get(connKey(userId, agentId))?.appId
}

/** 读取绑定行；无行或凭证为空返回 null */
async function loadBinding(userId: string, agentId: string) {
  const row = await db.select().from(qqBindings)
    .where(and(
      eq(qqBindings.user_id, userId),
      eq(qqBindings.agent_id, agentId),
    )).get()
  if (!row || !row.app_id || !row.app_secret) return null
  return row
}

/** 连接回调里写 DB 前的新鲜度守卫：行仍在且凭证未换才允许写 */
async function freshRow(userId: string, agentId: string, appId: string) {
  const row = await loadBinding(userId, agentId)
  return row && row.app_id.trim() === appId ? row : null
}

async function markStatus(userId: string, agentId: string, appId: string, status: string, error: string): Promise<void> {
  const row = await freshRow(userId, agentId, appId)
  if (!row) return
  await db.update(qqBindings)
    .set({ status, error, updated_at: Math.floor(Date.now() / 1000) })
    .where(and(
      eq(qqBindings.user_id, userId),
      eq(qqBindings.agent_id, agentId),
    )).run()
}

async function startBotInner(userId: string, agentId: string): Promise<void> {
  const key = connKey(userId, agentId)
  const existing = conns.get(key)
  const row = await loadBinding(userId, agentId)

  // 幂等：已有连接且 appId 未变 → 跳过（防 initQqBots 与绑定并发双起）
  if (existing && row && existing.appId === row.app_id.trim()) return
  if (existing) {
    existing.conn.stop()
    conns.delete(key)
  }
  if (!row) return

  const appId = row.app_id.trim()
  const creds = { appId, appSecret: row.app_secret }
  const conn = new QQGatewayConnection({
    userId,
    creds,
    onMessage: (msg) => {
      void handleQqMessage({
        userId,
        agentId,
        appId,
        openid: msg.openid,
        msgId: msg.messageId,
        text: msg.content,
        messageId: msg.messageId,
      }).catch((e) => {
        console.error(`[qq:${key}] message handling failed:`, e instanceof Error ? e.message : e)
      })
    },
    onGroupMessage: (msg) => {
      void handleQqGroupMessage({
        userId,
        agentId,
        appId,
        groupOpenid: msg.groupOpenid,
        authorOpenid: msg.authorOpenid,
        authorUsername: msg.authorUsername,
        text: msg.content,
        messageId: msg.messageId,
        msgId: msg.messageId,
      }).catch((e) => {
        console.error(`[qq:${key}] group message handling failed:`, e instanceof Error ? e.message : e)
      })
    },
    onReady: () => {
      const entry = conns.get(key)
      if (entry) entry.ready = true
      void markStatus(userId, agentId, appId, 'connected', '')
    },
    onError: (message) => {
      const entry = conns.get(key)
      if (entry) entry.ready = false
      console.error(`[qq:${key}] connection error: ${message}`)
      void markStatus(userId, agentId, appId, 'error', `连接失败: ${message}`)
    },
    onFatal: (reason) => {
      console.error(`[qq:${key}] fatal: ${reason}`)
      const entry = conns.get(key)
      if (entry && entry.conn === conn) conns.delete(key)
      void markStatus(userId, agentId, appId, 'error', reason)
    },
  })

  conns.set(key, { conn, appId, ready: false })
  conn.start()
}

/** 为用户的指定 Agent 启动连接（幂等；per-agent 锁串行化） */
export async function startBotForUser(userId: string, agentId: string): Promise<void> {
  await withNamedLock(lockKey(userId, agentId), () => startBotInner(userId, agentId))
}

/** 停止并移除用户指定 Agent 的连接（同步、幂等） */
export function stopBotForUser(userId: string, agentId: string): void {
  const key = connKey(userId, agentId)
  const entry = conns.get(key)
  if (entry) {
    entry.conn.stop()
    conns.delete(key)
  }
}

/** 停止用户所有 QQ Bot 连接（admin 删用户 / user 改名等级联清理用） */
export function stopAllBotsForUser(userId: string): void {
  const prefix = `${userId}:`
  for (const [key, entry] of conns) {
    if (key.startsWith(prefix)) {
      entry.conn.stop()
      conns.delete(key)
    }
  }
}

/** 停止后重启（凭证变更 / 改名换 key 用；per-agent 锁串行化防双连接） */
export async function restartBotForUser(userId: string, agentId: string): Promise<void> {
  await withNamedLock(lockKey(userId, agentId), async () => {
    stopBotForUser(userId, agentId)
    await startBotInner(userId, agentId)
  })
}

/** 服务启动恢复：拉起所有已绑定 Agent 的连接（单个失败不影响其余） */
export async function initQqBots(): Promise<void> {
  const rows = await db.select().from(qqBindings).all()
  const results = await Promise.allSettled(
    rows.map((row: typeof qqBindings.$inferSelect) => startBotForUser(row.user_id, row.agent_id)),
  )
  const failed = results.filter((r) => r.status === 'rejected').length
  if (rows.length > 0) {
    console.log(`[qq] restored ${rows.length - failed}/${rows.length} bot connection(s)`)
  }
}