# Spec — 世界模拟（World Simulation）

## 概述

世界模拟是第三种会话形态（`conversations.type = 'world'`），提供一个由提示词创生的**三维有限面积沙盘**，取代该会话消息气泡区的位置。用户在创建时写下一段世界描述，同时规定**世界地形规则**（山地、丘陵、森林……未提及则随机生成自然地形）与**世界法则**（永久黑夜、伤害一律致命、水体有毒……）。

核心约束：**地形规则创生后不可修改，世界法则可随时更改**。

**三个阶段均已完成**：
- **Phase 1** —— 创生、地形生成与渲染、相机操作、法则编辑
- **Phase 2** —— 生灵入场：实体持久化、回合制行动、世界工具、事件日志、专用 SSE 端点
- **Phase 3** —— 上帝化身（放置 + 邻近感知）、Agent 改造世界（叠加补丁）、自动演算

相关决策见 `docs/DECISIONS.md` D47–D52。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `packages/shared/src/noise.ts` | 确定性噪声原语：mulberry32 / 整型格点哈希 / 值噪声 / fBm / 脊状 fBm / fnv1a |
| `packages/shared/src/world.ts` | **协议面**：`TerrainSpec` 与词表、`buildTerrain`、`waterLevel`、`normalizeTerrainSpec`、`defaultTerrainSpec`、`spawnPoints`、`terrainSummary` |
| `apps/server/src/ai/world-generator.ts` | 提示词 → 结构化地形参数 + 法则原文誊写 |
| `apps/server/src/ai/world-orchestrator.ts` | **回合引擎**：上帝行动 → 存活 Agent 依次行动一拍 |
| `apps/server/src/tools/world-tools.ts` | 世界工具（move / speak / observe / act / reshape）+ `WorldSignal` 旁路对象 |
| `apps/server/src/lib/world-ticker.ts` | 自动演算：自重新调度的计时器 + 内存态开关 |
| `apps/server/src/lib/world.ts` | 世界状态层：生成任务、自愈清扫、状态读取、法则更新 |
| `apps/server/src/routes/worlds.ts` | `POST /api/worlds`、`GET /api/worlds/:id`、`PATCH /api/worlds/:id` |
| `apps/server/src/lib/realtime.ts` | `broadcastWorldStatus` |
| `apps/web/src/lib/webgl.ts` | WebGL2 能力探测 |
| `apps/web/src/components/sidebar/NewWorkflowDialog.tsx` | 「新工作流」统一入口对话框 |
| `apps/web/src/components/sidebar/AgentPickerList.tsx` | Agent 多选列表（新建群聊与群成员管理共用） |
| `apps/web/src/components/world/WorldPanel.tsx` | 世界视图容器：生成态、探测闸门、懒加载边界 |
| `apps/web/src/components/world/WorldCanvas.tsx` | **全仓唯一 import three 的模块**：网格 / 水面 / 天空 / 相机 / 控制器 / 拆卸 |
| `apps/web/src/components/world/WorldFallback.tsx` | 二维俯视地图降级 |
| `apps/web/src/components/world/LawsEditor.tsx` | 法则编辑 + 地形规则只读回显 |
| `apps/web/src/components/world/WorldEventLog.tsx` | 按回合分组的事件日志（可折叠、自动滚底） |
| `apps/web/src/components/world/GodActionBar.tsx` | 上帝行动输入条 |
| `apps/web/src/hooks/useWorld.ts` | `useWorldChat`：世界状态获取 / 缓存 / 轮询 / 实时 / 创生 |

## 数据模型

### `worlds` 表（与 `conversations` 1:1）

```sql
CREATE TABLE IF NOT EXISTS worlds (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  terrain_prompt  TEXT NOT NULL DEFAULT '',           -- 不可变：用户原文「世界地形规则」
  terrain_spec    TEXT NOT NULL DEFAULT '',           -- TerrainSpec JSON；生成中为空串
  laws            TEXT NOT NULL DEFAULT '',           -- 可变：世界法则
  status          TEXT NOT NULL DEFAULT 'generating', -- 'generating' | 'ready' | 'failed'
  status_error    TEXT NOT NULL DEFAULT '',           -- 失败原因（可展示）
  turn            INTEGER NOT NULL DEFAULT 0,         -- 回合计数（Phase 2 起使用）
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_worlds_status ON worlds(status);
```

**为何是侧表而非 `conversations` 上的列**：在本仓库的迁移机制下，新表 = 4 处机械编辑且 `sqlite.ts` 无需改动；新列则要**再加**一个 `pg.ts` 里目前不存在的 `ALTER` 通道，**再加** `sqlite.ts` 的 `try/catch`。此外 `GET /api/conversations` 在每次侧边栏刷新时全量查 `conversations`，数 KB 的 `terrain_spec` 不该搭那趟车。既有先例：`group_conversation_agents`、`wechat_bindings`、`qq_bindings` 都是类型专属状态的侧表。

**刻意省略 `user_id`**：归属**永远**以 `conversations.user_id` 为准（单一事实来源）。重复一份会与之漂移，等于开出第二条鉴权路径。

