import type { AgentConfigOption } from '../../types/agent.js'

/** ACP select options may be grouped by provider; values remain opaque. */
export function normalizeAgentConfigOptions(value: unknown): AgentConfigOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(row => {
    if (!row || typeof row !== 'object' || row.type !== 'select' || typeof row.id !== 'string') return []
    const choices: AgentConfigOption['options'] = []
    for (const option of Array.isArray(row.options) ? row.options : []) {
      if (Array.isArray(option.options)) {
        for (const item of option.options) if (typeof item.value === 'string') choices.push({ value: item.value, label: String(item.name || item.value) })
      } else if (typeof option.value === 'string') choices.push({ value: option.value, label: String(option.name || option.value) })
    }
    return [{ id: row.id, name: String(row.name || row.id), category: String(row.category || row.id), currentValue: typeof row.currentValue === 'string' ? row.currentValue : '', options: choices }]
  })
}
