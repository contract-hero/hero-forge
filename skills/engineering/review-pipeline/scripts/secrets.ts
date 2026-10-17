// The last guard before anything reaches GitHub. An agent reads untrusted PR
// text and may be told to copy a credential file into its output, so every
// text the CLI posts is scanned for secret shapes first. A match posts nothing.
import { Failure } from './run-state.ts'

const PATTERNS: [string, RegExp][] = [
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['a GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['a private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['an API key (sk-)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['a Slack token', /\bxox[abp]-[A-Za-z0-9-]{10,}/],
]

// The kind of the first secret found in `text`, or undefined. Never the secret itself.
export function secretIn(text: string): string | undefined {
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0]
}

// Exit 1, naming `what` and the kind of secret, when `text` holds one.
export function refuseSecrets(text: string, what: string): void {
  const kind = secretIn(text)
  if (kind !== undefined) {
    throw new Failure(`${what} contains what looks like ${kind}. Nothing was posted. Remove it and run again.`, 1)
  }
}
