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

  return {
    ok: true,
    workspace_mode: mode,
    worktree_path: targetDir,
    base_commit: headSha,
    baseline_commit: baselineCommit,
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
    return {
      ok: false,
      action: 'apply',
      applied: false,
      files: diff.files,
      error: `Merge preflight (git apply --check) detected conflicts; main workspace left untouched: ${checkRes.stderr.trim()}`,
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
