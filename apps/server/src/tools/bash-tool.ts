// ============================================================
// Bash Tool — 受限 shell 执行
// 设计原则：沙盒 cwd + 超时终止 + 输出截断 + 破坏性命令拦截
// 平台：win32 用 cmd.exe，其余用 /bin/sh
// ============================================================

import { spawn } from 'child_process'
import type { ToolModule, ToolResult } from './types.js'

const DEFAULT_TIMEOUT_SEC = 30
const MAX_TIMEOUT_SEC = 120
const MAX_OUTPUT_CHARS = 30_000

/**
 * 子进程环境变量剔除名单（精确匹配，大写）。
 * 进程 env 被完整继承，而目录沙盒只约束 cwd——`set` / `echo %VAR%` 可以读出
 * 任意环境变量（包括 .env 注入的密钥），因此敏感 key 必须单独剔除。
 * 新增密钥时优先走下方 *_API_KEY / *_TOKEN 等通用规则，特例才加进此名单。
 */
const BLOCKED_ENV_VARS = [
  'ADMIN', // 管理员用户名名单，避免向会话内泄露管理员身份
]

/** 剔除敏感变量后构造子进程 env（精确名单 + 通用规则） */
function scrubEnv(): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (BLOCKED_ENV_VARS.includes(upper)) continue
    if (/(_API_?KEY|_TOKEN|_SECRET|PASSWORD|PASSWD|CREDENTIAL)/.test(upper)) continue
    scrubbed[key] = value
  }
  return scrubbed
}

/** 破坏性系统命令黑名单（子串匹配，大小写不敏感） */
const BLOCKED_SNIPPETS = [
  // 清盘 / 格式化 / 整盘写入
  'rm -rf /',
  'rm -fr /',
  'rm -rf /*',
  'del /s /q',
  'rd /s /q',
  'format c:',
  'format C:',
  'mkfs',
  'dd if=/dev/zero',
  'diskpart',
  // 系统级破坏
  'shutdown',
  'reboot',
  'hibernate',
  'sc delete',
  'reg delete',
]

export const bashTool: ToolModule = {
  definition: {
    name: 'bash',
    description: 'Execute a shell command in a sandboxed workspace (受限 bash)。用于运行 openyida 等 CLI 工具、处理文件或执行脚本。命令在工作区沙盒目录下运行，带超时与输出截断；破坏性系统命令（格式化/清盘/关机/删除整盘等）会被拦截；含密钥的环境变量（API key / token / 密码等）不会传给子进程。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '可选：相对工作区根的子目录，命令在此运行（默认工作区根目录）' },
        timeout: { type: 'number', description: `可选：超时秒数（默认 ${DEFAULT_TIMEOUT_SEC}，最大 ${MAX_TIMEOUT_SEC}）` },
      },
      required: ['command'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const command = String(input.command ?? '').trim()
    if (!command) {
      return { summary: 'Error: empty command', error: true, terminate: true }
    }

    // 破坏性命令拦截
    const lower = command.toLowerCase()
    const blocked = BLOCKED_SNIPPETS.find((s) => lower.includes(s))
    if (blocked) {
      return {
        summary: `Blocked: 命令包含不允许的破坏性片段 "${blocked}"。受限 bash 只允许常规命令。`,
        error: true,
        terminate: true,
      }
    }

    const timeoutSec = Math.min(Number(input.timeout) || DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC)

    // 确保工作区目录存在：首次会话目录尚未创建时，spawn 的 cwd 不存在会
    // 报出误导性的 "spawn cmd.exe ENOENT"（实际是 cwd 找不到，不是缺 shell）。
    ctx.workspace.ensureDir()

    // cwd 锁在工作区沙盒内
    let cwd = ctx.workspace.getRoot()
    if (input.cwd) {
      const rel = String(input.cwd).replace(/^[/\\]+/, '')
      try {
        const resolved = ctx.workspace.resolve(rel)
        const stat = await ctx.workspace.stat(rel).catch(() => null)
        if (!stat?.isDirectory()) {
          return { summary: `Error: cwd "${rel}" 不存在或不是目录`, error: true, terminate: true }
        }
        cwd = resolved
      } catch (e) {
        return { summary: `Error: cwd "${String(input.cwd)}" 非法: ${(e as Error).message}`, error: true, terminate: true }
      }
    }

    const isWin = process.platform === 'win32'
    const shell = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    // Windows 先切到 UTF-8 代码页，避免中文输出乱码
    const full = isWin ? `chcp 65001 >NUL & ${command}` : command

    return new Promise<ToolResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false

      const child = spawn(shell, isWin ? ['/d', '/s', '/c', full] : ['-c', full], {
        cwd,
        env: { ...scrubEnv(), PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        // 给杀进程一点余量，仍不退出则强杀
        setTimeout(() => { if (!settled) child.kill('SIGKILL') }, 1_000).unref?.()
      }, timeoutSec * 1000)

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })

      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ summary: `Error spawning shell: ${err.message}`, error: true })
      })

      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)

        const combined = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`
        const truncated = combined.length > MAX_OUTPUT_CHARS
        const content = truncated
          ? combined.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, total ${combined.length} chars)`
          : combined

        const header: string[] = []
        if (timedOut) header.push('⏱ 已超时终止')
        if (code !== 0) header.push(`exit code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`)
        const prefix = header.length ? header.join(', ') + '\n\n' : ''

        resolve({
          summary: `${prefix}${content || '(no output)'}`,
          error: code !== 0 || timedOut,
          data: { stdout, stderr, exitCode: code, signal, timedOut, truncated },
        })
      })
    })
  },
}