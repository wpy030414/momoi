# Spec — 声线模拟（Voice Simulation）

## 概述

为 Agent 增加声线模拟能力：上传参考音频 → 克隆声线 → AI 回复后自动分句合成语音（GPT-SoVITS / CosyVoice）→ SSE 实时推送分段音频 → 消息气泡顶部播放按钮。

**TTS 提供商接口** (`apps/server/src/ai/tts.ts` 中的 `TtsProvider`) 定义了两个操作：`registerVoice(audioPath)` 上传参考音频并返回 `speakerId`，以及 `synthesize(text, speakerId, settings)` 按句合成并返回 WAV `Buffer`。GPT-SoVITS（默认）和 CosyVoice 各有一个实现，通过工厂函数 `createTtsProvider(config)` 创建。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `packages/shared/src/types.ts` | `VoiceSettings`、`VoiceAudioSegment` 类型；`Agent` 接口中的 `voice_enabled`/`voice_sample_url`/`voice_settings` 字段；`ServerMessage` 联合类型中的 `voice_segment`/`voice_done` 事件 |
| `packages/shared/src/constants.ts` | `DEFAULT_TTS_ENDPOINT`（`http://localhost:9880`）、`DEFAULT_TTS_PROVIDER`（`gpt-sovits`） |
| `apps/server/src/schema.ts` | `agents` 表：`voice_enabled`（boolean）、`voice_sample_url`（text）、`voice_settings`（text, JSON） |
| `apps/server/src/config.ts` | `getTtsConfig()` / `updateTtsConfig()` — TTS endpoint + provider 的热配置；Agent CRUD 对 voice 字段的读写 |
| `apps/server/src/ai/tts.ts` | TTS 引擎：`TtsProvider` 接口、GPT-SoVITS / CosyVoice 实现、工厂函数、`synthesizeAndSave()` / `markVoiceComplete()` |
| `apps/server/src/routes/admin.ts` | Agent 声线上传/克隆/状态查询/清除端点 + TTS 全局配置读写 |
| `apps/server/src/routes/voice.ts` | REST 回退：`POST /api/voice/segments` 查询已合成语音分段 |
| `apps/server/src/routes/assets.ts` | `GET /api/assets/voice/:agent_id/:message_id/:filename` — 音频文件静态服务（需用户 JWT，有路径穿越防护） |
| `apps/server/src/routes/chat.ts` | 后置分句 TTS 合成集成：AI 回复完成后异步分句 → 调 `synthesizeAndSave()` → SSE 推送 `voice_segment`/`voice_done` |
| `apps/web/src/components/voice/VoicePlayButton.tsx` | 播放按钮组件 |
| `apps/web/src/hooks/useVoice.ts` | 语音状态管理 hook |
| `apps/web/src/lib/audio/AudioPlaybackManager.ts` | Web Audio API 播放器 |
| `apps/web/src/hooks/useChat.ts` | SSE `voice_segment` → `voice:segment` CustomEvent；`voice_done` → `voice:done` CustomEvent |
| `apps/web/src/components/chat/MessageBubble.tsx` | 集成播放按钮 |
| `apps/web/src/components/admin/tabs/AgentManager.tsx` | 声线配置 UI |

## 数据模型

### Agent 扩展字段（`agents` 表）

```sql
voice_enabled   INTEGER NOT NULL DEFAULT 0      -- boolean, 声线开关
voice_sample_url TEXT    NOT NULL DEFAULT ''     -- 参考音频路径，如 /api/assets/voice/{agent_id}/sample.wav
voice_settings  TEXT    NOT NULL DEFAULT '{}'    -- JSON: VoiceSettings
```

