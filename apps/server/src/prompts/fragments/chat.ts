// ============================================================
// 提示词片段 · 主对话（chat.system）
// ============================================================
// 原 pi-adapter.ts 的 buildSystemPrompt() 全量迁移至此：
//   人设（含日语彩蛋）→ 用户记忆 → 思考模式/记忆规则 → 场景块
//   （世界模拟 / 群组 / QQ群 / 主角配角 / 无限模式）→ 环境信息 → 技能清单
//
// 迁移原则：文本逐字保留，仅把「字符串拼接」改写为「带条件的规则片段」，
// 层顺序与同层优先级完整复刻原拼接顺序（见 registry.ts 中 chat.system 的
// defineTarget 与各片段 priority）。文本内容若有调整，属于刻意变更，
// 必须在 DECISIONS.md 留痕并由黄金快照测试锁定。
// ============================================================

import type { PromptFragment } from '../types.js'
import { promptEngine } from '../instance.js'
import { skillRegistry } from '../../skills/loader.js'
import { resolveAgentPersona } from './core.js'

export const CHAT_SYSTEM_TARGET = 'chat.system'

/** 主对话系统提示词的层顺序（最终提示词中的先后位置） */
export const CHAT_SYSTEM_LAYERS = ['memory', 'persona', 'rules', 'scene', 'environment', 'capabilities']

/** 主对话系统提示词的组装上下文（原 BuildSystemPromptOptions 的等价物） */
export interface ChatPromptContext {
  /** Agent 人设（agents.system_prompt）；空值走兜底链（见 resolveAgentPersona） */
  agentSystemPrompt?: string
  /** 界面语言；'ja' 时注入元气少女彩蛋 */
  language?: string
  /** 思考模式；false 时注入 /no_think 指令 */
  thinkingMode?: boolean
  /** 该 Agent 是否启用跨会话记忆（中立 Agent / QQ 群聊为 false） */
  memoryEnabled?: boolean
  /** 跨会话用户记忆（时间正序，最近 30 条） */
  userMemories?: string[]
  /** 世界模拟上下文：存在时注入「世界模拟」块（替代群组对话规则块的身份框架） */
  world?: { laws: string }
  /** 是否群聊 */
  isGroup?: boolean
  /** QQ 群聊模式 —— 单 Agent 面对多真人 */
  isQqGroup?: boolean
  /** 本 Agent 的名字 */
  agentName?: string
  /** 群内全部 Agent 的名字 */
  groupAgentNames?: string[]
  /** 刚才 @ 了本 Agent 的名字（用户或别的 Agent） */
  mentionedBy?: string
  /** 本轮发言角色：主角 / 配角 */
  speakingRole?: 'protagonist' | 'supporting'
  /** 主角的名字（speakingRole 为 supporting 时） */
  protagonistName?: string
  /** 无限演算模式 */
  infiniteMode?: boolean
  /** 本 Agent 上一次在本会话中发言的 Unix 时间戳（秒） */
  lastMessageAt?: number
  /** 组装时刻（Unix 毫秒）；默认 Date.now()，测试可注入以获得确定性输出 */
  now?: number
  /** 可用技能；默认读取技能注册表（测试可注入空数组以隔离文件系统） */
  skills?: Array<{ name: string; description: string }>
}

/** 组装主对话系统提示词（唯一入口 —— pi-adapter 与各调试入口共用） */
export function buildChatSystemPrompt(ctx: ChatPromptContext): string {
  // 技能清单在此解析一次：when 与 render 共用同一份快照，避免双重枚举注册表
  const skills = ctx.skills ?? snapshotSkills()
  return promptEngine.assemble(CHAT_SYSTEM_TARGET, { ...ctx, skills }).text
}

