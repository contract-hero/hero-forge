// Helper CLI for the review pipeline. Run with Node (>= 22.18), no build step:
//   node review.ts <subcommand> [options]
// Each subcommand module exports `main(argv): Promise<number>`; the number is
// the exit code (0 ok, 1 failed, 2 usage, 3 absent, 4 broken).
import { main as config } from './config.ts'

const SUBCOMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  config,
}

const USAGE = `usage: review.ts <subcommand> [options]
subcommands: ${Object.keys(SUBCOMMANDS).join(', ')}
`

const [name, ...rest] = process.argv.slice(2)
const subcommand = name === undefined ? undefined : SUBCOMMANDS[name]

if (subcommand === undefined) {
  process.stderr.write(USAGE)
  process.exitCode = 2
} else {
  process.exitCode = await subcommand(rest)
}