`config.ts` 中 Agent CRUD 函数的反序列化处理：
- `listAgents()` / `getAgent()` 读取 `voice_enabled`（`(row as any).voice_enabled ?? false`）、`voice_sample_url`、`voice_settings`
- `createAgent()` 接收 `voiceEnabled` / `voiceSampleUrl` / `voiceSettings` 三个额外参数
- `updateAgent()` 的 `partial` 可包含 `voice_enabled` / `voice_sample_url` / `voice_settings`

### VoiceSettings（前端/Agent 存储使用）

```typescript
interface VoiceSettings {
  speed: number              // 0.5 - 2.0，默认 1.0
  pitch: number              // -12 ~ +12 semitones，默认 0
  emotionStrength: number    // 0.0 - 1.0，默认 0.8（当前存储但未传入 TTS 引擎）
  speakerId: string          // TTS API 返回的说话人 ID
  provider: string           // 'gpt-sovits' | 'cosyvoice'
}
```

`voice_settings` 字段以 JSON 字符串存入数据库；克隆声线成功后由 admin 端点写入 `speakerId` 和 `provider`。

### TtsSynthesisSettings（实际传入 TTS 引擎）

```typescript
interface TtsSynthesisSettings {
  speed: number  // 0.5 - 2.0
  pitch: number  // -12 ~ +12 semitones
}
```

`chat.ts` 中从 `voice_settings` JSON 取出 `speed` 和 `pitch` 构建此对象传给 `synthesizeAndSave()`。`emotionStrength` 已定义在类型中但尚未接入 TTS 引擎接口——GPT-SoVITS 和 CosyVoice 当前均不消费该参数。

#### GPT-SoVITS 请求体（`POST {endpoint}/tts`）

```json
{
  "text": "待合成文本",
  "text_language": "zh",
  "refer_wav_path": "<speakerId>",
  "speed": 1.0,
  "top_k": 5,
  "top_p": 1,
  "temperature": 1
}
```

#### CosyVoice 请求体（`POST {endpoint}/synthesize`）

```json
{
  "text": "待合成文本",
  "voice_id": "<speakerId>",
  "speed": 1.0
}
```

### VoiceAudioSegment

```typescript
interface VoiceAudioSegment {
  index: number
  text: string               // 对应原句
  audio_url: string          // 音频文件相对路径
  duration_seconds: number
}
```

响应中的 duration 估算公式：`audioBuffer.length / 64000`（假定 32kHz 单声道 16bit WAV）。

## 配置

### TTS 全局热配置

TTS endpoint 和 provider 通过 `settings` 表存储（键：`tts_api_endpoint`、`tts_provider`），由 `config.ts` 中的以下函数管理：

```typescript
getTtsConfig(): Promise<{ endpoint: string; provider: string }>
updateTtsConfig(partial: Partial<{ endpoint: string; provider: string }>): Promise<{ endpoint: string; provider: string }>
```

默认值：

| 键 | 默认值 | 常量 |
|---|---|---|
| `tts_api_endpoint` | `http://localhost:9880` | `DEFAULT_TTS_ENDPOINT` |
| `tts_provider` | `gpt-sovits` | `DEFAULT_TTS_PROVIDER` |

**运行时行为**：每次聊天请求触发语音合成时，`chat.ts` 调 `getTtsConfig()` 以获取当前最新配置（支持运行时热更新，无需重启）。`clone` 端点调用 `getTtsConfig()` 后传给 `createTtsProvider()` 以确定向哪个 TTS 后端注册声线。

## API 契约

### 用户端端点

#### POST /api/voice/segments（需用户 JWT）

页面刷新后 REST 回退查询已缓存的语音分段。

**请求**：
```json
{ "agent_id": "xxx", "message_id": 42 }
```

**响应**：
```json
{
  "segments": [
    { "index": 0, "text": "原文第一句", "audio_url": "/api/assets/voice/xxx/42/seg_0.wav", "duration_seconds": 3.2 },
    { "index": 1, "text": "原文第二句", "audio_url": "/api/assets/voice/xxx/42/seg_1.wav", "duration_seconds": 2.1 }
  ],
  "complete": true
}
```

