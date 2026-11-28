// Git worktree isolation (`share` / `branch`) with dirty working-tree overlay sync
// and Land-First-Kill-Later merge protection.
//
// Portability & security rule (verification-standards.md S7):
//   Never route argv through a command interpreter (`shell: true` or a concatenated
//   command string). Every git invocation uses `spawn('git', [...argv], { shell: false, windowsHide: true })`.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// #FUNC Run a `git` subprocess directly without a shell and capture stdout/stderr.
// #NOT  Never sets `shell: true`, preventing argument injection across Windows and WSL.
// #EDGE-OUT Non-zero exit returns `{ ok: false, code, stderr }` instead of throwing → test_worktree_git_no_shell_spawn
// #WHY  `windowsHide: true` and `shell: false` satisfy DSH verification standard S7 on both Windows and Linux.
export function runGit(args, { cwd, input, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error) })
      return
    }

    const outChunks = []
    const errChunks = []
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)

    child.stdout.on('data', chunk => outChunks.push(chunk))
    child.stderr.on('data', chunk => errChunks.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        code: code ?? -1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      })
    })

    if (input !== undefined && child.stdin) {
      child.stdin.end(input)
    } else if (child.stdin) {
      child.stdin.end()
    }
  })
}

/** Parse `git status --porcelain=v1 -z --untracked-files=all` output into file entries. */
export function parsePorcelainZero(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return []
  const tokens = raw.split('\0').filter(t => t.length > 0)
  const entries = []
  for (let i = 0; i < tokens.length; i += 1) {
    const line = tokens[i]
    const status = line.slice(0, 2)
    const relPath = line.slice(3)
    if (status.startsWith('R') || status.startsWith('C')) {
      const origPath = tokens[i + 1]
      i += 1
      entries.push({ status: status.trim(), path: relPath, origPath })
    } else {
      entries.push({ status: status.trim(), path: relPath })
    }
  }
  return entries
}

/** Match a relative slash-normalized path against a simple glob or directory prefix pattern. */
export function matchPathPattern(relPath, pattern) {
  const normPath = String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  const normPat = String(pattern ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (!normPath || !normPat) return false
  if (normPat.endsWith('/')) {
    return normPath.startsWith(normPat) || normPath === normPat.slice(0, -1)
  }
  if (!normPat.includes('*')) {
    return normPath === normPat || normPath.startsWith(`${normPat}/`)
  }
  const escaped = normPat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')
  return new RegExp(`^${escaped}$`).test(normPath)
}

/** Extract clean relative file paths from `git diff --name-status` lines (e.g. `M\tsrc/a.js`). */
export function extractPathsFromNameStatus(files = []) {
  const out = []
  for (const line of files) {
    const parts = String(line ?? '').split('\t').map(s => s.trim()).filter(Boolean)
    const p = parts.length >= 2 ? parts[parts.length - 1] : parts[0]
    if (p) out.push(p.replace(/\\/g, '/'))
  }
  return out
}

const SENSITIVE_PATH_PATTERNS = Object.freeze([
  /^\.env(?:\.(?!example$).+)?$/i,
  /(?:^|\/)\.env(?:\.(?!example$).+)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /(?:^|\/)credentials(?:\.[^/]+)?$/i,
  /(?:^|\/)(?:scratch|mutants)(?:\/|$)/i,
])

// #FUNC Audit changed worktree paths against `[OWNERSHIP]`, `[FORBIDDEN]`, and sensitive/scratch file blacklists before landing.
// #NOT  Never enforces `[OWNERSHIP]` when `ownedPaths` is empty (avoiding false positives on prose-only briefs).
// #EDGE-IN Modifying a forbidden path (`b.txt`) or sensitive file (`.env`) flags violations and blocks `swarm_land` unless overridden → test_worktree_scope_sensitive_gate_worktreeinclude_and_preflight_all
// #WHY  Checking `SENSITIVE_PATH_PATTERNS` and path scopes against Git diff paths catches both `write_file` and `bash` redirection writes mechanically.
export function auditChangedPaths({ files = [], ownedPaths = [], forbiddenPaths = [] } = {}) {
  const relPaths = extractPathsFromNameStatus(files)
  const sensitive = []
  const forbidden = []
  const outOfScope = []

  for (const p of relPaths) {
    if (SENSITIVE_PATH_PATTERNS.some(re => re.test(p))) {
      sensitive.push(p)
    }
    if (Array.isArray(forbiddenPaths) && forbiddenPaths.length > 0 && forbiddenPaths.some(pat => matchPathPattern(p, pat))) {
      forbidden.push(p)
    }
    if (Array.isArray(ownedPaths) && ownedPaths.length > 0 && !ownedPaths.some(pat => matchPathPattern(p, pat))) {
      outOfScope.push(p)
    }
  }

  return {
    ok: sensitive.length === 0 && forbidden.length === 0 && outOfScope.length === 0,
    paths: relPaths,
    sensitive,
    forbidden,
    outOfScope,
  }
}

const PATCH_HYGIENE_CHECKS = Object.freeze([
  Object.freeze(['added_skip_macro', /\b(?:GTEST_SKIP|pytest\.mark\.skip|unittest\.skip)\b|\b(?:test|it|describe)\.skip\s*\(|\[SKIP\]/i]),
  Object.freeze(['added_shell_ignore_error', /\|\|\s*(?:true|:)\b/]),
  Object.freeze(['added_trivial_assert', /\bassert(?:\.ok)?\s*\(\s*true\s*\)|expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\)/i]),
  Object.freeze(['added_empty_catch', /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/]),
])

/** Scan added lines (`+`) in a unified diff for objective reward-hacking / test-downgrade signals. */
export function scanPatchHygiene(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return []
  const flags = new Set()
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith('+') || line.startsWith('+++ ')) continue
    const added = line.slice(1)
    for (const [flagName, regex] of PATCH_HYGIENE_CHECKS) {
      if (regex.test(added)) flags.add(flagName)
    }
  }
  return [...flags]
}