**软删除语义**：`conversations` 是软删除（只置 `deleted_at`），故 `worlds` 行**不会**随会话删除而消失，**没有 FK 级联要补**；但每一次世界读取都必须连带过滤 `conversations.deleted_at IS NULL`，否则已删除会话的世界仍可被访问。

### 成员复用 `group_conversation_agents`

世界的参与 Agent 与群聊成员**结构完全同构**（同样的列、排序语义、生命周期），故复用该表，不新开 `world_agents`。代价是表名说「group」却服务两种会话类型——改名意味着一次没有迁移器的表迁移，严格更糟。本扩张记录于此与 `module-group-chat.md`。

`POST /api/worlds` 插入成员时过滤 `NEUTRAL_AGENT_ID`。

### `world_entities` 表 —— 世界中的存在

```sql
CREATE TABLE IF NOT EXISTS world_entities (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'agent',        -- 'agent' | 'god'（Phase 3 起用）
  agent_id TEXT,                             -- kind='agent' 时关联 agents.id
  name TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 0,                 -- 归一化坐标 [-1,1]
  z REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'alive',      -- 'alive' | 'dead' | 'gone'
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_world_entities_conv ON world_entities(conversation_id);
```

坐标刻意与 `@momoi/shared/world` 的采样坐标系**同构**（归一化 [-1,1]、中心 (0,0)），故客户端可直接把它送进 `sampleHeight` / `sampleBiome` 而无需任何换算。

**播种时机**：地形**生成完成后**在 `runGeneration` 里播种（`spawnPoints` 需要 spec）。播种是**幂等**的，且落点用 Phase 1 的确定性散列函数 —— 故用户看到的 Agent 位置不会因为「实体持久化了」而跳动。`GET /api/worlds/:id` 也会在发现「已就绪但无实体」时就地补播种（自愈）。

### `world_events` 表 —— 世界的「消息」

```sql
CREATE TABLE IF NOT EXISTS world_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,      -- PG: SERIAL
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn INTEGER NOT NULL DEFAULT 0,           -- 回合序号
  seq INTEGER NOT NULL DEFAULT 0,            -- 回合内顺序（1 起稠密）
  actor_kind TEXT NOT NULL DEFAULT 'world',  -- 'god' | 'agent' | 'world'
  actor_id TEXT,                             -- world_entities.id；'god'/'world' 为 null
  actor_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'act',          -- 'act'|'speak'|'move'|'die'|'law'|'narration'
  content TEXT NOT NULL DEFAULT '',
  payload TEXT,                              -- JSON：坐标移动、状态变更等结构化增量
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_world_events_conv ON world_events(conversation_id, turn, seq);
```

**这是世界的历史**。世界不传递聊天历史给 Agent —— 每个 Agent 的世界简报直接由这张日志构成。故世界完全不依赖 `messages` 表的任何机制（落库、追问建议、语音合成、无限模式）。

**法则变更也进日志**（`kind='law'`）：既是一份审计轨迹，也让「法则何时被改过」进入后续回合 Agent 可见的历史 —— 否则旧法则下的行动会显得毫无来由。

### `world_patches` 表 —— 改造的叠加层

```sql
CREATE TABLE IF NOT EXISTS world_patches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,      -- PG: SERIAL
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,            -- 全局单调递增 = 折叠顺序
  patch TEXT NOT NULL,                       -- TerrainPatch JSON
  source TEXT NOT NULL DEFAULT 'agent',      -- 'agent' | 'god'
  agent_id TEXT,
  actor_name TEXT NOT NULL DEFAULT '',
  turn INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_world_patches_conv ON world_patches(conversation_id, seq);
```

⚠️ **这是叠加层，永不写回 `terrain_spec`** —— 那正是「地形规则不可修改」与「Agent 可以改造世界」共存的方式（D49）。`foldPatches(spec, x, z, patches)` 按 `seq` 升序依次折叠。

⚠️ **网格（`buildTerrain`）与逐点采样（`sampleHeight`）必须共用同一份折叠实现**。曾经只有网格侧有，于是 Agent 抬高了地形、而服务端描述地形时仍报基准高度 —— 两边各说各话，且**静默**（不报错、类型检查也看不出）。`terrain:check` 有断言盯着这点。

水位**不随改造漂移**：`waterLevel` 由基准地形的分位数决定。Agent 抬高陆地只会让水变少，不会把海也一起抬高。

### `conversations.type` 扩为 `'direct' | 'group' | 'world'`

Drizzle 的 `type` 是**无枚举约束的 TEXT**，DDL 亦无约束 —— **无需任何 DDL 变更**。

⚠️ `POST /api/conversations` **显式拒绝** `type: 'world'` 并返回 `400`。运行时那是**未经校验的 JSON**，类型标注不是守卫；不拒绝就能造出「有 conversations 行、无 worlds 行」的永久损坏侧边栏条目。世界只能经 `POST /api/worlds` 创建。

## 地形参数与确定性生成

