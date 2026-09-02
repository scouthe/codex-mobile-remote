<template>
  <button
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
import { computed, nextTick, ref, watch } from 'vue'
import type { ThreadGoal } from '../../api/appServerDtos'
import { useUiLanguage } from '../../composables/useUiLanguage'

const props = defineProps<{
  threadId: string
  goal: ThreadGoal | null
  loading?: boolean
  supported?: boolean
  error?: string
  disabled?: boolean
  saveGoal: (objective: string) => Promise<boolean>
  clearGoal: () => Promise<boolean>
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

const isBusy = computed(() => props.loading === true || isSubmitting.value)
const displayError = computed(() => localError.value || props.error || '')
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
  if (minutes < 60) return t('{count}m', { count: minutes })
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder > 0 ? t('{hours}h {minutes}m', { hours, minutes: remainder }) : t('{count}h', { count: hours })
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
</script>

<style scoped>
@reference "tailwindcss";

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