const OUTPUT_GATE_CHECKS = Object.freeze([
  Object.freeze(['output_fail_keyword', /\b(?:FAILED|FAIL:|AssertionError|Traceback \(most recent call last\)|Segmentation fault|panic:|npm ERR!|ERR!|compilation terminated|build failed)\b|\u65ad\u8a00\u5931\u8d25|\u7f16\u8bd1\u5931\u8d25|\u6d4b\u8bd5\u5931\u8d25/i]),
  Object.freeze(['output_error_keyword', /(?:^|\s)(?:ERROR:|FATAL:|Exception:|SyntaxError:|TypeError:|ReferenceError:)|\u62a5\u9519|\u6267\u884c\u5931\u8d25/im]),
  Object.freeze(['output_skip_keyword', /\b(?:GTEST_SKIP|SKIPPED|pytest\.mark\.skip|unittest\.skip)\b|\[SKIP\]/i]),
])

// #FUNC Scan command or tool output text for objective failure, error, and skip signals beyond exit code 0.
// #NOT  Never embeds literal CJK characters (uses ASCII Unicode escapes) so runtime zero-CJK invariants stay intact.
// #EDGE-IN A command returning exit code 0 while printing `GTEST_SKIP` or `FAILED` is flagged non-empty → test_host_gate_commands_and_witness_enforcement
// #WHY  Legacy scripts frequently exit 0 after printing failures or skipping tests; scanning `OUTPUT_GATE_CHECKS` catches silent green lies.
export function scanOutputForGateFlags(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const flags = new Set()
  for (const [flagName, regex] of OUTPUT_GATE_CHECKS) {
    if (regex.test(text)) flags.add(flagName)
  }
  return [...flags]
}

