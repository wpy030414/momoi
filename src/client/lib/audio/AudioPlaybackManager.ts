export class AudioPlaybackManager {
  private audioContext: AudioContext | null = null
  private sourceNode: AudioBufferSourceNode | null = null
  private _isPlaying = false
  private _isPaused = false
  private onStateChange: ((state: 'idle' | 'loading' | 'playing' | 'paused' | 'done') => void) | null = null
  private onTimeUpdate: ((current: number, total: number) => void) | null = null
  private currentTime = 0
  private totalDuration = 0
  private startTime = 0
  private bufferedChunks: Array<{ url: string; duration: number }> = []
  private currentChunkIndex = 0
  private audioBuffer: AudioBuffer | null = null

  setStateListener(fn: (state: 'idle' | 'loading' | 'playing' | 'paused' | 'done') => void) {
    this.onStateChange = fn
  }

  setTimeListener(fn: (current: number, total: number) => void) {
    this.onTimeUpdate = fn
  }

  private getContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext()
    }
    return this.audioContext
  }

  async loadChunks(chunks: Array<{ url: string; duration: number }>): Promise<void> {
    this.bufferedChunks = chunks
    this.totalDuration = chunks.reduce((sum, c) => sum + c.duration, 0)
    this.currentChunkIndex = 0
    this.currentTime = 0

    if (chunks.length === 0) return

    this.onStateChange?.('loading')

    // Pre-fetch all chunks and concatenate
    try {
      const ctx = this.getContext()
      const allBuffers: AudioBuffer[] = []
      let totalLength = 0

      for (const chunk of chunks) {
        const response = await fetch(chunk.url)
        const arrayBuffer = await response.arrayBuffer()
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
        allBuffers.push(audioBuffer)
        totalLength += audioBuffer.length
      }

      // Concatenate into one buffer
      const sampleRate = allBuffers[0]!.sampleRate
      const channels = allBuffers[0]!.numberOfChannels
      const concatBuffer = ctx.createBuffer(channels, totalLength, sampleRate)

      let offset = 0
      for (const buf of allBuffers) {
        for (let ch = 0; ch < channels; ch++) {
          concatBuffer.getChannelData(ch).set(buf.getChannelData(ch), offset)
        }
        offset += buf.length
      }

      this.audioBuffer = concatBuffer
    } catch (err) {
      console.warn('[AudioPlayback] Failed to load chunks:', err)
      this.onStateChange?.('done')
    }
  }

  play(): void {
    if (!this.audioBuffer) return

    const ctx = this.getContext()
    if (ctx.state === 'suspended') {
      ctx.resume()
    }

    if (this._isPaused) {
      // Resume from pause position
      this._isPaused = false
      this.playFromOffset(this.currentTime)
    } else {
      // Start from beginning
      this.currentTime = 0
      this.playFromOffset(0)
    }
  }

  private playFromOffset(offsetSeconds: number): void {
    if (!this.audioBuffer) return

    const ctx = this.getContext()
    // Stop any existing source
    if (this.sourceNode) {
      try { this.sourceNode.stop() } catch { /* already stopped */ }
    }

    this.sourceNode = ctx.createBufferSource()
    this.sourceNode.buffer = this.audioBuffer
    this.sourceNode.connect(ctx.destination)

    const offset = Math.min(offsetSeconds, this.audioBuffer.duration)
    this.sourceNode.start(0, offset)
    this.startTime = ctx.currentTime - offset
    this._isPlaying = true
    this._isPaused = false
    this.onStateChange?.('playing')

    // Time update loop
    const tick = () => {
      if (!this._isPlaying || !this.audioContext) return
      this.currentTime = this.audioContext.currentTime - this.startTime
      this.onTimeUpdate?.(this.currentTime, this.totalDuration || this.audioBuffer!.duration)

      if (this.currentTime >= (this.audioBuffer?.duration ?? 0)) {
        this._isPlaying = false
        this.onStateChange?.('done')
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)

    this.sourceNode.onended = () => {
      if (!this._isPaused) {
        this._isPlaying = false
        this.onStateChange?.('done')
      }
    }
  }

  pause(): void {
    if (!this._isPlaying) return
    this._isPlaying = false
    this._isPaused = true
    // Save exact position
    if (this.audioContext) {
      this.currentTime = this.audioContext.currentTime - this.startTime
    }
    if (this.sourceNode) {
      try { this.sourceNode.stop() } catch { /* ignore */ }
      this.sourceNode = null
    }
    this.onStateChange?.('paused')
  }

  resume(): void {
    if (!this._isPaused) return
    this.play()
  }

  stop(): void {
    this._isPlaying = false
    this._isPaused = false
    if (this.sourceNode) {
      try { this.sourceNode.stop() } catch { /* ignore */ }
      this.sourceNode = null
    }
    this.currentTime = 0
    this.onStateChange?.('idle')
  }

  get isPlaying(): boolean { return this._isPlaying }
  get isPaused(): boolean { return this._isPaused }

  destroy(): void {
    this.stop()
    if (this.audioContext) {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
    }
    this.audioBuffer = null
    this.bufferedChunks = []
  }
}