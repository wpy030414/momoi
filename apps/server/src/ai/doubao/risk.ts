/**
 * 豆包上游风控标记。
 *
 * 71002200x 系列错误码表示需要人机验证 / 限流。服务端不尝试绕过验证码，
 * 只记录状态：管理端凭证面板展示提示，管理员在浏览器完成验证后调用
 * 「我已完成验证」清除标记，或重新扫码登录（登录成功亦清除）。
 */

let needsCaptcha = false

export function getNeedsCaptcha(): boolean {
  return needsCaptcha
}

export function markNeedsCaptcha(): void {
  needsCaptcha = true
}

export function resetNeedsCaptcha(): void {
  needsCaptcha = false
}