### `TerrainSpec`

```ts
interface TerrainSpec {
  version: 1
  seed: number
  terrain: {
    style: 'mountains'|'hills'|'plains'|'plateau'|'islands'|'mixed'
    amplitude: number   // 0..1 起伏强度
    roughness: number   // 0..1 基础频率倍率
    octaves: number     // 1..8
    warp: number        // 0..1 域扭曲强度
    seaLevel: number    // −1..1，**水位分位的微调量**（见 waterLevel）
    water: 'none'|'ocean'|'lakes'|'toxic'
  }
  biomes: BiomeRule[]   // 1..6，按序首次命中；末项必须无条件
  sky: { preset: 'day'|'dusk'|'night'|'eternal_night'|'blood'|'void'; fog?: number }
  marks?: Array<{ name: string; x: number; z: number; kind: MarkKind }>
  summary: string                        // 一句自然语言概括，注入 Agent 提示词
  generated_by: 'llm' | 'fallback'       // 降级可见性
}
```

**词表闭合**：`biomes[].id` 必须落在 `TERRAIN_ENUMS.biomeId` 内。模型很爱自造 id（`toxic`/`mountain`/`ice`…），`normalizeBiomes` 用别名表映射回词表；映射不到的取词表内首个未用 id；词表用尽则丢弃该条。不收口的后果实测有二：英文 id 漏进中文摘要（「生物群系：toxic、biome5」），以及拿不到调色板配色。

### 噪声管线（必须逐条落实，跨引擎可复现）

1. **PRNG** `mulberry32(seed)` → `[0,1)`，不依赖 `Math.random` / `crypto`
2. **整型格点哈希** `hash2i`：`Math.imul` 系，**全程 `Math.imul` + `>>> 0`**
3. **值噪声**：四角格点值 + 五次淡入 `t³(t(6t−15)+10)` 双线性插值
4. **fBm**：按总振幅归一化；每个八度用独立 seed 偏移（`+ i·1013`），避免格点对齐产生网格伪影
5. **脊状 fBm**：`1 − |2n − 1|` **在每个八度内部**累加 —— 事后对 fBm 结果脊化会把高度均值推到接近 1，山地世界会长成一片惨白
6. **域扭曲**：两个独立低八度 fBm 场偏移采样坐标
7. **`applyStyle`**：`plains` 压缩、`plateau` smoothstep + 台地量化、`islands` 岛群掩膜 × 方形边缘淡出、`mixed` 低频振幅调制
8. **生物群系判定**：按序迭代，首个满足全部条件的规则胜出；校验保证末项无条件，故判定是**全函数**

⚠️ **禁用 `Math.sin` 系哈希**：不同 JS 引擎的对数/三角函数实现存在 ulp 级差异，会让两端算出不同地形，且**静默**不一致（无报错、无堆栈）。

### `waterLevel(spec)` —— 水位不是绝对值

高度场的实际取值范围随 style 与 amplitude 剧烈变化（`plains` 实测只有 ±0.04，`mountains` 可达 ±0.7）。若把 `seaLevel` 当**绝对值**用，低起伏地貌会把任何水位整个越过——实测表现为「提示词写了湖泊，水面占比 0%」。

改为取**地形自身高度分布的分位数**：

```
q = clamp01(WATER_BASE_QUANTILE[water] + seaLevel × 0.25)
水位 = 33×33 探针高度数组的第 q 分位
```

| water | 基础分位 |
|---|---|
| `ocean` | 0.70 |
| `toxic` | 0.42 |
| `lakes` | 0.20 |
| `none` | 返回 −∞（整片沙盘无水面） |

`style === 'islands'` 时取 `max(base, 0.68)`：高群岛是「深海海底 + 岛体」的**双峰**分布，若沿用中位分位，水位会恰好落在海底平台上，海平面等于海底深度，群岛看起来像一片悬空的台地。

结果用 `WeakMap` 按 spec 对象记忆化。判定源仍然是唯一的 `heightAt`，故服务端与客户端、逐点采样与网格采样必然一致。

### `buildTerrain(spec, { segments, patches })`

返回 `{ heights: Float32Array; moisture; biomes: Uint8Array; seaLevel; waterY }`（长度 `(segments+1)²`，行主序 `k = iz·(N+1) + ix`）。

顶点顺序与 three.js `PlaneGeometry(w, h, N, N)` 经 `rotateX(−π/2)` 之后**逐位对应**，故渲染层只需 `pos.setY(k, h[k]·S·scale)`。

⚠️ 网格高度存在 `Float32Array` 里，故与 `sampleHeight`（返回 float64）相差约 1e-8 的 float32 舍入——这是存储精度差异，不是算法分歧。

`patches` 是 **Phase 3 的接缝**：地形改造以**叠加层**表达，在渲染与采样时 fold 到 base 之上，永远不写回 `terrain_spec`。这是「地形规则不可修改」与「Agent 可以改造世界」能够共存的关键。Phase 1 恒为 `[]`。

### 失败开放

三层，全部在服务端：

