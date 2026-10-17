// A last check before anything reaches GitHub. An agent reads untrusted PR
// text and may be told to copy a credential file into its output, so every
// text the CLI posts is scanned for secret shapes first. A match posts nothing.
//
// This is defence in depth, not a guarantee: an agent that wants to leak a
// secret can encode it in a way no scanner sees. The real boundary is that
// no agent gets the gh token, write access or the network (codex-exec.ts).
//
// Scan the exact strings that get posted, never a JSON encoding of them: in
// JSON a newline becomes `\n`, and `n` before a token hides its start. Each
// text is scanned as it is and in forms GitHub may render the same way.
import { Failure } from './cli.ts'

// A token starts where no letter or digit comes before it.
const START = '(?<![A-Za-z0-9])'
const PATTERNS: [string, RegExp][] = [
  ['a GitHub token', new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{20,}`)],
  ['a GitHub fine-grained token', new RegExp(`${START}github_pat_[A-Za-z0-9_]{20,}`)],
  ['a private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['an API key (sk-)', new RegExp(`${START}sk-[A-Za-z0-9_-]{20,}`)],
  ['a Slack token', new RegExp(`${START}xox[abp]-[A-Za-z0-9-]{10,}`)],
  // A JWT: Codex and ChatGPT access and id tokens, App JWTs.
  ['a JWT', new RegExp(`${START}eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.`)],
  // An OAuth token as a credential file holds it (Codex auth.json, for one).
  ['an OAuth token in a credential file', /(?:refresh|access|id)_token["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{20,}/i],
]

// The named entities that can spell a token, its prefix or its separators.
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­', lowbar: '_', hyphen: '-', dash: '-',
  minus: '-', period: '.', sol: '/', colon: ':', equals: '=', num: '#', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']',
  zwj: '‍', zwnj: '‌',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED[name.toLowerCase()] ?? whole
  })
}

// What a reader may see: compatibility forms folded (fullwidth letters),
// format characters gone (zero-width, soft hyphen, bidi marks), entities
// decoded, and markdown backslash escapes dropped. `tags` also removes HTML
// comments and tags, which can split a token. Repeated until nothing
// changes, so a double encoding is undone too.
function visible(text: string, tags: boolean): string {
  let out = text
  for (let i = 0; i < 5; i++) {
    let next = decodeEntities(out.normalize('NFKC').replace(/\p{Cf}/gu, '')).replace(/\\([!-/:-@[-`{-~])/g, '$1')
    if (tags) next = next.replace(/<!--[^]*?-->/g, '').replace(/<[^<>]*>/g, '')
    if (next === out) break
    out = next
  }
  return out
}

// The kind of the first secret found in `text`, or undefined. Never the secret
// itself.
export function secretIn(text: string): string | undefined {
  const forms = [text, visible(text, false), visible(text, true)]
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
