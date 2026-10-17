// The last guard before anything reaches GitHub. An agent reads untrusted PR
// text and may be told to copy a credential file into its output, so every
// text the CLI posts is scanned for secret shapes first. A match posts nothing.
//
// Scan the exact strings that get posted, never a JSON encoding of them: in
// JSON a newline becomes `\n`, and `n` before a token hides its start.
import { Failure } from './cli.ts'

// A token starts where no letter or digit comes before it.
const START = '(?<![A-Za-z0-9])'
const PATTERNS: [string, RegExp][] = [
  ['a GitHub token', new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{20,}`)],
  ['a GitHub fine-grained token', new RegExp(`${START}github_pat_[A-Za-z0-9_]{20,}`)],
  ['a private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['an API key (sk-)', new RegExp(`${START}sk-[A-Za-z0-9_-]{20,}`)],
  ['a Slack token', new RegExp(`${START}xox[abp]-[A-Za-z0-9-]{10,}`)],
]
const ZERO_WIDTH = /[​-‍⁠﻿]/g
const HTML_COMMENT = /<!--[^]*?-->/g

// The kind of the first secret found in `text`, or undefined. Never the secret
// itself. Zero-width characters are removed first, and the text is scanned
// both as it is and with its HTML comments removed (a comment can split a token).
export function secretIn(text: string): string | undefined {
  const visible = text.replace(ZERO_WIDTH, '')
  const forms = [visible, visible.replace(HTML_COMMENT, '')]
  return PATTERNS.find(([, pattern]) => forms.some((form) => pattern.test(form)))?.[0]
}

// Exit 1, naming `what` and the kind of secret, when any text holds one.
export function refuseSecrets(texts: string[], what: string): void {
  for (const text of texts) {
    const kind = secretIn(text)
    if (kind !== undefined) {
      throw new Failure(`${what} contains what looks like ${kind}. Nothing was posted. Remove it and run again.`, 1)
    }
  }
}

// Every string inside `value` (object keys included), at any depth.
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([k, v]) => [k, ...stringsIn(v)])
  return []
}

// refuseSecrets over every string of the exact object that will be sent.
export function refuseSecretsIn(value: unknown, what: string): void {
  refuseSecrets(stringsIn(value), what)
}
