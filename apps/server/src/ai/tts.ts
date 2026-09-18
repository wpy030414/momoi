import fs from 'fs'
import path from 'path'
import { repoRoot } from '../lib/paths.js'

// ---- TTS Provider Interface ----

export interface TtsProvider {
  name: string
  /** Upload a reference audio sample and register a speaker. Returns speakerId. */
  registerVoice(audioPath: string): Promise<string>
  /**
   * Synthesize text to speech.
   * For streaming providers, returns audio buffer for one sentence chunk.
   */
  synthesize(text: string, speakerId: string, settings: TtsSynthesisSettings): Promise<Buffer>
}

export interface TtsSynthesisSettings {
  speed: number          // 0.5 - 2.0
  pitch: number          // -12 ~ +12 semitones
}

// ---- GPT-SoVITS Provider (http://localhost:9880) ----

class GptSovitsProvider implements TtsProvider {
  readonly name = 'gpt-sovits'

  constructor(private endpoint: string) {}

  async registerVoice(audioPath: string): Promise<string> {
    const fileBuffer = fs.readFileSync(audioPath)
    const ext = path.extname(audioPath).toLowerCase()
    const mimeType = ext === '.mp3' ? 'audio/mpeg' : ext === '.ogg' ? 'audio/ogg' : 'audio/wav'

    const formData = new FormData()
    formData.append('refer_wav_path', new Blob([fileBuffer], { type: mimeType }), path.basename(audioPath))
    formData.append('prompt_text', '')
    formData.append('prompt_language', 'zh')

    const res = await fetch(`${this.endpoint}/set_refer_audio`, {
      method: 'POST',
      body: formData,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText)
      throw new Error(`GPT-SoVITS register voice failed: ${errText}`)
    }

    // GPT-SoVITS v2 returns { speaker: "name" } — use the filename stem as speaker id
    const stem = path.basename(audioPath, ext)
    return stem
  }

  async synthesize(text: string, speakerId: string, settings: TtsSynthesisSettings): Promise<Buffer> {
    const res = await fetch(`${this.endpoint}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        text_language: 'zh',
        refer_wav_path: speakerId,
        speed: settings.speed ?? 1.0,
        top_k: 5,
        top_p: 1,
        temperature: 1,
      }),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText)
      throw new Error(`GPT-SoVITS synthesize failed: ${errText}`)
    }

    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }
}

// ---- CosyVoice Provider ----

class CosyVoiceProvider implements TtsProvider {
  readonly name = 'cosyvoice'

  constructor(private endpoint: string) {}

  async registerVoice(audioPath: string): Promise<string> {
    const fileBuffer = fs.readFileSync(audioPath)
    const ext = path.extname(audioPath).toLowerCase()
    const mimeType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav'

    const formData = new FormData()
    formData.append('audio', new Blob([fileBuffer], { type: mimeType }), path.basename(audioPath))

    const res = await fetch(`${this.endpoint}/register_voice`, {
      method: 'POST',
      body: formData,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText)
      throw new Error(`CosyVoice register voice failed: ${errText}`)
    }

    const data = await res.json() as { voice_id: string }
    return data.voice_id
  }

  async synthesize(text: string, speakerId: string, settings: TtsSynthesisSettings): Promise<Buffer> {
    const res = await fetch(`${this.endpoint}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice_id: speakerId,
        speed: settings.speed ?? 1.0,
      }),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText)
      throw new Error(`CosyVoice synthesize failed: ${errText}`)
    }

    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }
}

// ---- Factory ----

export function createTtsProvider(config: { endpoint: string; type: string }): TtsProvider {
  switch (config.type) {
    case 'cosyvoice':
      return new CosyVoiceProvider(config.endpoint)
    case 'gpt-sovits':
    default:
      return new GptSovitsProvider(config.endpoint)
  }
}

// ---- Synthesize-and-save helper used by the chat route ----

export async function synthesizeAndSave(
  agentId: string,
  messageId: number,
  segmentIndex: number,
  text: string,
  settings: TtsSynthesisSettings,
  speakerId: string,
  provider: TtsProvider,
): Promise<{ url: string; duration: number }> {
  const dir = path.resolve(repoRoot(), 'data', 'voice', agentId, String(messageId))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const filename = `seg_${segmentIndex}.wav`
  const filepath = path.join(dir, filename)

  const audioBuffer = await provider.synthesize(text, speakerId, settings)
  fs.writeFileSync(filepath, audioBuffer)

  // Estimate duration: WAV 32kHz mono 16bit = 64000 bytes/sec
  const duration = audioBuffer.length / 64000

  // Write/update manifest
  const manifestPath = path.join(dir, 'manifest.json')
  let manifest: { total_segments: number; texts: string[]; complete: boolean } = { total_segments: 0, texts: [], complete: false }
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) } catch { /* reset */ }
  }
  while (manifest.texts.length <= segmentIndex) manifest.texts.push('')
  manifest.texts[segmentIndex] = text
  manifest.total_segments = Math.max(manifest.total_segments, segmentIndex + 1)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  return {
    url: `/api/assets/voice/${agentId}/${messageId}/${filename}`,
    duration,
  }
}

/** Mark manifest as complete after all segments are done */
export function markVoiceComplete(agentId: string, messageId: number): void {
  const manifestPath = path.resolve(repoRoot(), 'data', 'voice', agentId, String(messageId), 'manifest.json')
  let manifest: any = { total_segments: 0, texts: [], complete: false }
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) } catch { /* reset */ }
  }
  manifest.complete = true
  const dir = path.dirname(manifestPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}