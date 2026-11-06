/**
 * Resolve the plugin's peer packages (`@deepseek-ai/*`) for the host-half test.
 *
 * `lib/index.js` imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-llm`
 * by bare specifier, and in a real deployment those resolve from the profile
 * that installed the plugin. A checkout of this repository has no such
 * `node_modules`, so the old test harness created junctions into the profile —
 * which needs privileges (and an ACL-safe sandbox) that a normal `npm test`
 * does not have.
 *
 * Instead this module registers a Node resolve hook that retries a failed
 * `@deepseek-ai/*` lookup as if it had been imported from inside the harness
 * installation's own `node_modules`. Nothing on disk is modified, and the
 * resolution failure itself is still what happens for any other package.
 *
 * Search order:
 *   1. `DSH_INSTALL` — the directory of the installed `@deepseek-ai/dsh` package
 *      (its `node_modules` next to it holds the peers),
 *   2. the plugin's own resolution (a checkout inside a workspace that has them),
 *   3. `<DSH_HOME>/profiles/{web,default}/node_modules` (the profile that
 *      installed this plugin),
 *   4. the npm global prefix (`%APPDATA%\npm` on Windows, `/usr/local/lib` …).
 *
 * @module dsh-auto-handoff/test/resolve-install
 */
import { existsSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Whether a directory really holds the `@deepseek-ai` scope packages. */
function hasPeers(dir) {
  try {
    return existsSync(join(dir, '@deepseek-ai', 'cordis')) && existsSync(join(dir, '@deepseek-ai', 'schemastery'))
  } catch {
    return false
  }
}

/**
 * Locate a directory whose child `@deepseek-ai/` holds the harness packages.
 * @returns the first usable absolute directory.
 */
export function findModulesDir() {
  const candidates = []
  if (typeof process.env.DSH_INSTALL === 'string' && process.env.DSH_INSTALL !== '') {
    candidates.push(join(process.env.DSH_INSTALL, 'node_modules'))
    candidates.push(process.env.DSH_INSTALL)
  }
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const profile of ['web', 'default']) {
    candidates.push(join(dshHome, 'profiles', profile, 'node_modules'))
  }
  if (typeof process.env.APPDATA === 'string' && process.env.APPDATA !== '') {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  }
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules')
  // A checkout that happens to carry the packages next to the test.
  candidates.push(join(process.cwd(), 'node_modules'))

  for (const candidate of candidates) {
    if (hasPeers(candidate)) return candidate
  }
  // Last resort: ask Node to resolve from the profile anchor itself (works when
  // the profile links are valid but sit behind a different layout).
  for (const profile of ['web', 'default']) {
    try {
      const anchor = join(dshHome, 'profiles', profile, 'index.js')
      const require = createRequire(pathToFileURL(anchor))
      const resolved = require.resolve('@deepseek-ai/schemastery/package.json')
      const dir = resolved.slice(0, resolved.lastIndexOf('@deepseek-ai'))
      if (hasPeers(dir)) return dir
    } catch { /* try the next anchor */ }
  }
  throw new Error('could not locate @deepseek-ai/{cordis,schemastery,dsh-llm}; set DSH_INSTALL to the installed @deepseek-ai/dsh directory')
}

/**
 * Register the `@deepseek-ai/*` fallback resolver.
 * @param {string} [modulesDir] - directory holding `@deepseek-ai/`; found when omitted.
 * @returns the directory the fallback resolves from.
 */
export function registerResolver(modulesDir = findModulesDir()) {
  // A synthetic parent inside the modules directory: Node walks up from there
  // and finds `@deepseek-ai/<pkg>` exactly as it would for a real importer.
  const parentURL = pathToFileURL(join(modulesDir, '__resolve__.js')).href
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (!specifier.startsWith('@deepseek-ai/')) throw error
        return nextResolve(specifier, { ...context, parentURL })
      }
    },
  })
  return modulesDir
}
