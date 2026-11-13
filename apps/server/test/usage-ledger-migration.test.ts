// ============================================================
// 迁移回归：usage_ledger.micro → micro_credits
// ============================================================
//
// 背景：D77 修订把账本口径从 μtoken 改成微积分，列名随之从 `micro` 改为
// `micro_credits`。但建表用的是 `CREATE TABLE IF NOT EXISTS`——**表已存在时
// 它什么都不做**，新列永远不会补上。任何跑过首个开发版本的实例升级后都会在
// 首次查询挂掉（`no such column: micro_credits`）。
//
// 本套件把这条升级路径钉成显式门禁：
//   1. 旧结构（micro 列）的库 → initSqlite 后列名变成 micro_credits
//   2. 新结构（已有 micro_credits）的库 → initSqlite 不报错（幂等）
//   3. 迁移不丢数据：旧列里的行在改名后原样保留

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
  it('旧结构 micro → micro_credits，且数据保留', async () => {
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
    expect(cols).toContain('micro_credits')
    expect(cols).not.toContain('micro')
    // 数据随列改名原样保留
    const row = check.prepare('SELECT user_id, micro_credits FROM usage_ledger').get() as
      | { user_id: string; micro_credits: number }
      | undefined
    expect(row?.user_id).toBe('alice')
    expect(row?.micro_credits).toBe(1234)
    check.close()
  })

  it('已是新结构的库：initSqlite 幂等，不抛错', async () => {
    const path = join(dir, 'current.db')
    await initSqlite(path)
    // 连跑两次（真实场景就是每次重启都跑一遍）
    await expect(initSqlite(path)).resolves.toBeTruthy()

    const check = new DatabaseSync(path)
    expect(columnsOf(check)).toContain('micro_credits')
    check.close()
  })

  it('全新库：建表即带 micro_credits', async () => {
    const path = join(dir, 'fresh.db')
    await initSqlite(path)
    const check = new DatabaseSync(path)
    expect(columnsOf(check)).toContain('micro_credits')
    check.close()
  })
})

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 文件锁 */ }
})