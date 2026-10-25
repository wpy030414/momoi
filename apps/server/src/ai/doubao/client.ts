/**
 * Doubao 对话客户端：OpenAI Chat Completions 请求 → 豆包网页 /chat/completion。
 *
 * 上游协议（2026-10 实测，移植自 xrp-doubao 的 doubaoClient.ts）：
 *   - 主端点 POST /chat/completion?...，SSE；内容块 block_type=10040 是思考分隔符，
 *     10000 承载文本；patch_op / content_block 两种形态都可能出现。
 *   - 回退端点 POST /samantha/chat/completion?...，SSE；event_type=2001 承载消息，
 *     content_type=2008 是思考文本，2003 结束，2005 错误。
 *   - 认证：Cookie（sessionid / ttwid / passport_csrf_token …）。
 *   - 风控：710022004 表示需要人机验证；只记录状态，不尝试绕过。
 *
 * 不生成 a_bogus：纯 HTTP + 登录 Cookie 在实测中可用；若主端点被风控或协议变化，
 * auto 模式会自动回退到 /samantha。
 */

import { doubaoConfig as cfg, resolveModelPreset, type DoubaoModelPreset } from './config.js'
import { CookieJar, type CookieRecord } from './cookie-jar.js'
import { chatHeaders, desktopParams, toQuery, webParams } from './security-params.js'
import { iterateSse, type SseEvent } from './sse.js'
import { flattenMessages, UnsupportedMessageError } from './messages.js'
import { buildAttachmentBlock, uploadAttachments, UploadError, type UploadBatch } from './upload.js'
import { deleteConversation } from './conversation-cleanup.js'
import { AUTH_CODES, RISK_CODES } from './error-codes.js'
import { markNeedsCaptcha } from './risk.js'
import type { DoubaoSession } from './credentials.js'

export type ChatMode = 'web' | 'legacy'

export class DoubaoUpstreamError extends Error {
  readonly kind: 'auth' | 'risk' | 'upstream'
  readonly status?: number
  readonly code?: number
  readonly needsCaptcha?: boolean
  readonly detail?: unknown
  /** 显式标记是否允许回退到 /samantha；风险 / 鉴权 / 参数错误一律 false */
  readonly fallbackable?: boolean

  constructor(
    message: string,
    opts: {
      kind: 'auth' | 'risk' | 'upstream'
      status?: number
      code?: number
      needsCaptcha?: boolean
      detail?: unknown
      fallbackable?: boolean
    },
  ) {
    super(message)
    this.name = 'DoubaoUpstreamError'
    this.kind = opts.kind
    this.status = opts.status
    this.code = opts.code
    this.needsCaptcha = opts.needsCaptcha
    this.detail = opts.detail
    this.fallbackable = opts.fallbackable
  }
}

export interface ChatDelta {
  text?: string
  reasoning?: string
  usage?: unknown
  conversationId?: string
  done?: boolean
}

export interface ChatRequest {
  model?: string
  messages: unknown
  reasoningEffort?: number | string
  /** 覆盖预设的深度思考开关（Momoi 关闭思考模式时传 false） */
  deepThink?: boolean
  signal?: AbortSignal
  onMode?: (mode: ChatMode) => void
  /** 发生静默回退时回调（用于日志 / 诊断） */
  onFallback?: (reason: string) => void
  /** 成功建立上游 SSE 流后回调（供外层清理连接超时） */
  onConnected?: () => void
}

function randomLocalId(): string {
  return `local_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-8)}`
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function numberOrUndefined(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v) return v
  }
  return ''
}

function mapEffort(value: number | string | undefined, fallback: 3 | 4 | 5): 3 | 4 | 5 {
  if (typeof value === 'number' && value >= 1 && value <= 5) {
    return Math.min(5, Math.max(3, Math.round(value))) as 3 | 4 | 5
  }
  if (typeof value === 'string') {
    const v = value.toLowerCase().trim()
    if (v === 'low' || v === 'minimal') return 3
    if (v === 'medium' || v === 'mid') return 4
    if (v === 'high') return 5
    const n = Number(v)
    if (Number.isFinite(n)) return Math.min(5, Math.max(3, Math.round(n))) as 3 | 4 | 5
  }
  return fallback
}