1. **提示词级约束**：枚举清单与数值区间**由 `TERRAIN_ENUMS` 生成**后内联进系统提示词，提示词与校验器无从漂移
2. **`normalizeTerrainSpec(raw)`——永不抛异常**：数值钳制入区间、词表外的枚举丢弃、`octaves` 取整、颜色用 `/^#[0-9a-f]{6}$/i` 校验、`biomes` 长度保证 `∈[1,6]`、末项清除条件使其成为兜底、id 别名映射。返回 `repairs[]` 作为提示词需调优的信号
3. **`defaultTerrainSpec(prompt, laws)`**：LLM 抛错 / 超时 / JSON 不可解析时，依提示词文本**确定性**推导一份 spec（`seed = fnv1a(prompt｜laws)`，style/water/sky/群系由 `terrainKeywords(text)` 关键词扫描选出），`generated_by: 'fallback'`，**不发起第二次 LLM 调用**

于是世界**总是**能创生成功。`status = 'failed'` 只剩灾难情形（DB 写失败）。

## 接口契约

所有端点挂 `userAuthMiddleware`；查询一律带 `user_id` 条件，不存在 / 越权 / 已软删统一 `404`（不区分，防探测）。

### POST /api/worlds

**请求**：`{ prompt: string, agent_ids: string[], title?: string }`
其中 `prompt` 是用户写的那段世界描述，同时覆盖地形规则与法则；落在 `worlds.terrain_prompt` 列上（该列记录**地形规则的来源**，创生后不可修改，故列名与字段名不同）。

**校验**：`prompt.trim()` 非空且 ≤ 2000 字；`agent_ids` 过滤 `NEUTRAL_AGENT_ID` 后 ≥ 1 个。违反 → `400`。

**行为**（顺序写入，**不可用 `db.transaction()`** —— sql.js 适配层不支持）：
1. 建 `conversations`（`type='world'`，`title` 默认取提示词前 40 字，`agent_id` 取首个成员）
2. 批量插入 `group_conversation_agents`
3. 建 `worlds` 行（`status='generating'`）
4. `broadcastConversationSync` 使各设备侧边栏立即出现
5. **起火异步生成**（不 await）
6. 响应 **201** `{ conversation, world }`

**响应时间**：实测 27ms。刻意**不在 POST 里同步等 LLM** —— 那会把一个 10~60s 的 XHR 挂在代理超时边界上（nginx 默认 `proxy_read_timeout` 60s），钉钉 Android WebView 尤其容易把「长时间无字节流动」的请求判死；异步则生成中刷新页面 / 关标签都能恢复，失败也有持久痕迹。而且这本来就是世界的形状：世界是长生命周期对象，生成只是它的第一个 job。

### GET /api/worlds/:conversationId

**响应 200**：`{ world: WorldState, agents: Array<{ id, name, avatar }> }`
`terrain_spec` 生成中为 `null`（从 JSON 文本解析；解析失败 → `null` 且 `status` 修正为 `'failed'`，否则前端会永远停在生成态转圈）。

**惰性自愈**：`status === 'generating'` 但进程内 `generatingWorlds` 集合不含该 id（= 被重启打断）→ **直接重新生成**。

### PATCH /api/worlds/:conversationId

**请求**：`{ laws: string }`

⚠️ body 中出现 `terrain_prompt` 或 `prompt` → `400 { error: 'terrain_prompt is immutable' }`。
**服务端的这条拒绝才是「地形规则不可修改」的保证本身**；在界面上藏起输入框不算。

**响应 200**：`{ world }`（更新后的状态）

## 生成流程与自愈

```
POST /api/worlds（27ms 返回）
  → resumeWorldGeneration(convId, userId)
      → generatingWorlds.add(convId)      ← 同步占位，无竞态
      → 异步：getConfig + listAgents → 解析模型
      → generateWorldTerrain()            ← 永不抛异常，20s 超时
      → UPDATE worlds SET terrain_spec, laws, status='ready'
      → finally: generatingWorlds.delete + broadcastWorldStatus
```

**`generatingWorlds`（进程内 `Set<string>`）同时是两个东西**：

1. **并发守卫** —— 同一世界不会跑起两个生成任务
2. **「这次生成还活着吗」的权威判据** —— 不在集合里却仍是 `generating` 的行，一定是被进程重启打断的（sql.js 每 30s 才持久化一次，`SIGTERM` 会把 `generating` 行留在磁盘上）

因此被重启打断的生成可以**安全重跑**（生成是**幂等**的：只写 spec + ready），世界自愈，不需要一个「失败」状态再让用户手动点重试。

两处触发：
- **启动清扫**（`index.ts` 中 `await sweepInterruptedWorlds()`）：遍历 `status='generating'` 的行重新生成
- **`GET` 惰性检查**：正确性兜底，让状态更早自愈

仅单实例有效 —— 与 realtime 总线、`infiniteState` 同一既有限制。

**生成期间用户改法则的窗口**：`runGeneration` 只在 `row.laws` 为空时才写入模型提取的法则，否则保留用户已改的值。

## 实时事件

