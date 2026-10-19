// The hand-off marker that a thread posts as its last action (#29 posts it,
// `route` reads it). These tests call handoff.ts's two exported functions,
// the interface that the posting side imports: the format must stay the one
// that `route` parses.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handoffMarker, parseHandoff } from './handoff.ts'

test('handoff marker: the writer gives the one format, kind then pr then round', () => {
  assert.equal(handoffMarker({ kind: 'adjudicated', pr: 12, round: 1 }), '<!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->')
  assert.equal(handoffMarker({ kind: 'review-posted', pr: 7, round: 2 }), '<!-- hero-forge:handoff kind=review-posted pr=7 round=2 -->')
  assert.equal(handoffMarker({ kind: 'recheck-failed', pr: 40, round: 3 }), '<!-- hero-forge:handoff kind=recheck-failed pr=40 round=3 -->')
})

test('handoff marker: what the writer gives, as the last line of a comment, parses back', () => {
  for (const handoff of [
    { kind: 'review-posted', pr: 42, round: 1 },
    { kind: 'recheck-failed', pr: 42, round: 2 },
    { kind: 'adjudicated', pr: 9, round: 10 },
  ] as const) {
    assert.deepEqual(parseHandoff(handoffMarker(handoff)), handoff)
    assert.deepEqual(parseHandoff(`Round done.\n\n${handoffMarker(handoff)}\n`), handoff)
    assert.deepEqual(parseHandoff(`Round done.\r\n\r\n${handoffMarker(handoff)}\r\n`), handoff)
  }
})

const notMarkers: [string, string][] = [
  ['a marker that is not the last line', '<!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->\nmore text'],
  ['a quoted marker', '> <!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->'],
  ['a marker in a code span', '`<!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->`'],
  ['an unknown kind', '<!-- hero-forge:handoff kind=merged pr=12 round=1 -->'],
  ['fields in another order', '<!-- hero-forge:handoff pr=12 kind=adjudicated round=1 -->'],
  ['a missing round', '<!-- hero-forge:handoff kind=adjudicated pr=12 -->'],
  ['an extra field', '<!-- hero-forge:handoff kind=adjudicated pr=12 round=1 by=me -->'],
  ['a pr of 0', '<!-- hero-forge:handoff kind=adjudicated pr=0 round=1 -->'],
  ['a pr with a leading zero', '<!-- hero-forge:handoff kind=adjudicated pr=012 round=1 -->'],
  ['two spaces', '<!-- hero-forge:handoff  kind=adjudicated pr=12 round=1 -->'],
  ['another case', '<!-- HERO-FORGE:handoff kind=adjudicated pr=12 round=1 -->'],
  ['leading text on the line', 'done <!-- hero-forge:handoff kind=adjudicated pr=12 round=1 -->'],
  ['the review-pipeline marker', '<!-- hero-forge:review-pipeline pr=12 round=1 kind=review -->'],
  ['an empty body', ''],
]

for (const [name, body] of notMarkers) {
  test(`handoff marker: ${name} is no marker`, () => {
    assert.equal(parseHandoff(body), null)
  })
}