/** Run one deterministic host verification command without `shell: true`, returning exit code, output flags, and bounded excerpt. */
function runSingleGateCommand(command, { cwd, timeoutMs = 120_000, maxExcerptChars = 600 } = {}) {
  return new Promise((resolve) => {
    const startMs = Date.now()
    const bin = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const argv = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
    let child
    try {
      child = spawn(bin, argv, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        command,
        exit_code: -1,
        duration_ms: Date.now() - startMs,
        output_flags: ['spawn_error'],
        passed: false,
        excerpt: String(error).slice(0, maxExcerptChars),
      })
      return
    }

    const chunks = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)

    const pushChunk = (buf) => {
      chunks.push(buf)
      if (chunks.length > 256) chunks.splice(0, chunks.length - 256)
    }
    child.stdout.on('data', pushChunk)
    child.stderr.on('data', pushChunk)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        command,
        exit_code: -1,
        duration_ms: Date.now() - startMs,
        output_flags: ['spawn_error'],
        passed: false,
        excerpt: String(error).slice(0, maxExcerptChars),
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const combined = Buffer.concat(chunks).toString('utf8')
      const flags = scanOutputForGateFlags(combined)
      if (timedOut) flags.push('timeout')
      const exitCode = code ?? -1
      const passed = !timedOut && exitCode === 0 && flags.length === 0
      const trimmed = combined.trim()
      const excerpt = trimmed.length > maxExcerptChars
        ? `...${trimmed.slice(-maxExcerptChars)}`
        : trimmed
      resolve({
        command,
        exit_code: exitCode,
        duration_ms: Date.now() - startMs,
        output_flags: flags,
        passed,
        excerpt,
      })
    })
  })
}

// #FUNC Execute deterministic host `gate_commands` in `cwd`, requiring both `exit_code === 0` and zero failure/skip keyword hits.
// #NOT  Never trusts agent self-reported exit codes or runs commands via `shell: true`.
// #EDGE-IN A gate command exiting 0 while emitting `GTEST_SKIP` fails host verification and blocks landing → test_host_gate_commands_and_witness_enforcement
// #WHY  Host-executed `runHostGateCommands` with `scanOutputForGateFlags` eliminates circular self-proof and silent `rc=0` script lies.
export async function runHostGateCommands(cwd, commands = [], options = {}) {
  const list = Array.isArray(commands)
    ? commands.map(c => String(c ?? '').trim()).filter(Boolean)
    : []
  const results = []
  for (const cmd of list) {
    results.push(await runSingleGateCommand(cmd, { cwd, ...options }))
  }
  const failedCount = results.filter(r => !r.passed).length
  return {
    ok: failedCount === 0,
    cwd,
    ran: results.length,
    failed_count: failedCount,
    results,
  }
}

