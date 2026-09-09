export const SUGGESTIONS_FENCE = '```suggestions'
// 多轮思考链的片段分隔符：loop 在每一轮思考开始前插入，
// DB 存含分隔符的纯文本，前端按此拆分展示多个「思考片段」。
export const THINKING_SEGMENT_OPEN = '\n\n〔思考片段 '
export const THINKING_SEGMENT_CLOSE = '〕\n'
// 当一轮思考被输出 token 上限（finishReason === 'length'）截断时，
// 在思考片段尾部追加该标记，前端据此显示「思考被截断」。
export const THINKING_TRUNCATED_MARK = '\n…（思考被输出长度截断）…'
// Default system prompt is empty. 追问建议（suggestions）由中立 Agent
// 在每轮回复完成后单独生成补发，不再注入普通 Agent 的系统提示词。
export const DEFAULT_SYSTEM_PROMPT = ''
export const DEFAULT_APP_NAME = 'Momoi'
export const DEFAULT_API_ENDPOINT = 'https://api.openai.com/v1'
export const DEFAULT_MODEL = 'gpt-4o'

// Agent 默认值
export const DEFAULT_AGENT_NAME = 'Momoi'
export const DEFAULT_AGENT_MODEL = 'gpt-4o'
export const DEFAULT_AGENT_SYSTEM_PROMPT = ''
export const NEUTRAL_AGENT_NAME = '中立 Agent'
export const NEUTRAL_AGENT_ID = 'neutral-agent'
