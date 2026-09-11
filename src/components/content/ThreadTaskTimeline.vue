<template>
  <section v-if="visible" class="task-timeline" aria-label="Task activity">
    <button
      class="task-timeline-current"
      :class="{ 'is-expandable': events.length > 0 }"
      :data-state="snapshot.state"
      type="button"
      role="status"
      aria-live="polite"
      :aria-expanded="eventsVisible"
      :aria-label="events.length > 0 ? 'Toggle task activity history' : undefined"
      @click="toggleEvents"
    >
      <span class="task-timeline-spinner" :class="{ 'is-spinning': isActive }" aria-hidden="true" />
      <div class="task-timeline-current-copy">
        <strong>{{ currentLabel }}<span v-if="snapshot.writerClient" class="task-timeline-writer"> · {{ snapshot.writerClient.label }} writer</span></strong>
        <span v-if="currentDetails.length > 0">{{ currentDetails.join(' · ') }}</span>
      </div>
      <span class="task-timeline-state">{{ stateLabel }}</span>
      <span v-if="events.length > 0" class="task-timeline-chevron" :class="{ 'is-open': eventsVisible }" aria-hidden="true">▶</span>
    </button>
    <ol v-if="eventsVisible" class="task-timeline-events">
      <li v-for="event in events" :key="event.id" class="task-timeline-event" :data-type="event.type">
        <span class="task-timeline-event-dot" aria-hidden="true" />
        <div class="task-timeline-event-copy">
          <span>{{ event.label }}<small v-if="event.repeatCount && event.repeatCount > 1"> · ×{{ event.repeatCount }}</small></span>
          <small v-if="event.details.length > 0">{{ event.details.join(' · ') }}</small>
        </div>
        <time :datetime="event.atIso">{{ formatTime(event.atIso) }}</time>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TaskSnapshot } from '../../types/task'
import { compactTaskTimelineEvents } from '../../task/taskTimeline'
import { useMobile } from '../../composables/useMobile'

const props = defineProps<{ snapshot: TaskSnapshot | null }>()

const snapshot = computed(() => props.snapshot ?? {
  state: 'completed' as const,
  currentActivity: { kind: 'idle' as const, label: 'Completed', details: [] },
  timeline: [],
  writerClient: null,
})
const activeStates = new Set(['queued', 'starting', 'running', 'waiting_approval', 'waiting_user_input', 'steering'])
const isActive = computed(() => activeStates.has(snapshot.value.state))
const visible = computed(() => Boolean(props.snapshot && (isActive.value || snapshot.value.timeline.length > 0)))
const { isMobile } = useMobile()
const timelineExpanded = ref(false)
const events = computed(() => compactTaskTimelineEvents(snapshot.value.timeline).slice(-8).reverse())
const eventsVisible = computed(() => events.value.length > 0 && (!isMobile.value || timelineExpanded.value))
const currentLabel = computed(() => snapshot.value.currentActivity.label || 'Task')
const currentDetails = computed(() => snapshot.value.currentActivity.details)
const stateLabel = computed(() => snapshot.value.state.replace(/_/g, ' '))

function toggleEvents(): void {
  if (!isMobile.value || events.value.length === 0) return
  timelineExpanded.value = !timelineExpanded.value
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''
}
</script>

<style scoped>
@reference "tailwindcss";

.task-timeline {
  @apply mx-2 mb-2 overflow-hidden rounded-xl border border-slate-200 bg-slate-50/90 text-xs text-slate-700 sm:mx-3;
}

.task-timeline-current {
  @apply flex w-full items-center gap-2 border-b border-slate-200 bg-transparent px-3 py-2 text-left;
  appearance: none;
}

.task-timeline-current.is-expandable {
  @apply cursor-pointer hover:bg-slate-100/80;
}

.task-timeline-current[data-state='failed'] {
  @apply border-red-200 bg-red-50 text-red-700;
}

.task-timeline-current[data-state='waiting_approval'],
.task-timeline-current[data-state='waiting_user_input'] {
  @apply border-amber-200 bg-amber-50 text-amber-800;
}

.task-timeline-spinner {
  @apply h-3.5 w-3.5 shrink-0 rounded-full border-2 border-slate-400 border-t-transparent;
}

.task-timeline-spinner.is-spinning {
  @apply animate-spin;
}

.task-timeline-current-copy {
  @apply flex min-w-0 flex-1 flex-col gap-0.5;
}

.task-timeline-current-copy strong {
  @apply truncate font-medium;
}

.task-timeline-current-copy span {
  @apply truncate text-[11px] opacity-75;
}

.task-timeline-state {
  @apply shrink-0 capitalize opacity-70;
}

.task-timeline-chevron {
  @apply shrink-0 text-[9px] text-slate-400 transition-transform duration-150;
}

.task-timeline-chevron.is-open {
  transform: rotate(90deg);
}

.task-timeline-events {
  @apply m-0 flex max-h-40 list-none flex-col gap-1 overflow-y-auto px-3 py-2;
}

.task-timeline-event {
  @apply flex items-center gap-2;
}

.task-timeline-event-dot {
  @apply h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400;
}

.task-timeline-event[data-type='error'] .task-timeline-event-dot {
  @apply bg-red-500;
}

.task-timeline-event-copy {
  @apply flex min-w-0 flex-1 flex-col;
}

.task-timeline-event-copy span {
  @apply truncate;
}

.task-timeline-event-copy small {
  @apply truncate text-[11px] opacity-65;
}

.task-timeline-event time {
  @apply shrink-0 text-[10px] opacity-50;
}

:global(:root.dark) .task-timeline {
  @apply border-zinc-700 bg-zinc-900/80 text-zinc-200;
}

:global(:root.dark) .task-timeline-current {
  @apply border-zinc-700;
}

:global(:root.dark) .task-timeline-current.is-expandable {
  @apply hover:bg-zinc-800/80;
}
</style>
