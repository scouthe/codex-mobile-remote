<template>
  <div v-if="variant === 'card' && goal" class="thread-goal-status-card" :class="`is-${goal.status}`">
    <div class="thread-goal-status-main">
      <svg class="thread-goal-status-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3" />
        <path d="M15 9l5-5m0 0v4m0-4h-4" />
      </svg>
      <span class="thread-goal-status-copy">
        <span class="thread-goal-status-title">{{ goalHeaderLabel }}</span>
        <span class="thread-goal-status-objective" :title="goal.objective">{{ goal.objective }}</span>
      </span>
      <span class="thread-goal-status-separator" aria-hidden="true">•</span>
      <span class="thread-goal-status-time">{{ formatDuration(liveTimeUsedSeconds) }}</span>
    </div>
    <div class="thread-goal-status-actions">
      <button
        class="thread-goal-status-action"
        type="button"
        :aria-label="t('Clear goal')"
        :title="t('Clear goal')"
        :disabled="isBusy"
        @click="clear"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16m-10 4v6m4-6v6M9 7V4h6v3m-9 0 1 13h10l1-13" />
        </svg>
      </button>
      <button
        v-if="canTogglePause"
        class="thread-goal-status-action"
        type="button"
        :aria-label="pauseActionLabel"
        :title="pauseActionLabel"
        :disabled="isBusy || !togglePause"
        @click="togglePauseStatus"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <template v-if="goal.status === 'active'">
            <path d="M8 6v12M16 6v12" />
          </template>
          <path v-else d="m9 6 9 6-9 6V6Z" />
        </svg>
      </button>
      <button
        class="thread-goal-status-action"
        type="button"
        :aria-label="t('Edit goal')"
        :title="t('Edit goal')"
        :disabled="isBusy"
        @click="openDialog"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 19h4L19 9a2.8 2.8 0 0 0-4-4L5 15v4Zm9-12 3 3" />
        </svg>
      </button>
    </div>
  </div>

  <button
    v-else
    class="thread-goal-menu-button"
    type="button"
    :disabled="disabled || loading || supported === false"
    :aria-label="t('Goal')"
    @click="openDialog"
  >
    <svg class="thread-goal-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M15 9l5-5m0 0v4m0-4h-4" />
    </svg>
    <span class="thread-goal-menu-copy">
      <span class="thread-goal-menu-label">{{ t('Goal') }}</span>
      <span class="thread-goal-menu-description" :title="goal?.objective || goalDescription">
        {{ goalDescription }}
      </span>
    </span>
    <span v-if="goal" class="thread-goal-menu-status" :class="`is-${goal.status}`">
      {{ goalStatusLabel }}
    </span>
  </button>

  <Teleport to="body">
    <div
      v-if="isDialogOpen"
      class="thread-goal-dialog-backdrop"
      role="presentation"
      @click.self="closeDialog"
    >
      <form
        class="thread-goal-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('Thread goal')"
        @submit.prevent="save"
        @keydown.esc="closeDialog"
      >
        <header class="thread-goal-dialog-header">
          <div>
            <h2 class="thread-goal-dialog-title">{{ t('Thread goal') }}</h2>
            <p class="thread-goal-dialog-subtitle">{{ t('Set a goal for Codex to keep working toward in this thread.') }}</p>
          </div>
          <button
            class="thread-goal-dialog-close"
            type="button"
            :aria-label="t('Close')"
            :disabled="isBusy"
            @click="closeDialog"
          >
            ×
          </button>
        </header>

        <label class="thread-goal-dialog-field">
          <span class="thread-goal-dialog-field-label">{{ t('Objective') }}</span>
          <textarea
            ref="textareaRef"
            v-model="draft"
            class="thread-goal-dialog-textarea"
            :placeholder="t('Describe the outcome Codex should keep pursuing…')"
            :disabled="isBusy"
            rows="5"
          />
        </label>

        <div v-if="goal" class="thread-goal-dialog-meta" aria-live="polite">
          <span class="thread-goal-dialog-status" :class="`is-${goal.status}`">{{ goalStatusLabel }}</span>
          <span v-if="goal.tokenBudget !== null">
            {{ t('{used} / {budget} tokens', { used: formatNumber(goal.tokensUsed), budget: formatNumber(goal.tokenBudget) }) }}
          </span>
          <span v-else-if="goal.tokensUsed > 0">
            {{ t('{count} tokens used', { count: formatNumber(goal.tokensUsed) }) }}
          </span>
          <span v-if="goal.timeUsedSeconds > 0">{{ formatDuration(goal.timeUsedSeconds) }}</span>
        </div>

        <p v-if="displayError" class="thread-goal-dialog-error" role="alert">
          {{ displayError }}
        </p>

        <footer class="thread-goal-dialog-actions">
          <button
            v-if="goal"
            class="thread-goal-dialog-button thread-goal-dialog-button--clear"
            type="button"
            :disabled="isBusy"
            @click="clear"
          >
            {{ t('Clear goal') }}
          </button>
          <span class="thread-goal-dialog-action-spacer" />
          <button
            class="thread-goal-dialog-button"
            type="button"
            :disabled="isBusy"
            @click="closeDialog"
          >
            {{ t('Cancel') }}
          </button>
          <button
            class="thread-goal-dialog-button thread-goal-dialog-button--primary"
            type="submit"
            :disabled="isBusy || draft.trim().length === 0"
          >
            {{ isBusy ? t('Saving…') : t('Save goal') }}
          </button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ThreadGoal } from '../../api/appServerDtos'
