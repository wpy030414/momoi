import fs from 'fs'
import path from 'path'
import { createSqliteDb } from '@homurajs/db'
import { MIGRATION_SQL } from './ddl.js'
import { repoRoot } from '../lib/paths.js'

/**
 * 本地 SQLite（node:sqlite）初始化。
 *
 * 迁移背景（2026-10）：driver 由 sql.js（WASM 整库常驻内存 + 手动定时 export 落盘）
 * 换成 node:sqlite（每 commit 由 SQLite 自己 fsync）。根治实战暴露的数据丢失——
 * 服务器满载挤死进程（OOM/SIGKILL）时，sql.js 最近 ≤30s 的已提交数据随进程蒸发；
 * node:sqlite 的 synchronous=FULL 每笔 commit 落盘，持久性不依赖优雅退出。
 * 详见 docs/specs/module-database.md 与 docs/DECISIONS.md D2/D39。
 *
 * 复用 @homurajs/db 的 createSqliteDb（node:sqlite 的 drizzle 封装）；迁移仍用本仓
 * 手写 MIGRATION_SQL（CREATE TABLE IF NOT EXISTS）+ try/catch ALTER 补列，不引入
 * drizzle-kit 迁移产物。
 *
 * @param dbPath 可注入的库文件路径（测试用 temp 路径）；缺省 <repoRoot>/data/momoi.db
 */
export async function initSqlite(dbPath?: string) {
  const schema = await import('./schema.sqlite.js')

  const resolvedPath =
    dbPath ?? path.join((() => {
      const dataDir = path.resolve(repoRoot(), 'data')
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
      return dataDir
    })(), 'momoi.db')

  if (fs.existsSync(resolvedPath)) {
    console.log(`[db] Opening existing database: ${resolvedPath} (${(fs.statSync(resolvedPath).size / 1024).toFixed(1)} KB)`)
  } else {
    console.log(`[db] Creating new database: ${resolvedPath}`)
  }

  // node:sqlite 传路径即自动加载/建库（现存 sql.js 导出的标准 SQLite 文件原地可读）。
  const db = createSqliteDb({ dialect: 'sqlite', path: resolvedPath }) as any
  const client = db.$client

  // 外键：node:sqlite 默认强制（foreign_keys=ON），与旧 sql.js「不强制 + 路由层手动级联」
  // 语义相反。显式关掉以逐字还原既有行为——15+ 路由依赖宽松语义，且现存库可能已有悬空
  // 外键历史行（OFF 下无害）。拥抱真外键级联留作未来单独一轮，不在本次 driver 迁移内。
  client.exec('PRAGMA foreign_keys = OFF')
  // 防御性：单连接下无并发锁，但设一个 busy_timeout 无害，且为未来多 handle 留余地。
  client.exec('PRAGMA busy_timeout = 5000')

  // Run migrations（node:sqlite 的 DatabaseSync 用 exec 跑裸 SQL；支持多语句一次执行）
  client.exec(MIGRATION_SQL)

  // Migration: add last_read_at for unread tracking (safe to run, throws if column exists)
  try {
    client.exec(`ALTER TABLE conversations ADD COLUMN last_read_at INTEGER`)
    console.log('[db] Migration: added last_read_at to conversations')
  } catch {
    // Column already exists, safe to ignore
  }

  // Migration: add workspace_id (分组工作区，创建时锁定；见 docs/specs/module-workspace.md)
  try {
    client.exec(`ALTER TABLE conversations ADD COLUMN workspace_id TEXT`)
    console.log('[db] Migration: added workspace_id to conversations')
  } catch {
    // Column already exists, safe to ignore
  }

  // Migration: add stats (会话状态条统计 JSON；见 docs/specs/module-chat.md 状态条章节)
  try {
    client.exec(`ALTER TABLE conversations ADD COLUMN stats TEXT`)
    console.log('[db] Migration: added stats to conversations')
  } catch {
    // Column already exists, safe to ignore
  }

  // Migration: add states / state_values（世界模拟「Agent 状态」；见 docs/specs/module-world.md）
  // 无 DEFAULT：旧库既有行读到 NULL 由 lib/world-state.ts 统一容错（跟随 stats 先例）
  try {
    client.exec(`ALTER TABLE worlds ADD COLUMN states TEXT`)
    console.log('[db] Migration: added states to worlds')
  } catch {
    // Column already exists, safe to ignore
  }
  try {
    client.exec(`ALTER TABLE worlds ADD COLUMN state_values TEXT`)
    console.log('[db] Migration: added state_values to worlds')
  } catch {
    // Column already exists, safe to ignore
  }

  // Migration: add standing_art（智能体立绘；仅单聊聊天区上半屏展示）
  try {
    client.exec(`ALTER TABLE agents ADD COLUMN standing_art TEXT NOT NULL DEFAULT ''`)
    console.log('[db] Migration: added standing_art to agents')
  } catch {
    // Column already exists, safe to ignore
  }

  // Migration: OAuth2 → OIDC（表 user_oauth_bindings 改名 user_oidc_bindings）
  // 旧表不删——已部署实例升级后可回退；INSERT OR IGNORE 依赖 UNIQUE(provider_id, provider_user_id)
  // 保证重复启动幂等。旧表不存在（全新部署）时 try 内语句会抛错，被 catch 吞掉。
  try {
    client.exec(`INSERT OR IGNORE INTO user_oidc_bindings SELECT * FROM user_oauth_bindings`)
    console.log('[db] Migration: copied user_oauth_bindings → user_oidc_bindings')
  } catch {
    // 旧表不存在或无数据，safe to ignore
  }

  // Persistent index creation — safe to run on every startup
  client.exec(`CREATE INDEX IF NOT EXISTS idx_qq_group_conv_app ON qq_group_conversations(app_id)`)
  client.exec(`CREATE INDEX IF NOT EXISTS idx_qq_bindings_conv ON qq_bindings(conversation_id)`)
  client.exec(`CREATE INDEX IF NOT EXISTS idx_wechat_bindings_conv ON wechat_bindings(conversation_id)`)
  client.exec(`CREATE INDEX IF NOT EXISTS idx_oidc_user ON user_oidc_bindings(user_id)`)
  client.exec(`CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id)`)

  console.log('[db] SQLite (node:sqlite) ready')
  return { db, schema }
}
