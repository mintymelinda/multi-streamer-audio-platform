export type QueueInsertionPosition = 'front' | 'back';

export function isExactQueuePermutation(currentIds: string[], requestedIds: string[]): boolean {
  if (requestedIds.length !== currentIds.length || new Set(requestedIds).size !== requestedIds.length) {
    return false;
  }
  const current = new Set(currentIds);
  return requestedIds.every((id) => current.has(id));
}

export function moveQueueItem(
  currentIds: string[],
  requestId: string,
  position: QueueInsertionPosition,
): string[] | null {
  if (!currentIds.includes(requestId)) return null;
  const remaining = currentIds.filter((id) => id !== requestId);
  return position === 'front' ? [requestId, ...remaining] : [...remaining, requestId];
}