import { useUiLanguage } from '../../composables/useUiLanguage'

const props = defineProps<{
  threadId: string
  goal: ThreadGoal | null
  variant?: 'menu' | 'card'
  loading?: boolean
  supported?: boolean
  error?: string
  disabled?: boolean
  saveGoal: (objective: string) => Promise<boolean>
  clearGoal: () => Promise<boolean>
  togglePause?: () => Promise<boolean>
}>()

const emit = defineEmits<{
  opened: []
}>()

const { t } = useUiLanguage()
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const isDialogOpen = ref(false)
const isSubmitting = ref(false)
const draft = ref('')
const initialObjective = ref('')
const localError = ref('')
const liveTimeUsedSeconds = ref(0)
let liveTimeTimer: number | null = null

const isBusy = computed(() => props.loading === true || isSubmitting.value)
const displayError = computed(() => localError.value || props.error || '')
const canTogglePause = computed(() => props.goal?.status === 'active' || props.goal?.status === 'paused')
const goalHeaderLabel = computed(() => {
  if (props.goal?.status === 'active') return t('Active goal')
  if (props.goal?.status === 'paused') return t('Paused goal')
  return t('Goal')
})
const pauseActionLabel = computed(() => props.goal?.status === 'active' ? t('Pause goal') : t('Resume goal'))
const goalDescription = computed(() => {
  if (props.supported === false) return t('Goals are unavailable in this Codex version')
  if (props.loading && !props.goal) return t('Loading goal…')
  return props.goal?.objective || t('Set a goal to keep working toward')
})
const goalStatusLabel = computed(() => {
  const status = props.goal?.status
  if (status === 'active') return t('Active')
  if (status === 'paused') return t('Paused')
  if (status === 'blocked') return t('Blocked')
  if (status === 'usageLimited') return t('Usage limited')
  if (status === 'budgetLimited') return t('Budget limited')
  if (status === 'complete') return t('Complete')
  return ''
})

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.max(0, Math.floor(value)))
}

function formatDuration(seconds: number): string {
  const normalizedSeconds = Math.max(0, Math.floor(seconds))
  if (normalizedSeconds < 60) return t('{count}s', { count: normalizedSeconds })
  const minutes = Math.floor(normalizedSeconds / 60)
  const remainderSeconds = normalizedSeconds % 60
  if (minutes < 60) return remainderSeconds > 0
    ? t('{minutes}m {seconds}s', { minutes, seconds: remainderSeconds })
    : t('{count}m', { count: minutes })
  const hours = Math.floor(minutes / 60)
  const remainderMinutes = minutes % 60
  if (remainderMinutes > 0) return t('{hours}h {minutes}m', { hours, minutes: remainderMinutes })
  return t('{count}h', { count: hours })
}

