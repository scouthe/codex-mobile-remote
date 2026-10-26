<template>
  <header class="content-header" :class="{ 'has-center': Boolean($slots.center) }">
    <div class="content-leading" :class="{ 'is-accent': accent }">
      <slot name="leading" />
    </div>
    <div v-if="$slots.center" class="content-center">
      <slot name="center" />
    </div>
    <h1 class="content-title" :class="{ 'is-accent': accent }" :title="title">{{ title }}</h1>
    <span
      v-if="status"
      class="content-header-status-indicator"
      :data-status="status"
      role="status"
      :aria-label="statusLabel || status"
      :title="statusLabel || status"
    />
    <div class="content-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  accent?: boolean
  status?: 'working'
  statusLabel?: string
}>()
</script>

<style scoped>
@reference "tailwindcss";

.content-header {
  @apply relative z-[250] w-full min-w-0 min-h-12 sm:min-h-14 flex items-center gap-2 sm:gap-3 px-2 sm:px-3 pt-3 sm:pt-4 pb-2 bg-white;
}

.content-title {
  @apply m-0 min-w-0 max-w-[min(72ch,100%)] flex-1 truncate text-sm font-medium leading-6 text-slate-900 max-sm:text-xs;
}

.content-title.is-accent {
  @apply text-lg font-semibold leading-7 tracking-[-0.01em] text-zinc-950 sm:text-[1.4rem];
}

.content-actions {
  @apply ml-auto flex shrink-0 items-center justify-end gap-1;
}

.content-header-status-indicator {
  @apply inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-zinc-400 border-t-transparent animate-spin;
}

.content-leading {
  @apply flex shrink-0 items-center gap-1;
}

.content-leading.is-accent {
  @apply gap-2;
}

.content-header.has-center {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  column-gap: 0;
  row-gap: 4px;
  padding-top: max(8px, env(safe-area-inset-top, 0px));
}

.has-center .content-leading {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  gap: 0;
}

.content-center {
  grid-column: 2;
  grid-row: 1;
  justify-self: center;
}

.has-center .content-actions {
  grid-column: 3;
  grid-row: 1;
  min-width: 0;
  gap: 0;
  margin-left: 0;
}

.has-center .content-title {
  grid-column: 1 / -1;
  grid-row: 2;
  max-width: 100%;
  padding: 4px 24px 0 8px;
  font-size: 14px;
}

.has-center .content-header-status-indicator {
  grid-column: 3;
  grid-row: 2;
  justify-self: end;
  margin-right: 8px;
}

:global(:root.dark) .content-title.is-accent {
  @apply text-zinc-100;
}

:global(:root.dark) .content-header-status-indicator {
  @apply border-zinc-500 border-t-transparent;
}
</style>