```ts
// RealtimeEvent 联合追加
| { type: 'world_status'; conversation_id: string; status: WorldStatus }
```

**只传状态、不传 spec**：`publish` 会扇出到本账号的**每一台**设备，数 KB 的地形参数不该搭上根本没开世界面板的设备；客户端在转入 `ready` 时自行重拉 `GET /api/worlds/:id`。

**不复用 `conv_changed`**：客户端对它的响应是 `refetchConversation`（重拉消息列表），而世界没有消息，那会是一次无意义的请求，也把「消息变了」与「世界状态变了」混为一谈 —— 本仓库正是为此才给 `group_members` 单开了一个事件。

客户端侧：`useChat` 的实时 switch 把该事件派发为 `window` CustomEvent `realtime:world_status`（与 `realtime:group_members` 逐字同构），`useWorld` 监听后处理。

## 渲染契约

### 分层懒加载

1. `App.tsx` 懒加载 `WorldPanel`（`React.lazy` → 组件模块）
2. `WorldPanel` 在**模块作用域**懒加载 `WorldCanvas`（three 那个 chunk）

⚠️ `lazy()` 必须在模块作用域，不能在组件内 —— 组件内每次渲染都会重建 lazy 类型。

实测产物（`pnpm build`）：

| chunk | raw | gzip |
|---|---|---|
| 入口 `index` | 177 KB | 49 KB |
| `vendor-three` | 559 KB | 137 KB |

入口**未**静态引用 `vendor-three`；仅 `WorldPanel`（动态预载映射）与 `WorldCanvas`（静态导入）引用。故不开世界会话的用户零成本。

### 能力探测

⚠️ **只接受 WebGL2**。three 自 r163 起移除了 WebGL1 支持，`WebGLRenderer` 是 WebGL2-only —— 放行一个「有 WebGL1」的设备，结果要么构造时抛错，要么渲染出一片垃圾。仅 WebGL1 的设备等同于 `none`。

```ts
export type GLSupport = 'webgl2' | 'software' | 'none'
```

- 严格探测：`getContext('webgl2', { failIfMajorPerformanceCaveat: true })` → 显式拒绝软件渲染（软件 GL 上的三维沙盘会变成幻灯片，降画质也救不回来）
- 宽松探测：`failIfMajorPerformanceCaveat: false` → `'software'`，降画质渲染而非拒之门外
- 结果缓存在模块变量：探测会分配一个**真实的 GL 上下文**（稀缺资源）

探测在**懒加载模块之外**求值，故 `none` 设备根本不会请求 `three` chunk。

### 二维降级

`'none'` 或上下文丢失时渲染 `WorldFallback`：对 `buildTerrain` 的产物采样 256×256，把群系颜色写入 `ImageData` 后 `putImageData`，并绘制 Agent 落点。水体按水深压暗，陆地按高度做明暗浮雕。

它消费**与三维视图完全相同的 `buildTerrain` 产物**，故两者不会各说各话。钉钉 Android 内置内核是首要部署目标，而这可能是多数用户唯一的渲染路径 —— 故先建先验。

### 相机（「旋转 + 缩放，不平移」）

```ts
controls.enableRotate = true
controls.enableZoom = true
controls.enablePan = false            // ← 需求本身；同时干掉右键拖拽平移
controls.enableDamping = false        // ← 按需渲染策略的前提
controls.minDistance = S * 0.5
controls.maxDistance = S * 2.8
controls.minPolarAngle = degToRad(12) // 绝不降到地平面以下
controls.maxPolarAngle = degToRad(78)
controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: null, RIGHT: null }
controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE }
```

- **`TOUCH.TWO = DOLLY_ROTATE`** 使双指手势**既能捏合缩放、又能扭转旋转**，正是需求描述的「双指缩放 / 手指滑动旋转」
- **`touchAction = 'none'` 必需** —— 没有它浏览器会滚动/缩放**页面**而不是把事件喂给画布；这是 WebGL 视图最常见的触屏 bug，在这里尤甚（画布位于 app 的主滚动区内）
- **极角钳制同时省掉双面材质**：平移已禁用，若不加钳制，用户暴力向下拖可绕到地形下方看穿背面；钳到 12°–78° 后不可能发生
- **不调 `listenToKeyEvents`**：键盘平移/缩放不是要的能力

### 渲染策略

**按需重绘**（`controls` 的 `change` 事件 + `ResizeObserver`），不跑常驻 `requestAnimationFrame`。Phase 1 没有动画，唯一需要重绘的契机是相机变化或尺寸变化；代价是必须 `enableDamping = false`（阻尼需要连续循环才能收敛）。收益在移动端是实的：读法则时没有 60fps 的持续 GPU 唤醒与发热。

**分段数**：桌面 `96` / 移动 `64` / 软件渲染 `48`（`WORLD_LIMITS`）。仅影响渲染精度，不影响地形本身。用 `window.innerWidth < 768` 判定而**非** CSS 断点 —— 钉钉 Android 内核会丢弃媒体查询。

