<template>
  <KeepAlive v-if="ready">
    <component :is="workspace" :key="tool" />
  </KeepAlive>
  <div v-else class="workspace-loading" role="status">正在打开工作台…</div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { rememberWorkspaceRoute } from './composables/workspaceNavigation'

const CodexWorkspace = defineAsyncComponent(() => import('./CodexWorkspace.vue'))
const DshWorkspace = defineAsyncComponent(() => import('./components/workspace/DshWorkspace.vue'))
const route = useRoute(), router = useRouter(), ready = ref(false)
const tool = computed(() => String(route.name).startsWith('dsh') ? 'dsh' : 'codex')
const workspace = computed(() => tool.value === 'dsh' ? DshWorkspace : CodexWorkspace)
const media = window.matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  const preference = localStorage.getItem('codex-web-local.dark-mode.v1') || 'system'
  document.documentElement.classList.toggle('dark', preference === 'dark' || preference === 'system' && media.matches)
}
applyTheme()
onMounted(async () => { await router.isReady(); ready.value = true; media.addEventListener('change', applyTheme); window.addEventListener('storage', applyTheme) })
onUnmounted(() => { media.removeEventListener('change', applyTheme); window.removeEventListener('storage', applyTheme) })
watch(() => route.fullPath, path => { if (ready.value) rememberWorkspaceRoute(tool.value, path) })
</script>
