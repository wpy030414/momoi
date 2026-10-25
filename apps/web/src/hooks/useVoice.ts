import { useState, useEffect, useRef, useCallback } from 'react'
import { AudioPlaybackManager } from '../lib/audio/AudioPlaybackManager'

interface VoiceSegment {
  index: number
  text: string
  audio_url: string
  duration_seconds: number
}

type PlayState = 'idle' | 'loading' | 'synthesizing' | 'ready' | 'playing' | 'paused' | 'done'

interface UseVoiceOptions {
  agentId: string
  messageId: number
  text: string
  /** Whether this agent has voice enabled */
  enabled: boolean
}

export function useVoice({ agentId, messageId, text, enabled }: UseVoiceOptions) {
  const [segments, setSegments] = useState<VoiceSegment[]>([])
  const [allReady, setAllReady] = useState(false)
  /** 服务端没有该消息的语音缓存（未合成 / 内容被编辑后已清理）：隐藏播放按钮，
   *  避免空 manifest 让加载动画无限轮询 */
  const [unavailable, setUnavailable] = useState(false)
  const [playState, setPlayState] = useState<PlayState>(() => {
    // Check if pre-synthesized segments exist
    return 'idle'  // start idle — user clicks to trigger
  })
  const [currentTime, setCurrentTime] = useState(0)
  const [totalDuration, setTotalDuration] = useState(0)
  const playbackRef = useRef<AudioPlaybackManager | null>(null)

  // 消息内容 / 发言者变化（如编辑）：丢弃旧片段与播放态
  useEffect(() => {
    setSegments([])
    setAllReady(false)
    setUnavailable(false)
    setPlayState('idle')
    setCurrentTime(0)
    setTotalDuration(0)
  }, [agentId, messageId, text])

  // Listen for SSE voice_segment events
  useEffect(() => {
    if (!enabled) return

    const collected: Map<number, VoiceSegment> = new Map()

    const onSegment = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail.messageId !== messageId) return
      collected.set(detail.index, {
        index: detail.index,
        text: detail.text,
        audio_url: detail.audioUrl,
        duration_seconds: detail.duration,
      })
      setUnavailable(false)
    }

    const onDone = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail.messageId !== messageId) return
      // Convert map to sorted array
      const sorted = Array.from(collected.entries())
        .sort(([a], [b]) => a - b)
        .map(([, seg]) => seg)
      if (sorted.length > 0) setUnavailable(false)
      setSegments(sorted)
      setAllReady(true)
      const total = sorted.reduce((sum, s) => sum + s.duration_seconds, 0)
      setTotalDuration(total)
    }

    window.addEventListener('voice:segment', onSegment)
    window.addEventListener('voice:done', onDone)

    return () => {
      window.removeEventListener('voice:segment', onSegment)
      window.removeEventListener('voice:done', onDone)
    }
  }, [enabled, messageId])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      playbackRef.current?.destroy()
    }
  }, [])

  // Fetch segments via REST fallback (for page refresh)
  const fetchSegments = useCallback(async () => {
    if (!enabled) return false
    setPlayState('loading')

    try {
      const res = await fetch('/api/voice/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, message_id: messageId }),
      })
      if (!res.ok) throw new Error('Failed to fetch segments')
      const data = await res.json()
      const segs = Array.isArray(data.segments) ? data.segments : []
      if (segs.length > 0) {
        setSegments(segs)
        setTotalDuration(segs.reduce((sum: number, s: VoiceSegment) => sum + s.duration_seconds, 0))
        setUnavailable(false)
      } else if (!data.complete) {
        // 没有 manifest / 空片段且未完成：视为不可用，停止轮询
        setUnavailable(true)
      }
      setAllReady(data.complete ?? false)
      if (data.complete) {
        setPlayState('ready')
      } else if (segs.length > 0) {
        setPlayState('synthesizing')
      } else {
        setPlayState('idle')
      }
      return data.complete === true || segs.length === 0
    } catch (err) {
      console.warn('[useVoice] Failed to fetch segments:', err)
      setPlayState('idle')
      return false
    }
  }, [agentId, messageId, enabled])

  // Poll until ready when synthesizing
  useEffect(() => {
    if (playState !== 'synthesizing' || allReady) return

    const interval = setInterval(async () => {
      const complete = await fetchSegments()
      if (complete) {
        clearInterval(interval)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [playState, allReady, fetchSegments])

  // Play control
  const play = useCallback(async () => {
    if (unavailable) return
    // If we have segments from SSE (ready), or need to fetch them
    let segs = segments
    if (segs.length === 0 || !allReady) {
      const complete = await fetchSegments()
      if (!complete) {
        // Poll will eventually show ready
        return
      }
      // Need to re-read segments after fetch
      // fetchSegments already set state, but we can't read updated state here
      // So we'll read from the fetched data directly
      try {
        const res = await fetch('/api/voice/segments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agentId, message_id: messageId }),
        })
        const data = await res.json()
        segs = data.segments || []
      } catch {
        return
      }
    }

    if (segs.length === 0) return

    // Create or reuse playback manager
    if (!playbackRef.current) {
      playbackRef.current = new AudioPlaybackManager()
    }

    const pm = playbackRef.current
    pm.setStateListener((state) => {
      setPlayState(state)
      if (state === 'idle') setCurrentTime(0)
    })
    pm.setTimeListener((current) => {
      setCurrentTime(current)
    })

    await pm.loadChunks(segs.map(s => ({ url: s.audio_url, duration: s.duration_seconds })))
    setPlayState('ready')

    pm.play()
  }, [segments, allReady, agentId, messageId, fetchSegments, unavailable])

  const pause = useCallback(() => {
    playbackRef.current?.pause()
  }, [])

  const resume = useCallback(() => {
    playbackRef.current?.resume()
  }, [])

  const stop = useCallback(() => {
    playbackRef.current?.stop()
  }, [])

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return {
    playState,
    segments,
    allReady,
    unavailable,
    currentTime,
    totalDuration,
    currentTimeFormatted: formatTime(currentTime),
    totalDurationFormatted: formatTime(totalDuration),
    play,
    pause,
    resume,
    stop,
  }
}