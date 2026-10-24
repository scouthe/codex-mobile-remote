import { computed, onUnmounted, ref, shallowRef, type Ref } from 'vue'
import type { PhoneControlSession, PhoneInput, PhoneVideoFormat } from '../types/phoneControl'
import type { PhoneRun } from '../types/phoneAgent'
import { PhoneVideoPlayer } from '../phone/videoPlayer'

const CONTEXT_KEY = 'phone-agent-manual-context'

export function usePhoneControl(video: Ref<HTMLVideoElement | null>, resumed: (run: PhoneRun) => void, visible = () => true) {
  const session = shallowRef<PhoneControlSession>()
  const context = shallowRef<PhoneControlSession>()
  const stage = ref<'idle' | 'acquiring' | 'connecting' | 'live' | 'closing'>('idle')
  const error = ref(''), inputBusy = ref(false), resumeBusy = ref(false)
  const format = shallowRef<PhoneVideoFormat>()
  const supported = PhoneVideoPlayer.supported()
  const ownsControl = computed(() => stage.value !== 'idle')
  let player: PhoneVideoPlayer | undefined
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const lifetime = new AbortController()
  try { context.value = JSON.parse(sessionStorage.getItem(CONTEXT_KEY) || 'null') || undefined } catch {}

  async function request<T>(path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetch('/phone-agent-api/control/' + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}), signal: lifetime.signal,
      })
    } catch (cause) {
      if (lifetime.signal.aborted) throw cause
      throw new Error('连接已中断，请恢复网络后刷新任务和接管状态。')
    }
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '手机控制请求失败。')
    return data as T
  }

  function remember(value?: PhoneControlSession) {
    context.value = value
    if (value) sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(CONTEXT_KEY)
  }

  function stopVideo() { clearTimeout(heartbeat); clearTimeout(startupTimer); player?.stop(); player = undefined; format.value = undefined }

  async function release(quiet = false) {
    const current = session.value
    stopVideo()
    if (!current) return
    stage.value = 'closing'
    try {
      const response = await fetch(`/phone-agent-api/control/sessions/${current.id}/release`, { method: 'POST', keepalive: true, signal: AbortSignal.timeout(10000) })
      if (!response.ok && !quiet) throw new Error('释放接管失败，请稍后重试。')
    } catch (cause) { if (!quiet && !disposed) error.value = cause instanceof Error ? cause.message : '连接已断开，接管将自动释放。' }
    finally { if (session.value === current) { session.value = undefined; stage.value = 'idle' } }
  }

  function scheduleHeartbeat(id: string) {
    clearTimeout(heartbeat)
    heartbeat = setTimeout(async () => {
      if (session.value?.id !== id || disposed) return
      try { await request(`sessions/${id}/heartbeat`); if (session.value?.id === id) scheduleHeartbeat(id) }
      catch (cause) { if (!disposed) { error.value = cause instanceof Error ? cause.message : '接管连接已断开。'; await release(true) } }
    }, 5000)
  }

  async function acquire(deviceId: string, previousRunId?: string) {
    if (ownsControl.value || disposed) return
    error.value = ''
    if (!supported) { error.value = '请使用新版 Chrome 或 Edge 打开实时投屏。'; return }
    stage.value = 'acquiring'
    try {
      const data = await request<{ session: PhoneControlSession }>('sessions', { deviceId, previousRunId })
      session.value = data.session; remember(data.session)
      if (disposed || document.hidden || !visible() || !video.value) { await release(true); return }
      stage.value = 'connecting'; scheduleHeartbeat(data.session.id)
      const activePlayer = new PhoneVideoPlayer(video.value, {
        format: value => { format.value = value; stage.value = 'connecting' },
        ready: () => { if (session.value?.id === data.session.id) { clearTimeout(startupTimer); stage.value = 'live' } },
      })
      player = activePlayer
      startupTimer = setTimeout(() => {
        if (player === activePlayer && stage.value === 'connecting') { error.value = '实时画面连接超时，请重新接管。'; void release(true) }
      }, 16000)
      void activePlayer.play(`/phone-agent-api/control/sessions/${data.session.id}/stream`).catch(async cause => {
        if (player !== activePlayer || disposed) return
        error.value = cause instanceof Error ? cause.message : '投屏已断开，Agent 保持停止。'
        await release(true)
      })
    } catch (cause) {
      if (!disposed) error.value = cause instanceof Error ? cause.message : '接管失败。'
      await release(true); stage.value = 'idle'
    }
  }

  async function input(value: PhoneInput) {
    const waking = stage.value === 'connecting' && value.type === 'key' && value.key === 'wake'
    if ((stage.value !== 'live' && !waking) || !session.value || inputBusy.value) return
    inputBusy.value = true; error.value = ''
    try { await request(`sessions/${session.value.id}/input`, value) }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '手机操作失败。' }
    finally { inputBusy.value = false }
  }

  async function resume(note: string) {
    const previous = context.value
    if (!previous?.previousRunId || resumeBusy.value) return
    resumeBusy.value = true; error.value = ''
    const id = session.value?.id
    stopVideo(); stage.value = id ? 'closing' : 'idle'
    try {
      const data = await request<{ run: PhoneRun }>('resume', {
        sessionId: id, previousRunId: previous.previousRunId, deviceId: previous.deviceId, note,
      })
      remember(); session.value = undefined; stage.value = 'idle'
      if (!disposed) resumed(data.run)
    } catch (cause) {
      if (!disposed) error.value = cause instanceof Error ? cause.message : '继续任务失败。'
      await release(true)
    } finally { resumeBusy.value = false }
  }

  function leave() {
    if (session.value) { error.value = '投屏已关闭，Agent 保持停止。'; void release(true) }
  }
  function visibility() { if (document.hidden) leave() }
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pagehide', leave)
  onUnmounted(() => {
    disposed = true; lifetime.abort(); leave(); stopVideo()
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', leave)
  })
  return { session, context, stage, format, error, ownsControl, supported, inputBusy, resumeBusy, acquire, release, input, resume }
}
