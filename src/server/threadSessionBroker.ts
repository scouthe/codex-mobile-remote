/**
 * Serializes mutations for one Codex thread while allowing unrelated threads
 * to make progress independently.  The Codex app-server remains the source
 * of truth for its writer lock; this broker only prevents two HTTP clients
 * from sending overlapping writes through the same bridge process.
 */
export class ThreadSessionBroker {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly writerReady = new Map<string, number>()

  constructor(private readonly getGeneration: () => number = () => 0) {}

  async runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) {
      throw new Error('threadId is required')
    }

    const previous = this.chains.get(normalizedThreadId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const chain = previous.then(() => current)
    this.chains.set(normalizedThreadId, chain)

    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.chains.get(normalizedThreadId) === chain) {
        this.chains.delete(normalizedThreadId)
      }
    }
  }

  async runTurn<T>(
    threadId: string,
    resume: () => Promise<void>,
    start: () => Promise<T>,
  ): Promise<T> {
    return this.runExclusive(threadId, async () => {
      await this.ensureWriterReady(threadId, resume)
      return await start()
    })
  }

  /**
   * Mark a thread as materialized for the current app-server process.  This
   * method is intentionally usable while the caller already owns the
   * runExclusive lock (for example the backend queue worker).
   */
  async ensureWriterReady(threadId: string, resume: () => Promise<void>): Promise<void> {
    const normalizedThreadId = threadId.trim()
    if (!normalizedThreadId) throw new Error('threadId is required')
    if (this.writerReady.get(normalizedThreadId) === this.getGeneration()) return
    await resume()
    this.writerReady.set(normalizedThreadId, this.getGeneration())
  }

  isWriterReady(threadId: string): boolean {
    const normalizedThreadId = threadId.trim()
    return Boolean(normalizedThreadId && this.writerReady.get(normalizedThreadId) === this.getGeneration())
  }

  markWriterReady(threadId: string): void {
    const normalizedThreadId = threadId.trim()
    if (normalizedThreadId) this.writerReady.set(normalizedThreadId, this.getGeneration())
  }

  clearWriterState(): void {
    this.writerReady.clear()
  }
}
