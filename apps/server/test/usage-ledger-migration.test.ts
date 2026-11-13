// ============================================================
// 迁移回归：usage_ledger 列名演化（micro → micro_credits → tokens）
// ============================================================
//
// 背景：账本口径在 D77 期间修订过两次，列名随之演化：
//   micro（μtoken）→ micro_credits（微积分）→ tokens（原始 token 数，积分改为派生量）
//
// 但建表用的是 `CREATE TABLE IF NOT EXISTS`——**表已存在时它什么都不做**，
// 新列永远不会补上。任何跑过旧版本的实例升级后都会在首次查询挂掉
// （`no such column: tokens`）。
//
// 本套件把每条历史升级路径都钉成显式门禁：
//   1. 最旧结构（micro 列）→ 逐级改名到 tokens，且数据保留
//   2. 中间结构（micro_credits 列）→ 改名到 tokens
//   3. 已是新结构（tokens）→ initSqlite 幂等，不报错
//   4. 全新库 → 建表即带 tokens

import { describe, it, expect, afterAll } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, mkdtempSync } from 'node:fs'
import { initSqlite } from '../src/db/sqlite.js'

const dir = mkdtempSync(join(tmpdir(), 'momoi-ledger-mig-'))

/** 列名列表 */

function columnsOf(client: DatabaseSync): string[] {
  return (client.prepare('PRAGMA table_info(usage_ledger)').all() as Array<{ name: string }>)
    .map((c) => c.name)
}

describe('usage_ledger 列名迁移', () => {
  it('旧结构 micro → tokens，且数据保留', async () => {
    const path = join(dir, 'legacy.db')
    // 造一个「只有旧列」的库（模拟首个开发版本的产物）
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT '',
        micro INTEGER NOT NULL,
        estimated INTEGER NOT NULL DEFAULT 0,
        week_start INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    raw.prepare('INSERT INTO usage_ledger (user_id, micro, week_start, created_at) VALUES (?,?,?,?)')
      .run('alice', 1234, 100, 200)
    raw.close()

    await initSqlite(path)

    const check = new DatabaseSync(path)
    const cols = columnsOf(check)
    expect(cols).toContain('tokens')
    expect(cols).not.toContain('micro')
    // 数据随列改名原样保留
    const row = check.prepare('SELECT user_id, tokens FROM usage_ledger').get() as
      | { user_id: string; tokens: number }
      | undefined
    expect(row?.user_id).toBe('alice')
    expect(row?.tokens).toBe(1234)
    check.close()
  })

  it('中间结构 micro_credits → tokens', async () => {
    const path = join(dir, 'mid.db')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT '',
        micro_credits INTEGER NOT NULL,
        estimated INTEGER NOT NULL DEFAULT 0,
        week_start INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    raw.prepare('INSERT INTO usage_ledger (user_id, micro_credits, week_start, created_at) VALUES (?,?,?,?)')
      .run('bob', 777, 100, 200)
    raw.close()

    await initSqlite(path)

    const check = new DatabaseSync(path)
    expect(columnsOf(check)).toContain('tokens')
    expect(columnsOf(check)).not.toContain('micro_credits')
    const row = check.prepare('SELECT user_id, tokens FROM usage_ledger').get() as
      | { user_id: string; tokens: number }
      | undefined
    expect(row?.user_id).toBe('bob')
    expect(row?.tokens).toBe(777)
    check.close()
  })

  it('已是新结构的库：initSqlite 幂等，不抛错', async () => {
    const path = join(dir, 'current.db')
    await initSqlite(path)
    // 连跑两次（真实场景就是每次重启都跑一遍）
    await expect(initSqlite(path)).resolves.toBeTruthy()

    const check = new DatabaseSync(path)
    expect(columnsOf(check)).toContain('tokens')
    check.close()
  })

  it('全新库：建表即带 tokens', async () => {
    const path = join(dir, 'fresh.db')
    await initSqlite(path)
    const check = new DatabaseSync(path)
    expect(columnsOf(check)).toContain('tokens')
    check.close()
  })
})

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 文件锁 */ }
})