interface ParseState {
  inThinking: boolean
  thinkDelimiters: number
  conversationId: string
  /** 最近一次已展示的思考步骤标题，避免重复 */
  lastThinkingTitle: string
}

export class DoubaoClient {
  readonly jar: CookieJar
  readonly state: DoubaoSession
  readonly baseUrl: string
  readonly chatMode: 'auto' | 'chat' | 'samantha'
  /** 最近一次已同步的 Cookie 快照：只有内容变化才回调写回 */
  private cookieSnapshot: string
  private readonly onCookiesChanged?: (cookies: CookieRecord[]) => void | Promise<void>

  constructor(
    state: DoubaoSession,
    opts: {
      baseUrl?: string
      chatMode?: 'auto' | 'chat' | 'samantha'
      /** 上游轮换了 Cookie（Set-Cookie）时回调，供会话层加密写回 */
      onCookiesChanged?: (cookies: CookieRecord[]) => void | Promise<void>
    } = {},
  ) {
    this.state = state
    this.jar = CookieJar.fromJSON(state.cookies)
    this.baseUrl = (opts.baseUrl || cfg.baseUrl).replace(/\/+$/, '')
    this.chatMode = opts.chatMode || cfg.chatMode
    this.cookieSnapshot = JSON.stringify(this.jar.toJSON())
    this.onCookiesChanged = opts.onCookiesChanged
  }

  /** 吸收上游 Set-Cookie；内容变化时通知会话层写回，避免轮换结果丢失 */
  private async absorbResponseCookies(response: Response, requestUrl: string): Promise<void> {
    this.jar.absorb(response.headers, requestUrl)
    const next = JSON.stringify(this.jar.toJSON())
    if (next === this.cookieSnapshot) return
    this.cookieSnapshot = next
    await this.onCookiesChanged?.(this.jar.toJSON())
  }

  /** 把 OpenAI messages 压平并发送；返回上游增量 */
  async *chat(req: ChatRequest): AsyncGenerator<ChatDelta> {
    const preset = resolveModelPreset(req.model)
    const effort = mapEffort(req.reasoningEffort, preset.reasoningEffort)
    const deep = req.deepThink ?? preset.deepThink
    const flattened = flattenMessages(req.messages)
    const prompt = flattened.prompt
    if (cfg.debug) {
      console.log(
        `[doubao] prompt chars=${prompt.length} attachments=${flattened.attachments.length} ` +
          `preview=${JSON.stringify(prompt.slice(0, 120))}`,
      )
    }

    // 当前用户消息的图片 / 文件先上传到豆包 ImageX，再以 10052 附件块发送。
    // 上传失败不回退 /samantha（旧端点没有附件语义，静默丢弃比报错更糟）。
    let batch: UploadBatch = { localMessageId: '', attachments: [] }
    if (flattened.attachments.length > 0) {
      try {
        batch = await uploadAttachments(
          {
            baseUrl: this.baseUrl,
            jar: this.jar,
            device: this.state.device,
            uid: this.state.uid,
            signal: req.signal,
          },
          flattened.attachments,
        )
      } catch (e) {
        if (e instanceof UploadError) {
          if (e.kind === 'unsupported') throw new UnsupportedMessageError(e.message)
          throw new DoubaoUpstreamError(e.message, {
            kind: e.kind,
            status: e.status,
            code: e.code,
            needsCaptcha: e.needsCaptcha,
            detail: e.detail,
            fallbackable: false,
          })
        }
        throw e
      }
    }

    const { response, kind } = await this.openChat(prompt, preset, effort, deep, req, batch)
    req.onMode?.(kind)
    req.onConnected?.()
    if (!response.body) throw new DoubaoUpstreamError('豆包上游响应为空', { kind: 'upstream' })

    const state: ParseState = {
      inThinking: false,
      thinkDelimiters: 0,
      conversationId: '',
      lastThinkingTitle: '',
    }
    let sawDone = false
    let bodyClosed = false

    try {
      for await (const ev of iterateSse(response.body)) {
        if (ev.data.trim() === '[DONE]') {
          sawDone = true
          break
        }
        const deltas = kind === 'web' ? this.parseWebEvent(ev, state) : this.parseLegacyEvent(ev, state)
        for (const d of deltas) {
          if (d.done) {
            sawDone = true
            break
          }
          if (d.conversationId && !state.conversationId) state.conversationId = d.conversationId
          if (d.text || d.reasoning || d.usage) yield d
        }
        if (sawDone) break
      }
      // 正常读到流尾 => body 已关闭；因 SSE_REPLY_END / 结束标记提前 break
      // => 主动 cancel，避免上游连接（可能还有推荐问题）被长时间占住
      bodyClosed = !sawDone
    } finally {
      if (!bodyClosed) {
        try {
          await response.body.cancel()
        } catch {
          /* 已关闭 */
        }
      }
      // 每轮在豆包侧创建的会话不留在账号最近会话里：流结束后异步删除，
      // 不阻塞客户端；失败只记录统计与警告。
      if (state.conversationId) {
        void deleteConversation({
          baseUrl: this.baseUrl,
          jar: this.jar,
          device: this.state.device,
          conversationId: state.conversationId,
        })
      }
    }
    yield { done: true, conversationId: state.conversationId || undefined }
  }