成本分析（96 的依据）：工作量 `O(seg² × octaves × 4 个场)`，96² 约 22 万次采样 ≈ 10–30ms；256² 则是约 160 万次采样 ≈ 手机上 100–200ms 主线程阻塞，换来在典型相机距离下看不出来的提升。

**DPR**：`min(devicePixelRatio, software ? 1 : 2)` —— 移动端最大的单项性能杠杆。

### 拆卸

必须在 effect cleanup 中逐项 dispose：`controls.dispose()`、`geo` / `slabGeo` / `waterGeo`、`terrainMat` / `slabMat` / `waterMat`、名牌的材质与纹理、`renderer.dispose()`、`renderer.forceContextLoss()`、`ro.disconnect()`、移除 `change` 监听与 `webglcontextlost` 监听。WebGL 代码就是在这里泄漏的。

并监听 `webglcontextlost`（钉钉 WebView 切后台会丢上下文）：`preventDefault()` 后切换到二维降级视图，而不是留一个冻结的黑屏。

## 回合引擎（`ai/world-orchestrator.ts`）

```
POST /api/worlds/:id/act  { content }        ← 上帝行动，SSE 流式响应
  → 校验归属；世界必须 status='ready'；未就绪 → 409
  → 并发守卫：claimWorldTurn() 同步占位；已有回合在跑 → 409
  → turn = world.turn + 1；写库
  → 落库 god 事件（kind='act'）→ SSE: world_turn_start
  → 按 id 升序（确定性）遍历 status='alive' 的 agent 实体：
      → SSE: world_agent_start
      → 构造该 Agent 的世界简报 → runPiAgentLoop（**仅世界工具**）
      → 工具经 WorldSignal 回传的待定事件落库 → SSE: world_event × N
      → 持久化实体（每拍都存，中途崩溃不丢前面几拍）
      → SSE: world_agent_done
  → SSE: world_turn_end
```

**每个 Agent 的简报**（作为 `runPiAgentLoop` 的 userMessage）：回合序号、**自身确切坐标与所处地形**、附近有哪些存在（含对方位置与所处地形）、最近 20 条事件（跳过 `move` —— 噪音大信息量低）、上帝这一步做了什么。末尾附工具清单、一致性与语言要求。

**容错**：单个 Agent 失败只记一条 `narration` 事件，其余照常行动（与群聊编排一致）。`runWorldTurn` 自身不抛异常。

**思考模式**：世界回合**开启思考**。关掉它会让「我先看看四周」这类计划句无处可去、直接漏进叙述正文（实测出现过英文计划句 + 中文叙述拼接的割裂）；开启后推理走 `reasoning_content` 通道，正文只剩叙述本身。

## 世界工具（`tools/world-tools.ts`）

| 工具 | 参数 | 行为 |
|---|---|---|
| `world_move` | `{ x, z }` | 归一化坐标，服务端钳制到 ±1；写 `move` 事件 + 就地改实体坐标；返回目的地地形描述 |
| `world_speak` | `{ content, to? }` | 说话；`to` 为实体名则标记接收者；写 `speak` 事件 |
| `world_observe` | `{ radius?, target? }` | **只读**：返回自身位置、附近存在及其所处地形、最近事件。不产生事件（否则噪音淹没有效信息） |
| `world_act` | `{ action, target?, target_status? }` | 自由行动。`target_status`（`dead`/`gone`）让裁决方声明结局；服务端校验目标存在且活着，再写实体状态 + 追加 `die` 事件。**无法作用于上帝**（祂高于世界法则），但可以对祂说话 |
| `world_reshape` | `{ op, x, z, radius, strength, biome? }` | **永久**改造地貌：`raise`/`lower`/`carve`/`flatten`/`flood`/`paint`。写一条 `world_patches` + 一条 `act` 事件。三道闸：半径 ≤ 0.5、**单回合 ≤ 2 次**、`biome` 必须落在词表内 |

**旁路范式**（照搬 `MentionSignal`）：工具**不直接写库**，而是经 `ToolContext.worldSignal` 上的一个可变对象回传待落库事件与就地修改的实体。**编排器是唯一写入方** —— 它统一负责落库、下发与持久化。

⚠️ **世界回合只开放世界工具 + `load_skill`**。住在沙盘里的生灵不该能读写文件、执行 Shell 或发 HTTP 请求 —— 那些能力属于「与用户对话的助手」，不属于「世界里的人」。这条边界由 `pi-adapter` 两处维持：`defs` 的白名单选择，以及「世界回合到此为止」的提前返回（跳过 `at_mention` 与 MCP 工具的注入）。有确定性守卫盯着它（`pnpm --filter @momoi/server world:tools`）。

⚠️ **世界回合同样关闭跨会话记忆**：记忆块会**要求** Agent 调用 `save_memory`，而世界工具白名单里没有它 —— 那会让模型去够一个不存在的工具。

## 世界回合的 SSE 事件

专用端点 `POST /api/worlds/:id/act`（**不复用 `POST /api/chat`**）。

