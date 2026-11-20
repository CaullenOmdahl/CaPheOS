// owner-questions: a Cordis plugin that provides one skill through the `skills` service. Same contract as a DeepSeek Harness
// skill plugin (export name, inject, apply; ctx.skills.registerProvider), so it runs on the CaPheOS compat host now,
// on the new backend later, and in the Harness unchanged.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'owner-questions'
export const inject = ['skills']

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', 'skills', 'owner-questions', 'SKILL.md')
const describe = text => ((text.match(/^description:\s*(.+)$/m) || [])[1] || '').trim()

export function apply (ctx) {
  ctx.skills.registerProvider(() => ({
    name,
    async list () { return [{ name: 'owner-questions', description: describe(await readFile(file, 'utf8')) }] },
    async get (candidate) { return { ...candidate, content: await readFile(file, 'utf8') } }
  }))
}
