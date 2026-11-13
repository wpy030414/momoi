// ============================================================
// 会话状态快照的落库口（唯一实现，各渠道共用）
// ============================================================
//
// 写的是 `conversations.stats` 这一个 JSON 列：状态条快照每次**覆盖写**，会话累计
// （`totalTokens`）**只增不减**。口径与合并规则见 ai/conversation-stats.ts（纯函数）。
//
// 为什么放在 lib/ 而不是 ai/：这里依赖 db（ai/conversation-stats.ts 保持纯函数，
// 测试导入它时不会触发建库副作用）。
//
// 所有渠道共用（网页 / QQ / 微信）——「整个会话消耗」必须把每个渠道的生成都算进来，
// 否则绑定了 IM 的会话在网页端会显示偏小的数。
//
// 并发：累计是「读旧值 → 加增量 → 写回」。同一会话真并发两个生成（网页双设备同时
// 发；IM 侧有 im/locks.ts 的会话锁、网页侧无锁）理论上会丢一次增量——概率极低且只
// 影响一个会话的累计数值。真需要时的解法是改成「每次生成追加一行用量流水、总额读时
// 求和」，见 docs/DECISIONS.md D52。

import { db, conversations } from '../db/index.js'
import { eq } from 'drizzle-orm'
import type { ConversationStats } from '@momoi/shared/types'
import { mergeCumulativeTotals, parseCumulativeTotals, type CumulativeTotals } from '../ai/conversation-stats.js'
import { recordUsage } from './quota.js'

export async function persistConversationStats(
  convId: string,
  stats: ConversationStats | undefined,
  bill?: { billTokens: number; billEstimated: boolean; priorBillEstimate: number },
  /** 消耗归属者（周额度账本用）；缺省时按空串记入实例总额度。 */
  userId?: string,
): Promise<void> {
  if (!stats || !convId) return
  try {
    let cumulative: CumulativeTotals | null = null
    if (bill) {
      const row = await db.select({ stats: conversations.stats })
        .from(conversations).where(eq(conversations.id, convId)).get()
      cumulative = mergeCumulativeTotals(
        parseCumulativeTotals(row?.stats),
        { tokens: bill.billTokens, estimated: bill.billEstimated },
        bill.priorBillEstimate,
      )
    }
    await db.update(conversations)
      .set({ stats: JSON.stringify(cumulative ? { ...stats, ...cumulative } : stats) })
      .where(eq(conversations.id, convId))
      .run()
  } catch (err) {
    console.error('[stats] Failed to persist conversation stats:', (err as Error).message)
  }

  // 周额度账本（与快照同一口径、同一落点）：每次生成追加一行流水，
  // 与上面的「读旧值 → 加增量 → 写回」不同，这里是纯追加，无竞态可丢。
  // 失败开放——账本写失败绝不中断对话。
  if (bill && bill.billTokens > 0) {
    await recordUsage(userId || '', convId, bill.billTokens, bill.billEstimated)
  }
}