function syncLiveTime(): void {
  liveTimeUsedSeconds.value = props.goal?.timeUsedSeconds ?? 0
}

function startLiveTimeTicker(): void {
  if (liveTimeTimer !== null || typeof window === 'undefined') return
  liveTimeTimer = window.setInterval(() => {
    if (props.goal?.status === 'active') {
      liveTimeUsedSeconds.value += 1
    }
  }, 1000)
}

function stopLiveTimeTicker(): void {
  if (liveTimeTimer === null || typeof window === 'undefined') return
  window.clearInterval(liveTimeTimer)
  liveTimeTimer = null
}

function openDialog(): void {
  if (props.disabled || props.loading || props.supported === false || !props.threadId) return
  const objective = props.goal?.objective ?? ''
  draft.value = objective
  initialObjective.value = objective
  localError.value = ''
  isDialogOpen.value = true
  emit('opened')
  void nextTick(() => textareaRef.value?.focus())
}

function closeDialog(): void {
  if (isBusy.value) return
  isDialogOpen.value = false
  localError.value = ''
}

async function save(): Promise<void> {
  const objective = draft.value.trim()
  if (!objective || isBusy.value) return
  isSubmitting.value = true
  localError.value = ''
  try {
    const saved = await props.saveGoal(objective)
    if (saved) {
      isDialogOpen.value = false
      return
    }
    localError.value = props.error || t('Failed to save thread goal')
  } finally {
    isSubmitting.value = false
  }
}

async function clear(): Promise<void> {
  if (!props.goal || isBusy.value) return
  isSubmitting.value = true
  localError.value = ''
  try {
    const cleared = await props.clearGoal()
    if (cleared) {
      isDialogOpen.value = false
      return
    }
    localError.value = props.error || t('Failed to clear thread goal')
  } finally {
    isSubmitting.value = false
  }
}

async function togglePauseStatus(): Promise<void> {
  if (!props.togglePause || !canTogglePause.value || isBusy.value) return
  isSubmitting.value = true
  localError.value = ''
  try {
    const updated = await props.togglePause()
    if (!updated) {
      localError.value = props.error || t('Failed to update thread goal')
    }
  } finally {
    isSubmitting.value = false
  }
}

watch(
  () => props.threadId,
  () => {
    isDialogOpen.value = false
    localError.value = ''
  },
)

watch(
  () => props.goal?.objective ?? '',
  (nextObjective) => {
    if (!isDialogOpen.value || draft.value !== initialObjective.value) return
    draft.value = nextObjective
    initialObjective.value = nextObjective
  },
)

watch(
  () => [props.goal?.threadId, props.goal?.status, props.goal?.timeUsedSeconds] as const,
  () => syncLiveTime(),
  { immediate: true },
)

onMounted(startLiveTimeTicker)
onBeforeUnmount(stopLiveTimeTicker)
</script>

<style scoped>
@reference "tailwindcss";

.thread-goal-status-card {
  @apply flex min-h-12 items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white px-4 py-2.5 shadow-sm;
}

.thread-goal-status-main {
  @apply flex min-w-0 items-center gap-2;
}

