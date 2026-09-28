// ============================================================
// Prompt Rule Engine — 组装流水线
// ============================================================
// 极简规则引擎：注册表 + 条件 + 分层排序 + 拼接。
//
//   注册：片段以 id 为唯一键；重复注册 = 原位覆盖（便于运行时调参而不乱序）
//   条件：when(ctx) 决定片段是否参与本次组装
//   排序：目标配方的层顺序 → 同层 priority 降序 → 注册先后（稳定）
//   组装：逐个渲染、空产出丢弃、块间以配方的 separator 连接（默认 '\n\n'）
//   容错：单个片段的 when/render 抛错只跳过该片段并打日志——
//         一条坏规则绝不能弄瘫整条提示词（扩展性的前提）。
// ============================================================

import type {
  AssembledPart,
  AssembledPrompt,
  PromptFragment,
  PromptFragmentInfo,
  PromptLayer,
  PromptTarget,
  PromptTargetInfo,
  PromptTargetSpec,
} from './types.js'

/** 片段的可变部分（override() 用） */
export type PromptFragmentPatch = Partial<
  Pick<PromptFragment<any>, 'targets' | 'layer' | 'priority' | 'description' | 'when' | 'render' | 'source'>
>

export interface AssembleOptions<C extends object = Record<string, unknown>> {
  /** 本次组装的临时片段（不进入注册表）：对话记录等「数据块」以片段身份参与排序 */
  fragments?: PromptFragment<C>[]
  /** 连接符覆盖（默认取目标配方的 separator，未定义则 '\n\n'） */
  separator?: string
}

interface Entry {
  fragment: PromptFragment<any>
  /** 注册序号：稳定排序的最终兜底；覆盖注册不改变序号 */
  order: number
  disabled: boolean
}

const DEFAULT_SEPARATOR = '\n\n'

/** 片段块归一化：统一换行、去掉首尾空白（块之间的间距由 separator 统一负责）。
 *  这样无论片段文本自带几个前导/尾随换行，组装结果都保持一致。 */
function normalizeBlock(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^\s+|\s+$/g, '')
}

export class PromptEngine {
  private entries: Entry[] = []
  private byId = new Map<string, Entry>()
  private targets = new Map<PromptTarget, Required<PromptTargetSpec>>()
  /** 层首次出现顺序（未在配方中显式列出的层，按其兜底排序） */
  private layerSeen = new Map<PromptLayer, number>()
  private seq = 0

  // ---- 目标（配方） ----

  /** 定义一份配方：层顺序 + 连接符。重复定义 = 覆盖。 */
  defineTarget(target: PromptTarget, spec: PromptTargetSpec): this {
    this.targets.set(target, {
      layers: [...spec.layers],
      separator: spec.separator ?? DEFAULT_SEPARATOR,
      description: spec.description ?? '',
    })
    return this
  }

  hasTarget(target: PromptTarget): boolean {
    return this.targets.has(target)
  }

  /** 列出所有已注册的配方（含各自片段数） */
  listTargets(): PromptTargetInfo[] {
    return [...this.targets.entries()].map(([target, spec]) => ({
      target,
      description: spec.description,
      layers: [...spec.layers],
      separator: spec.separator,
      fragmentCount: this.entries.filter(
        (e) => !e.disabled && matchesTarget(e.fragment, target),
      ).length,
    }))
  }

  // ---- 注册表 ----

  /** 注册片段。同 id 已存在 = 原位覆盖（保留注册序号，不改变既有排序）。 */
  register<C extends object>(fragment: PromptFragment<C>): this {
    this.assertFragment(fragment)
    const existing = this.byId.get(fragment.id)
    if (existing) {
      existing.fragment = fragment as PromptFragment<any>
      existing.disabled = false
    } else {
      const entry: Entry = { fragment: fragment as PromptFragment<any>, order: this.seq++, disabled: false }
      this.entries.push(entry)
      this.byId.set(fragment.id, entry)
    }
    this.noteLayer(fragment.layer)
    return this
  }

  registerAll(fragments: PromptFragment<any>[]): this {
    for (const f of fragments) this.register(f)
    return this
  }

  /** 注销片段（扩展卸载时用）。返回是否命中。 */
  unregister(id: string): boolean {
    const entry = this.byId.get(id)
    if (!entry) return false
    this.entries = this.entries.filter((e) => e !== entry)
    this.byId.delete(id)
    return true
  }

  /** 覆盖已注册片段的可变部分（文本/条件/位置）。返回是否命中。 */
  override(id: string, patch: PromptFragmentPatch): boolean {
    const entry = this.byId.get(id)
    if (!entry) return false
    const next = { ...entry.fragment, ...patch } as PromptFragment<any>
    // 只有显式给出 render/when 才替换函数，避免 patch 里 undefined 抹掉原实现
    if (!('render' in patch)) next.render = entry.fragment.render
    if (!('when' in patch)) next.when = entry.fragment.when
    if (patch.source === undefined) next.source = 'override'
    entry.fragment = next
    this.noteLayer(next.layer)
    return true
  }

  /** 禁用片段：它仍在注册表里（找得到），但不参与任何组装。 */
  disable(id: string): boolean {
    const entry = this.byId.get(id)
    if (!entry) return false
    entry.disabled = true
    return true
  }