| 事件 | 数据 | 说明 |
|---|---|---|
| `world_turn_start` | `{ turn, entities }` | 回合开始，附带全部实体 |
| `world_agent_start` | `{ entity_id, name }` | 某个 Agent 开始行动 |
| `world_event` | `{ event: WorldEvent }` | 一条已落库的事件 |
| `world_agent_done` | `{ entity_id, name }` | 某个 Agent 行动结束 |
| `world_turn_end` | `{ turn }` | 回合结束 |

**保活**：每 15 秒 SSE 注释。**写入串行化**：`writeChain` 保证流关闭前尾部事件被 flush（与 `chat.ts` 同款）。**断开中止**：`stream.onAbort` 触发 `AbortController`，编排器在下一个个体前退出。

**多设备**：`RealtimeEvent` 新增两个成员 —— `world_event`（单条事件逐条中继；世界事件是**离散**的，故可直接中继，无需聊天流那条有损的 token 批量路径）与 `world_turn`（回合生命周期，其它设备据此禁用输入并显示「谁正在行动」）。客户端在 `useChat` 的实时 switch 里把它们派发为 `window` CustomEvent，由 `useWorld` 监听。

⚠️ 客户端**按事件 id 去重**：`broadcastWorldEvent` 不跳过来源设备，故触发本次回合的设备会既从本地 SSE 流收到、又从实时通道收到同一条。

## 上帝化身（Phase 3）

`POST /api/worlds/:id/god  { x, z }` —— 放置或**移动**上帝的化身（按 `kind` 唯一，重复放置是移动而非新增）。

化身的位置**是有意义的**：只有感知半径（`GOD_PERCEIVE_RADIUS = 0.6`）内的存在能在简报里读到祂的确切坐标与所处地形，远处的只能读到「你能感到上帝的存在，却无法确定祂在何处」。这正是「把 Avatar 放在世界的任何位置，与 Agent 互动」的落点 —— 想与某个 Agent 面对面，就把化身放到祂身边。

- 上帝**不受世界法则约束**（那是祂写的），故标记在沙盘上永不被压暗
- Agent 无法作用于上帝（`world_act` 明确拒绝），但可以 `world_speak` 对祂说话
- 客户端用**射线拾取**落点：点击地形 → 命中点 → 归一化坐标。放置模式**不**禁用旋转（用户往往先转个视角再落点），靠 pointerdown→pointerup 的 6px 位移阈值区分点击与拖动

## 自动演算（Phase 3）

`POST /api/worlds/:id/auto-tick  { enabled }`

开启后世界自行推进：每个回合**没有上帝行动**（`godAction` 为空），编排器因此不记空洞的上帝事件 —— 否则日志会被一串一模一样的「（时间流逝）」淹掉。

- **自重新调度的 `setTimeout`**（不用 `setInterval`）：一个回合可能跑十几秒，固定间隔会让两回合重叠，而 `turn` 与实体位置都不允许交错写。与本仓库的 push-scheduler / 微信轮询器同一范式
- 间隔 15 秒，留足时间让用户读完上一拍
- **手动回合优先**：若已有回合在跑（`claimWorldTurn` 失败），这一拍让路，下次再来
- **自动停止**：会话被删 / 世界未就绪 / **没有存活的存在**（否则只会不停记空回合）/ 用户关闭
- **开关是内存态**（与无限演算模式的 `infiniteState` 同一惯例）：重启即关闭是合理且安全的默认，而为此加一个 `worlds` 列要付的代价是 PG 那条**并不存在**的 ALTER 通道（见 `module-database.md`）。故它挂在快照旁（`WorldSnapshot.auto_tick`）而不是塞进 `WorldState`，并随 `world_turn` 广播同步到各设备

## 鉴权模型

世界与会话同等的用户隔离：
- 存在性、归属、软删除一并校验（一次查询带 `id` + `user_id` + `deleted_at IS NULL`），失败统一 `404`
- `POST /api/worlds` 与 `POST /api/conversations` 都需用户 JWT
- 世界会话**不可**绑定微信（`wechat.ts` 拒绝 `type === 'group' || type === 'world'`）
- 世界会话**不可**合并（`/merge` 的既有检查 `type !== 'group'` 即 400，天然覆盖）
- 侧边栏对世界会话隐藏「另存为 Markdown」（世界没有消息，导出只会得到空文件）

## 行为约束

### 服务端

1. **地形规则不可修改**由 `PATCH` 显式拒绝保证，不依赖界面隐藏输入框
2. **`POST /api/conversations` 拒绝 `type: 'world'`** —— 运行时是未校验 JSON，类型标注不是守卫
3. **`POST /api/chat` 拒绝 `conversation_type: 'world'`** —— Phase 1 尚无回合引擎，放它进单聊路径只会把消息气泡塞进世界会话
4. **创生立即落库**，不走「新会话草稿态」（D34 的显式例外，见 D48）
5. **顺序写入**，不使用 `db.transaction()`（sql.js 适配层不支持）
6. **生成幂等**，故被重启打断的世界可安全重跑
7. **失败开放**：`generateWorldTerrain` 永不抛异常，世界总能创生成功
8. **法则不被模型改写**：要求逐字誊写用户原文；若与原文不符则记 `repairs` 但仍采用模型版本（改写也好过丢失）

