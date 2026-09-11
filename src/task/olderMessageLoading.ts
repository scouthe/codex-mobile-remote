/**
 * Decide whether reaching the top of the conversation should automatically
 * request older persisted messages. Mobile users expect the gesture itself to
 * continue loading history; the deferred mode remains available for desktop
 * observer sessions where an explicit action is less surprising.
 */
export function shouldAutoLoadPersistedAbove(isMobile: boolean, deferred: boolean | undefined): boolean {
  return isMobile || deferred !== true
}
