// compat-host.mjs: phase 0.5 of the unit system (docs/MODULE-SYSTEM.md section 15). Runs the Cordis plugins of a
// company's ENABLED units on the current stack and hands what they contribute to the tools that exist today, so a
// piece ported into a unit works now and moves to the new backend unchanged.
//
// What a unit's plugin may use here (the services this host provides; more arrive as pieces are ported):
//   ctx.skills.registerProvider(() => ({ name, list(): Promise<[{name, description}]>, get(candidate, opts): Promise<{content}> }))
//     the same contract DeepSeek Harness skill plugins use, so such a plugin also runs here unmodified.
// A unit with no `entry` but with provides.skills gets a built-in provider that serves those SKILL.md files.
// A plugin that injects a service this host does not provide never starts; sync reports it by name.
//
// Output: company/state/unit-skills/<name>/SKILL.md (+ index.json), which company/tools/skills.js treats as company
// skills and pushes to the seats. Stale skills from units no longer enabled are removed.
//
//   node runtime/src/compat-host.mjs sync [--root <company root>] [--json]
import { Context } from 'cordis'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SKILL_RE = /^[a-z][a-z0-9-]{1,63}$/
const SERVICES = ['skills']
const settle = ms => new Promise(r => setTimeout(r, ms))
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

function enabledUnits (root) {
  const reg = readJson(path.join(root, 'company', 'state', 'units.json'), { units: {} })
  const out = []
  for (const [id, u] of Object.entries(reg.units || {})) {
    if (!u || u.state !== 'enabled') continue
    const dir = path.join(root, 'company', 'state', 'units', id, u.version)
    const manifest = readJson(path.join(dir, 'module.json'), null)
    if (manifest) out.push({ id, dir, manifest, config: readJson(path.join(root, 'company', 'state', 'unit-config', id + '.json'), (manifest.config && manifest.config.defaults) || {}) })
  }
  return out
}

// the built-in provider for a unit that lists its skills as files (no code of its own)
function staticProvider (unit) {
  const skills = ((unit.manifest.provides && unit.manifest.provides.skills) || []).filter(s => s && SKILL_RE.test(String(s.name || '')))
  const fileOf = s => path.join(unit.dir, s.file || ('skills/' + s.name + '/SKILL.md'))
  const descOf = txt => ((txt.match(/^description:\s*(.+)$/m) || [])[1] || '').trim()
  return () => ({
    name: unit.id,
    list: async () => skills.map(s => ({ name: s.name, description: descOf(fs.readFileSync(fileOf(s), 'utf8')) })),
    get: async (c) => ({ ...c, content: fs.readFileSync(fileOf(skills.find(s => s.name === c.name)), 'utf8') })
  })
}

// a skill's text as a SKILL.md with front matter (a provider may return the body only)
function asSkillMd (name, description, content) {
  const body = String(content || '')
  if (/^---\s*\n[\s\S]*?\n---/.test(body) && new RegExp('^name:\\s*' + name + '\\s*$', 'm').test(body)) return body
  const d = String(description || '').replace(/\s+/g, ' ').trim()
  return '---\nname: ' + name + '\ndescription: ' + JSON.stringify(d) + '\n---\n\n' + body.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
}

export async function sync ({ root, settleMs = 150 } = {}) {
  root = path.resolve(root || process.env.CAPHEOS_ROOT || process.cwd())
  const ctx = new Context()
  const providers = [] // { unit, make }
  let current = null
  ctx.provide('skills', { registerProvider (make) { providers.push({ unit: current, make }) } })
  const result = { units: [], skills: [], problems: [] }
  for (const unit of enabledUnits(root)) {
    current = unit.id
    const before = providers.length
    const entry = unit.manifest.entry
    try {
      if (entry) {
        const mod = await import(pathToFileURL(path.join(unit.dir, entry)).href)
        const plugin = mod.default && (mod.default.apply || typeof mod.default === 'function') ? mod.default : mod
        const needs = [].concat(plugin.inject || []).map(x => typeof x === 'string' ? x : '').filter(Boolean)
        const missing = needs.filter(n => !SERVICES.includes(n))
        if (missing.length) { result.problems.push(unit.id + ': needs ' + missing.join(', ') + ', which this stack does not provide yet; not started'); continue }
        ctx.plugin(plugin, unit.config)
        await settle(settleMs)
      } else if (unit.manifest.provides && Array.isArray(unit.manifest.provides.skills)) {
        providers.push({ unit: unit.id, make: staticProvider(unit) })
      }
      result.units.push({ id: unit.id, providers: providers.length - before })
    } catch (e) { result.problems.push(unit.id + ': ' + String(e && e.message || e).slice(0, 200)) }
  }
  // collect every skill, first unit wins a name
  const outDir = path.join(root, 'company', 'state', 'unit-skills')
  const want = new Map()
  for (const p of providers) {
    try {
      const prov = p.make()
      for (const c of await prov.list()) {
        if (!c || !SKILL_RE.test(String(c.name || ''))) continue
        if (want.has(c.name)) { result.problems.push(c.name + ': provided by ' + want.get(c.name).unit + ' and ' + p.unit + '; kept the first'); continue }
        const got = await prov.get(c, {})
        want.set(c.name, { unit: p.unit, provider: prov.name || p.unit, description: c.description || '', text: asSkillMd(c.name, c.description, got && got.content) })
      }
    } catch (e) { result.problems.push((p.unit || '?') + ': ' + String(e && e.message || e).slice(0, 200)) }
  }
  fs.mkdirSync(outDir, { recursive: true })
  for (const name of fs.readdirSync(outDir)) {
    const d = path.join(outDir, name)
    if (fs.statSync(d).isDirectory() && !want.has(name)) fs.rmSync(d, { recursive: true, force: true })
  }
  const index = {}
  for (const [name, s] of want) {
    fs.mkdirSync(path.join(outDir, name), { recursive: true })
    fs.writeFileSync(path.join(outDir, name, 'SKILL.md'), s.text)
    index[name] = { unit: s.unit, provider: s.provider, description: s.description }
    result.skills.push({ name, unit: s.unit })
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1) + '\n')
  try { await ctx.registry?.dispose?.() } catch {}
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2)
  if (a[0] !== 'sync') { console.error('usage: compat-host.mjs sync [--root <dir>] [--json]'); process.exit(2) }
  const i = a.indexOf('--root')
  const r = await sync({ root: i > 0 ? a[i + 1] : undefined })
  if (a.includes('--json')) console.log(JSON.stringify(r, null, 1))
  else console.log('units ' + r.units.length + ', skills ' + r.skills.map(s => s.name).join(', ') + (r.problems.length ? '\nproblems:\n- ' + r.problems.join('\n- ') : ''))
  process.exit(r.problems.length ? 1 : 0)
}
