<template>
  <section ref="panel" class="dsh-panel" :class="{ 'is-embedded': !showToolbar }" aria-label="DeepSeek Harness">
    <div v-if="showToolbar" class="dsh-toolbar">
      <p>DeepSeek Harness <span>原生界面</span></p>
      <div class="dsh-actions">
        <button type="button" :disabled="checking" @click="reload">重新加载</button>
        <button v-if="available" type="button" @click="fullscreen">全屏</button>
        <a v-if="available" href="/dsh/" target="_blank" rel="noopener">独立打开 ↗</a>
      </div>
    </div>
    <div v-if="error" class="dsh-notice" role="alert">
      <p>{{ error }}</p>
      <button type="button" :disabled="checking" @click="reload">重试</button>
    </div>
    <div v-else-if="checking || !loaded" class="dsh-loading" role="status">{{ checking ? '正在连接 DSH…' : '正在加载 DSH…' }}</div>
    <iframe v-if="available" :key="generation" class="dsh-frame" src="/dsh/" title="DeepSeek Harness 原生界面"
      allow="clipboard-read; clipboard-write; fullscreen" allowfullscreen referrerpolicy="same-origin" @load="onLoad" />
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

withDefaults(defineProps<{ showToolbar?: boolean }>(), { showToolbar: true })

const panel = ref<HTMLElement | null>(null)
const available = ref(false), checking = ref(false), loaded = ref(false), error = ref(''), generation = ref(0)
const controller = new AbortController()
let loadTimer: ReturnType<typeof setTimeout> | undefined

async function reload() {
  if (checking.value) return
  checking.value = true; available.value = false; loaded.value = false; error.value = ''
  clearTimeout(loadTimer)
  try {
    const response = await fetch('/dsh-api/status', { cache: 'no-store', signal: controller.signal })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('连接验证失败，请重新登录后重试。')
    const status = await response.json() as { available: boolean; message: string }
    if (!status.available) throw new Error(status.message || 'DSH 暂时不可用，请稍后重试。')
    available.value = true; generation.value++
    loadTimer = setTimeout(() => { if (!loaded.value) error.value = 'DSH 页面加载较慢，可以稍候或重新加载。' }, 30000)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'DSH 连接失败。'
  } finally { checking.value = false }
}

function onLoad() { clearTimeout(loadTimer); loaded.value = true; error.value = '' }
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await panel.value?.requestFullscreen()
  } catch { error.value = '当前浏览器无法进入全屏，可使用“独立打开”。' }
}
onMounted(reload)
onUnmounted(() => { controller.abort(); clearTimeout(loadTimer) })
defineExpose({ reload, fullscreen, available, checking })
</script>