- `complete` 从 `manifest.json` 中读取；`false` 表示 TTS 仍在合成中。
- 无 manifest 文件时返回 `{ "segments": [], "complete": false }`。

#### GET /api/assets/voice/:agent_id/:message_id/:filename

音频文件下载。需用户 JWT。路径穿越防护：拒绝包含 `..` 的 `filename` 参数，且校验 `filePath.startsWith(path.resolve('data', 'voice'))`，防止越权读取其他目录。返回 `audio/wav` MIME 类型。

### 管理员端点

所有端点均需管理员 JWT（`adminAuthMiddleware` 保护 `/tts` 和 `/tts/*`）。

#### POST /api/admin/agents/:id/voice/upload

上传参考音频文件（form-data，`Content-Type: multipart/form-data`）。

**字段**：`file` — 音频文件（`.wav` / `.mp3` / `.ogg`）

**行为**：
1. 校验 Agent 存在
2. 仅校验扩展名白名单（`.wav` / `.mp3` / `.ogg`），不做 magic bytes 校验
3. 保存到 `data/voice/{agent_id}/sample{ext}`
4. 更新 Agent 的 `voice_sample_url` 为 `/api/assets/voice/{agent_id}/sample{ext}`

**响应**：`{ "success": true, "sample_url": "/api/assets/voice/{id}/sample.wav" }`

#### POST /api/admin/agents/:id/voice/clone

调用当前配置的 TTS 提供商注册声线。

**行为**：
1. 校验 Agent 存在
2. 检查 `data/voice/{agent_id}/sample.wav` 是否存在（回退查 `.mp3`）
3. 读取当前 `tts_config` → 创建 `TtsProvider` → 调 `registerVoice(audioPath)` 获取 `speakerId`
4. 合并写入 `voice_settings` JSON：`speakerId` 和 `provider`
5. 不自动启用 `voice_enabled`（需手动开启）

**响应**：`{ "success": true, "speaker_id": "xxx" }`

#### GET /api/admin/agents/:id/voice/status

查询 Agent 声线状态。

**响应**：
```json
{
  "speaker_id": "xxx",
  "sample_url": "/api/assets/voice/{id}/sample.wav",
  "voice_enabled": true
}
```

#### DELETE /api/admin/agents/:id/voice

清除 Agent 声线数据。

**行为**：
1. 删除 `data/voice/{agent_id}/` 整个目录
2. 重置 `voice_enabled=false`、`voice_sample_url=''`、`voice_settings='{}'`

**响应**：`{ "success": true }`

#### GET /api/admin/tts/config

读取 TTS 全局配置。

**响应**：`{ "endpoint": "http://localhost:9880", "provider": "gpt-sovits" }`

#### PUT /api/admin/tts/config

更新 TTS 全局配置。

**请求**（partial）：
```json
{ "endpoint": "http://localhost:9880", "provider": "cosyvoice" }
```

**响应**：同 GET。

## SSE 事件

聊天 SSE 流中推送两个语音事件，定义在 `ServerMessage` 联合类型：

### voice_segment

```typescript
{ type: 'voice_segment'; message_id: number; index: number; audio_url: string; text: string; duration_seconds: number }
```

每完成一句 TTS 合成即推送。前端 `useChat.ts` 将 SSE `voice_segment` 转发为 `voice:segment` CustomEvent。

### voice_done

```typescript
{ type: 'voice_done'; message_id: number; total_segments: number }
```

全部句子合成完成后推送。前端 `useChat.ts` 将 SSE `voice_done` 转发为 `voice:done` CustomEvent（携带 `message_id` 和 `total_segments`）。

## 合成 Pipeline