/** Check whether two normalized path/glob patterns can statically match at least one common file path. */
export function patternsMayOverlap(patA, patB) {
  const a = String(patA ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim()
  const b = String(patB ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim()
  if (!a || !b) return false
  if (a === b) return true
  if (matchPathPattern(a, b) || matchPathPattern(b, a)) return true
  const stripWildcard = (p) => {
    const idx = p.indexOf('*')
    if (idx === -1) return p
    const prefix = p.slice(0, idx)
    const lastSlash = prefix.lastIndexOf('/')
    return lastSlash === -1 ? '' : prefix.slice(0, lastSlash)
  }
  const aHasWild = a.includes('*')
  const bHasWild = b.includes('*')
  const prefA = stripWildcard(a)
  const prefB = stripWildcard(b)
  if (aHasWild && bHasWild) {
    if (!prefA || !prefB) return true
    return prefA === prefB || prefA.startsWith(`${prefB}/`) || prefB.startsWith(`${prefA}/`)
  }
  if (aHasWild) {
    if (!prefA) return a.includes('**') || !b.includes('/')
    return b === prefA || b.startsWith(`${prefA}/`)
  }
  if (bHasWild) {
    if (!prefB) return b.includes('**') || !a.includes('/')
    return a === prefB || a.startsWith(`${prefB}/`)
  }
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

// #FUNC Detect static `[OWNERSHIP]` path/glob overlaps between a newly spawned worker and existing active workers before work begins.
// #NOT  Never flags retired (`killed`) members, reviewers, or the predecessor being replaced via `adopt_worktree_from`.
// #EDGE-IN Spawning `@worker-b` owning `src/auth/login.js` while `@worker-a` owns `src/auth/*` reports the exact overlapping pair → test_prespawn_ownership_overlap_and_supersedes_auth
// #WHY  Checking `patternsMayOverlap` at `swarm_add` time warns Coordinator before parallel workers waste turns creating merge conflicts.
export function findOwnershipOverlaps(candidatePatterns = [], existingMembers = {}, excludeNames = []) {
  const patterns = Array.isArray(candidatePatterns) ? candidatePatterns.filter(Boolean) : []
  if (patterns.length === 0) return []
  const excluded = new Set((excludeNames || []).filter(Boolean))
  const overlaps = []
  for (const [mName, m] of Object.entries(existingMembers || {})) {
    if (!m || m.killed || m.role !== 'worker' || excluded.has(mName)) continue
    const otherPatterns = Array.isArray(m.owned_paths) && m.owned_paths.length > 0
      ? m.owned_paths
      : (Array.isArray(m.brief_owned_paths) ? m.brief_owned_paths : [])
    for (const cand of patterns) {
      for (const other of otherPatterns) {
        if (patternsMayOverlap(cand, other)) {
          overlaps.push({
            member: mName,
            pattern: cand,
            other_pattern: other,
            workspace_mode: m.workspace_mode ?? 'inherit',
          })
          break
        }
      }
    }
  }
  return overlaps
}

/** Selectively copy gitignored files matching `<mainCwd>/.worktreeinclude` into `targetDir` after `baselineCommit` (never committed). */
async function syncWorktreeIncludeFiles(mainCwd, targetDir) {
  const includeFile = path.join(mainCwd, '.worktreeinclude')
  if (!fs.existsSync(includeFile)) return []
  let patterns = []
  try {
    patterns = fs.readFileSync(includeFile, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'))
  } catch {
    return []
  }
  if (patterns.length === 0) return []

  const ignoredRes = await runGit(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd: mainCwd })
  if (!ignoredRes.ok || !ignoredRes.stdout) return []
  const ignoredFiles = ignoredRes.stdout.split('\0').filter(Boolean)
  const copied = []
  for (const relPath of ignoredFiles) {
    if (!patterns.some(pat => matchPathPattern(relPath, pat))) continue
    const srcFile = path.join(mainCwd, relPath)
    const dstFile = path.join(targetDir, relPath)
    try {
      if (fs.existsSync(srcFile) && fs.statSync(srcFile).isFile()) {
        fs.mkdirSync(path.dirname(dstFile), { recursive: true })
        fs.copyFileSync(srcFile, dstFile)
        copied.push(relPath)
      }
    } catch {
      // Best-effort copy of ignored local config
    }
  }
  return copied
}

// dup-ok: worktree provisioning counterpart to removeIsolatedWorktree
// #FUNC Provision an isolated worktree (`share` or `branch`) and sync uncommitted staged/unstaged/untracked changes from `mainCwd`.
// #NOT  Does not lose the user's uncommitted work when creating a worktree from HEAD.
// #EDGE-IN Uncommitted modified and untracked files in `mainCwd` appear in the worker's worktree and are excluded from the worker's own incremental diff → test_worktree_syncs_dirty_files_and_isolates_worker_diff
// #WHY  `baselineCommit` commits the synced dirty state inside the detached worktree so `diffWorktree` measures only what the worker itself changed.
export async function createIsolatedWorktree({
  mainCwd,
  worktreesRoot,
  swarmId,
  memberName,
  mode = 'share',
}) {
  if (mode === 'inherit') {
    return {
      ok: true,
      workspace_mode: 'inherit',
      worktree_path: mainCwd,
      base_commit: null,
      baseline_commit: null,
    }
  }

  const targetDir = path.join(
    worktreesRoot,
    String(swarmId).replace(/[^a-zA-Z0-9_.-]/g, '_'),
    memberName,
  )
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  if (fs.existsSync(targetDir)) {
    await runGit(['worktree', 'remove', '--force', targetDir], { cwd: mainCwd })
    fs.rmSync(targetDir, { recursive: true, force: true })
  }

  const headRes = await runGit(['rev-parse', 'HEAD'], { cwd: mainCwd })
  if (!headRes.ok) {
    return {
      ok: false,
      error: `Workspace (${mainCwd}) is not a valid Git repository or has no commits yet: ${headRes.stderr.trim()}`,
    }
  }
  const headSha = headRes.stdout.trim()

  const addArgs = mode === 'branch'
    ? ['worktree', 'add', '-b', `swarm/${String(swarmId).slice(0, 8)}/${memberName}`, targetDir, 'HEAD']
    : ['worktree', 'add', '--detach', targetDir, 'HEAD']
  const addRes = await runGit(addArgs, { cwd: mainCwd })
  if (!addRes.ok) {
    return {
      ok: false,
      error: `Failed to create git worktree: ${addRes.stderr.trim()}`,
    }
  }

  const statusRes = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: mainCwd })
  const dirtyEntries = statusRes.ok ? parsePorcelainZero(statusRes.stdout) : []

  for (const item of dirtyEntries) {
    const srcFile = path.join(mainCwd, item.path)
    const dstFile = path.join(targetDir, item.path)
    if (item.status === 'D') {
      fs.rmSync(dstFile, { force: true })
    } else if (fs.existsSync(srcFile) && fs.statSync(srcFile).isFile()) {
      fs.mkdirSync(path.dirname(dstFile), { recursive: true })
      fs.copyFileSync(srcFile, dstFile)
    }
  }

  let baselineCommit = headSha
  if (dirtyEntries.length > 0) {
    await runGit(['add', '-A'], { cwd: targetDir })
    const commitRes = await runGit(
      ['-c', 'user.name=dsh-swarm', '-c', 'user.email=swarm@local', 'commit', '-m', 'dsh-swarm: dirty-baseline-snapshot', '--no-verify'],
      { cwd: targetDir },
    )
    if (commitRes.ok) {
      const baseRev = await runGit(['rev-parse', 'HEAD'], { cwd: targetDir })
      if (baseRev.ok) baselineCommit = baseRev.stdout.trim()
    }
  }

  const copiedIncluded = await syncWorktreeIncludeFiles(mainCwd, targetDir)

  return {
    ok: true,
    workspace_mode: mode,
    worktree_path: targetDir,
    base_commit: headSha,
    baseline_commit: baselineCommit,
    included_ignored_files: copiedIncluded,
  }
}

// dup-ok: reviewer snapshot worktree builder that overlays a worker patch as an immutable review baseline
// #FUNC Provision an isolated review snapshot worktree pre-loaded with a target worker's incremental patch as its `baselineCommit`.
// #NOT  Never shares `mainCwd` or the worker's live directory, so reviewer shell commands cannot mutate production files.
// #EDGE-IN A reviewer mutating a repo file via shell inside its review worktree is caught by `diffWorktree` on `approve` → test_isolated_review_worktree_catches_rogue_writes_and_blind_projection
// #WHY  Committing the target worker patch into the reviewer's `baselineCommit` makes any subsequent repo edit by the reviewer appear immediately as a non-empty `diffWorktree`.
export async function createReviewSnapshotWorktree({
  mainCwd,
  worktreesRoot,
  swarmId,
  memberName,
  targetWorktreePath = null,
  targetBaselineCommit = null,
}) {
  const base = await createIsolatedWorktree({
    mainCwd,
    worktreesRoot,
    swarmId,
    memberName,
    mode: 'share',
  })
  if (!base.ok) return base

  let reviewBaseline = base.baseline_commit
  if (targetWorktreePath && fs.existsSync(targetWorktreePath) && targetWorktreePath !== mainCwd) {
    const targetDiff = await diffWorktree({
      worktreePath: targetWorktreePath,
      baselineCommit: targetBaselineCommit,
    })
    if (targetDiff.ok && targetDiff.hasChanges && targetDiff.patch) {
      const applyRes = await runGit(['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', '-'], {
        cwd: base.worktree_path,
        input: targetDiff.patch,
      })
      if (!applyRes.ok) {
        return {
          ok: false,
          error: `Failed to overlay target worker diff into review worktree: ${applyRes.stderr.trim()}`,
        }
      }
      await runGit(['add', '-A'], { cwd: base.worktree_path })
      const snapRes = await runGit(
        ['-c', 'user.name=dsh-swarm', '-c', 'user.email=swarm@local', 'commit', '-m', 'dsh-swarm: review-target-snapshot', '--no-verify'],
        { cwd: base.worktree_path },
      )
      if (snapRes.ok) {
        const rev = await runGit(['rev-parse', 'HEAD'], { cwd: base.worktree_path })
        if (rev.ok) reviewBaseline = rev.stdout.trim()
      }
    }
  }

  return {
    ...base,
    baseline_commit: reviewBaseline,
  }
}

// #FUNC Commit pending edits inside a worker's isolated worktree to produce an immutable `commitSha` per submission round without altering `baselineCommit`.
// #NOT  Never commits to `mainCwd` (`inherit` mode) and never alters `baselineCommit` used by `swarm_land`.
// #EDGE-IN Submitting a worker report creates a new `commitSha` while `diffWorktree` against `baselineCommit` still measures the full cumulative patch → test_isolated_review_worktree_catches_rogue_writes_and_blind_projection
// #WHY  Giving each submission an immutable `commitSha` lets blind reviewers run `git diff prev..curr` and `git diff baseline..curr` without ever reading worker prose.
export async function snapshotWorktreeCommit({ worktreePath, baselineCommit, label = 'worker' }) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { ok: false, error: 'worktree path does not exist' }
  }
  const prevRes = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: worktreePath })
  const prevCommitSha = prevRes.ok ? prevRes.stdout.trim() : null

  const statusRes = await runGit(['status', '--porcelain'], { cwd: worktreePath })
  let commitSha = prevCommitSha
  if (statusRes.ok && statusRes.stdout.trim().length > 0) {
    await runGit(['add', '-A'], { cwd: worktreePath })
    const commitRes = await runGit(
      ['-c', 'user.name=dsh-swarm', '-c', 'user.email=swarm@local', 'commit', '-m', `dsh-swarm snapshot: ${label}`, '--no-verify'],
      { cwd: worktreePath },
    )
    if (commitRes.ok) {
      const nextRes = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: worktreePath })
      if (nextRes.ok) commitSha = nextRes.stdout.trim()
    }
  }

  const diff = await diffWorktree({ worktreePath, baselineCommit })
  const hygieneFlags = diff.ok ? scanPatchHygiene(diff.patch) : []
  return {
    ok: diff.ok,
    commitSha,
    prevCommitSha,
    baselineCommit: baselineCommit || prevCommitSha,
    diffHash: diff.diffHash,
    hasChanges: diff.hasChanges,
    files: diff.files,
    patch: diff.patch,
    hygieneFlags,
    ...(diff.ok ? {} : { error: diff.error }),
  }
}

