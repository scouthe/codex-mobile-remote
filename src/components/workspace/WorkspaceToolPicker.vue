<template>
  <div v-if="compact" class="workspace-tool-compact">
    <ComposerDropdown :model-value="currentTool" :options="tools" placeholder="选择工具" @update:model-value="select" />
  </div>
  <div v-else class="workspace-tool-tabs" role="group" aria-label="选择工具">
    <button v-for="tool in tools" :key="tool.value" type="button" :aria-pressed="currentTool === tool.value" @click="select(tool.value)">{{ tool.label }}</button>
  </div>
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import ComposerDropdown from '../content/ComposerDropdown.vue'
import { rememberWorkspaceRoute, workspaceRoute, type WorkspaceTool } from '../../composables/workspaceNavigation'
const props = defineProps<{ currentTool: WorkspaceTool; compact?: boolean }>()
const tools = [{ value: 'codex', label: 'Codex' }, { value: 'dsh', label: 'DSH' }]
const router = useRouter(), route = useRoute()
function select(value: string) {
  if (value === props.currentTool || value !== 'codex' && value !== 'dsh') return
  rememberWorkspaceRoute(props.currentTool, route.fullPath)
  void router.push(workspaceRoute(value))
}
</script>
