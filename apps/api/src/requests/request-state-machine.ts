export type RequestStatus =
  | 'submitted' | 'pending' | 'held' | 'approved' | 'queued' | 'resolving'
  | 'ready' | 'playing' | 'completed' | 'rejected' | 'cancelled' | 'failed' | 'skipped';

const transitions: Readonly<Record<RequestStatus, ReadonlySet<RequestStatus>>> = {
  submitted: new Set(['pending', 'held', 'approved', 'rejected', 'cancelled']),
  pending: new Set(['approved', 'held', 'rejected', 'cancelled']),
  held: new Set(['pending', 'approved', 'rejected', 'cancelled']),
  approved: new Set(['queued', 'cancelled']),
  queued: new Set(['resolving', 'cancelled', 'skipped']),
  resolving: new Set(['ready', 'failed', 'queued', 'skipped']),
  ready: new Set(['playing', 'failed', 'queued', 'skipped']),
  playing: new Set(['completed', 'failed', 'skipped']),
  completed: new Set(),
  rejected: new Set(),
  cancelled: new Set(),
  failed: new Set(['queued', 'cancelled', 'skipped']),
  skipped: new Set(),
};

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  return transitions[from]?.has(to) ?? false;
}

export function assertRequestTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransitionRequest(from, to)) {
    throw new Error(`Invalid request state transition: ${from} -> ${to}`);
  }
}

export function classifyModeration(
  mode: 'automatic' | 'manual' | 'filtered',
  title: string,
  artist: string | null,
  holdTerms: readonly string[],
  rejectTerms: readonly string[],
): 'pending' | 'held' | 'rejected' | 'approved' {
  if (mode === 'manual') return 'pending';
  if (mode === 'automatic') return 'approved';
  const haystack = `${title} ${artist ?? ''}`.normalize('NFKC').toLowerCase();
  const matches = (terms: readonly string[]) =>
    terms.some((term) => term.trim().length > 0 && haystack.includes(term.normalize('NFKC').toLowerCase()));
  if (matches(rejectTerms)) return 'rejected';
  if (matches(holdTerms)) return 'held';
  return 'approved';
}