  enable(id: string): boolean {
    const entry = this.byId.get(id)
    if (!entry) return false
    entry.disabled = false
    return true
  }

  isDisabled(id: string): boolean {
    return this.byId.get(id)?.disabled ?? false
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** 列出片段元信息（可按目标过滤）——「所有的提示词都可以在里面被找到」的入口 */
  list(filter?: { target?: PromptTarget; includeDisabled?: boolean }): PromptFragmentInfo[] {
    const includeDisabled = filter?.includeDisabled ?? true
    return this.entries
      .filter((e) => includeDisabled || !e.disabled)
      .filter((e) => !filter?.target || matchesTarget(e.fragment, filter.target))
      .map((e) => ({
        id: e.fragment.id,
        targets: normalizeTargets(e.fragment.targets),
        layer: e.fragment.layer,
        priority: e.fragment.priority ?? 0,
        description: e.fragment.description,
        source: e.fragment.source ?? 'builtin',
        conditional: typeof e.fragment.when === 'function',
        disabled: e.disabled,
      }))
  }

  // ---- 组装 ----

  /** 渲染单个片段（按 id）。被禁用 / 条件不满足 / 空产出 → null。
   *  用于「按名字取一段文本」的场景（默认人设兜底、工具描述、重试消息等）。 */
  render(id: string, ctx: object = {}): string | null {
    const entry = this.byId.get(id)
    if (!entry || entry.disabled) return null
    return this.renderEntry(entry, ctx)
  }

  /** 按配方组装完整提示词。parts 逐段给出贡献者，text 即最终文本。 */
  assemble<C extends object>(target: PromptTarget, ctx: C, opts: AssembleOptions<C> = {}): AssembledPrompt {
    const spec = this.targets.get(target)
    const separator = opts.separator ?? spec?.separator ?? DEFAULT_SEPARATOR

    const candidates: Entry[] = this.entries.filter(
      (e) => !e.disabled && matchesTarget(e.fragment, target),
    )
    // 临时片段：紧随注册表之后（注册序号更大），同样参与层/优先级排序
    const ephemeral: Entry[] = (opts.fragments ?? []).map((f, i) => ({
      fragment: f as PromptFragment<any>,
      order: this.seq + 1 + i,
      disabled: false,
    }))

    const parts: AssembledPart[] = []
    for (const entry of [...candidates, ...ephemeral].sort((a, b) => this.compare(a, b, spec))) {
      const content = this.renderEntry(entry, ctx)
      if (!content) continue
      parts.push({
        id: entry.fragment.id,
        layer: entry.fragment.layer,
        priority: entry.fragment.priority ?? 0,
        description: entry.fragment.description,
        source: entry.fragment.source ?? (ephemeral.includes(entry) ? 'runtime' : 'builtin'),
        content,
      })
    }

    return { target, text: parts.map((p) => p.content).join(separator), parts }
  }

  // ---- 内部 ----

  private renderEntry(entry: Entry, ctx: object): string | null {
    const f = entry.fragment
    try {
      if (f.when && !f.when(ctx)) return null
    } catch (err) {
      console.error(`[prompts] fragment "${f.id}" when() failed, skipped:`, (err as Error).message)
      return null
    }
    try {
      const raw = f.render(ctx)
      if (raw === null || raw === undefined) return null
      const text = normalizeBlock(String(raw))
      return text || null
    } catch (err) {
      console.error(`[prompts] fragment "${f.id}" render() failed, skipped:`, (err as Error).message)
      return null
    }
  }

  private compare(a: Entry, b: Entry, spec?: Required<PromptTargetSpec>): number {
    const layers = spec?.layers ?? []
    const ra = this.layerRank(a.fragment.layer, layers)
    const rb = this.layerRank(b.fragment.layer, layers)
    if (ra !== rb) return ra - rb
    const pa = a.fragment.priority ?? 0
    const pb = b.fragment.priority ?? 0
    if (pa !== pb) return pb - pa
    return a.order - b.order
  }

  private layerRank(layer: PromptLayer, layers: PromptLayer[]): number {
    const idx = layers.indexOf(layer)
    if (idx !== -1) return idx
    // 配方未声明的层：排在显式层之后，按「层首次出现的先后」兜底
    return layers.length + (this.layerSeen.get(layer) ?? 0) + 1
  }

  private noteLayer(layer: PromptLayer): void {
    if (!this.layerSeen.has(layer)) this.layerSeen.set(layer, this.layerSeen.size)
  }

  private assertFragment(fragment: PromptFragment<any>): void {
    if (!fragment?.id) throw new Error('[prompts] fragment id is required')
    if (typeof fragment.render !== 'function') {
      throw new Error(`[prompts] fragment "${fragment.id}" must provide render()`)
    }
    if (!fragment.targets) throw new Error(`[prompts] fragment "${fragment.id}" must declare targets`)
  }
}

function matchesTarget(fragment: PromptFragment<any>, target: PromptTarget): boolean {
  const t = fragment.targets
  if (t === '*') return true
  return Array.isArray(t) ? t.includes(target) : t === target
}

function normalizeTargets(targets: PromptFragment<any>['targets']): PromptTarget[] {
  if (targets === '*') return ['*']
  return Array.isArray(targets) ? [...targets] : [targets]
}
