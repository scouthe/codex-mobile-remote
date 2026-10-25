<template>
  <form class="agent-composer" @submit.prevent="send" @dragover.prevent @drop.prevent="onDrop" @paste="onPaste">
    <div v-if="attachments.length" class="agent-attachments">
      <div v-for="(item, index) in attachments" :key="item.path" class="agent-attachment">
        <img v-if="item.mimeType.startsWith('image/')" :src="`/codex-local-image?path=${encodeURIComponent(item.path)}`" :alt="item.name" />
        <span>{{ item.name }}</span>
        <button type="button" :aria-label="`移除 ${item.name}`" :disabled="sending" @click="attachments.splice(index, 1)">×</button>
      </div>
    </div>
    <textarea v-model="draft" aria-label="向 DSH 发送消息" placeholder="向 DSH 发送消息…" rows="3" :disabled="sending" @keydown="onKey" />
    <div class="agent-composer-controls">
      <button type="button" :disabled="uploading || sending" aria-label="添加文件" @click="fileInput?.click()">＋</button>
      <button v-if="imagesSupported" type="button" :disabled="uploading || sending" aria-label="添加图片" @click="imageInput?.click()">图片</button>
      <ComposerDropdown v-for="option in configOptions" :key="option.id" :model-value="option.currentValue" :options="option.options" :placeholder="option.name" :disabled="busy || configuring || sending" :enable-search="option.category === 'model'" search-placeholder="搜索模型" open-direction="up" @update:model-value="value => configure(option.id, value)" />
      <button v-if="busy" class="agent-stop" type="button" :disabled="stopping" @click="stop">{{ stopping ? '停止中…' : '停止' }}</button>
      <button v-else class="agent-send" type="submit" :disabled="sending || uploading || (!draft.trim() && !attachments.length)" aria-label="发送到 DSH">{{ sending ? '发送中…' : '↑' }}</button>
    </div>
    <p v-if="uploading" class="agent-inline-status" role="status">正在上传附件…</p>
    <p v-if="error" class="agent-inline-error" role="alert">{{ error }}</p>
    <input ref="fileInput" class="agent-file-input" type="file" multiple @change="onFiles" />
    <input ref="imageInput" class="agent-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple @change="onFiles" />
  </form>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import ComposerDropdown from '../content/ComposerDropdown.vue'
import { uploadFile } from '../../api/codexGateway'
import type { AgentConfigOption, AgentPromptInput } from '../../types/agent'

type Attachment = { path: string; name: string; mimeType: string }
const props = defineProps<{
  sessionId: string; configOptions: AgentConfigOption[]; imagesSupported: boolean; busy: boolean
  submit: (input: AgentPromptInput) => Promise<void>
  configure: (id: string, value: string) => Promise<void>
  stopTask: () => Promise<void>
}>()
const draft = ref(''), attachments = ref<Attachment[]>([]), error = ref('')
const uploading = ref(false), sending = ref(false), configuring = ref(false), stopping = ref(false)
const fileInput = ref<HTMLInputElement>(), imageInput = ref<HTMLInputElement>()
const storageKey = `codex-remote.dsh.draft.${props.sessionId}`
let pendingRequest = '', pendingFingerprint = ''
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
  draft.value = typeof saved.text === 'string' ? saved.text : ''
  attachments.value = Array.isArray(saved.attachments) ? saved.attachments.filter((value: Attachment) => typeof value.path === 'string' && typeof value.name === 'string' && typeof value.mimeType === 'string') : []
  pendingRequest = typeof saved.requestId === 'string' ? saved.requestId : ''
  pendingFingerprint = typeof saved.fingerprint === 'string' ? saved.fingerprint : ''
} catch { /* unavailable browser storage */ }
function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify({ text: draft.value, attachments: attachments.value, requestId: pendingRequest, fingerprint: pendingFingerprint })) } catch { /* drafts are best effort */ }
}
watch([draft, attachments], persist, { deep: true })

async function attachFiles(files: File[]) {
  if (uploading.value || sending.value) return false
  uploading.value = true; error.value = ''
  try {
    for (const file of files) {
      if (attachments.value.length >= 20) throw new Error('一次最多添加 20 个附件。')
      const extensions: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
      const mimeType = file.type && file.type !== 'application/octet-stream' ? file.type.toLowerCase() : extensions[file.name.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream'
      const image = mimeType.startsWith('image/')
      if (image && !props.imagesSupported) throw new Error('当前 DSH 配置没有声明图片输入能力，请切换到支持图片的配置。')
      if (image && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) throw new Error('请将图片转换为 PNG、JPEG、WebP 或 GIF 后添加。')
      if (image && attachments.value.filter(item => item.mimeType.startsWith('image/')).length >= 8) throw new Error('一次最多添加 8 张图片。')
      if (file.size > (image ? 10 : 20) * 1024 * 1024) throw new Error(`${file.name} 过大，图片上限为 10 MB，其他文件为 20 MB。`)
      const path = await uploadFile(file)
      if (!path) throw new Error(`${file.name} 上传失败，请重试。`)
      attachments.value.push({ path, name: file.name, mimeType })
    }
    return true
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '附件上传失败。'; return false }
  finally { uploading.value = false }
}
function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || []); input.value = ''; void attachFiles(files)
}
function onDrop(event: DragEvent) { void attachFiles(Array.from(event.dataTransfer?.files || [])) }
function onPaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files || [])
  if (files.length) { event.preventDefault(); void attachFiles(files) }
}
async function send() {
  if (sending.value || uploading.value || props.busy || (!draft.value.trim() && !attachments.value.length)) return
  sending.value = true; error.value = ''
  const text = draft.value, items = [...attachments.value], fingerprint = JSON.stringify([text, items])
  if (!pendingRequest || fingerprint !== pendingFingerprint) {
    pendingRequest = globalThis.crypto?.randomUUID?.() || `request-${Date.now()}-${Math.random().toString(36).slice(2)}`
    pendingFingerprint = fingerprint
  }
  persist()
  try {
    await props.submit({ requestId: pendingRequest, text, images: items.filter(item => item.mimeType.startsWith('image/')).map(item => ({ path: item.path, mimeType: item.mimeType })), files: items.filter(item => !item.mimeType.startsWith('image/')).map(item => ({ path: item.path, name: item.name })) })
    draft.value = ''; attachments.value = []; pendingRequest = ''; pendingFingerprint = ''; persist()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '发送失败，请重试。' }
  finally { sending.value = false }
}
async function configure(id: string, value: string) {
  configuring.value = true; error.value = ''
  try { await props.configure(id, value) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '配置切换失败。' }
  finally { configuring.value = false }
}
async function stop() {
  stopping.value = true; error.value = ''
  try { await props.stopTask() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '停止失败。' }
  finally { stopping.value = false }
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.matchMedia('(pointer: fine)').matches) { event.preventDefault(); void send() }
}
defineExpose({ attachFiles, appendText: (text: string) => { draft.value += (draft.value ? '\n' : '') + text } })
</script>
