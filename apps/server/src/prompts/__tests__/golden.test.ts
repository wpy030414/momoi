// ============================================================
// 提示词黄金快照测试
// ============================================================
// 锁定「每个配方的最终提示词文本」：任何改动都会在这里显形。
//
// 快照来源：迁移前基线（旧实现逐字节比对通过后写入，见 DECISIONS.md）。
// 时间戳/相对时间在生成时已被替换为占位符（<DATETIME> / <N> 分钟前），
// 比对同样先做替换，保证与运行时刻无关。
//
// 需要更新快照（刻意的提示词变更）：
//   UPDATE_PROMPTS_GOLDEN=1 pnpm --filter @momoi/server test
// ============================================================

import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildChatSystemPrompt,
  buildFollowUpSystemPrompt,
  buildFollowUpUserMessage,
  buildSuggestionsSystemPrompt,
  buildSuggestionsUserMessage,
  buildOrchestrationSystemPrompt,
  buildOrchestrationUserMessage,
  buildGreetingInstruction,
  buildPushInstruction,
  getFabricatedReply,
  getRetryPlaceholder,
  resolveToolDescription,
  type ChatPromptContext,
} from '../index.js'
import { getToolDefinitions } from '../../tools/registry.js'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_PATH = path.join(DIR, 'golden', 'prompts.golden.json')
const UPDATE = process.env.UPDATE_PROMPTS_GOLDEN === '1'

interface GoldenCase {
  name: string
  ctx: Record<string, unknown>
  text: string
}

/** 与生成快照时一致的归一化：时间戳 / 相对时间 → 占位符 */
function scrub(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4},? +\d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?/g, '<DATETIME>')
    .replace(/\d{1,2}:\d{2}:\d{2}/g, '<TIME>')
    .replace(/距今约\d+分钟前/g, '距今约<N>分钟前')
    .trim()
}

/** 配方 → 组装入口（与 golden 中的 target 键一一对应；name 为用例名） */
const BUILDERS: Record<string, (ctx: any, name: string) => string> = {
  'chat.system': (ctx: ChatPromptContext) => buildChatSystemPrompt(ctx),
  'neutral.followup.system': (ctx) => buildFollowUpSystemPrompt(ctx),
  'neutral.followup.user': (ctx) => buildFollowUpUserMessage(ctx),
  'neutral.suggestions.system': (ctx) => buildSuggestionsSystemPrompt(ctx),
  'neutral.suggestions.user': (ctx) => buildSuggestionsUserMessage(ctx),
  'neutral.orchestration.system': (ctx) => buildOrchestrationSystemPrompt(ctx),
  'neutral.orchestration.user': (ctx) => buildOrchestrationUserMessage(ctx),
  'notification.greeting.user': (ctx) => buildGreetingInstruction(ctx),
  'notification.push.user': () => buildPushInstruction(),
  'retry.message': (_ctx, name) => (name === 'fabricated-reply' ? getFabricatedReply() : getRetryPlaceholder()),
  'tool.description': (ctx) => {
    const def = getToolDefinitions().find((d) => d.name === ctx.name)
    if (!def) throw new Error(`unknown tool: ${ctx.name}`)
    return resolveToolDescription(def)
  },
}

const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as {
  $comment: string
  cases: Record<string, GoldenCase[]>
}

describe('提示词黄金快照', () => {
  for (const [target, cases] of Object.entries(golden.cases)) {
    describe(target, () => {
      for (const c of cases) {
        it(c.name, () => {
          const build = BUILDERS[target]
          expect(build, `缺少 ${target} 的组装入口`).toBeTypeOf('function')
          const actual = scrub(build(c.ctx, c.name))
          if (UPDATE) {
            c.text = actual
            return
          }
          expect(actual).toBe(c.text)
        })
      }
    })
  }

  afterAll(() => {
    if (UPDATE) {
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n')
      console.log(`[golden] 已更新快照：${GOLDEN_PATH}`)
    }
  })
})

describe('快照的结构性断言（防归一化掩盖回归）', () => {
  const caseOf = (target: string, name: string): string => {
    const c = golden.cases[target].find((x) => x.name === name)
    expect(c, `缺少用例 ${target}/${name}`).toBeDefined()
    return buildFor(target, c!.ctx, c!.name)
  }

  it('环境信息块包含真实日期时间', () => {
    const text = buildFor('chat.system', { agentSystemPrompt: 'A', thinkingMode: true, skills: [] })
    expect(text).toMatch(/## 环境信息\n现在的日期时间是\d/)
  })

  it('技能清单为逐行 bullet（单换行分隔）', () => {
    const text = buildFor('chat.system', {
      agentSystemPrompt: 'A',
      thinkingMode: true,
      skills: [
        { name: 'alpha', description: '第一个技能' },
        { name: 'beta', description: '第二个技能' },
      ],
    })
    expect(text).toContain('- **alpha**: 第一个技能\n- **beta**: 第二个技能')
  })

  it('空产出的片段不会留下空行空洞', () => {
    const text = buildFor('chat.system', { agentSystemPrompt: 'A', thinkingMode: true, skills: [] })
    expect(text).not.toMatch(/\n{3,}/)
  })

  it('提到的 @ 名字会进入对应场景块', () => {
    const text = caseOf('chat.system', 'group-protagonist')
    expect(text).toContain('- 刚才 用户 @ 了你，在回复时请自然回应对方的点名')
  })
})

/** 与主断言共用同一组装入口 */
function buildFor(target: string, ctx: any, name = ''): string {
  const build = BUILDERS[target]
  if (!build) throw new Error(`未知配方：${target}`)
  return build(ctx, name)
}
