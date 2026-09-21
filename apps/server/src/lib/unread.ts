// ============================================================
// Unread — 会话未读计数（侧边栏红点的服务端权威口径）
// ============================================================
// 未读 = role='assistant' 且 created_at > conversations.last_read_at 的消息数。
// 口径必须与 GET /conversations 列表的 unread_count 子查询完全一致，
// 供 saveAssistantMsg / visit-greeting / IM 回复等「写入新消息」路径
// 广播 unread_update 时复用，避免各处内联 SQL 漂移。

import { db, conversations, messages } from '../db/index.js'
import { and, eq, count, sql } from 'drizzle-orm'

export async function countUnread(convId: string): Promise<number> {
  const res = await db.select({ unread: count() })
    .from(messages)
    .where(and(
      eq(messages.conversation_id, convId),
      eq(messages.role, 'assistant'),
      // 列名写显式「表.列」文本：drizzle 的 sql`` 模板渲染是否带表限定
      // 取决于所处上下文（WHERE 带、SELECT 字段不带），显式写死不依赖该行为
      sql`messages.created_at > COALESCE((SELECT conversations.last_read_at FROM conversations WHERE conversations.id = ${convId}), 0)`,
    ))
    .get()
  return Number(res?.unread ?? 0)
}
