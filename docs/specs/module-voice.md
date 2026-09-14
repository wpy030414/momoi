# Spec — Voice Simulation（声线模拟）

## 概述

为 Agent 增加声线模拟能力：上传参考音频 → 克隆声线 → AI 回复后自动分句合成语音 → 消息气泡顶部播放按钮。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/shared/types.ts` | Agent 扩展字段、VoiceSettings、VoiceAudioSegment、SSE 事件 |
| `src/shared/constants.ts` | TTS 默认配置常量 |
| `src/server/schema.ts` | agents 表 voice 列（SQLite/PG） |
| `src/server/db.ts` | 双方言迁移 SQL |
| `src/server/config.ts` | Agent CRUD 扩展 + TTS 配置函数 |
| `src/server/routes/admin.ts` | 声线上传/克隆/删除 + TTS 配置端点 |
| `src/server/routes/voice.ts` | REST segments 查询端点 |
| `src/server/routes/assets.ts` | 音频静态资源路由 |
| `src/server/ai/tts.ts` | TTS 提供商抽象（GPT-SoVITS / CosyVoice） |
| `src/server/routes/chat.ts` | 后置分句 TTS 合成集成 |
| `src/client/components/voice/VoicePlayButton.tsx` | 播放按钮组件 |
| `src/client/hooks/useVoice.ts` | 语音状态管理 hook |
| `src/client/lib/audio/AudioPlaybackManager.ts` | Web Audio API 播放器 |
| `src/client/hooks/useChat.ts` | SSE voice 事件转发 |
| `src/client/components/chat/MessageBubble.tsx` | 集成播放按钮 |
| `src/client/components/admin/tabs/AgentManager.tsx` | 声线配置 UI |
| `src/client/lib/api.ts` | API client 扩展 |

## 数据模型

### Agent 扩展字段

```
voice_enabled: boolean       — 声线开关
voice_sample_url: string     — 参考音频路径
voice_settings: string       — JSON: VoiceSettings
```

### VoiceSettings

```typescript
interface VoiceSettings {
  speed: number              // 0.5 - 2.0，默认 1.0
  pitch: number              // -12 ~ +12 semitones，默认 0
  emotionStrength: number    // 0.0 - 1.0，默认 0.8
  speakerId: string          // TTS API 返回的说话人 ID
  provider: string           // 'gpt-sovits' | 'cosyvoice'
}
```

### SSE 事件

```
voice_segment: { message_id, index, audio_url, text, duration_seconds }
voice_done:    { message_id, total_segments }
```

### 文件存储

```
data/voice/{agent_id}/
  sample.wav                 # 参考音频原文件
  {message_id}/
    seg_0.wav                # 第 1 句 TTS 合成结果
    seg_1.wav                # 第 2 句
    manifest.json            # 分段元信息
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/agents/:id/voice/upload` | 上传参考音频 |
| POST | `/api/admin/agents/:id/voice/clone` | 克隆声线 |
| GET | `/api/admin/agents/:id/voice/status` | 查询状态 |
| DELETE | `/api/admin/agents/:id/voice` | 清除声线 |
| GET | `/api/admin/tts/config` | TTS 全局配置 |
| PUT | `/api/admin/tts/config` | 更新 TTS 全局配置 |
| POST | `/api/voice/segments` | REST 回退查询分段 |
| GET | `/api/assets/voice/:agent_id/:message_id/:filename` | 音频下载 |

## 合成 Pipeline

```
AI 回复完成 → 分句 → 异步逐句调 TTS API → 写入 WAV → SSE voice_segment 事件 → voice_done
```

- 句子边界：`[。！？.!?\n]` + 40 字符长度上限
- 异步 fork：不阻塞 SSE token 流
- 前端回退：页面刷新后 POST `/api/voice/segments` 查询，`manifest.json` 标记 complete

## 行为约束

1. voice 与中立 Agent 无关（中立 Agent 不启用声线）
2. 语音合成失败不影响聊天功能（优雅降级）
3. 音频文件与 Agent 生命周期绑定（删除 Agent 可级联清理）
4. 音频静态路由需 JWT 认证，防路径穿越
5. GPT-SoVITS / CosyVoice 需用户自行部署

## 验收标准

1. Admin 面板可上传参考音频并克隆声线
2. Agent 启用声线后 AI 回复自动生成语音分段
3. SSE `voice_segment` / `voice_done` 事件正确下发
4. 消息气泡显示播放按钮，点击播放语音
5. 刷新页面后仍可通过 REST 回退获取分段
6. 语速/音调参数在合成中可感知
7. 未启用声线不触发任何 TTS 流程
8. 三语 i18n 完整覆盖