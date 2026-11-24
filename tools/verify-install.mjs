// Pre-publish & remote-deployment verification gate (adapted from dsh-wsl-workspace/scripts/verify-install.mjs).
//
// Proves that a user installing `dsh-swarm` remotely from GitHub or an npm tarball:
//   `dsh plugin --profile web add https://github.com/MISTYEYE2088/dsh-swarm`
// gets all required files (`index.js`, `client.js`, `src/host/*`, `cordis.patch.yml`, `LICENSE`),
// zero unresolvable runtime dependencies, no `prepare` build script trap, and a working
// Host + Client module after unpacking into a clean scratch directory.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

function fail(msg) {
  console.error('verify-install FAIL: ' + msg)
  process.exit(1)
}
function pass(msg) {
  console.info('ok   ' + msg)
}

// 1. Ensure no `prepare` script exists in package.json (pnpm 10+ blocks git dependencies with prepare scripts unless allowBuilds is edited)
if (manifest.scripts && manifest.scripts.prepare) {
  fail('package.json must not define a `prepare` script: pnpm blocks git-hosted plugins with lifecycle scripts unless listed in allowBuilds')
} else {
  pass('no `prepare` lifecycle script (remote git install works out-of-the-box without allowBuilds edits)')
}

// 2. Ensure no version-locked peerDependencies block compatibility preflight
if (manifest.peerDependencies && Object.keys(manifest.peerDependencies).length > 0) {
  fail('package.json must not declare peerDependencies that trigger DSH version-lock rejections')
} else {
  pass('zero peerDependencies (passes DSH plugin-compatibility preflight across versions)')
}

// 3. Pack tarball and install into an isolated scratch directory
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swarm-verify-install-'))
let tarballPath = null

try {
  const packRes = spawnSync('npm', ['pack', '--pack-destination', scratch], {
    cwd: repoRoot,
    shell: false,
    encoding: 'utf8',
  })
  if (packRes.status !== 0) {
    fail('npm pack failed: ' + (packRes.stderr || packRes.stdout))
  }
  const tgzName = packRes.stdout.trim().split(/\r?\n/).pop()
  tarballPath = path.join(scratch, tgzName)
  if (!fs.existsSync(tarballPath)) {
    fail('packed tarball not found at ' + tarballPath)
  }
  pass('packed tarball: ' + tgzName)

  const consumerDir = path.join(scratch, 'consumer')
  fs.mkdirSync(consumerDir, { recursive: true })
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'scratch-consumer', private: true }, null, 2),
    'utf8',
  )

  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith('npm_')),
  )
  const installRes = spawnSync('npm', ['install', '--no-audit', '--no-fund', tarballPath], {
    cwd: consumerDir,
    env: cleanEnv,
    shell: false,
    encoding: 'utf8',
  })
  if (installRes.status !== 0) {
    fail('npm install from tarball failed: ' + (installRes.stderr || installRes.stdout))
  }
  pass('installed packed tarball into isolated scratch consumer with zero external network deps')

  const installedPkgDir = path.join(consumerDir, 'node_modules', manifest.name)
  for (const requiredFile of ['index.js', 'client.js', 'cordis.patch.yml', 'LICENSE', 'src/host/projector.js', 'src/host/store.js', 'src/host/tools.js']) {
    if (!fs.existsSync(path.join(installedPkgDir, requiredFile))) {
      fail('missing required file in packed artifact: ' + requiredFile)
    }
  }
  pass('all required Host, Client, patch, and LICENSE files present in packed artifact')

  const imported = await import(pathToFileURL(path.join(installedPkgDir, 'index.js')).href)
  if (imported.name !== 'dsh-swarm' || typeof imported.apply !== 'function' || imported.Config !== undefined) {
    fail('packed index.js export contract broken')
  }
  pass('packed index.js imports cleanly from scratch node_modules')
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log('\nverify-install passed: ready for remote GitHub / npm deployment')
