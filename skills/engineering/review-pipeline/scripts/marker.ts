// The hidden marker the CLI puts at the end of everything it posts, so a
// re-run finds its own post and never posts twice.
import { refuse } from './cli.ts'
import { HANDOFF_TAG } from './handoff.ts'

const TAG = 'hero-forge:review-pipeline'

// `<!-- hero-forge:review-pipeline pr=13 round=1 kind=review -->`, with the
// fields in the order given.
export function marker(fields: Record<string, string | number>): string {
  return `<!-- ${TAG} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')} -->`
}

// `body` with `mark` as its last line.
export function withMarker(body: string, mark: string): string {
  return `${body}\n\n${mark}`
}

// True only when the last line of `body` is exactly `mark`. A marker anywhere
// else in a post (quoted, or copied into the text) does not count.
export function hasOwnMarker(body: string | null, mark: string): boolean {
  const lines = (body ?? '').replace(/\s+$/, '').split('\n')
  return (lines[lines.length - 1] ?? '').replace(/\r$/, '') === mark
}

// Exit 1 when agent-written text holds a marker tag, this file's or the
// hand-off's (handoff.ts): only the CLI writes markers, so a forged one can
// neither pass for an earlier post nor start the other App's work.
export function refuseMarkerIn(texts: string[], what: string): void {
  for (const tag of [TAG, HANDOFF_TAG]) {
    refuse(
      texts.every((text) => !text.toLowerCase().includes(tag)),
      `${what} contains the marker "${tag}", which only the helper CLI writes. Nothing was posted. Remove it and run again.`,
    )
  }
}