.thread-goal-status-icon {
  @apply h-5 w-5 shrink-0 fill-none stroke-zinc-400;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.thread-goal-status-copy {
  @apply flex min-w-0 items-baseline gap-1.5;
}

.thread-goal-status-title {
  @apply shrink-0 text-sm font-medium text-zinc-800;
}

.thread-goal-status-objective {
  @apply min-w-0 truncate text-sm text-zinc-500;
}

.thread-goal-status-separator {
  @apply shrink-0 text-zinc-400;
}

.thread-goal-status-time {
  @apply shrink-0 text-sm tabular-nums text-zinc-500;
}

.thread-goal-status-actions {
  @apply flex shrink-0 items-center gap-1;
}

.thread-goal-status-action {
  @apply inline-flex h-8 w-8 items-center justify-center rounded-lg border-0 bg-transparent text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50;
}

.thread-goal-status-action svg {
  @apply h-4 w-4 fill-none stroke-current;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.thread-goal-menu-button {
  @apply flex w-full items-center gap-2 rounded-lg border-0 bg-transparent px-3 py-2 text-left transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400;
}

.thread-goal-menu-icon {
  @apply h-5 w-5 shrink-0 fill-none stroke-zinc-600;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.thread-goal-menu-copy {
  @apply min-w-0 flex flex-1 flex-col;
}

.thread-goal-menu-label {
  @apply text-sm text-zinc-800;
}

.thread-goal-menu-description {
  @apply mt-0.5 truncate text-xs text-zinc-500;
}

.thread-goal-menu-status {
  @apply shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600;
}

.thread-goal-menu-status.is-active,
.thread-goal-menu-status.is-complete {
  @apply bg-emerald-50 text-emerald-700;
}

.thread-goal-menu-status.is-blocked,
.thread-goal-menu-status.is-usageLimited,
.thread-goal-menu-status.is-budgetLimited {
  @apply bg-amber-50 text-amber-700;
}

.thread-goal-dialog-backdrop {
  @apply fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-4;
}

.thread-goal-dialog {
  width: min(32rem, calc(100vw - 2rem));
  max-height: calc(100dvh - 2rem);
  @apply overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl;
}

.thread-goal-dialog-header {
  @apply flex items-start justify-between gap-4;
}

.thread-goal-dialog-title {
  @apply m-0 text-lg font-semibold text-zinc-900;
}

.thread-goal-dialog-subtitle {
  @apply mt-1 text-sm leading-5 text-zinc-500;
}

.thread-goal-dialog-close {
  @apply inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-xl text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50;
}

.thread-goal-dialog-field {
  @apply mt-5 block;
}

.thread-goal-dialog-field-label {
  @apply mb-2 block text-sm font-medium text-zinc-800;
}

.thread-goal-dialog-textarea {
  @apply w-full resize-y rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm leading-6 text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:cursor-not-allowed disabled:opacity-60;
  min-height: 8rem;
}

.thread-goal-dialog-meta {
  @apply mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500;
}

.thread-goal-dialog-status {
  @apply rounded-full bg-zinc-100 px-2 py-1 font-medium text-zinc-600;
}

.thread-goal-dialog-status.is-active,
.thread-goal-dialog-status.is-complete {
  @apply bg-emerald-50 text-emerald-700;
}

.thread-goal-dialog-status.is-blocked,
.thread-goal-dialog-status.is-usageLimited,
.thread-goal-dialog-status.is-budgetLimited {
  @apply bg-amber-50 text-amber-700;
}

.thread-goal-dialog-error {
  @apply mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700;
}

.thread-goal-dialog-actions {
  @apply mt-5 flex flex-wrap items-center gap-2;
}

.thread-goal-dialog-action-spacer {
  @apply flex-1;
}

.thread-goal-dialog-button {
  @apply rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50;
}

.thread-goal-dialog-button--clear {
  @apply border-red-200 text-red-700 hover:bg-red-50;
}

.thread-goal-dialog-button--primary {
  @apply border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800;
}

@media (max-width: 420px) {
  .thread-goal-status-card {
    @apply items-start px-3 py-2;
  }

  .thread-goal-status-main {
    @apply min-w-0 items-start;
  }

  .thread-goal-status-copy {
    @apply min-w-0 flex-col items-start gap-0;
  }

  .thread-goal-status-separator {
    @apply hidden;
  }

  .thread-goal-status-time {
    @apply mt-0.5 text-xs;
  }

  .thread-goal-status-actions {
    @apply gap-0;
  }

  .thread-goal-dialog {
    @apply p-4;
  }

  .thread-goal-dialog-actions {
    @apply grid grid-cols-2;
  }

  .thread-goal-dialog-action-spacer {
    @apply hidden;
  }

  .thread-goal-dialog-button--clear {
    @apply col-span-2;
  }
}
</style>
