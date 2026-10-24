<template>
  <div class="phone-agent" data-testid="phone-agent-panel">
    <div class="phone-agent-toolbar">
      <div class="phone-agent-identity"><span class="phone-agent-orb" aria-hidden="true">✦</span><div><strong>UI-Venus-2</strong><span>你的本地手机助手</span></div></div>
      <div class="phone-agent-toolbar-actions">
        <button type="button" class="phone-button" @click="newTask">新任务</button>
        <button type="button" class="phone-button phone-screen-toggle" :aria-pressed="showScreen" @click="showScreen = !showScreen">{{ showScreen ? '返回对话' : '手机画面' }}</button>
      </div>
    </div>
    <div v-if="error" class="phone-agent-error" role="alert">{{ error }} <button type="button" @click="refresh">重试</button></div>
    <div class="phone-workspace" :class="{ 'is-screen-visible': showScreen }">
      <section class="phone-conversation" aria-label="手机 Agent 对话">
        <div ref="conversation" class="phone-messages" aria-live="polite" aria-relevant="additions text">
          <div v-if="!runs.length" class="phone-welcome">
            <span class="phone-welcome-icon" aria-hidden="true">✦</span><h2>让手机替你做点事</h2>
            <p>告诉我目标，我会查看屏幕，一步步完成操作。<br>你可以查看手机画面，随时停止任务。</p>
            <div class="phone-suggestions"><button v-for="suggestion in suggestions" :key="suggestion" type="button" @click="draft = suggestion">{{ suggestion }} <span aria-hidden="true">↗</span></button></div>
          </div>
          <article v-for="run in runs" :key="run.id" class="phone-turn" :data-run-id="run.id">
            <div class="phone-user-message"><p>{{ run.purpose }}</p><time>{{ formatTime(run.createdAt) }}</time></div>
            <div class="phone-assistant-message">
              <div class="phone-assistant-label"><span aria-hidden="true">✦</span> Venus <span class="phone-run-status" :data-status="run.status">{{ statusLabel(run.status) }}</span></div>
              <p class="phone-assistant-text">{{ run.message }}</p>
              <button v-if="selectedId !== run.id" type="button" class="phone-detail-button" @click="selectRun(run.id)">查看步骤与截图 →</button>
              <ol v-else-if="actions.length" class="phone-timeline" aria-label="执行步骤"><li v-for="event in actions" :key="event.seq"><span>{{ event.step }}</span><p>{{ event.message }}</p></li></ol>
              <span v-if="run.step" class="phone-step-count">{{ run.step }} / {{ run.stepLimit }} 步</span>
            </div>
          </article>
        </div>
        <form class="phone-composer" @submit.prevent="send">
          <div class="phone-composer-meta"><span class="phone-connection" :class="{ 'is-connected': readyDevice }"><i />{{ readyDevice ? selectedDevice?.model : connectionLabel }}</span><button type="button" class="phone-detail-button" @click="refresh">刷新连接</button></div>
          <ComposerDropdown v-if="devices.length > 1" v-model="deviceId" class="phone-device-picker" :options="deviceOptions" placeholder="选择手机" />
          <label for="phone-agent-message" class="phone-visually-hidden">给手机 Agent 的指令</label>
          <textarea id="phone-agent-message" v-model="draft" rows="3" maxlength="4000" placeholder="例如：打开设置，查看关于手机页面，不修改任何设置" @keydown="onKeydown" />
          <div class="phone-composer-footer">
            <label class="phone-limit">最多 <input v-model.number="stepLimit" aria-label="最大操作步数" type="number" min="1" max="50" :disabled="!!activeRun" /> 步</label>
            <span v-if="selectedId && !activeRun" class="phone-context-hint">将参考所选任务继续</span><span v-else class="phone-keyboard-hint">Shift + Enter 换行</span>
            <button v-if="activeRun" type="button" class="phone-send phone-stop" :disabled="busy || activeRun.status === 'stopping'" @click="stop">{{ activeRun.status === 'stopping' ? '正在停止…' : '停止任务' }}</button>
            <button v-else type="submit" class="phone-send" :disabled="busy || !draft.trim() || !readyDevice || !available">{{ busy ? '正在提交…' : '发送任务' }} ↑</button>
          </div>
          <p class="phone-composer-note">{{ activeRun ? '任务正在执行。可以先写下下一条指令，停止或完成后再发送。' : '每条指令启动一个任务；需要补充信息时，直接在这里回复。' }}</p>
        </form>
      </section>
      <aside class="phone-screen" aria-label="手机屏幕预览">
        <div class="phone-screen-heading"><div><strong>手机画面</strong><span>{{ selectedDevice?.model || '等待手机连接' }}</span></div><button type="button" class="phone-button" :disabled="!readyDevice || screenBusy" @click="capture">{{ screenBusy ? '获取中…' : '刷新画面' }}</button></div>
        <div class="phone-screen-frame"><img v-if="screenUrl" :src="screenUrl" alt="已连接手机的当前截图" @error="screenError = '暂时无法显示截图，请刷新画面。'" @load="screenError = ''" /><div v-else class="phone-screen-empty"><span aria-hidden="true">▯</span><p>手机连接后<br>画面会显示在这里</p></div></div>
        <p class="phone-screen-note" :role="screenError ? 'status' : undefined">{{ screenError || (activeRun ? '每个操作步骤会更新画面' : '点击刷新画面，查看手机的最新状态') }}</p>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import ComposerDropdown from './ComposerDropdown.vue'
