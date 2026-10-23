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
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const profileDir = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web')
const anchor = join(profileDir, 'index.js')

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

console.log('\n[2/3] settings schema builds and applies its defaults')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('package.json name is dsh-auto-handoff', manifest.name === 'dsh-auto-handoff')
check('dsh.bundle.patch is declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('dsh.client.platform is web', manifest.dsh?.client?.platform === 'web')
check('./client export is declared', manifest.exports?.['./client'] !== undefined)
const schema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().default(0.8),
  minRounds: z.number().default(3),
  provider: z.string().default(''),
})
const resolved = schema({})
check('schema fills defaults', resolved.enabled === true && resolved.threshold === 0.8 && resolved.minRounds === 3)
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

console.log('')
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} check(s)`)
  process.exit(1)
}
console.log('PASS: all checks green')
