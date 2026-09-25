// ============================================================
// web-push 懒加载器 — ESM/CJS 互操作的唯一权威入口
// ============================================================
// web-push 是 CJS 包：在 ESM 运行时下动态 import() 得到的命名空间对象
// 上，真正的导出挂在 .default（cjs-module-lexer 未必能静态探测出全部
// 具名导出，裸用 `mod.setVapidDetails` 会得到 undefined）。
//
// 本模块是 import('web-push') 的唯一入口（config.ts / push-scheduler.ts
// 等一律经由 getWebPush()），附带模块级缓存避免重复解包。
// 历史：af9d990 修过 config.ts 一处，f335447 重构时 push-scheduler.ts
// 又引入裸导入导致 bug 复活——集中于此就是为了杜绝第三次。

type WebPushModule = typeof import('web-push')

/**
 * VAPID subject（JWT sub 声明）。
 * ⚠ Apple (web.push.apple.com) 会校验 sub：伪 TLD（.local/.localhost）
 * 直接 403 BadJwtToken（实测 2026-09：mailto:no-reply@momoi.local 全拒，
 * 真实域名 / https URL 全 201）。默认值用实测可用的保留域名，
 * 生产环境应通过 PUSH_VAPID_SUBJECT 配置真实联系方式或站点 URL。
 */
export const VAPID_SUBJECT =
  process.env.PUSH_VAPID_SUBJECT || 'mailto:admin@example.com'

let cached: WebPushModule | null = null

/** 获取解包后的 web-push 模块（CJS default 兼容 + 缓存） */
export async function getWebPush(): Promise<WebPushModule> {
  if (cached) return cached
  const mod: unknown = await import('web-push')
  cached = ((mod as { default?: WebPushModule }).default ?? mod) as WebPushModule
  return cached
}
