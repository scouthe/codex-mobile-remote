<template>
  <DesktopLayout :is-sidebar-collapsed="true">
    <template #content>
      <section class="agent-workspace dsh-native-workspace">
        <ContentHeader title="DeepSeek Harness">
          <template v-if="isMobile" #center>
            <WorkspaceToolPicker current-tool="dsh" compact />
          </template>
          <template v-if="!isMobile" #leading>
            <WorkspaceToolPicker current-tool="dsh" compact />
          </template>
          <template #actions>
            <div ref="actions" class="dsh-header-actions" @keydown.esc="moreOpen = false">
              <button class="agent-header-button" type="button" aria-label="更多 DSH 操作" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen"><IconTablerDots class="icon-svg" /></button>
              <div v-if="moreOpen" class="agent-more-menu">
                <button type="button" :disabled="panel?.checking" @click="reload">重新加载</button>
                <button v-if="panel?.available" type="button" @click="fullscreen">全屏</button>
                <a v-if="panel?.available" href="/dsh/" target="_blank" rel="noopener" @click="moreOpen = false">独立打开 ↗</a>
                <button type="button" @click="toggleTheme">切换外观</button>
              </div>
            </div>
          </template>
        </ContentHeader>
        <DshPanel v-if="active" ref="panel" :show-toolbar="false" />
      </section>
    </template>
  </DesktopLayout>
</template>

<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import DesktopLayout from '../layout/DesktopLayout.vue'
import ContentHeader from '../content/ContentHeader.vue'
import IconTablerDots from '../icons/IconTablerDots.vue'
import DshPanel from '../content/DshPanel.vue'
import WorkspaceToolPicker from './WorkspaceToolPicker.vue'
import { useMobile } from '../../composables/useMobile'

const route = useRoute(), { isMobile } = useMobile()
const panel = ref<InstanceType<typeof DshPanel>>()
const active = ref(true), moreOpen = ref(false), actions = ref<HTMLElement>()

function closeMenu(event: Event) {
  if (event.type === 'blur' || !actions.value?.contains(event.target as Node)) moreOpen.value = false
}
function reload() { moreOpen.value = false; void panel.value?.reload() }
function fullscreen() { moreOpen.value = false; void panel.value?.fullscreen() }
function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark')
  try { localStorage.setItem('codex-web-local.dark-mode.v1', dark ? 'dark' : 'light') } catch {}
  moreOpen.value = false
}

watch(() => route.fullPath, () => {
  if (String(route.name).startsWith('dsh')) document.title = 'DeepSeek Harness · DSH'
}, { immediate: true })
onActivated(() => { active.value = true })
onDeactivated(() => { active.value = false; moreOpen.value = false })
onMounted(() => { document.addEventListener('pointerdown', closeMenu); window.addEventListener('blur', closeMenu) })
onUnmounted(() => { document.removeEventListener('pointerdown', closeMenu); window.removeEventListener('blur', closeMenu) })
</script>