import { isPhoneRunActive, type PhoneAgentState, type PhoneEvent, type PhoneRun, type PhoneRunStatus } from '../../types/phoneAgent'

const runs = ref<PhoneRun[]>([]), devices = ref<PhoneAgentState['devices']>([]), events = ref<PhoneEvent[]>([])
const selectedId = ref(''), deviceId = ref(''), draft = ref(''), stepLimit = ref(15)
const available = ref(false), busy = ref(false), error = ref(''), screenError = ref(''), screenUrl = ref(''), screenBusy = ref(false), showScreen = ref(false)
const conversation = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false, refreshing = false, selectionInitialized = false, cursor = 0
const controller = new AbortController()
const suggestions = ['打开设置，查看关于手机页面，不修改任何设置', '返回手机桌面', '打开时钟，查看已有闹钟，不修改闹钟']
const activeRun = computed(() => runs.value.find(run => isPhoneRunActive(run.status)))
const selectedDevice = computed(() => devices.value.find(device => device.id === deviceId.value))
const readyDevice = computed(() => selectedDevice.value?.state === 'device' && selectedDevice.value.keyboardReady)
const deviceOptions = computed(() => devices.value.map(device => ({ value: device.id, label: device.model })))
const actions = computed(() => events.value.filter(event => event.type === 'action'))
const connectionLabel = computed(() => !selectedDevice.value ? '未连接手机' : selectedDevice.value.state === 'unauthorized' ? '请在手机允许 USB 调试' : selectedDevice.value.state !== 'device' ? '手机尚未授权或没有 USB 访问权限' : '请启用 ADB Keyboard 输入法')
const labels: Record<PhoneRunStatus, string> = { loading: '加载模型', running: '执行中', stopping: '正在停止', succeeded: '已完成', needs_input: '等待回复', failed: '未完成', stopped: '已停止', interrupted: '已中断' }
const statusLabel = (status: PhoneRunStatus) => labels[status] || status
const formatTime = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/phone-agent-api/' + path, { ...init, signal: controller.signal })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`)
  return data as T
}
function updateRun(run: PhoneRun) { const index = runs.value.findIndex(item => item.id === run.id); if (index >= 0) runs.value[index] = run; else runs.value.push(run) }
function setScreen(url: string) { if (url === screenUrl.value) return; if (screenUrl.value.startsWith('blob:')) URL.revokeObjectURL(screenUrl.value); screenUrl.value = url }
function schedule(delay = 2000) { clearTimeout(timer); if (!disposed) timer = setTimeout(poll, delay) }