  private async openChat(
    prompt: string,
    preset: DoubaoModelPreset,
    effort: 3 | 4 | 5,
    deep: boolean,
    req: ChatRequest,
    batch: UploadBatch,
  ): Promise<{ response: Response; kind: ChatMode }> {
    const signal = req.signal

    const fetchUpstream = async (url: string, init: RequestInit): Promise<Response> => {
      try {
        return await fetch(url, { ...init, signal })
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e
        throw new DoubaoUpstreamError(`豆包网络错误：${(e as Error).message}`, {
          kind: 'upstream',
          fallbackable: true,
        })
      }
    }

    const tryWeb = async (): Promise<{ response: Response; kind: ChatMode }> => {
      const url = `${this.baseUrl}${cfg.chatPath}?${toQuery(webParams(this.state.device, this.jar))}`
      const body = JSON.stringify(this.buildWebPayload(prompt, preset, effort, deep, batch))
      const response = await fetchUpstream(url, {
        method: 'POST',
        headers: chatHeaders(this.jar, { stream: true }),
        body,
      })
      await this.absorbResponseCookies(response, url)
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw this.errorFromResponse(response.status, text)
      }
      const ct = response.headers.get('content-type') || ''
      if (!/text\/event-stream/i.test(ct)) {
        const text = await response.text().catch(() => '')
        throw this.errorFromResponse(response.status, text, '上游返回非 SSE 响应', true)
      }
      return { response, kind: 'web' }
    }

