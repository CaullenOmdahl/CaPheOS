// model-bench: a Cordis plugin. Today it provides the model manager's how-to skill through the `skills` service (the
// runner is company/tools/model-bench.js on the current stack). When the host offers the `tools` service it also registers
// the runner's functions as model_bench.* (functions first, CLI second: docs/MODULE-SYSTEM.md section 5.7.4).
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

export const name = 'model-bench'
export const inject = ['skills']

const here = dirname(fileURLToPath(import.meta.url))
const unitDir = join(here, '..')
const file = join(unitDir, 'skills', 'model-bench', 'SKILL.md')
const describe = text => ((text.match(/^description:\s*(.+)$/m) || [])[1] || '').trim()

export function apply (ctx) {
  ctx.skills.registerProvider(() => ({
    name,
    async list () { return [{ name: 'model-bench', description: describe(await readFile(file, 'utf8')) }] },
    async get (candidate) { return { ...candidate, content: await readFile(file, 'utf8') } }
  }))
  // optional: the tools service is not on the phase 0.5 compat host yet; ctx.get reads it without declaring it
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : null
  if (tools && typeof tools.register === 'function') {
    const B = createRequire(import.meta.url)('../lib/bench.js')
    const reg = t => (typeof ctx.effect === 'function' ? ctx.effect(() => tools.register(t)) : tools.register(t))
    reg({ name: 'model_bench.list_tasks', purpose: 'list the bench tasks', run: args => B.loadTasks(unitDir, args || {}).map(t => ({ id: t.id, kind: t.kind, depth: t.depth, version: t.version, title: t.title })) })
    reg({ name: 'model_bench.dry_run', purpose: 'what a run would do and cost, running nothing', run: args => B.dryRun(Object.assign({ unitDir }, args || {})) })
    reg({ name: 'model_bench.run', purpose: 'run the bench for one model through ctx.agents.run', run: async args => {
      const agents = ctx.get('agents')
      if (!agents) throw new Error('the agents service is not available')
      const driver = { id: args.model, family: B.familyOf(String(args.model).split('/').pop()), turn: async messages => agents.run(args.seat, { purpose: 'model-bench', task: messages, tools: [] }) }
      return B.run(Object.assign({ unitDir, driver }, args))
    } })
  }
}