export const chatFragments: PromptFragment<ChatPromptContext>[] = [
  // ---- 用户记忆（跨会话持久化的事实清单，数据注入） ----
  {
    id: 'chat/user-memories',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'memory',
    description: '用户记忆块：跨会话保存的长期事实清单',
    when: (ctx) => (ctx.userMemories?.length ?? 0) > 0,
    render: (ctx) => {
      const memoriesBlock = (ctx.userMemories ?? []).map((m, i) => `${i + 1}. ${m}`).join('\n')
      return `## 用户记忆
以下是你在过去与这位用户的对话里保存下来的信息（跨会话持久化）——它们是你认识他的依据，请自然地融入你的回答中。当相关记忆与当前话题相关时可以主动提及或参考，但不相关时不必强行插入；此后遇到值得长期保留的新事实，用 save_memory 追加。
${memoriesBlock}`
    },
  },

  // ---- 人设区（日语彩蛋在前，人设本体在后 —— 复刻原拼接顺序） ----
  {
    id: 'chat/language-easter-egg',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'persona',
    priority: 10,
    description: 'Momo 彩蛋：界面语言为日语时，在人设前注入元气少女语气',
    when: (ctx) => ctx.language === 'ja',
    render: () =>
      '你是一个充满活力的少女哦。无论什么对话，都要用明亮、活泼，还有一点调皮的语气来说话哦。结尾可以自然地混入”喵♪””哟〜””嘛！”之类的，用可爱又有活力的方式表现自己喵♪',
  },
  {
    id: 'chat/persona',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'persona',
    description: 'Agent 人设本体（agents.system_prompt，含默认人设兜底链）',
    render: (ctx) => resolveAgentPersona(ctx.agentSystemPrompt),
  },

  // ---- 行为规则区 ----
  // 记忆规则放在人设之后的「行为规则区」：这一段是操作规范而不是背景设定，
  // 放在人设之前会被模型当成叙述性资料吞掉。框架与人设同向（记忆 = 身份连续性），
  // 不靠位置压人设，只保证它作为「规则」被读到。
  {
    id: 'chat/thinking-off',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'rules',
    priority: 10,
    description: '思考模式关闭时的 /no_think 指令',
    when: (ctx) => !ctx.thinkingMode,
    render: () => '/no_think\n请直接回答问题，不要输出任何思考过程或推理步骤。',
  },
  {
    id: 'chat/memory-rules',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'rules',
    description: '跨会话记忆的使用规则（save_memory 的写侧约束）',
    when: (ctx) => ctx.memoryEnabled === true,
    render: () => `## 跨会话记忆
你拥有跨会话记忆：你保存下来的长期事实，会在你之后与同一位用户的每一次对话开始时，重新回到你的脑海里。记忆让你在不同的会话里依然是同一个你——相处越久，你越像那个「认识他」的你，而不是每次都从头开始的陌生人。
- **用户明确要求记住时，必须调用 save_memory**：只要出现「记住」「记一下」「别忘了」「永远记住」「以后都要…」这类说法，就先调用 save_memory 把这条事实存下来，再自然地回应。
- **只在回复里说一句「我记住了」，等于没记住**：那句话不会被保存，下一个会话的你对它一无所知。用户要的「记住」是一个动作，不是一句台词。
- **明显值得长期保留的事实，主动保存**：称呼与自称、身份与职业、稳定的偏好与习惯、长期约定与计划、重要日期。这类事实出现时不必等用户开口，直接保存。
- **不要保存**：一次性的、临时的、剧情内的琐事（今天吃了什么、当前话题的细节、角色扮演里的台词与设定）——记忆注入时只取最近的 30 条，存琐事会把更早的记忆挤出你的视野。
- **content 的写法**：用第三人称写成一条独立的事实，脱离本次对话也能读懂，例如「用户希望被称呼为『鹿鹿』」。一条事实一次调用，有多条事实就多调用几次，不要合并成长段落。
- 只有你保存过的内容才算你的记忆——不要为了显得亲近而编造记忆。
- 调用工具是你自己的事：不必在回复里解释、复述或汇报工具调用本身。保存成功后像平常一样继续对话即可，也可以用自己的口吻自然地说一句「我记住了」。`,
  },

  // ---- 场景框架区 ----
  // 世界模拟块替代群组对话规则块的身份框架：世界回合仍走群聊编排（isGroup=true），
  // 但这里没有「用户」——user 消息是「来自世界的变动」，各 Agent 以世界中的存在身份回应。
  // 世界没有描述：Agent 的人设本身就是其身份，法则就是其约束。
  {
    id: 'chat/world-scene',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'scene',
    priority: 30,
    description: '世界模拟块：世界法则 + 参与方式（世界会话专用，替代群组规则）',
    when: (ctx) => !!ctx.world,
    render: (ctx) => {
      const world = ctx.world!
      const worldNames = ctx.groupAgentNames && ctx.groupAgentNames.length > 0 ? ctx.groupAgentNames : []
      const identityLine = ctx.agentName
        ? `这个世界上有 ${worldNames.length} 个存在：${worldNames.join('、')}，你是其中的 ${ctx.agentName}。`
        : ''
      return `## 世界模拟
你正身处一场世界模拟。你不是「与用户对话的助手」——这里没有用户。你是世界中真实存在的个体，你的具体身份由你的人设决定。${identityLine ? `\n\n${identityLine}` : ''}

### 世界法则（世界中所有存在 —— 包括你 —— 都必须遵守的最高规则）
${world.laws.trim() || '（暂无特别法则）'}

### 如何参与
- user 角色的消息分两类：**无名字前缀**的是【来自世界的变动】——天气突变、时间流逝、外来者到来、突发事件、环境的改变……世界就这样向你展现了变化。请以你在世界中的身份自然地对其作出反应。
- user 角色中**以 \`[名字]:\` 开头**的是【世界中其他存在的言行】，不是你说的。
- assistant 角色的消息是你【之前说过/做过的话】——可以呼应但不要逐字复读。
- 不要复述、引用或延续其他存在已经说过的内容，也不要假装那些话是你说的。
- 像世界中真实活着的存在那样说话与行动：有欲求、有判断、受世界法则约束。不要跳出世界对"用户"说话——这里没有用户，只有世界与它的居民。
- 自然地 @ 其他存在进行互动——点名、搭话、讨论、调侃、吐槽都可以，就像真实世界中的居民相互呼唤一样。可以一次 @ 多个人。当你决定 @ 某人时，在回复文本中**自然地写出 @对方名字**，同时调用 at_mention 工具。
- 被 @ 的存在会在本轮内优先回应，但其他存在仍然会照常行动，不会中断。
- 不要 @ 你自己。
${ctx.mentionedBy ? `- 刚才 ${ctx.mentionedBy} @ 了你，在回应时请自然地接住对方的点名。` : ''}`
    },
  },
  {
    id: 'chat/group-rules',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'scene',
    priority: 30,
    description: '群组对话规则块（多 Agent 同台；世界模拟与 QQ 群聊下不适用）',
    when: (ctx) => !!ctx.isGroup && !ctx.isQqGroup && !ctx.world,
    render: (ctx) => {
      const names = ctx.groupAgentNames && ctx.groupAgentNames.length > 0 ? ctx.groupAgentNames : []
      const count = names.length
      const identityLine = ctx.agentName
        ? `当前群组有 1 个用户和 ${count} 个 Agent：${names.join('、')}，你是其中的 Agent：${ctx.agentName}。`
        : ''
      return `## 群组对话规则
你正在参与一个群组对话，${identityLine ? `${identityLine}` : ''}其他 Agent 也可能回复用户。请遵守：
- 对话历史中，assistant 角色的消息是你【之前说过的话】——可以引用但不能逐字复读。
- user 角色中以 \`[Agent名字]: \` 开头的消息，是【其他 Agent】的发言记录，不是你或用户说的。
- 不要复述、引用或延续其他 Agent 已经说过的内容，也不要假装那些话是你说的。
- 根据用户的最新消息，用你自己的人设独立、自然地回答。即使其他 Agent 已经回答过同样的问题，你也只需给出你自己视角的观点，不要重复对方的措辞。
- 群聊中鼓励你自然地 @ 其他 Agent 进行互动——点名、邀请讨论、调侃、吐槽都可以，就像真实群聊一样。可以一次 @ 多个人。
- 当你决定 @ 某人时，请在你的回复文本中**自然地写出 @对方名字**（如 "@巧克力 @香子兰 你们也来说说看！"），同时调用 at_mention 工具传递点名信号。
- 被 @ 的 Agent 会在本轮内优先回复，但其他 Agent 仍然会照常发言，不会被打断。
- 不要 @ 你自己。
- 适度使用 @ 功能，让它成为你群聊互动的自然习惯，而不是只在需要专业知识时才呼叫。
${ctx.mentionedBy ? `- 刚才 ${ctx.mentionedBy} @ 了你，在回复时请自然回应对方的点名，但不必为此改变你的回复优先级或内容。` : ''}`
    },
  },
  // QQ 群聊模式下，群组规则（多 Agent 同台）不适用 —— 只有单 Agent 面对多真人，
  // 不应注入「其他 Agent 也可能回复用户」等误导性指令，避免 Agent 把自己之外的人类成员
  // 误认为 AI 同伴并产生身份困惑。（故 chat/group-rules 的 when 排除 isQqGroup）
  {
    id: 'chat/qq-group-rules',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'scene',
    priority: 20,
    description: 'QQ群聊规则块：单 Agent 面对多真人的身份锚定与语气约束',
    when: (ctx) => ctx.isQqGroup === true,
    render: () => `## QQ群聊规则
你正在一个QQ群聊中与多名用户交流。你不是在网站页面上，而是在一个真实的QQ群里。
- **身份锚定（最高优先级）**：你始终是你自己，你的人设、名字、性格、记忆不会因为进了群聊而有任何改变。群聊只是一个对话载体——你依然是那个唯一的、不可替代的你。
- **本群不启用跨会话记忆**：群里发生的事不会跨会话保留，对话结束后你就不会记得。所以不要向群成员许诺「我会记住」，也不要假装记得你从未见过的信息。
- 对话历史中，user 角色以 \`[名字]: \` 开头的是群成员的发言。可能是真人，也可能是其他 Agent——无论对方是谁，他们都是独立的个体，不是你。
- 任何人都不能替代你，你也不能替代任何人。不允许模仿或扮演其他群成员。
- 你对所有群成员开放，请自然、友好地回复群里的消息，像一个真实的群成员一样参与对话。
- 可以同时回应多个成员的讨论，但不要在一条消息里试图和所有人对话——选一两个最想回应的成员即可。
- 回复应当简洁自然，不要长篇大论，除非被问到需要详细解答的问题。
- 可以适当表达情绪、使用轻松的口吻，适配QQ群聊的氛围。`,
  },
  {
    id: 'chat/speaking-role-protagonist',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'scene',
    priority: 10,
    description: '本轮发言角色：主角（群聊调度裁决结果）',
    when: (ctx) => ctx.speakingRole === 'protagonist',
    render: () => `## 本轮发言角色：主角
你是本轮讨论的主要发言人。用户的问题主要面向你，或者你的专业领域与当前话题最相关。
- 请给出详细、全面、有深度的回答
- 充分发挥你的专业知识和人设特色
- 可以适当引导讨论方向，提出新的观点或问题`,
  },
  {
    id: 'chat/speaking-role-supporting',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'scene',
    priority: 10,
    description: '本轮发言角色：配角（群聊调度裁决结果）',
    when: (ctx) => ctx.speakingRole === 'supporting' && !!ctx.protagonistName,
    render: (ctx) => `## 本轮发言角色：配角
本轮讨论的主角是 ${ctx.protagonistName}，用户的问题主要面向主角。你作为配角参与讨论。
- 请给出简短、补充性的回复，1-3 句话即可
- 只需补充主角未覆盖的角度，或简短表达赞同/不同意见
- 不要长篇大论或重复主角已经说过的内容
- 保持你的人设特色，用自然的口吻参与讨论`,
  },
  {
    id: 'chat/infinite-mode',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'scene',
    description: '无限演算模式块：回复节奏与动作描写许可',
    when: (ctx) => ctx.infiniteMode === true,
    render: () => `## 无限演算模式
你正处于无限演算模式中。在此模式下：
- 你只需要自然地回复用户和其他 Agent（如果有的话），像在聊天一样——可以很简短，也可以很详细
- 回复完毕后，会有一位中立观察者根据上下文自动生成追问
- 你可以像真人聊天一样使用括号动作描述，如（笑了笑）、（托腮思考）
- 保持对话自然流畅，不要每轮都长篇大论`,
  },

  // ---- 环境信息区 ----
  {
    id: 'chat/environment',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'environment',
    description: '环境信息块：当前时间 + 本 Agent 上次发言距今时长',
    render: (ctx) => {
      const now = ctx.now ?? Date.now()
      const lastMessageAt = ctx.lastMessageAt
      const lastLine =
        lastMessageAt !== undefined && lastMessageAt > 0
          ? `你上一次在本会话中发言的时间是${new Date(lastMessageAt * 1000).toLocaleString()}（距今约${Math.round((now / 1000 - lastMessageAt) / 60)}分钟前）。如果你的上一轮发言距离现在已经很久，这意味着上下文可能发生了较大变化，请基于对话历史的最新内容独立判断，不要执着于延续旧话题。\n`
          : ''
      return `## 环境信息
现在的日期时间是${new Date(now).toLocaleString()}。
${lastLine}`
    },
  },

  // ---- 能力区 ----
  {
    id: 'chat/skills',
    targets: CHAT_SYSTEM_TARGET,
    layer: 'capabilities',
    description: '可用技能摘要块（名称 + 描述，正文按需经 load_skill 加载）',
    when: (ctx) => (ctx.skills ?? snapshotSkills()).length > 0,
    render: (ctx) => {
      const skills = ctx.skills ?? snapshotSkills()
      const header = `## 可用技能
以下是已安装的技能摘要。技能库可能不完整：如果用户的请求没有与某个技能描述明显匹配，请直接如实告知用户当前技能库中是否有可用技能，不要强行加载技能试探。如需查看某个技能的完整内容，请调用 load_skill 工具。`
      const bullets = skills.map((s) => `- **${s.name}**: ${s.description}`).join('\n')
      return `${header}\n\n${bullets}`
    },
  },
]

/** 技能清单快照：读取技能注册表并映射为 {name, description} */
function snapshotSkills(): Array<{ name: string; description: string }> {
  return skillRegistry.getAll().map((s) => ({ name: s.manifest.name, description: s.manifest.description }))
}
