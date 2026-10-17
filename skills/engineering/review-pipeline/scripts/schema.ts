// A check of a JSON value against the JSON Schema subset the pipeline's
// schema files use: type (one or a list), enum, properties, required,
// additionalProperties: false, items. It returns the first problem, or
// undefined when the value matches.
type Schema = {
  type?: string | string[]
  enum?: unknown[]
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  items?: Schema
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

const fits = (actual: string, wanted: string) => actual === wanted || (wanted === 'number' && actual === 'integer')

export function schemaProblem(schema: Schema, value: unknown, at = '$'): string | undefined {
  const actual = typeOf(value)
  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!wanted.some((w) => fits(actual, w))) return `${at}: must be ${wanted.join(' or ')}, not ${actual}`
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return `${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`
  }
  if (actual === 'object') {
    const object = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!(key in object)) return `${at}: missing "${key}"`
    for (const [key, child] of Object.entries(object)) {
      const sub = schema.properties?.[key]
      if (sub === undefined) {
        if (schema.additionalProperties === false) return `${at}: unknown key "${key}"`
        continue
      }
      const problem = schemaProblem(sub, child, `${at}.${key}`)
      if (problem !== undefined) return problem
    }
  }
  if (actual === 'array' && schema.items !== undefined) {
    const items = value as unknown[]
    for (let i = 0; i < items.length; i++) {
      const problem = schemaProblem(schema.items, items[i], `${at}[${i}]`)
      if (problem !== undefined) return problem
    }
  }
  return undefined
}
