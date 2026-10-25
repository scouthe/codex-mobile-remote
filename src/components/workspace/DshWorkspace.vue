<template>
  <DesktopLayout :is-sidebar-collapsed="sidebarClosed" @close-sidebar="sidebarClosed = true">
    <template #sidebar>
      <section class="agent-sidebar">
        <WorkspaceToolPicker current-tool="dsh" />
        <button type="button" class="agent-new" @click="newChat">＋ 新建 DSH 对话</button>
        <div class="agent-thread-list">
          <p v-if="state.loading.value" role="status">正在读取 DSH 对话…</p>
          <p v-else-if="!state.sessions.value.length" class="agent-muted">尚无 DSH 对话</p>
          <section v-for="group in groups" :key="group.cwd" class="agent-project-group">
            <h2 :title="group.cwd">{{ leaf(group.cwd) }}</h2>
            <div v-for="session in group.sessions" :key="session.id" class="agent-thread-row" :class="{ 'is-selected': session.id === selectedId && !native }">
              <button type="button" :aria-current="session.id === selectedId && !native ? 'page' : undefined" @click="selectSession(session.id)">
                <span>{{ session.title }}</span><span v-if="isAgentBusy(session.state)" class="agent-working-dot" aria-label="正在执行" />
              </button>
              <button type="button" class="agent-archive" :aria-label="`归档 ${session.title}`" :disabled="isAgentBusy(session.state)" @click="archive(session.id)">×</button>
            </div>
          </section>
        </div>
        <div class="agent-sidebar-footer"><button type="button" @click="router.push('/dsh/native'); sidebarClosed = isMobile">打开 DSH 原生界面 ↗</button><button type="button" @click="toggleTheme">切换外观</button></div>
      </section>
    </template>
    <template #content>
      <section class="agent-workspace">
        <ContentHeader :title="native ? 'DSH 原生界面' : detail?.session.title || '新建 DSH 对话'" :status="busy ? 'working' : undefined" status-label="DSH 正在执行">
          <template #leading>
            <button class="agent-header-button" type="button" aria-label="打开会话列表" @click="sidebarClosed = !sidebarClosed">☰</button>
            <WorkspaceToolPicker current-tool="dsh" compact />
          </template>
          <template #actions>
            <button class="agent-header-button" type="button" aria-label="新建 DSH 对话" @click="newChat">＋</button>
            <button class="agent-header-button" type="button" aria-label="更多 DSH 操作" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">···</button>
            <div v-if="moreOpen" class="agent-more-menu"><button type="button" @click="router.push('/dsh/native'); moreOpen = false">打开 DSH 原生界面</button><button type="button" @click="refresh">刷新状态</button><button type="button" @click="toggleTheme">切换外观</button></div>
          </template>
        </ContentHeader>
        <DshPanel v-if="native" />
        <template v-else>
          <div v-if="!state.connected.value" class="agent-connection-status" role="status">{{ state.loading.value ? '正在连接…' : '连接中断，正在重新连接；正在执行的任务会继续运行。' }} <button type="button" @click="refresh">刷新状态</button></div>
          <div v-if="state.error.value || pageError" class="agent-notice" role="alert">{{ pageError || state.error.value }} <button type="button" @click="refresh">重试</button></div>
          <div v-if="!state.available.value" class="agent-notice" role="status">{{ state.statusMessage.value }}</div>
          <div v-if="!selectedId" class="agent-start">
            <h2>用 DSH 开始开发</h2><p>选择这台主机上的项目，使用 DSH 已配置的模型和工具。</p>
            <div class="agent-start-folder"><ComposerDropdown :model-value="cwd" :options="folderOptions" placeholder="选择项目目录" :enable-search="true" search-placeholder="搜索最近的项目" @update:model-value="cwd = $event" /><button type="button" @click="openFolders">浏览目录</button></div>
            <p v-if="cwd" class="agent-cwd">{{ cwd }}</p>
            <button type="button" class="agent-create" :disabled="creating || !cwd || !state.available.value" @click="create">{{ creating ? '正在创建…' : '创建 DSH 对话' }}</button>
          </div>
          <template v-else-if="detail">
            <div class="agent-project-path" :title="detail.session.cwd">{{ detail.session.cwd }}</div>
            <ThreadConversation ref="conversation" :messages="detail.messages" :pending-requests="[]" :live-overlay="null" :is-loading="false" :active-thread-id="`dsh:${selectedId}`" :cwd="detail.session.cwd" :codex-actions="false" :has-more-persisted-above="detail.nextCursor !== null" :is-loading-persisted-above="state.loadingEarlier.value" :load-earlier-messages="loadEarlier" />
            <p v-if="detail.session.error" class="agent-task-error" role="alert">{{ detail.session.error }}</p>
            <div v-for="permission in detail.permissions" :key="permission.id" class="agent-permission" role="region" :aria-label="permission.title">
              <strong>{{ permission.title }}</strong><pre v-if="permission.details">{{ permission.details }}</pre>
              <div><button v-for="option in permission.options" :key="option.optionId" type="button" :disabled="approving" @click="respond(permission.id, option.optionId)">{{ option.name }}</button></div>
            </div>
            <p v-if="busy" class="agent-run-status" role="status">{{ runLabel }}</p>
            <div class="agent-composer-area"><DshComposer :key="selectedId" ref="composer" :session-id="selectedId" :config-options="detail.configOptions" :images-supported="detail.imagesSupported" :busy="busy" :submit="submit" :configure="configure" :stop-task="stop" /></div>
          </template>
          <div v-else class="workspace-loading" role="status">正在读取对话…</div>
        </template>
      </section>
      <Teleport to="body">
        <div v-if="foldersOpen" class="agent-modal-backdrop" @click.self="foldersOpen = false">
          <section class="agent-folder-dialog" role="dialog" aria-modal="true" aria-label="选择 DSH 项目目录" @keydown.esc="foldersOpen = false">
            <header><h2>选择项目目录</h2><button type="button" aria-label="关闭目录选择" @click="foldersOpen = false">×</button></header>
            <form @submit.prevent="browse(pathInput)"><input v-model="pathInput" aria-label="项目绝对路径" :disabled="browsing" /><button type="submit" :disabled="browsing">前往</button></form>
            <p v-if="folderError" class="agent-inline-error" role="alert">{{ folderError }}</p>
            <div class="agent-directory-list"><button v-if="directory.parent !== directory.path" type="button" :disabled="browsing" @click="browse(directory.parent)">↰ 上一级</button><button v-for="folder in directory.directories" :key="folder.path" type="button" :disabled="browsing" @click="browse(folder.path)">▸ {{ folder.name }}</button></div>
            <button class="agent-create" type="button" :disabled="browsing || !directory.path" @click="chooseFolder">使用此目录</button>
          </section>
        </div>
      </Teleport>
    </template>
  </DesktopLayout>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DesktopLayout from '../layout/DesktopLayout.vue'