### 服务端（Phase 2）

9. **回合并发守卫**：一个世界同时只允许一个回合，否则两个回合会交错写 `turn` 与实体位置。「已有回合在跑」返回 `409`
10. **每拍持久化**：每个 Agent 行动完就写一次实体位置，中途崩溃不至于丢掉前面几拍的移动与死亡
11. **死亡不可逆**：`status` 一旦离开 `'alive'` 就不再进入行动队列
12. **`target_status` 需有据**：声明目标结局必须同时指定 `target`，且目标必须存在、活着、不是自己 —— 防止「凭空声明某人死亡」
13. **世界工具零事件**：`world_observe` 只读，不产生事件

### 服务端（Phase 3）

14. **上帝按 kind 唯一**：一个世界只有一个化身；重复放置是移动
15. **改造三道闸**：半径 ≤ 0.5、单回合 ≤ 2 次、`biome` 必须在词表内
16. **改造即时生效于同伴**：某一拍产生的补丁**就地并入** `view.patches`，后续 Agent 看到的世界必须包含前面 Agent 已动过的土 —— 否则它们会对着一个不存在的地形行动
17. **自动演算不抢手动回合**：`claimWorldTurn` 失败即让路
18. **自动演算在无存活者时停止**

### 客户端

1. **模式识别**与 `isGroupMode` 在**完全相同的三处赋值点**同步设置（`useGroupChat` 的 effect / `selectConversation` / 草稿重置分支），走同一套世代计数守卫
2. **`convTypeOf` 的联合类型必须含 `'world'`** —— 否则世界会话会**静默**回退成 `'direct'`
3. **命名纪律**：`useWorldChat` 的成员一律带 world 前缀/后缀。返回值经 `{ ...chat, ...群聊, ...世界 }` 两层展开，同名成员会**静默覆盖**内层实现
4. **选择跨模式共享**：选完三个 Agent 再切模式仍保留，只是阈值变了
5. **提交失败保持对话框打开**并保留已输入的提示词 —— 因一次瞬时 500 丢掉用户刚写的三百字世界描述是不可接受的
6. **生成中轮询**（2s × 30 次）作为实时连接掉线的兜底

## 验收标准

1. 侧边栏显示「新工作流」；点击弹出对话框，可选「群组会话」/「世界模拟」
2. 群组会话模式选 1 个 Agent → 确认禁用；选 2 个 → 启用；**现有群聊流程完全不变**
3. 世界模拟模式：Agent 数 < 1 或提示词为空 → 确认禁用
4. 确认后立即进入世界视图（对话框不阻塞），先见「大地正在成形……」，随后地形浮现
5. 地形与提示词语义相符（「黑色山脉 + 毒水 + 永夜」→ 实际如此）
6. 相机：拖拽旋转、滚轮/双指缩放、**无法平移**、不会钻到地面以下
7. 沙盘边界可见，视图不出现无限延伸
8. 所选 Agent 以名牌出现在陆地上且彼此不重叠；**刷新后位置不变**（确定性落点）
9. 地形规则区只读；法则可编辑，保存后刷新仍为新值
10. **多设备**：A 创生后 B 的侧边栏自动出现；A 生成期间 B 打开该世界，就绪后 B 自动浮现
11. **无 LLM 路径**：API 不可达时世界仍创生成功，`generated_by === 'fallback'`，UI 显示降级提示
12. **WebGL2 缺失时**：渲染二维地图 + 文本卡片，且 Network 面板**无 `vendor-three` 请求**
13. `PATCH` 带 `terrain_prompt` → `400`；未认证 → `401`；他人世界 → `404`；软删会话的世界 → `404`
14. `POST /api/conversations` 带 `type: 'world'` → `400`；`POST /api/chat` 带 `conversation_type: 'world'` → `400`
15. 自动验收脚本 `pnpm --filter @momoi/server world:e2e` 全绿（77 项）
16. 自动验收脚本 `pnpm --filter @momoi/server world:tools` 全绿（44 项，含工具契约）
17. **放置化身**：点「放置化身」→ 点击沙盘任意处 → 金色 ✦ 标记出现在落点；再点一次是**移动**而非新增；刷新后位置保留
18. **邻近感知**：化身放在某 Agent 旁边 → 下一回合该 Agent 的简报里出现上帝的确切坐标；放得很远 → 只感到「有什么在看着」
19. **Agent 改造世界**：Agent 调用 `world_reshape` → 沙盘上那块地形**当场变形**；事件日志出现对应事件；刷新后改造仍在；地形规则（只读区）不变
20. **自动演算**：点「自动演算」→ 每约 15 秒自行推进一拍，日志持续增长，无上帝事件；再点一次停下；世界无存活者时自行停止
21. **上帝不可被作用于**：Agent 若试图对上帝动手，工具返回明确拒绝，目标状态不变
