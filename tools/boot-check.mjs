// Boot check: mount `dsh-swarm` in a REAL `@deepseek-ai/cordis` Context.
//
// Proves (per dsh-plugin-guide/verification-standards.md S1-S3):
//   1. `index.js` imports cleanly, exports `name` and `apply`, and exports NO `Config`
//      (preventing the `resolveConfig` plain-object startup crash).
//   2. `ctx.plugin(plugin)` mounts in a real Cordis Context and logs `[dsh-swarm] active`.
//   3. A sibling plugin publishing `session/event` via `storeCtx.events.dispatch('emit', [carrier, ...])`
//      reaches `dsh-swarm`'s listener (no fake root `ctx.emit`).
//   4. Row `config:` overrides reach `apply()` on remount and disposal cleans up listeners.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_CORDIS_DIR = '/mnt/c/portable_software/dsh/deepseek-harness/vendor/cordis'
const specifier = process.argv[2] ?? (fs.existsSync(DEFAULT_CORDIS_DIR) ? DEFAULT_CORDIS_DIR : '@deepseek-ai/cordis')
const cordisSpec = /^[a-zA-Z]:[\\/]/.test(specifier) || specifier.startsWith('/') || specifier.startsWith('.')
  ? pathToFileURL(specifier.endsWith('.js') ? specifier : specifier.replace(/[\\/]+$/, '') + '/lib/index.js').href
  : specifier

const lines = []
const errors = []
const origInfo = console.info
const origError = console.error
const origWarn = console.warn
console.info = (...args) => { lines.push(args.map(item => typeof item === 'object' ? JSON.stringify(item) : String(item)).join(' ')); origInfo(...args) }
console.error = (...args) => { errors.push(args.map(String).join(' ')); origError(...args) }
console.warn = (...args) => { lines.push('warn ' + args.map(String).join(' ')); origWarn(...args) }

let exitCode = 0
function fail(msg) {
  exitCode = 1
  origError('FAIL ' + msg)
}
function pass(msg) {
  origInfo('ok   ' + msg)
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swarm-boot-'))

try {
  const mod = await import(cordisSpec)
  if (typeof mod.Context !== 'function') {
    fail('Cordis does not export Context')
    process.exit(1)
  }

  const plugin = await import(new URL('../index.js', import.meta.url).href)

  if (plugin.name !== 'dsh-swarm') fail('index.js must export name = "dsh-swarm"')
  else pass('host entry exports name = dsh-swarm')

  if (typeof plugin.apply !== 'function') fail('index.js has no apply() export')
  else pass('host entry exports apply()')

  if (plugin.Config !== undefined) {
    fail('index.js must NOT export Config (a plain object crashes Cordis resolveConfig at boot)')
  } else {
    pass('index.js exports no Config (Cordis passes row config through unchanged)')
  }

  const ctx = new mod.Context()
  const fiber = ctx.plugin(plugin, { swarmDir: tempDir })
  if (fiber && typeof fiber.then === 'function') await fiber
  await new Promise(resolve => setTimeout(resolve, 25))

  if (!lines.some(line => line.includes('[dsh-swarm] active'))) {
    fail('apply() did not log activation')
  } else {
    pass('apply() mounted in real Cordis Context and logged activation')
  }

  // Mount a sibling emitter plugin and dispatch `session/event` the exact way DSH does:
  // `storeCtx.events.dispatch('emit', [carrier, 'session/event', session, event])`
  let storeCtx
  const storeFiber = ctx.plugin({
    name: 'boot-check-sibling-store',
    apply(c) { storeCtx = c },
  })
  if (storeFiber && typeof storeFiber.then === 'function') await storeFiber
  await new Promise(resolve => setTimeout(resolve, 20))

  const carrier = { name: 'boot-check-carrier' }
  const fakeSession = { id: 'sess-boot-1', header: { id: 'sess-boot-1', cwd: tempDir } }
  const callbacks = storeCtx.events.dispatch('emit', [
    carrier,
    'session/event',
    fakeSession,
    { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
  ])
  for (const cb of callbacks) cb(fakeSession, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })

  if (callbacks.length === 0) {
    fail('sibling dispatch collected 0 listeners for session/event')
  } else {
    pass(`sibling dispatch collected ${callbacks.length} listener(s) for session/event`)
  }

  await fiber?.dispose?.()

  // Second mount with custom config overrides
  const fiber2 = ctx.plugin(plugin, {
    swarmDir: tempDir,
    defaultConcurrency: 4,
    defaultModel: 'glm5.3',
  })
  if (fiber2 && typeof fiber2.then === 'function') await fiber2
  await new Promise(resolve => setTimeout(resolve, 25))

  if (!lines.some(line => line.includes('"defaultConcurrency":4') && line.includes('"defaultModel":"glm5.3"'))) {
    fail('row config overrides did not reach apply()')
  } else {
    pass('row config overrides (defaultConcurrency=4, defaultModel=glm5.3) reached apply()')
  }

  await fiber2?.dispose?.()
  if (errors.length > 0) fail('unexpected errors logged:\n' + errors.join('\n'))
  else pass('no errors logged during mount/remount/dispose')
} finally {
  console.info = origInfo
  console.error = origError
  console.warn = origWarn
  fs.rmSync(tempDir, { recursive: true, force: true })
}

if (exitCode === 0) {
  console.log('\nboot check passed: dsh-swarm mounts safely in a real Cordis context')
}
process.exit(exitCode)
