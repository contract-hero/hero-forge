// What every subcommand shares: the Failure that carries an exit code, the
// guard that throws it, the argument parser, and the `main` wrapper that turns
// a Failure into one stderr line and an exit code.
import { parseArgs, type ParseArgsConfig } from 'node:util'

// A failure with its exit code (1 refused, 2 usage, 3 absent, 4 broken).
export class Failure extends Error {
  code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

// Exit 1 with `message` unless `ok`.
export function refuse(ok: boolean, message: string): void {
  if (!ok) throw new Failure(message, 1)
}

// A usage error (exit 2): the message, then the usage text.
export type Usage = (message: string) => Failure

export function usageFor(usage: string): Usage {
  return (message) => new Failure(`${message}\n${usage}`, 2)
}

const REPO = /^[\w.-]+\/[\w.-]+$/
const WHOLE = /^[0-9]+$/

export const isRepo = (v: unknown): v is string => typeof v === 'string' && REPO.test(v)

// `--<name>` as a positive whole number, or a usage error.
export function positive(name: string, value: unknown, usage: Usage): number {
  if (typeof value !== 'string' || !WHOLE.test(value) || Number(value) < 1) {
    throw usage(`--${name} must be a positive whole number`)
  }
  return Number(value)
}

export function repoOption(value: unknown, usage: Usage): string {
  if (!isRepo(value)) throw usage('--repo must be OWNER/REPO')
  return value
}

// parseArgs in strict mode; any parse error is a usage error.
export function parse<T extends NonNullable<ParseArgsConfig['options']>>(
  argv: string[],
  options: T,
  usage: Usage,
  allowPositionals = false,
) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals })
  } catch (error) {
    throw usage((error as Error).message)
  }
}

// The subcommand entry point. `fn` returns the stdout text, or an exit code
// when it wrote its own output. A Failure becomes one stderr line, prefixed
// `review.ts <name>: `, and its exit code.
export function runMain(name: string, fn: (argv: string[]) => Promise<string | number>): (argv: string[]) => Promise<number> {
  return async (argv) => {
    try {
      const result = await fn(argv)
      if (typeof result === 'number') return result
      process.stdout.write(result)
      return 0
    } catch (error) {
      if (!(error instanceof Failure)) throw error
      process.stderr.write(`review.ts ${name}: ${error.message}\n`)
      return error.code
    }
  }
}
