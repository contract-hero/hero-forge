// The findings ledger (`<run dir>/findings.json`), the re-checker's output
// (`<run dir>/recheck-r<N>.json`), and the gate that compares them.
import { readFile } from 'node:fs/promises'
import { Failure } from './run-state.ts'

export const DECISIONS = ['ACCEPT', 'REFUTE']
export const CLOSED = ['fixed', 'refutation_accepted']
const STATUSES = [...CLOSED, 'open']

export type LedgerEntry = { id: string; decision: string; reason: string; [key: string]: unknown }
export type RecheckItem = { id: string; status: string; reason: string }

async function readJson(path: string, what: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    throw new Failure(`cannot read ${what} ${path}: ${(error as Error).message}`, 1)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Failure(`${what} ${path} is not valid JSON`, 1)
  }
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Failure(message, 1)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function loadLedger(path: string): Promise<LedgerEntry[]> {
  const value = await readJson(path, 'ledger')
  const at = `ledger ${path}`
  check(Array.isArray(value), `${at} must be a JSON array`)
  const seen = new Set<string>()
  ;(value as unknown[]).forEach((raw, i) => {
    check(isObject(raw), `${at}: [${i}] must be an object`)
    const e = raw as Record<string, unknown>
    check(typeof e.id === 'string' && e.id !== '', `${at}: [${i}].id must be a string`)
    check(!seen.has(e.id as string), `${at}: duplicate id "${e.id}"`)
    seen.add(e.id as string)
    check(e.decision === '' || DECISIONS.includes(e.decision as string), `${at}: [${i}].decision must be ACCEPT, REFUTE or empty`)
    check(typeof e.reason === 'string', `${at}: [${i}].reason must be a string`)
  })
  return value as LedgerEntry[]
}

export async function loadRecheck(path: string): Promise<RecheckItem[]> {
  const value = await readJson(path, 're-check file')
  const at = `re-check file ${path}`
  check(isObject(value) && Array.isArray(value.items), `${at}: must be an object with an items array`)
  const items = (value as { items: unknown[] }).items
  items.forEach((raw, i) => {
    check(isObject(raw), `${at}: items[${i}] must be an object`)
    const item = raw as Record<string, unknown>
    check(typeof item.id === 'string' && item.id !== '', `${at}: items[${i}].id must be a string`)
    check(STATUSES.includes(item.status as string), `${at}: items[${i}].status must be fixed, refutation_accepted or open`)
    check(typeof item.reason === 'string', `${at}: items[${i}].reason must be a string`)
  })
  return items as RecheckItem[]
}

// The gate passes only when every finding is decided, every posted inline
// finding has exactly one ledger entry, the re-check covers exactly the
// ledger's ids, and it closed every one. Returns the problems, in that order.
export function gateProblems(
  ledger: LedgerEntry[],
  recheck: RecheckItem[],
  posted: { comment: number; finding: string | null }[],
): string[] {
  const problems: string[] = []
  const ledgerIds = new Set(ledger.map((e) => e.id))
  const recheckIds = new Set(recheck.map((i) => i.id))
  for (const e of ledger) if (!DECISIONS.includes(e.decision)) problems.push(`${e.id} has no decision (ACCEPT or REFUTE)`)
  const counts = new Map<string, number>()
  for (const p of posted) {
    if (p.finding === null) problems.push(`inline comment ${p.comment} starts with no **F<n>** finding id`)
    else counts.set(p.finding, (counts.get(p.finding) ?? 0) + 1)
  }
  for (const [id, n] of counts) {
    if (n > 1) problems.push(`${id} is posted inline ${n} times`)
    if (!ledgerIds.has(id)) problems.push(`${id} is posted inline but is not in the ledger`)
  }
  for (const id of ledgerIds) if (!recheckIds.has(id)) problems.push(`${id} is in the ledger but not in the re-check`)
  for (const id of recheckIds) if (!ledgerIds.has(id)) problems.push(`${id} is in the re-check but not in the ledger`)
  for (const item of recheck) if (!CLOSED.includes(item.status)) problems.push(`${item.id} is ${item.status}: ${item.reason}`)
  return problems
}
