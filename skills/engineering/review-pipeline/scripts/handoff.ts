// The hand-off marker: the hidden comment a thread posts as its very last
// action (after `run-state advance` and the lock release), so the other App's
// `route` knows the step is done. A webhook fires the moment a post lands,
// before the posting thread advances the run state, so a review or a reply is
// never a trigger: only this comment is.
//
//   <!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->
//
// Kinds: review-posted and recheck-failed (posted by contract-reviewer[bot],
// they start an Adjudication), adjudicated (posted by
// contract-implementer[bot], it starts a re-check). Only the helper CLI
// writes one: marker.ts refuses agent text that holds HANDOFF_TAG.
export const HANDOFF_TAG = 'hero-forge:handoff'

export const HANDOFF_KINDS = ['review-posted', 'recheck-failed', 'adjudicated'] as const
export type HandoffKind = (typeof HANDOFF_KINDS)[number]

export type Handoff = { kind: HandoffKind; pr: number; round: number }

// The marker for one hand-off, fields always in this order.
export function handoffMarker({ kind, pr, round }: Handoff): string {
  return `<!-- ${HANDOFF_TAG} kind=${kind} pr=${pr} round=${round} -->`
}

const LINE = new RegExp(`^<!-- ${HANDOFF_TAG} kind=(${HANDOFF_KINDS.join('|')}) pr=([1-9][0-9]*) round=([1-9][0-9]*) -->$`)

// The hand-off in `body`, or null. It counts only when the last line of the
// body is exactly what handoffMarker writes: a marker that is quoted, edited
// into the text, or followed by more text is no hand-off.
export function parseHandoff(body: string | null | undefined): Handoff | null {
  const lines = (body ?? '').replace(/\s+$/, '').split('\n')
  const match = LINE.exec((lines[lines.length - 1] ?? '').replace(/\r$/, ''))
  if (match === null) return null
  return { kind: match[1] as HandoffKind, pr: Number(match[2]), round: Number(match[3]) }
}