    const tryLegacy = async (): Promise<{ response: Response; kind: ChatMode }> => {
      const url = `${this.baseUrl}${cfg.legacyChatPath}?${toQuery(desktopParams(this.state.device, this.jar))}`
      const body = JSON.stringify(this.buildLegacyPayload(prompt, preset, deep))
      const response = await fetchUpstream(url, {
        method: 'POST',
        headers: chatHeaders(this.jar, { stream: true, legacy: true }),
        body,
      })
      await this.absorbResponseCookies(response, url)
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw this.errorFromResponse(response.status, text)
      }
      const ct = response.headers.get('content-type') || ''
      if (!/text\/event-stream/i.test(ct)) {
        const text = await response.text().catch(() => '')
        throw this.errorFromResponse(response.status, text, '上游返回非 SSE 响应', true)
      }
      return { response, kind: 'legacy' }
    }

    if (this.chatMode === 'samantha') return tryLegacy()
    if (this.chatMode === 'chat') return tryWeb()

    try {
      return await tryWeb()
    } catch (e) {
      // 附件无法在旧端点上还原；宁可报错，也不静默丢附件
      if (batch.attachments.length > 0) throw e
      if (!this.isFallbackable(e)) throw e
      // 外层超时 / 调用方取消：回退没有意义，且会把超时错误掩盖成上游错误
      if ((e as Error)?.name === 'AbortError') throw e
      const reason = e instanceof Error ? e.message : String(e)
      console.warn(`[doubao] /chat/completion 不可用，回退 /samantha: ${reason}`)
      req.onFallback?.(reason)
      try {
        return await tryLegacy()
      } catch (legacyError) {
        if (legacyError instanceof DoubaoUpstreamError && legacyError.kind === 'auth') throw legacyError
        if ((legacyError as Error)?.name === 'AbortError') throw legacyError
        const prefix = e instanceof Error ? `主端点: ${e.message}; ` : ''
        throw new DoubaoUpstreamError(
          `${prefix}回退端点: ${(legacyError as Error).message}`,
          legacyError instanceof DoubaoUpstreamError
            ? {
                kind: legacyError.kind,
                status: legacyError.status,
                code: legacyError.code,
                needsCaptcha: legacyError.needsCaptcha,
                detail: legacyError.detail,
                fallbackable: false,
              }
            : { kind: 'upstream', fallbackable: false },
        )
      }
    }
  }

  /** 只有端点缺失 / 网络或协议错误才允许回退；风控、鉴权、参数错误一律不回退 */
  private isFallbackable(error: unknown): boolean {
    if (error instanceof DoubaoUpstreamError) {
      if (error.kind === 'auth' || error.kind === 'risk') return false
      if (error.fallbackable !== undefined) return error.fallbackable
      if (error.status === undefined) return true
      return [404, 405, 410, 501, 502, 503, 504].includes(error.status)
    }
    if (error instanceof Error && /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|network/i.test(error.message)) {
      return true
    }
    return false
  }

  private buildWebPayload(prompt: string, preset: DoubaoModelPreset, effort: 3 | 4 | 5, deep: boolean, batch: UploadBatch): unknown {
    // 网页端的 need_deep_think / ext.use_deep_think 取菜单 menu_type（0/3/9/5/10001），
    // 不是 0/1 布尔。Momoi 的「关闭思考」开关仍需生效：对默认思考的模型收起为 0；
    // 工作任务类模型的 menu_type 是模式标识（非思考开关），不因开关而改变。
    const menuType = deep ? preset.menuType : preset.deepThink ? 0 : preset.menuType
    const textBlock = {
      block_type: 10000,
      content: {
        text_block: {
          text: prompt,
          icon_url: '',
          icon_url_dark: '',
          summary: '',
        },
        pc_event_block: '',
      },
      block_id: uuid(),
      parent_id: '',
      meta_info: [],
      extra_info: {},
      append_fields: [],
    }
    const messageList: any[] = []
    if (batch.attachments.length > 0) {
      messageList.push({
        local_message_id: batch.localMessageId || uuid(),
        content_block: [buildAttachmentBlock(batch)],
        message_status: 0,
      })
    }
    if (prompt) {
      messageList.push({
        local_message_id: uuid(),
        content_block: [textBlock],
        message_status: 0,
      })
    }
    if (messageList.length === 0) {
      throw new UnsupportedMessageError('没有可发送的文本或附件内容')
    }
    return {
      client_meta: {
        local_conversation_id: randomLocalId(),
        conversation_id: '',
        bot_id: cfg.botId,
        last_section_id: '',
        last_message_index: null,
        local_permissions: [
          { permission_name: 'ACCESS_COARSE_LOCATION', status: 3 },
          { permission_name: 'ACCESS_FINE_LOCATION', status: 3 },
          { permission_name: 'ACCESS_BACKGROUND_LOCATION', status: 3 },
        ],
      },
      messages: messageList,
      option: {
        send_message_scene: '',
        create_time_ms: Date.now(),
        collect_id: '',
        is_audio: false,
        answer_with_suggest: false,
        agent_mode: preset.agentMode,
        tts_switch: false,
        need_deep_think: menuType,
        click_clear_context: false,
        from_suggest: false,
        is_regen: false,
        is_replace: false,
        is_from_click_option: false,
        is_from_click_softlink: false,
        disable_sse_cache: false,
        select_text_action: '',
        is_select_text: false,
        resend_for_regen: false,
        scene_type: 0,
        unique_key: uuid(),
        start_seq: 0,
        need_create_conversation: true,
        conversation_init_option: { need_ack_conversation: true },
        conversation_init_ext: {
          model_item_key: preset.modelItemKey,
          reasoning_effort: String(effort),
          mode_id: preset.modeId,
        },
        regen_query_id: [],
        edit_query_id: [],
        regen_instruction: '',
        no_replace_for_regen: false,
        message_from: 0,
        shared_app_name: '',
        shared_app_id: '',
        sse_recv_event_options: { support_chunk_delta: true },
        support_lazy_fetch_stream: true,
        is_ai_playground: false,
        is_old_user: false,
        general_task_param: { server_do_compare: true },
        recovery_option: {
          is_recovery: false,
          req_create_time_sec: Math.floor(Date.now() / 1000),
          append_sse_event_scene: 0,
        },
        message_storage_type: 0,
        related_deleted_message_ids: {},
        connector_info_list: [],
        model_config: {
          model_item_key: preset.modelItemKey,
          model_extra_params: preset.modelExtraParams ?? {},
          reasoning_effort: effort,
        },
        aggregate_params: {
          mention_skill_list: '[]',
          mention_plugin_list: '[]',
          mention_ext: '[{}]',
          conversation_mode: preset.modeId,
          mode_id: preset.modeId,
          model_item_key: preset.modelItemKey,
          agent_mode: String(preset.agentMode),
          reasoning_effort: String(effort),
          provider_id: '',
        },
        conversation_mode: Number(preset.modeId),
      },
      user_context: [],
      ext: {
        agent_mode: String(preset.agentMode),
        use_deep_think: String(menuType),
        sub_conv_firstmet_type: '1',
        general_task_param: '{"server_do_compare":true}',
        collection_id: '',
        is_finish: '1',
        conversation_init_option: '{"need_ack_conversation":true}',
        commerce_credit_config_enable: '0',
      },
    }
  }

  private buildLegacyPayload(prompt: string, preset: DoubaoModelPreset, deep: boolean): unknown {
    return {
      messages: [
        {
          content: JSON.stringify({ text: prompt }),
          content_type: 2001,
          attachments: [],
          references: [],
        },
      ],
      completion_option: {
        is_regen: false,
        with_suggest: false,
        need_create_conversation: true,
        launch_stage: 1,
        is_replace: false,
        is_delete: false,
        is_ai_playground: false,
        memory_type: 2,
        message_from: 0,
        use_deep_think: deep && preset.menuType > 0,
        use_auto_cot: deep && preset.menuType === 3,
        resend_for_regen: false,
        enable_commerce_credit: false,
      },
      evaluate_option: { web_ab_params: '' },
      local_conversation_id: randomLocalId(),
      local_message_id: uuid(),
      bot_id: cfg.botId,
    }
  }

  private errorFromResponse(status: number, text: string, prefix?: string, fallbackable?: boolean): DoubaoUpstreamError {
    let json: Record<string, unknown> | null = null
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      /* 非 JSON */
    }
    const errorObj = json?.error as Record<string, unknown> | undefined
    const code = numberOrUndefined(json?.code ?? json?.error_code ?? errorObj?.code)
    const message = pickString(
      json?.msg,
      json?.message,
      json?.error_msg,
      errorObj?.message,
      text.slice(0, 300),
      prefix,
      `豆包上游 HTTP ${status}`,
    )
    return this.classifyError(message, { status, code, detail: json ?? text, fallbackable })
  }

  private classifyError(
    message: string,
    opts: { status?: number; code?: number; detail?: unknown; fallbackable?: boolean },
  ): DoubaoUpstreamError {
    const status = opts.status
    const code = opts.code
    const decisionText = (() => {
      try {
        return JSON.stringify(opts.detail ?? '')
      } catch {
        return ''
      }
    })()
    if (status === 401 || status === 403 || (code !== undefined && AUTH_CODES.has(code))) {
      return new DoubaoUpstreamError(`豆包登录态失效：${message}`, {
        kind: 'auth',
        status,
        code,
        detail: opts.detail,
        fallbackable: false,
      })
    }
    if (
      (code !== undefined && RISK_CODES.has(code)) ||
      /71002200\d/.test(message) ||
      /verify|captcha|rate limited|风控|验证码|人机验证/i.test(`${message} ${decisionText}`)
    ) {
      markNeedsCaptcha()
      return new DoubaoUpstreamError(`豆包触发风控/验证：${message}`, {
        kind: 'risk',
        status,
        code,
        needsCaptcha: true,
        detail: opts.detail,
        fallbackable: false,
      })
    }
    const fallbackable =
      opts.fallbackable ?? (status === undefined || [404, 405, 410, 501, 502, 503, 504].includes(status))
    return new DoubaoUpstreamError(`豆包上游错误：${message}`, {
      kind: 'upstream',
      status,
      code,
      detail: opts.detail,
      fallbackable,
    })
  }

  // ── /chat/completion 事件解析 ──────────────────────────────

  private parseWebEvent(ev: SseEvent, state: ParseState): ChatDelta[] {
    const eventName = (ev.event || '').toLowerCase()
    const data = ev.data.trim()
    if (!data) return []
    if (data === '[DONE]') return [{ done: true }]
    if (eventName === 'sse_heartbeat') return []

    let obj: Record<string, any>
    try {
      obj = JSON.parse(data)
    } catch {
      return []
    }
    if (!obj || typeof obj !== 'object') return []

    if (eventName === 'gateway-error') {
      throw this.classifyError(pickString(obj.message, obj.msg, data), {
        status: numberOrUndefined(obj.status ?? obj.status_code),
        code: numberOrUndefined(obj.code ?? obj.error_code),
        detail: obj,
      })
    }
    if (eventName === 'stream_error' || (obj.error_code !== undefined && Number(obj.error_code) !== 0)) {
      throw this.classifyError(pickString(obj.error_msg, obj.message, obj.msg, data), {
        code: numberOrUndefined(obj.error_code ?? obj.code),
        detail: obj,
      })
    }

    // 用户消息回显，绝不能当成助手正文
    if (eventName === 'full_msg_notify') return []

    const out: ChatDelta[] = []
    let blockTextInEvent = false

    if (eventName === 'sse_reply_end') {
      // end_type=1 是正文结束；后续只有推荐问题，提前收尾
      out.push({ done: true })
      return out
    }

    if (eventName === 'sse_ack') {
      const cid = pickString(obj.ack_client_meta?.conversation_id, obj.conversation_id, obj.conversationId)
      if (cid && cid !== '0') out.push({ conversationId: cid })
      return out
    }

    const usage = obj.usage ?? obj.token_usage ?? obj.message?.usage ?? obj.event_data?.usage
    if (usage && typeof usage === 'object') out.push({ usage })

    const pushText = (text: string, forceThinking?: boolean) => {
      if (!text) return
      if (forceThinking ?? state.inThinking) out.push({ reasoning: text })
      else out.push({ text })
    }

    /** 新版协议：block_type=10040 的 content.thinking_block 承载思考内容或步骤摘要 */
    const pushThinking = (content: any): boolean => {
      const thinking = content?.thinking_block
      if (!thinking || typeof thinking !== 'object') return false
      const think = pickString(
        thinking.think,
        thinking.text,
        typeof thinking.content === 'string' ? thinking.content : '',
      )
      if (think) {
        out.push({ reasoning: think })
      } else if (cfg.emitThinkingSummary) {
        // 网页端 cot_ui_style=summary 时只下发步骤标题，不下发完整 CoT
        const title = pickString(
          thinking.finish_title,
          thinking.streaming_title,
          thinking.unfold_streaming_title,
          thinking.title,
          thinking.summary,
        )
        if (title && title !== state.lastThinkingTitle) {
          state.lastThinkingTitle = title
          if (!/^(正在思考|深度思考中|深度思考|已完成思考|思考中)$/.test(title)) {
            out.push({ reasoning: `${title}\n` })
          }
        }
      }
      // thinking_block 是自包含块；重置旧的 delimiter 状态，避免把正文误判为思考
      state.inThinking = false
      state.thinkDelimiters = 0
      return true
    }

    const handleBlock = (block: any) => {
      if (!block || typeof block !== 'object') return
      const bt = Number(block.block_type ?? block.content_type ?? block.type ?? 0)
      const content = block.content ?? block
      if (bt === 10040) {
        if (pushThinking(content)) return
        // 兼容旧协议：无 thinking_block 的 10040 作为思考分隔符
        state.thinkDelimiters += 1
        state.inThinking = state.thinkDelimiters === 1
        const think = pickString(
          content?.text_block?.text,
          content?.think,
          typeof content === 'string' ? content : '',
        )
        if (think) pushText(think, true)
        return
      }
      if (bt === 10000 || bt === 10001 || bt === 2001 || bt === 2003) {
        const text = pickString(
          content?.text_block?.text,
          content?.text,
          content?.text_block?.content,
          typeof content === 'string' ? content : '',
        )
        if (text) {
          blockTextInEvent = true
          pushText(text)
        }
        return
      }
      if (bt === 2008) {
        const think = pickString(content?.think)
        const answer = pickString(content?.text_block?.text, content?.text)
        if (think) out.push({ reasoning: think })
        if (answer) {
          blockTextInEvent = true
          out.push({ text: answer })
        }
        return
      }
      if (bt === 10024 || bt === 10025 || bt === 10101 || bt === 10052) {
        return // 工具/搜索/附件块：当前不映射为正文
      }
      // 未知块：只抓明显的 think/text 字段，避免把结构化内容当成正文
      if (pushThinking(content)) return
      const think = pickString(content?.think)
      if (think) out.push({ reasoning: think })
      const text = pickString(content?.text_block?.text, content?.text)
      if (text) {
        blockTextInEvent = true
        pushText(text)
      }
    }

    const handleBlockList = (list: unknown) => {
      if (Array.isArray(list)) for (const b of list) handleBlock(b)
    }

    handleBlockList(obj.content_block)
    handleBlockList(obj.content?.content_block)
    if (Array.isArray(obj.patch_op)) {
      for (const patch of obj.patch_op) {
        const pv = patch?.patch_value ?? patch
        handleBlockList(pv?.content_block)
        if (typeof pv?.content === 'string' && pv.content) {
          try {
            const inner = JSON.parse(pv.content)
            if (inner && typeof inner === 'object' && (inner.block_type !== undefined || inner.content?.thinking_block || inner.content?.text_block)) {
              handleBlock(inner)
            } else if (!pushThinking(inner)) {
              const t = pickString(inner?.text)
              if (t) {
                blockTextInEvent = true
                pushText(t)
              }
              const think = pickString(inner?.think)
              if (think) out.push({ reasoning: think })
            }
          } catch {
            /* 非 JSON patch，忽略 */
          }
        }
      }
    }

    // 紧凑 chunk_delta：{"text":"..."}（当前事件没有 content_block 时）
    if (!blockTextInEvent && typeof obj.text === 'string' && obj.text && obj.error_code === undefined) {
      pushText(obj.text)
    }
    if (typeof obj.think === 'string' && obj.think) out.push({ reasoning: obj.think })

    // 兼容 legacy message 结构混入
    const msg = obj.message ?? obj.event_data?.message
    if (msg && typeof msg === 'object') {
      const ct = Number(msg.content_type ?? 0)
      let content: any = msg.content
      if (typeof content === 'string') {
        try {
          content = JSON.parse(content)
        } catch {
          content = {}
        }
      }
      if (content?.thinking_block) {
        const think = pickString(content.thinking_block.think, content.thinking_block.text)
        if (think) out.push({ reasoning: think })
      } else {
        const t = pickString(content?.text)
        const think = pickString(content?.think)
        if (ct === 2008) {
          if (think) out.push({ reasoning: think })
          if (t) out.push({ text: t })
        } else if (ct === 2001 || ct === 10000 || ct === 2003) {
          if (t) out.push({ text: t })
        }
      }
    }

    if (eventName === 'stream_end' || eventName === 'sse_end' || eventName === 'done' || eventName === 'finish') {
      out.push({ done: true })
    } else if (typeof obj.finish_reason === 'string' && obj.finish_reason) {
      out.push({ done: true })
    }
    return out
  }

  // ── /samantha/chat/completion 事件解析 ─────────────────────

  private parseLegacyEvent(ev: SseEvent, state: ParseState): ChatDelta[] {
    const eventName = (ev.event || '').toLowerCase()
    const data = ev.data.trim()
    if (!data) return []
    if (data === '[DONE]') return [{ done: true }]

    let obj: Record<string, any>
    try {
      obj = JSON.parse(data)
    } catch {
      return []
    }
    if (!obj || typeof obj !== 'object') return []

    if (eventName === 'gateway-error') {
      throw this.classifyError(pickString(obj.message, obj.msg, data), {
        status: numberOrUndefined(obj.status ?? obj.status_code),
        code: numberOrUndefined(obj.code ?? obj.error_code),
        detail: obj,
      })
    }

    const eventType = Number(obj.event_type ?? obj.type ?? 0)
    const out: ChatDelta[] = []

    if (eventType === 2003) return [{ done: true }]
    if (eventType === 2005) {
      const detail = obj.event_data ?? obj
      const detailObj = typeof detail === 'string'
        ? (() => {
            try {
              return JSON.parse(detail)
            } catch {
              return { message: detail }
            }
          })()
        : detail
      throw this.classifyError(
        pickString(detailObj?.description, detailObj?.message, detailObj?.msg, String(detail)),
        {
          code: numberOrUndefined(detailObj?.error_code ?? obj.error_code),
          detail,
        },
      )
    }
    if (eventType === 2002) {
      const cid = pickString(obj.event_data?.conversation_id, obj.event_data?.ack_client_meta?.conversation_id)
      if (cid && cid !== '0') out.push({ conversationId: cid })
    }
    if (eventType === 2010) return out

    let eventData: any = obj.event_data
    if (typeof eventData === 'string') {
      try {
        eventData = JSON.parse(eventData)
      } catch {
        eventData = {}
      }
    }
    const usage = eventData?.usage ?? obj.usage
    if (usage && typeof usage === 'object') out.push({ usage })

    let msg: any = eventData?.message ?? obj.message
    if (typeof msg === 'string') {
      try {
        msg = JSON.parse(msg)
      } catch {
        msg = {}
      }
    }
    if (!msg || typeof msg !== 'object') {
      if (eventName === 'done') return [{ done: true }]
      return out
    }

    const ct = Number(msg.content_type ?? 0)
    let content: any = msg.content
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content)
      } catch {
        content = { text: content }
      }
    }
    const text = pickString(content?.text)
    const think = pickString(content?.think)

    if (ct === 2008 || ct === 10040) {
      if (think) out.push({ reasoning: think })
      if (text) {
        // 2008 在部分响应里承载最终答案；10040 仅承载思考
        if (ct === 10040) out.push({ reasoning: text })
        else out.push({ text })
      }
    } else if (ct === 2001 || ct === 10000 || ct === 2003) {
      if (text) out.push({ text })
    } else if (ct === 2002) {
      /* 推荐问题，忽略 */
    } else {
      if (think) out.push({ reasoning: think })
      if (text) out.push({ text })
    }

    if (eventName === 'done') out.push({ done: true })
    return out
  }
}
