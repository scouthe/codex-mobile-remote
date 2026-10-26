<template>
  <div class="workspace-tool-tabs" :class="{ 'workspace-tool-compact': compact }" role="group" aria-label="选择工具">
    <button v-for="tool in tools" :key="tool.value" type="button" :aria-pressed="currentTool === tool.value" @click="select(tool.value)">{{ tool.label }}</button>
  </div>
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
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