import ContentHeader from '../content/ContentHeader.vue'
import ComposerDropdown from '../content/ComposerDropdown.vue'
import ThreadConversation from '../content/ThreadConversation.vue'
import WorkspaceToolPicker from './WorkspaceToolPicker.vue'
import DshComposer from './DshComposer.vue'
import { useAgentState } from '../../composables/useAgentState'
import { useMobile } from '../../composables/useMobile'
import { agentGateway } from '../../api/agentGateway'
import { isAgentBusy, type AgentPromptInput, type AgentSession } from '../../types/agent'
import { useAndroidBridge } from '../../composables/useAndroidBridge'
import { CODEX_ANDROID_EVENTS, parseSharePayload } from '../../native/codexAndroid'

const DshPanel = defineAsyncComponent(() => import('../content/DshPanel.vue'))
const router = useRouter(), route = useRoute(), { isMobile } = useMobile()
const sidebarClosed = ref(isMobile.value), selectedId = ref(''), native = ref(false), moreOpen = ref(false), pageError = ref('')
const creating = ref(false), approving = ref(false), cwd = ref(''), foldersOpen = ref(false), browsing = ref(false), folderError = ref(''), pathInput = ref('')
const directory = ref({ path: '', parent: '', directories: [] as Array<{ path: string; name: string }> })
const composer = ref<InstanceType<typeof DshComposer>>()
type ReadingPosition = { top: number; windowStart: number; follow: boolean }
const conversation = ref<{ readPosition: () => ReadingPosition; restorePosition: (position: ReadingPosition) => Promise<void> }>()
const readingPositions = new Map<string, ReadingPosition>()
const state = useAgentState(selectedId), detail = state.current
const busy = computed(() => !!detail.value && isAgentBusy(detail.value.session.state))
const runLabel = computed(() => ({ starting: 'DSH 正在准备任务…', running: 'DSH 正在执行…', waiting_approval: '等待你确认操作', stopping: '正在停止任务…' }[detail.value?.session.state as string] || ''))
const groups = computed(() => {
  const groups = new Map<string, AgentSession[]>()
  for (const session of state.sessions.value) { const rows = groups.get(session.cwd) || []; rows.push(session); groups.set(session.cwd, rows) }
  return Array.from(groups, ([cwd, sessions]) => ({ cwd, sessions }))
})
const folderOptions = computed(() => [...new Set([cwd.value, ...state.sessions.value.map(session => session.cwd)].filter(Boolean))].map(path => ({ value: path, label: leaf(path) })))
function leaf(path: string) { return path.split(/[\\/]/).filter(Boolean).pop() || path }

