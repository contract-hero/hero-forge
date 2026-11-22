// `review.ts builder` (usage in the table in cli.ts): the builder that a
// ticket's `builder:<alias>` label selects. The config on the repo's default
// branch is the allowlist: a label selects only a builder that config names,
// so a branch cannot add a model and pick it. Every doubt exits 4, so the
// caller builds nothing on another model and nothing on its own model either.
import { Failure, parse, positive, repoOption, runMain, usageFor } from './cli.ts'
import { gh, json, oneLine, remoteConfig } from './github.ts'

const PREFIX = 'builder:'
const NOTHING = 'Nothing is built on another model'

async function builder(argv: string[]): Promise<string> {
  const usage = usageFor('builder')
  const { values } = parse(argv, { repo: { type: 'string' }, issue: { type: 'string' } }, usage)
  const repo = repoOption(values.repo, usage)
  const issue = positive('issue', values.issue, usage)

  const got = await gh(['api', `repos/${repo}/issues/${issue}`, '--jq', '[.labels[].name]'])
  if (got.code !== 0) throw new Failure(`cannot read the labels of #${issue} in ${repo}: ${oneLine(got.stderr)}`, 1)
  // GitHub matches label names without case, so the prefix does too.
  const names = json<unknown>(got.stdout, `labels of #${issue}`)
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    throw new Failure(`unexpected output from gh (labels of #${issue}): ${oneLine(got.stdout)}`, 1)
  }
  const labels = names.filter((name) => name.toLowerCase().startsWith(PREFIX))

  if (labels.length === 0) return `${JSON.stringify({ issue, builder: null })}\n`
  if (labels.length > 1) throw new Failure(`#${issue} has ${labels.length} builder labels (${labels.join(', ')}): keep one. ${NOTHING}`, 4)
  const label = labels[0] ?? ''
  const alias = label.slice(PREFIX.length)

  const config = await remoteConfig(repo, undefined)
  if (config === null) {
    throw new Failure(`#${issue} has the label ${label}, but ${repo} has no docs/agents/review.md on its default branch. ${NOTHING}`, 4)
  }
  const found = Object.hasOwn(config.builders, alias) ? config.builders[alias] : undefined
  if (found === undefined) {
    const named = Object.keys(config.builders).join(', ') || 'none'
    throw new Failure(
      `#${issue} has the label ${label}, but the config on the default branch of ${repo} names no builder ${alias} (it names: ${named}). ${NOTHING}`,
      4,
    )
  }
  return `${JSON.stringify({ issue, builder: { alias, ...found } }, null, 2)}\n`
}

export const main = runMain('builder', builder)
