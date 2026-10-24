<template>
  <aside class="phone-screen" :class="{ 'is-manual': ownsControl }" aria-label="手机屏幕预览" data-testid="phone-screen-panel">
    <div class="phone-screen-heading">
      <div><strong>{{ ownsControl ? '手动接管' : '手机画面' }}</strong><span>{{ model || '等待手机连接' }}</span></div>
      <button v-if="!ownsControl" type="button" class="phone-button" :disabled="!connected || screenshotBusy" @click="$emit('capture')">{{ screenshotBusy ? '获取中…' : '刷新画面' }}</button>
      <span v-else class="phone-live-badge" :class="{ 'is-live': stage === 'live' }">{{ stageLabel }}</span>
    </div>
    <div class="phone-screen-frame" :class="{ 'is-controllable': stage === 'live' && !inputBusy }">
      <video ref="video" v-show="ownsControl" muted autoplay playsinline aria-label="手机实时画面，可点击、拖动和长按" data-testid="phone-live-video"
        @pointerdown="pointerDown" @pointerup="pointerUp" @pointercancel="gesture = undefined" @contextmenu.prevent />
      <img v-if="!ownsControl && screenshot" :src="screenshot" alt="手机截图，仅供查看" @error="imageError = '暂时无法显示截图，请刷新画面。'" @load="imageError = ''" />
      <div v-else-if="!ownsControl" class="phone-screen-empty"><span aria-hidden="true">▯</span><p>手机连接后<br>画面会显示在这里</p></div>
      <div v-if="ownsControl && stage !== 'live'" class="phone-video-overlay" role="status">{{ stageLabel }}<span>Agent 保持停止</span></div>
    </div>
    <div v-if="ownsControl" class="phone-manual-controls">
      <div class="phone-navigation" aria-label="手机导航键">
        <button v-for="key in navigation" :key="key.key" type="button" class="phone-button" :disabled="inputBusy || (stage !== 'live' && !(key.key === 'wake' && stage === 'connecting'))" @click="input({ type: 'key', key: key.key })">{{ key.label }}</button>
      </div>
      <form class="phone-text-input" @submit.prevent="sendText">
        <label for="phone-manual-text" class="phone-visually-hidden">输入到手机的文字</label>
        <input id="phone-manual-text" v-model="text" maxlength="2000" placeholder="先点手机输入框，再输入文字" :disabled="stage !== 'live'" />
        <button type="submit" class="phone-button" :disabled="stage !== 'live' || inputBusy || !text">输入</button>
      </form>
      <button type="button" class="phone-button phone-release" :disabled="stage === 'acquiring' || stage === 'closing' || resumeBusy" @click="release()">结束接管</button>
    </div>
    <button v-else type="button" class="phone-button phone-takeover" :disabled="!connected || !controlState?.available || controlState?.busy || resumeBusy || !supported" @click="acquire(deviceId, previousRunId)">{{ controlState?.busy ? '手机正在接管' : '接管手机' }}</button>
    <div v-if="context?.previousRunId && context.deviceId === deviceId" class="phone-handback">
      <p :title="context.purpose">待继续：{{ context.purpose }}</p>
      <label for="phone-handback-note" class="phone-visually-hidden">交回 Agent 的补充说明</label>
      <input id="phone-handback-note" v-model="note" maxlength="1000" placeholder="补充说明（可选）" :disabled="resumeBusy" />
      <button type="button" class="phone-button phone-handback-button" :disabled="resumeBusy || inputBusy || stage === 'acquiring' || stage === 'closing' || (!ownsControl && !!controlState?.busy)" @click="resume(note)">{{ resumeBusy ? '正在交回…' : '交回 Agent，继续任务' }}</button>
    </div>
    <p v-if="error || imageError || screenshotError" class="phone-control-error" role="alert">{{ error || imageError || screenshotError }}</p>
    <p class="phone-screen-note">{{ ownsControl ? '点击、拖动或长按画面 · 断线后 Agent 保持停止' : !supported ? '实时接管请使用新版 Chrome 或 Edge' : !controlState?.available ? controlState?.message : '截图仅供查看 · 接管后开启实时画面和手动操作' }}</p>
  </aside>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { PhoneRun } from '../../types/phoneAgent'
import type { PhoneControlState, PhoneInput, PhonePoint } from '../../types/phoneControl'
import { usePhoneControl } from '../../composables/usePhoneControl'
import { phoneGesture, videoPoint } from '../../phone/gestures'

const props = defineProps<{
  deviceId: string; model?: string; connected: boolean; previousRunId?: string
  screenshot: string; screenshotBusy: boolean; screenshotError: string; controlState?: PhoneControlState
  shown: boolean
}>()
const emit = defineEmits<{ capture: []; resumed: [run: PhoneRun]; ownership: [busy: boolean] }>()
const video = ref<HTMLVideoElement | null>(null)
const desktopQuery = window.matchMedia('(min-width: 1101px)')
const desktop = ref(desktopQuery.matches)
const visibilityChanged = () => { desktop.value = desktopQuery.matches }
desktopQuery.addEventListener('change', visibilityChanged)
onUnmounted(() => desktopQuery.removeEventListener('change', visibilityChanged))
const visible = computed(() => props.shown || desktop.value)
const { context, stage, error, format, ownsControl, supported, inputBusy, resumeBusy, acquire, release, input, resume } = usePhoneControl(video, run => emit('resumed', run), () => visible.value)
const text = ref(''), note = ref(''), imageError = ref('')
let gesture: { point: PhonePoint; time: number; epoch: number; pointerId: number } | undefined
const stageLabel = computed(() => ({ idle: '', acquiring: '等待 Agent 停止…', connecting: '连接实时画面…', live: '实时 · 人工控制', closing: '正在结束接管…' }[stage.value]))
const navigation: Array<{ key: Extract<PhoneInput, { type: 'key' }>['key']; label: string }> = [
  { key: 'back', label: '返回' }, { key: 'home', label: '桌面' }, { key: 'recent', label: '最近' }, { key: 'wake', label: '亮屏' },
  { key: 'enter', label: '回车' }, { key: 'delete', label: '退格' },
]
watch(ownsControl, value => emit('ownership', value), { immediate: true })
watch(format, () => { gesture = undefined })
watch(visible, value => { if (!value && ownsControl.value) void release(true) })

function pointerDown(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0 || stage.value !== 'live' || inputBusy.value || !video.value || !format.value) return
  const point = videoPoint(video.value.getBoundingClientRect(), format.value, event.clientX, event.clientY)
  if (!point) return
  event.preventDefault(); video.value.setPointerCapture(event.pointerId)
  gesture = { point, time: performance.now(), epoch: format.value.epoch, pointerId: event.pointerId }
}
function pointerUp(event: PointerEvent) {
  const start = gesture; gesture = undefined
  if (!start || start.pointerId !== event.pointerId || !video.value || !format.value || start.epoch !== format.value.epoch) return
  const point = videoPoint(video.value.getBoundingClientRect(), format.value, event.clientX, event.clientY)
  if (point) void input(phoneGesture(start.point, point, performance.now() - start.time, start.epoch))
}
async function sendText() { if (!text.value) return; await input({ type: 'text', text: text.value }) }
</script>
