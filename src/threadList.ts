function readThreadRecord(value: unknown): { id?: unknown; updatedAt?: unknown } | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export function threadUpdatedAt(value: unknown): number {
  const updatedAt = readThreadRecord(value)?.updatedAt
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0
}

/**
 * A resumed session can have several rollout files with the same thread ID.
 * Keep the newest entire record, so an old path or task error cannot leak
 * into the current session. Preserve page order (and the first row on ties).
 */
export function deduplicateThreadRecords<T>(rows: readonly T[]): T[] {
  const result: T[] = []
  const indexById = new Map<string, number>()
  for (const row of rows) {
    const rawId = readThreadRecord(row)?.id
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    const existingIndex = id ? indexById.get(id) : undefined
    if (existingIndex === undefined) {
      if (id) indexById.set(id, result.length)
      result.push(row)
    } else if (threadUpdatedAt(row) > threadUpdatedAt(result[existingIndex])) {
      result[existingIndex] = row
    }
  }
  return result
}
