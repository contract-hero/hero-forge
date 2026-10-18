// The reviewer outputs of one round, in the run dir: who is expected, and
// whether each one's output is there and valid. A round consolidates only
// when every expected output is valid, so no reviewer is lost silently.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SCHEMAS } from './codex-exec.ts'
import { parseOutput, schemaProblem } from './schema.ts'

export const AXES = ['standards', 'spec'] as const
export type Axis = (typeof AXES)[number]

export type Expected = { name: string; pair: number; axis: Axis }

// The reviewers a round starts: one per pair and axis, and no Spec reviewer
// without a spec.
export function expectedReviewers(pairs: number, withSpec: boolean): Expected[] {
  const axes: readonly Axis[] = withSpec ? AXES : ['standards']
  const list: Expected[] = []
  for (let pair = 1; pair <= pairs; pair++) for (const axis of axes) list.push({ name: `reviewer-p${pair}-${axis}`, pair, axis })
  return list
}

// Why `<dir>/<name>.json` is not a valid reviewer output (missing, not JSON
// after one surrounding code fence is removed, or not findings.schema.json),
// or undefined when it is valid.
export async function outputProblem(dir: string, name: string): Promise<string | undefined> {
  const path = join(dir, `${name}.json`)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return `${path} is missing`
  }
  const parsed = parseOutput(text)
  if (!parsed.ok) return `${path} ${parsed.problem}`
  const problem = schemaProblem(JSON.parse(await readFile(SCHEMAS.reviewer, 'utf8')), parsed.value)
  return problem === undefined ? undefined : `${path} does not match findings.schema.json: ${problem}`
}