watch(() => route.fullPath, () => {
  if (!String(route.name).startsWith('dsh')) return
  if (selectedId.value && conversation.value) readingPositions.set(selectedId.value, conversation.value.readPosition())
  native.value = route.name === 'dsh-native'
  selectedId.value = route.name === 'dsh-session' ? String(route.params.sessionId || '') : ''
  pageError.value = ''
  if (selectedId.value) {
    const id = selectedId.value
    void state.refresh(id).then(async () => {
      await nextTick()
      const position = readingPositions.get(id)
      if (id === selectedId.value && position) await conversation.value?.restorePosition(position)
      return state.refresh(id, true)
    }).catch(cause => { if (id === selectedId.value) pageError.value = cause instanceof Error ? cause.message : 'DSH 对话加载失败。' })
  }
}, { immediate: true })
watch(isMobile, value => { sidebarClosed.value = value })
onDeactivated(() => { sidebarClosed.value = true; foldersOpen.value = false; moreOpen.value = false })
onActivated(() => { if (!isMobile.value) sidebarClosed.value = false; void shared() })

async function create() {
  if (creating.value) return
  creating.value = true; pageError.value = ''
  try { const created = state.accept(await agentGateway.create(cwd.value)); await router.push(`/dsh/session/${created.session.id}`) }
  catch (cause) { pageError.value = cause instanceof Error ? cause.message : '创建失败。' }
  finally { creating.value = false }
}
function newChat() { void router.push('/dsh'); sidebarClosed.value = isMobile.value; moreOpen.value = false }
function selectSession(id: string) { void router.push(`/dsh/session/${id}`); sidebarClosed.value = isMobile.value }
async function archive(id: string) {
  try { await agentGateway.archive(id); await state.refreshList(); if (selectedId.value === id) newChat() }
  catch (cause) { pageError.value = cause instanceof Error ? cause.message : '归档失败。' }
}
async function refresh() {
  moreOpen.value = false; pageError.value = ''
  await state.synchronize()
  if (selectedId.value) try { await state.refresh(selectedId.value, true) } catch (cause) { pageError.value = cause instanceof Error ? cause.message : '重新连接失败。' }
}
async function submit(input: AgentPromptInput) { state.apply({ session: await agentGateway.prompt(selectedId.value, input) }) }
async function configure(id: string, value: string) { state.accept(await agentGateway.configure(selectedId.value, id, value)) }
async function stop() { state.apply({ session: await agentGateway.stop(selectedId.value) }) }
async function loadEarlier() { await state.loadEarlier() }
async function respond(permissionId: string, optionId: string) {
  approving.value = true; pageError.value = ''
  try { await agentGateway.permission(selectedId.value, permissionId, optionId) }
  catch (cause) { pageError.value = cause instanceof Error ? cause.message : '审批失败。' }
  finally { approving.value = false }
}
async function browse(path = '') {
  browsing.value = true; folderError.value = ''
  try { directory.value = await agentGateway.directories(path); pathInput.value = directory.value.path }
  catch (cause) { folderError.value = cause instanceof Error ? cause.message : '目录加载失败。' }
  finally { browsing.value = false }
}
function openFolders() { foldersOpen.value = true; void browse(cwd.value) }
function chooseFolder() { cwd.value = directory.value.path; foldersOpen.value = false; try { localStorage.setItem('codex-remote.dsh.cwd', cwd.value) } catch {} }
function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark')
  try { localStorage.setItem('codex-web-local.dark-mode.v1', dark ? 'dark' : 'light') } catch {}
}

const android = useAndroidBridge()
let removeShareListener: (() => void) | undefined
let handlingShare = false
async function shared(event?: CustomEvent<unknown>) {
  if (!String(route.name).startsWith('dsh') || !composer.value || handlingShare) return
  const payload = parseSharePayload(event?.detail) || android.getPendingShare()
  if (!payload) return
  handlingShare = true
  try {
    const files: File[] = []
    let bytes = 0
    for (const item of payload.files) {
      const result = android.readSharedContent(item.uri)
      if (!result.file) throw new Error('无法读取分享文件，请重新添加。')
      bytes += result.file.size
      if (bytes > 40 * 1024 * 1024) throw new Error('本次分享文件超过 40 MB，请分批添加。')
      files.push(result.file)
    }
    if (!(await composer.value.attachFiles(files))) return
    if (payload.text) composer.value.appendText(payload.text)
    android.clearPendingShare()
  } catch (cause) { pageError.value = cause instanceof Error ? cause.message : '分享内容读取失败。' }
  finally { handlingShare = false }
}
watch(composer, () => { void shared() })
onMounted(() => {
  try { cwd.value = localStorage.getItem('codex-remote.dsh.cwd') || '' } catch {}
  if (!cwd.value) void agentGateway.directories().then(value => { if (!cwd.value) cwd.value = value.path }).catch(() => {})
  void state.initialize()
  removeShareListener = android.listen(CODEX_ANDROID_EVENTS.share, event => { void shared(event) })
})
onUnmounted(() => removeShareListener?.())
</script>