async function selectRun(id: string, incremental = false) {
  if (!incremental) { selectedId.value = id; selectionInitialized = true; events.value = []; cursor = 0; localStorage.setItem('phone-agent-selected', id) }
  try {
    const data = await request<{ run: PhoneRun; events: PhoneEvent[]; cursor: number }>(`runs/${encodeURIComponent(id)}?after=${cursor}`)
    if (disposed || selectedId.value !== id) return
    const nearBottom = !conversation.value || conversation.value.scrollHeight - conversation.value.scrollTop - conversation.value.clientHeight < 160
    updateRun(data.run)
    const existing = new Set(events.value.map(event => event.seq))
    events.value.push(...data.events.filter(event => !existing.has(event.seq))); cursor = data.cursor
    if (data.run.screenshot) setScreen(`/phone-agent-api/runs/${encodeURIComponent(id)}/screenshot?v=${data.run.step}`)
    if (nearBottom || !incremental) {
      await nextTick()
      if (runs.value.at(-1)?.id === id) conversation.value?.scrollTo({ top: conversation.value.scrollHeight })
      else conversation.value?.querySelector(`[data-run-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '读取任务失败。' }
}
async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    const state = await request<PhoneAgentState>('state')
    if (disposed) return
    available.value = state.available; devices.value = state.devices; runs.value = state.runs; error.value = state.message
    if (!devices.value.some(device => device.id === deviceId.value)) deviceId.value = devices.value.find(device => device.state === 'device')?.id || devices.value[0]?.id || ''
    if (!selectionInitialized) {
      selectionInitialized = true
      const saved = localStorage.getItem('phone-agent-selected')
      const id = activeRun.value?.id || runs.value.find(run => run.id === saved)?.id || runs.value.at(-1)?.id
      if (id) await selectRun(id)
    }
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '连接失败，请重试。' }
  finally { refreshing = false }
}
async function capture() {
  if (!readyDevice.value || screenBusy.value) return
  screenBusy.value = true
  try {
    const response = await fetch(`/phone-agent-api/screen?deviceId=${encodeURIComponent(deviceId.value)}`, { signal: controller.signal })
    if (!response.ok) throw new Error((await response.json()).error || '无法读取手机画面。')
    setScreen(URL.createObjectURL(await response.blob())); screenError.value = ''
  } catch (cause) { if (!disposed) screenError.value = cause instanceof Error ? cause.message : '截图失败。' }
  finally { screenBusy.value = false }
}
async function send() {
  if (busy.value || activeRun.value || !draft.value.trim() || !readyDevice.value) return
  busy.value = true; error.value = ''
  try {
    const data = await request<{ run: PhoneRun }>('runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: draft.value, deviceId: deviceId.value, stepLimit: stepLimit.value, previousRunId: selectedId.value || undefined }) })
    updateRun(data.run); draft.value = ''; await selectRun(data.run.id)
    await nextTick(); conversation.value?.scrollTo({ top: conversation.value.scrollHeight, behavior: 'smooth' }); schedule(500)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '任务提交失败。' }
  finally { busy.value = false }
}
async function stop() {
  if (!activeRun.value || busy.value) return
  busy.value = true
  try { updateRun((await request<{ run: PhoneRun }>(`runs/${activeRun.value.id}/stop`, { method: 'POST' })).run); schedule(500) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '停止失败。' }
  finally { busy.value = false }
}
function newTask() { selectedId.value = ''; selectionInitialized = true; events.value = []; cursor = 0; localStorage.removeItem('phone-agent-selected'); document.getElementById('phone-agent-message')?.focus() }
function onKeydown(event: KeyboardEvent) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send() } }
async function poll() {
  if (disposed) return
  if (!document.hidden) {
    try { if (activeRun.value) { const id = activeRun.value.id; if (selectedId.value === id) await selectRun(id, true); else updateRun((await request<{ run: PhoneRun }>(`runs/${id}?after=999999`)).run) } else await refresh() }
    catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '连接暂时中断。' }
  }
  schedule(activeRun.value ? 2000 : 15000)
}
onMounted(async () => { await refresh(); if (readyDevice.value && !screenUrl.value) await capture(); schedule() })
onUnmounted(() => { disposed = true; controller.abort(); clearTimeout(timer); if (screenUrl.value.startsWith('blob:')) URL.revokeObjectURL(screenUrl.value) })
</script>