```
AI 回复完成
  → 检查 agent.voice_enabled && voiceSettings.speakerId 存在
  → 分句（正则 /[。！？.!?\n]/，单句最长 40 字符）
  → fork 异步任务（不阻塞 SSE token 流）
    → 读 TTS 全局配置 (getTtsConfig)
    → 构建 TtsSynthesisSettings { speed, pitch }
    → createTtsProvider(config)
    → 逐句调 synthesizeAndSave()
      → provider.synthesize(text, speakerId, settings) → Buffer
      → 写 WAV 到 data/voice/{agentId}/{messageId}/seg_{i}.wav
      → 写/更新 manifest.json
      → SSE voice_segment
    → 全部完成后 markVoiceComplete()
    → SSE voice_done
```

**分句规则**：
- 句子边界正则：`/[。！？.!?\n]/`
- 单句长度上限：40 字符（超过则按 40 字符硬切）
- 实现：`chat.ts` 中的 `splitSentences()` 工具函数

**异步 fork**：`synthesizeReplyVoice()` 在 `Promise.allSettled()` 中调度所有分句，使用 `Promise.resolve().then(...)` 异步踢开，不与 SSE token 流竞争。合成失败不影响聊天功能（`console.warn` + 优雅降级）。

## 音频文件存储

```
data/voice/
  {agent_id}/
    sample.wav                 # 参考音频原文件（或 sample.mp3）
    {message_id}/
      seg_0.wav                # 第 1 句 TTS 合成结果（32kHz 单声道 16bit WAV）
      seg_1.wav                # 第 2 句
      manifest.json            # 分段元信息
```

### manifest.json

```json
{
  "total_segments": 3,
  "texts": ["第一句原文", "第二句原文", "第三句原文"],
  "complete": false
}
```

- `synthesizeAndSave()` 每次写入一个 segment 时更新 manifest
- `markVoiceComplete()` 在所有 segment 完成后将 `complete` 设为 `true`
- `POST /api/voice/segments` 通过 manifest 重建响应

## 行为约束

1. **中立 Agent 不参与语音**：`voice_enabled` 对 neutral role Agent 无意义（chat.ts 中 `voiceAgent` 检查不排除 neutral，但 UI/逻辑层面应避免）
2. **语音合成失败不影响聊天**：所有 TTS 调用包裹在 try-catch 中，失败只打 `console.warn`，不阻断 SSE 流
3. **音频文件与 Agent 生命周期绑定**：`DELETE /api/admin/agents/:id/voice` 清理 `data/voice/{agent_id}/` 目录（但删除 Agent 本身不会自动 cascade 清理音频文件）
4. **音频静态路由需用户 JWT**，带双重路径穿越防护（`filename.includes('..')` + `filePath.startsWith` 校验）
5. **GPT-SoVITS / CosyVoice 需用户自行部署**，项目不内嵌 TTS 引擎
6. **合成在 reply 写入 DB 后才触发**：保证 `message_id` 已确定
7. **未启用声线不触发任何 TTS 流程**：`voiceEnabled && voiceSpeakerId` 双重守卫
8. **TTS 全局配置支持热更新**：chat 请求中实时 `getTtsConfig()`，无需重启服务

## 验收标准

1. Admin 面板可上传参考音频并克隆声线
2. `clone` 端点正确调用 TTS backend 并写入 `speakerId` + `provider` 到 `voice_settings`
3. Agent 启用 `voice_enabled` 后，AI 回复自动按句合成语音分段
4. SSE `voice_segment` / `voice_done` 事件在合成过程中实时按下发
5. 消息气泡显示播放按钮，点击播放语音
6. 刷新页面后通过 `POST /api/voice/segments` 可恢复已合成语音分段
7. 语速（speed）/音调（pitch）参数在合成中可感知
8. TTS 全局配置（endpoint / provider）可通过 admin 端点热更新
9. 未启用声线的 Agent 不触发任何 TTS 流程
10. 语音合成失败时 SSE 流和聊天功能正常（优雅降级）
11. 音频文件路径不存在越权风险（双重路径穿越防护）