/**
 * Compute the pure incremental diff produced by the worker inside its worktree
 * relative to `baselineCommit` (including any untracked files the worker created).
 */
export async function diffWorktree({ worktreePath, baselineCommit }) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { ok: false, hasChanges: false, files: [], patch: '', error: 'worktree path does not exist' }
  }
  await runGit(['add', '-N', '.'], { cwd: worktreePath })
  const ref = baselineCommit || 'HEAD'
  const nameRes = await runGit(['diff', '--name-status', ref], { cwd: worktreePath })
  const diffRes = await runGit(['diff', '--binary', ref], { cwd: worktreePath })

  const files = nameRes.ok
    ? nameRes.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    : []
  const patch = diffRes.ok ? diffRes.stdout : ''
  const diffHash = diffRes.ok
    ? createHash('sha256').update(patch, 'utf8').digest('hex').slice(0, 16)
    : null

  return {
    ok: diffRes.ok,
    hasChanges: files.length > 0 || patch.trim().length > 0,
    files,
    patch,
    diffHash,
    ...(diffRes.ok ? {} : { error: diffRes.stderr.trim() }),
  }
}

// #FUNC Verify and apply a worker's incremental worktree patch onto `mainCwd` (`swarm_land`).
// #NOT  Never forces a partial apply: runs `git apply --check` first so conflicts leave `mainCwd` untouched.
// #EDGE-OUT Conflicting edits between `mainCwd` and the worker worktree fail preflight cleanly → test_worktree_land_conflict_preflight
// #WHY  `--check` guarantees all-or-nothing patch landing into the user's primary working tree.
export async function landWorktree({ mainCwd, worktreePath, baselineCommit, action = 'diff' }) {
  const diff = await diffWorktree({ worktreePath, baselineCommit })
  if (!diff.ok) return diff
  if (action === 'diff') {
    return {
      ok: true,
      action: 'diff',
      hasChanges: diff.hasChanges,
      files: diff.files,
      patch: diff.patch,
      diffHash: diff.diffHash,
    }
  }
  if (!diff.hasChanges) {
    return {
      ok: true,
      action: 'apply',
      applied: false,
      files: [],
      message: 'No incremental edits in this worktree; nothing to land.',
    }
  }

  const checkRes = await runGit(['-c', 'core.autocrlf=false', 'apply', '--check', '--whitespace=nowarn', '-'], {
    cwd: mainCwd,
    input: diff.patch,
  })
  if (!checkRes.ok) {
    const threeWayRes = await runGit(['-c', 'core.autocrlf=false', 'apply', '--3way', '--check', '--whitespace=nowarn', '-'], {
      cwd: mainCwd,
      input: diff.patch,
    })
    const diagText = `${checkRes.stderr.trim()}${threeWayRes.ok ? ' (3-way merge looks clean)' : (threeWayRes.stderr.trim() ? ' | 3-way: ' + threeWayRes.stderr.trim() : '')}`
    return {
      ok: false,
      action: 'apply',
      applied: false,
      files: diff.files,
      threeWayClean: threeWayRes.ok,
      error: `Merge preflight (git apply --check) detected conflicts; main workspace left untouched: ${diagText}`,
    }
  }

  const applyRes = await runGit(['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', '-'], {
    cwd: mainCwd,
    input: diff.patch,
  })
  if (!applyRes.ok) {
    return {
      ok: false,
      action: 'apply',
      applied: false,
      files: diff.files,
      error: `Failed to apply patch: ${applyRes.stderr.trim()}`,
    }
  }

  return {
    ok: true,
    action: 'apply',
    applied: true,
    files: diff.files,
    message: `Successfully landed changes across ${diff.files.length} file(s) into main workspace.`,
  }
}

// dup-ok: worktree teardown counterpart to createIsolatedWorktree
/** Remove an isolated worktree after checking for unmerged changes (unless `force: true`). */
export async function removeIsolatedWorktree({ mainCwd, worktreePath, baselineCommit, force = false }) {
  if (!worktreePath || worktreePath === mainCwd || !fs.existsSync(worktreePath)) {
    return { ok: true, removed: false }
  }
  if (!force) {
    const diff = await diffWorktree({ worktreePath, baselineCommit })
    if (diff.hasChanges) {
      return {
        ok: false,
        unmerged: true,
        files: diff.files,
        error: `Worktree (${worktreePath}) still has ${diff.files.length} unmerged file change(s): ${diff.files.join(', ')}`,
      }
    }
  }
  await runGit(['worktree', 'remove', '--force', worktreePath], { cwd: mainCwd })
  fs.rmSync(worktreePath, { recursive: true, force: true })
  return { ok: true, removed: true }
}
