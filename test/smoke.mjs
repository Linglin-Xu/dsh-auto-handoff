/**
 * dsh-auto-handoff smoke test.
 *
 * Verifies the two static contracts that, when wrong, make the plugin fail
 * loudly at `dsh web` boot rather than at handoff time:
 *
 *   1. every module the host half imports resolves from the PROFILE anchor
 *      (`~/.dsh/profiles/web`), which is where the loader mounts it;
 *   2. the settings schema actually builds (schemastery `z` interface);
 *   3. the client half registers the exact bundle id the package declares,
 *      under `window.__ModuleLoader__`, and exports apply/inject.
 *
 * Run: node test/smoke.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { registerResolver } from './resolve-install.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const profileDir = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web')
const anchor = join(profileDir, 'index.js')
// The plugin's own modules import `@deepseek-ai/*` by bare specifier; the hook
// retries those lookups from the harness install (see resolve-install.mjs).
registerResolver()

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('=== dsh-auto-handoff smoke ===')
console.log(`profile anchor: ${anchor}`)

console.log('\n[1/3] host-half imports resolve from the profile anchor')
const require = createRequire(`file:///${anchor.replaceAll('\\', '/')}`)
for (const specifier of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm']) {
  try {
    check(specifier, require.resolve(specifier).length > 0)
  } catch (error) {
    check(specifier, false, error.code ?? String(error))
  }
}
const dshLlm = require('@deepseek-ai/dsh-llm')
for (const name of ['BlockAssembler', 'createUserMessage', 'contentHasImage']) {
  check(`@deepseek-ai/dsh-llm exports ${name}`, typeof dshLlm[name] === 'function')
}
const z = require('@deepseek-ai/schemastery').default ?? require('@deepseek-ai/schemastery')
check('schemastery default export is an object schema factory', z !== undefined && typeof z.object === 'function')

console.log('\n[2/3] the real settings schema builds, floors its defaults and clamps')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('package.json name is dsh-auto-handoff', manifest.name === 'dsh-auto-handoff')
check('dsh.bundle.patch is declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('dsh.client.platform is web', manifest.dsh?.client?.platform === 'web')
check('./client export is declared', manifest.exports?.['./client'] !== undefined)
// The settings namespace is what the harness renders and persists: a schema that
// cannot build turns `dsh web` into a startup failure, so it is built here from
// the real module rather than a copy of it.
const config = await import(pathToFileURL(join(root, 'lib', 'config.js')).href)
const resolvedSchema = config.SCHEMA({})
for (const [key, value] of Object.entries(config.DEFAULTS)) {
  check(`schema default ${key}`, JSON.stringify(resolvedSchema[key]) === JSON.stringify(value),
    `schema ${JSON.stringify(resolvedSchema[key])} vs DEFAULTS ${JSON.stringify(value)}`)
}
check('threshold defaults to 80%', resolvedSchema.threshold === 0.8)
check('automatic handoff is OFF by default (manual mode)', resolvedSchema.autoHandoff === false)
check('the goal guard is ON by default', resolvedSchema.guardGoal === true)
check('the summary falls back by default', resolvedSchema.summaryMode === 'auto')
const clamped = config.normalizeConfig({ threshold: 5, minRounds: -2, maxTokens: 1e9, summaryMode: 'nope' })
check('normalizeConfig clamps the numeric bounds', clamped.threshold === 1 && clamped.minRounds === 0
  && clamped.maxTokens === 32768, JSON.stringify({ threshold: clamped.threshold, minRounds: clamped.minRounds, maxTokens: clamped.maxTokens }))
check('normalizeConfig drops an unknown enum value', clamped.summaryMode === 'auto')
check('normalizeConfig keeps the widget-owned keys', config.pickUiConfig({
  promptRounds: 4, promptPercent: 0.5, promptCompactions: 1, autoHandoff: true, junk: 1,
}).promptRounds === 4)
check('patch file exists', readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8').includes('dsh-auto-handoff'))

console.log('\n[3/3] client half registers the declared bundle id')
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const registrations = []
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(registration) { registrations.push(registration) },
    },
    localStorage: {
      getItem() { return null },
      setItem() {},
    },
  },
  console,
  setInterval,
  clearInterval,
  AbortController,
  fetch,
  document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
}
vm.createContext(sandbox)
vm.runInContext(clientSource, sandbox, { filename: 'client.js' })
check('registered exactly one bundle', registrations.length === 1, `got ${registrations.length}`)
const registration = registrations[0]
check('bundle id matches the package name', registration?.id === manifest.name, `got ${registration?.id}`)
const exports = registration?.factory(() => { throw new Error('client half should require nothing') })
check('client half exports apply()', typeof exports?.apply === 'function')
check('client half exports inject[]', Array.isArray(exports?.inject) && exports.inject.length > 0)
// The client must survive a host without the services it wants (an older DSH,
// or a bundle loaded outside the conversation view) instead of breaking the GUI.
check('client apply degrades without its services', (() => {
  try {
    exports.apply({ get: () => undefined, effect: (run) => run() })
    return true
  } catch {
    return false
  }
})())

console.log('')
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} check(s)`)
  process.exit(1)
}
console.log('PASS: all checks green')
