// Comprehensive smoke & guardrail test suite for `dsh-swarm`.
//
// Executes real file I/O, real git worktree commands, real tool executions,
// real concurrency semaphore queueing/AIMD/abort, real Stop-Hook race lock,
// real `@monitor` stall detection, and real classic-script evaluation of `client.js`.
//
// Every test function name matches the exact `→ test_...` edge tag in the
// source files so `check-function-comments.py` can verify 100% edge coverage.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  SwarmStore,
  SwarmStateProjector,
  writeJsonAtomicSync,
  readJsonSync,
  replayChannelsAt,
  replaySwarmEvents,
} from '../src/host/store.js'
import {
  validateSwarmInit,
  validateSwarmAdd,
  validatePostBoard,
  validateSwarmWait,
} from '../src/host/validators.js'
import { ConcurrencyGate, PRIORITY } from '../src/host/concurrency-gate.js'
import { handleTurnStopping, statusOf } from '../src/host/stop-hook.js'
import {
  runGit,
  createIsolatedWorktree,
  diffWorktree,
  landWorktree,
  removeIsolatedWorktree,
} from '../src/host/worktree.js'
import { detectSwarmStall, SwarmMonitorDaemon } from '../src/host/monitor.js'
import { toLosslessJson } from '../src/host/tools.js'
import { applyWith, PLUGIN_VERSION } from '../index.js'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-swarm-smoke-'))
const results = []

async function runTest(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('ok   ' + name)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.error('FAIL ' + name + ': ' + (error?.stack ?? error))
  }
}

// ---------------------------------------------------------------------------
// 1. Three-file blackboard store & event-sourced channels
// ---------------------------------------------------------------------------

async function test_atomic_store_roundtrip() {
  const file = path.join(tempRoot, 'atomic', 'test.json')
  await Promise.all([
    Promise.resolve().then(() => writeJsonAtomicSync(file, { step: 1 })),
    Promise.resolve().then(() => writeJsonAtomicSync(file, { step: 2 })),
  ])
  const data = readJsonSync(file)
  assert.equal(data.step, 2)
}

async function test_init_preserves_existing_board() {
  const store = new SwarmStore(path.join(tempRoot, 'store-preserve'))
  store.initSwarm('s1', { title: 'Wave 1', concurrency_limit: 2, concurrency_confirmed: true })
  store.appendBoardRecord('s1', {
    type: 'post',
    agent: 'coordinator',
    text: '@all hello #1',
    mentions: ['all'],
  })
  store.initSwarm('s1', { title: 'Wave 2 Updated', concurrency_limit: 4, concurrency_confirmed: true })
  assert.equal(store.readSwarm('s1').title, 'Wave 2 Updated')
  assert.equal(store.readSwarm('s1').concurrency_limit, 4)
  assert.equal(store.headSeq('s1'), 1)
}

async function test_event_sourced_channels_replay() {
  const store = new SwarmStore(path.join(tempRoot, 'store-channels'))
  store.initSwarm('s-ch', { title: 'Channels', concurrency_confirmed: true })
  store.registerMemberWithBrief('s-ch', {
    name: 'parser',
    session_id: 'sess-parser',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })
  // seq 2: create #render
  store.appendBoardRecord('s-ch', { type: 'control', action: 'channel.create', agent: 'coordinator', channel: 'render' })
  // seq 3: subscribe parser to #render
  store.appendBoardRecord('s-ch', { type: 'control', action: 'channel.subscribe', agent: 'coordinator', channel: 'render', target: 'parser' })
  // seq 4: archive #render
  store.appendBoardRecord('s-ch', { type: 'control', action: 'channel.archive', agent: 'coordinator', channel: 'render' })

  const records = store.readBoard('s-ch')
  const at3 = replayChannelsAt(records, 3)
  assert.deepEqual(at3.channels.sort(), ['main', 'render'])
  assert.deepEqual(at3.subscriptionsOf('parser').sort(), ['main', 'render'])

  const at4 = replayChannelsAt(records, 4)
  assert.deepEqual(at4.channels, ['main'])
  assert.deepEqual(at4.subscriptionsOf('parser'), ['main'])
}

async function test_post_board_group_and_cursor() {
  const store = new SwarmStore(path.join(tempRoot, 'store-group'))
  store.initSwarm('s-grp', { title: 'Group test', concurrency_confirmed: true })
  store.registerMemberWithBrief('s-grp', {
    name: 'fix-1',
    session_id: 's-fix-1',
    group: 'fix',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })
  store.registerMemberWithBrief('s-grp', {
    name: 'fix-2',
    session_id: 's-fix-2',
    group: 'fix',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })
  const post = store.appendBoardRecord('s-grp', {
    type: 'post',
    agent: 'coordinator',
    mentions: ['fix'],
    text: '@fix please check #1 and #2',
  })
  const targets = store.resolveTargetsForPost('s-grp', post)
  assert.deepEqual(targets.sort(), ['fix-1', 'fix-2'])
  assert.equal(store.readMembers('s-grp').coordinator.last_post_seq, post.seq)
}

async function test_new_worker_cursor_skips_opening_noise() {
  const store = new SwarmStore(path.join(tempRoot, 'store-opening'))
  store.initSwarm('s-open', { title: 'Opening skip', concurrency_confirmed: true })
  store.registerMemberWithBrief('s-open', {
    name: 'pdf-pipeline',
    session_id: 's-pdf',
    role: 'worker',
    brief: '[OWNERSHIP] pdf\n[FORBIDDEN] dom\n[DONE_CRITERIA] test',
  })
  store.registerMemberWithBrief('s-open', {
    name: 'template-dom',
    session_id: 's-dom',
    role: 'worker',
    brief: '[OWNERSHIP] dom\n[FORBIDDEN] pdf\n[DONE_CRITERIA] test',
  })
  store.registerMemberWithBrief('s-open', {
    name: 'verifier',
    session_id: 's-ver',
    role: 'verifier',
    brief: '[OWNERSHIP] test\n[FORBIDDEN] src\n[DONE_CRITERIA] verify',
  })
  const members = store.readMembers('s-open')
  // All 3 opening members should have their `last_read_seq` set to 3 so none of them wastes tokens reading the other two opening briefs!
  assert.equal(members['pdf-pipeline'].last_read_seq, 3)
  assert.equal(members['template-dom'].last_read_seq, 3)
  assert.equal(members.verifier.last_read_seq, 3)
}

async function test_plan_json_size_guard() {
  const store = new SwarmStore(path.join(tempRoot, 'store-plan'))
  store.initSwarm('s-plan', { title: 'Plan Guard', concurrency_confirmed: true })
  store.writePlan('s-plan', { goal: 'Valid plan', current_wave: 1, waves: [], tracks: [] })
  assert.throws(() => {
    store.writePlan('s-plan', { goal: 'x'.repeat(70_000) })
  }, /exceeds 64 KB/)
  assert.equal(store.readPlan('s-plan').goal, 'Valid plan')
}

// ---------------------------------------------------------------------------
// 2. Strict format & semantic validators for glm5.3 / deepseek4.1f
// ---------------------------------------------------------------------------

async function test_validator_rejects_excessive_concurrency() {
  const bad = validateSwarmInit({ title: 'Invalid swarm', concurrency_limit: 0 })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /positive integer/i)

  // High concurrency and large worker batch (no artificial cap) must succeed
  const high = validateSwarmInit({ title: 'Large parallel swarm', concurrency_limit: 16 })
  assert.equal(high.ok, true)
  assert.equal(high.value.concurrency_limit, 16)

  const batchAdd = validateSwarmAdd(
    {
      name: 'shard',
      n: 10,
      role: 'worker',
      workspace: 'inherit',
      brief: '[OWNERSHIP] src/\n[FORBIDDEN] dist/\n[DONE_CRITERIA] test',
    },
    { concurrency_confirmed: true, concurrency_limit: 2 },
    {},
  )
  assert.equal(batchAdd.ok, true)
  assert.equal(batchAdd.value.targetNames.length, 10)
}

async function test_validator_blocks_add_before_concurrency_confirmed() {
  const res = validateSwarmAdd(
    { name: 'worker-1', brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c' },
    { concurrency_confirmed: false, concurrency_limit: 2 },
    {},
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /ask_user_question/)
}

async function test_validator_rejects_killed_name_reuse() {
  const res = validateSwarmAdd(
    { name: 'arch-1', role: 'architect', brief: '[OWNERSHIP] docs/\n[FORBIDDEN] src/\n[DONE_CRITERIA] adr' },
    { concurrency_confirmed: true, concurrency_limit: 3 },
    { 'arch-1': { killed: true, role: 'architect' } },
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /arch-2/)

  const monRes = validateSwarmAdd(
    { name: 'watcher', role: 'monitor', brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c' },
    { concurrency_confirmed: true, concurrency_limit: 3 },
    {},
  )
  assert.equal(monRes.ok, false)
  assert.match(monRes.error, /Watchdog/)
}

async function test_validator_enforces_three_part_brief() {
  const res = validateSwarmAdd(
    { name: 'fixer-1', role: 'worker', brief: 'Just fix the bug please' },
    { concurrency_confirmed: true, concurrency_limit: 3 },
    {},
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /\[OWNERSHIP\]/)
  assert.match(res.error, /\[FORBIDDEN\]/)
  assert.match(res.error, /\[DONE_CRITERIA\]/)
}

async function test_validator_rejects_unaddressed_worker_post() {
  const members = {
    coordinator: { role: 'coordinator', killed: false },
    'worker-1': { role: 'worker', killed: false, last_read_seq: 2 },
    verifier: { role: 'verifier', killed: false },
  }
  const res = validatePostBoard(
    { title: 'Template check findings ready', text: 'I finished checking the templates and found a bug.' },
    members,
    'worker-1',
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /must address at least one recipient/)
}

async function test_validator_rejects_channel_main_broadcast() {
  const members = { coordinator: { role: 'coordinator', killed: false } }
  const res = validatePostBoard(
    { title: 'Broadcast to main channel test', text: 'Hello @#main everyone wake up!' },
    members,
    'coordinator',
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /Forbidden @#main/)
}

async function test_validator_rejects_mentioning_killed_member() {
  const members = {
    coordinator: { role: 'coordinator', killed: false },
    'old-worker': { role: 'worker', killed: true },
    'new-worker': { role: 'worker', killed: false },
  }
  const res = validatePostBoard(
    { title: 'Follow-up check on dead worker', text: '@old-worker please check this', mentions: ['old-worker'] },
    members,
    'coordinator',
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /retired \(killed\)/)
}

async function test_validator_blocks_wait_ahead_of_last_read_seq() {
  const res = validateSwarmWait(
    { since: 15, mentions_only: true },
    { last_read_seq: 10 },
    15,
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /read_board/)
}

// ---------------------------------------------------------------------------
// 3. ConcurrencyGate: priority ordering, bounds, AbortSignal, AIMD
// ---------------------------------------------------------------------------

async function test_concurrency_gate_abort_releases_waiter() {
  const gate = new ConcurrencyGate({ limit: 1, minSpacingMs: 0 })
  const lease1 = await gate.acquire({ agentId: 'a1', priority: PRIORITY.WORKER })
  const ac = new AbortController()
  const p2 = gate.acquire({ agentId: 'a2', priority: PRIORITY.WORKER, signal: ac.signal })
  assert.equal(gate.snapshot().queued, 1)
  ac.abort(new Error('user_cancelled'))
  await assert.rejects(p2, /user_cancelled/)
  assert.equal(gate.snapshot().queued, 0)
  lease1.release()
  assert.equal(gate.snapshot().active, 0)
}

async function test_concurrency_gate_priority_and_bounds() {
  const gate = new ConcurrencyGate({ limit: 2, minSpacingMs: 0 })
  const l1 = await gate.acquire({ agentId: 'w1', priority: PRIORITY.WORKER })
  const l2 = await gate.acquire({ agentId: 'w2', priority: PRIORITY.WORKER })
  assert.equal(gate.snapshot().active, 2)

  const order = []
  const pMonitor = gate.acquire({ agentId: 'm1', priority: PRIORITY.MONITOR }).then((l) => { order.push('monitor'); l.release() })
  const pWorker = gate.acquire({ agentId: 'w3', priority: PRIORITY.WORKER }).then((l) => { order.push('worker'); l.release() })
  const pVerifier = gate.acquire({ agentId: 'v1', priority: PRIORITY.VERIFIER }).then((l) => { order.push('verifier'); l.release() })
  const pCoord = gate.acquire({ agentId: 'c1', priority: PRIORITY.COORDINATOR }).then((l) => { order.push('coordinator'); l.release() })

  l1.release()
  l2.release()
  await Promise.all([pMonitor, pWorker, pVerifier, pCoord])
  assert.deepEqual(order, ['coordinator', 'verifier', 'worker', 'monitor'])
  assert.equal(gate.snapshot().active, 0)
}

async function test_concurrency_gate_aimd_backoff_and_recovery() {
  const gate = new ConcurrencyGate({ limit: 4, minSpacingMs: 0, increaseAfterSuccesses: 2, cooldownMs: 10 })
  assert.equal(gate.snapshot().effectiveLimit, 4)
  gate.onRateLimited(10)
  assert.equal(gate.snapshot().effectiveLimit, 2)
  gate.onSuccess()
  gate.onSuccess()
  assert.equal(gate.snapshot().effectiveLimit, 3)
  gate.onSuccess()
  gate.onSuccess()
  assert.equal(gate.snapshot().effectiveLimit, 4)
}

// ---------------------------------------------------------------------------
// 4. Stop Hook race lock & Transcript Liveness
// ---------------------------------------------------------------------------

async function test_stop_hook_blocks_on_race_message() {
  const store = new SwarmStore(path.join(tempRoot, 'stop-hook-race'))
  store.initSwarm('s-race', { title: 'Race Test', concurrency_confirmed: true })
  store.registerMemberWithBrief('s-race', {
    name: 'fixer-templates',
    session_id: 'sess-ft',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })
  // Suppose fixer-templates read up to #1 and called swarm_wait(1), but right before turn-stopping, #2 arrived mentioning @fixer-templates!
  store.appendBoardRecord('s-race', {
    type: 'post',
    agent: 'verifier',
    mentions: ['fixer-templates'],
    text: '@fixer-templates found an issue in #1',
  })

  const steered = []
  const fakeAgent = {
    id: 'sess-ft',
    steer(msg) { steered.push(msg) },
  }
  const outcome = handleTurnStopping({
    store,
    swarmId: 's-race',
    memberName: 'fixer-templates',
    agent: fakeAgent,
    turnState: { calledSwarmWait: true, unparkedBlockCount: 0 },
  })

  assert.equal(outcome.blocked, true)
  assert.equal(outcome.reason, 'unread_messages')
  assert.equal(outcome.last_park_blocked_seq, 2)
  assert.equal(store.readMembers('s-race')['fixer-templates'].last_park_blocked_seq, 2)
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /Stop hook: unread/)
}

async function test_stop_hook_catches_worker_forgetting_swarm_wait() {
  const store = new SwarmStore(path.join(tempRoot, 'stop-hook-unparked'))
  store.initSwarm('s-unpark', { title: 'Unparked Test', concurrency_confirmed: true })
  store.registerMemberWithBrief('s-unpark', {
    name: 'lazy-worker',
    session_id: 'sess-lazy',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })

  const steered = []
  const fakeAgent = { id: 'sess-lazy', steer(msg) { steered.push(msg) } }
  const turnState = { calledSwarmWait: false, unparkedBlockCount: 0 }

  const res1 = handleTurnStopping({
    store,
    swarmId: 's-unpark',
    memberName: 'lazy-worker',
    agent: fakeAgent,
    turnState,
    maxUnparkedBlocks: 1,
  })
  assert.equal(res1.blocked, true)
  assert.equal(res1.reason, 'missing_swarm_wait')

  // Second time in the same turn is not blocked so a broken model cannot infinite-loop
  const res2 = handleTurnStopping({
    store,
    swarmId: 's-unpark',
    memberName: 'lazy-worker',
    agent: fakeAgent,
    turnState,
    maxUnparkedBlocks: 1,
  })
  assert.equal(res2.blocked, false)
}

async function test_liveness_reads_transcript_over_wake_mode() {
  const member = {
    session_id: 'sess-w1',
    role: 'worker',
    wake_mode: 'mentions', // Stale wake_mode in members.json
    wait_since: 5,
    killed: false,
  }
  const sessionEvents = [
    { type: 'turn/start', seq: 10 },
    { type: 'step/start', seq: 11 },
    { type: 'tool/call', seq: 12, data: { name: 'bash', arguments: '{"command":"pytest tests/"}' } },
  ]
  const live = statusOf(member, {
    liveAgent: { status: 'running' },
    sessionEvents,
  })
  assert.equal(live.status, 'working')
  assert.match(live.stepSummary, /bash:/)
}

// ---------------------------------------------------------------------------
// 5. Git Worktree isolation, dirty working-tree sync, and conflict preflight
// ---------------------------------------------------------------------------

async function test_worktree_git_no_shell_spawn() {
  const res = await runGit(['--version'], { cwd: tempRoot })
  assert.equal(res.ok, true)
  assert.match(res.stdout, /git version/)
}

async function test_worktree_syncs_dirty_files_and_isolates_worker_diff() {
  const repoDir = path.join(tempRoot, 'git-repo-dirty')
  const wtRoot = path.join(tempRoot, 'wt-root')
  fs.mkdirSync(repoDir, { recursive: true })

  await runGit(['init'], { cwd: repoDir })
  await runGit(['config', 'user.name', 'Test'], { cwd: repoDir })
  await runGit(['config', 'user.email', 'test@local'], { cwd: repoDir })
  fs.writeFileSync(path.join(repoDir, 'base.txt'), 'line1\n', 'utf8')
  await runGit(['add', 'base.txt'], { cwd: repoDir })
  await runGit(['commit', '-m', 'initial'], { cwd: repoDir })

  // Make dirty uncommitted changes in mainCwd (modified + untracked)
  fs.writeFileSync(path.join(repoDir, 'base.txt'), 'line1\ndirty-user-edit\n', 'utf8')
  fs.writeFileSync(path.join(repoDir, 'untracked-user.txt'), 'user-untracked\n', 'utf8')

  const wt = await createIsolatedWorktree({
    mainCwd: repoDir,
    worktreesRoot: wtRoot,
    swarmId: 'sw-wt',
    memberName: 'fixer-1',
    mode: 'share',
  })
  assert.equal(wt.ok, true)
  // Verify the worker sees the user's dirty edits
  assert.equal(fs.readFileSync(path.join(wt.worktree_path, 'base.txt'), 'utf8'), 'line1\ndirty-user-edit\n')
  assert.equal(fs.readFileSync(path.join(wt.worktree_path, 'untracked-user.txt'), 'utf8'), 'user-untracked\n')

  // Before the worker makes any edits, worker incremental diff must be EMPTY!
  const emptyDiff = await diffWorktree({
    worktreePath: wt.worktree_path,
    baselineCommit: wt.baseline_commit,
  })
  assert.equal(emptyDiff.hasChanges, false)

  // Now the worker edits `worker-fix.txt`
  fs.writeFileSync(path.join(wt.worktree_path, 'worker-fix.txt'), 'fixed-by-worker\n', 'utf8')
  const workerDiff = await diffWorktree({
    worktreePath: wt.worktree_path,
    baselineCommit: wt.baseline_commit,
  })
  assert.equal(workerDiff.hasChanges, true)
  assert.equal(workerDiff.files.some(f => f.includes('worker-fix.txt')), true)
  assert.equal(workerDiff.files.some(f => f.includes('untracked-user.txt')), false)

  // Unmerged kill must be blocked without force
  const blockedKill = await removeIsolatedWorktree({
    mainCwd: repoDir,
    worktreePath: wt.worktree_path,
    baselineCommit: wt.baseline_commit,
    force: false,
  })
  assert.equal(blockedKill.ok, false)
  assert.equal(blockedKill.unmerged, true)

  // Land worker's changes back into mainCwd
  const landRes = await landWorktree({
    mainCwd: repoDir,
    worktreePath: wt.worktree_path,
    baselineCommit: wt.baseline_commit,
    action: 'apply',
  })
  assert.equal(landRes.ok, true)
  assert.equal(fs.readFileSync(path.join(repoDir, 'worker-fix.txt'), 'utf8'), 'fixed-by-worker\n')

  // Cleanup worktree
  const cleanRm = await removeIsolatedWorktree({
    mainCwd: repoDir,
    worktreePath: wt.worktree_path,
    baselineCommit: wt.baseline_commit,
    force: true,
  })
  assert.equal(cleanRm.ok, true)
}

async function test_worktree_land_conflict_preflight() {
  const repoDir = path.join(tempRoot, 'git-repo-conflict')
  const wtRoot = path.join(tempRoot, 'wt-conflict-root')
  fs.mkdirSync(repoDir, { recursive: true })

  await runGit(['init'], { cwd: repoDir })
  await runGit(['config', 'user.name', 'Test'], { cwd: repoDir })
  await runGit(['config', 'user.email', 'test@local'], { cwd: repoDir })
  fs.writeFileSync(path.join(repoDir, 'shared.txt'), 'original\n', 'utf8')
  await runGit(['add', 'shared.txt'], { cwd: repoDir })
  await runGit(['commit', '-m', 'init'], { cwd: repoDir })

  const wt = await createIsolatedWorktree({
    mainCwd: repoDir,
    worktreesRoot: wtRoot,
    swarmId: 'sw-conflict',
    memberName: 'fixer-c',
    mode: 'share',
  })
  fs.writeFileSync(path.join(wt.worktree_path, 'shared.txt'), 'worker-version\n', 'utf8')
  // Simultaneously modify shared.txt in mainCwd to cause a conflict
  fs.writeFileSync(path.join(repoDir, 'shared.txt'), 'conflicting-main-version\n', 'utf8')

  const landRes = await landWorktree({
    mainCwd: repoDir,
    worktreePath: wt.worktree_path,
    baselineCommit: wt.baseline_commit,
    action: 'apply',
  })
  assert.equal(landRes.ok, false)
  // Verify mainCwd was NOT corrupted
  assert.equal(fs.readFileSync(path.join(repoDir, 'shared.txt'), 'utf8'), 'conflicting-main-version\n')
  await removeIsolatedWorktree({ mainCwd: repoDir, worktreePath: wt.worktree_path, force: true })
}

// ---------------------------------------------------------------------------
// 6. Anti-deadlock `@monitor` watchdog
// ---------------------------------------------------------------------------

async function test_monitor_uses_last_post_seq_not_wait_since() {
  const store = new SwarmStore(path.join(tempRoot, 'monitor-post-seq'))
  store.initSwarm('s-mon1', { title: 'Monitor Test', concurrency_confirmed: true })
  store.registerMemberWithBrief('s-mon1', {
    name: 'fixer-templates',
    session_id: 's-ft',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })
  // Simulate a failed turn that advanced wait_since to 1, while last_post_seq is still 0
  store.updateMember('s-mon1', 'fixer-templates', m => ({ ...m, wait_since: 1, last_post_seq: 0 }))

  const diag = detectSwarmStall({
    store,
    swarmId: 's-mon1',
    getMemberLiveness: () => ({ status: 'waiting', stepSummary: null }),
  })
  assert.equal(diag.stalled, true)
  assert.equal(diag.kind, 'mentioned_silent')
  assert.equal(diag.target, 'fixer-templates')
}

async function test_monitor_skips_when_member_queued_for_concurrency() {
  const store = new SwarmStore(path.join(tempRoot, 'monitor-queued'))
  store.initSwarm('s-mon2', { title: 'Monitor Queue Test', concurrency_confirmed: true })
  store.registerMemberWithBrief('s-mon2', {
    name: 'fixer-1',
    session_id: 's-f1',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })

  const diag = detectSwarmStall({
    store,
    swarmId: 's-mon2',
    getMemberLiveness: () => ({ status: 'queued', stepSummary: 'Waiting for slot #1' }),
  })
  assert.equal(diag.stalled, false)
  assert.equal(diag.reason, 'member_busy_or_queued')
}

async function test_monitor_three_strike_cap_and_auto_sleep() {
  const store = new SwarmStore(path.join(tempRoot, 'monitor-3strike'))
  store.initSwarm('s-mon3', { title: 'Monitor 3 Strike', concurrency_confirmed: true })
  store.registerMemberWithBrief('s-mon3', {
    name: 'silent-worker',
    session_id: 's-sw',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })

  const nudges = []
  const daemon = new SwarmMonitorDaemon({
    store,
    swarmId: 's-mon3',
    intervalMs: 60_000,
    getMemberLiveness: () => ({ status: 'waiting', stepSummary: null }),
    onPostStall: async (info) => { nudges.push(info) },
  })

  await daemon.tick()
  await daemon.tick()
  const third = await daemon.tick()
  assert.equal(nudges.length, 3)
  // 3rd strike escalates to coordinator
  assert.equal(third.target, 'coordinator')
  // 4th and 5th ticks suppress duplicate nudges and auto-sleep on tick 5
  const fourth = await daemon.tick()
  assert.equal(fourth.action, 'suppressed_duplicate')
  const fifth = await daemon.tick()
  assert.equal(fifth.action, 'auto_slept_after_max_nudges')
  assert.equal(daemon.sleeping, true)
}

// ---------------------------------------------------------------------------
// 7. End-to-end Host tools (`swarm_wait` concludesTurn) & Browser Client half
// ---------------------------------------------------------------------------

async function test_swarm_wait_concludes_turn() {
  const registeredTools = new Map()
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') {
        return {
          register(t) { registeredTools.set(t.name, t); return () => {} },
        }
      }
      return undefined
    },
  }
  applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-tools') }, { log: () => {}, warn: () => {} })

  const callerAgent = { id: 'sess-coord-1', session: { header: { id: 'sess-coord-1', cwd: tempRoot } } }
  const initRes = await registeredTools.get('swarm_init').execute(
    { title: 'E2E Swarm', concurrency_limit: 3, default_model: 'deepseek4.1f' },
    { agent: callerAgent },
  )
  assert.equal(initRes.ok, true)

  const addRes = await registeredTools.get('swarm_add').execute(
    {
      name: 'verifier',
      role: 'verifier',
      workspace: 'inherit',
      brief: '[OWNERSHIP] tests/\n[FORBIDDEN] src/\n[DONE_CRITERIA] run pytest',
    },
    { agent: callerAgent },
  )
  assert.equal(addRes.ok, true)

  // Read board first so coordinator's last_read_seq is up to date
  const readRes = await registeredTools.get('read_board').execute({}, { agent: callerAgent })
  assert.equal(readRes.ok, true)

  let turnConcluded = false
  const waitRes = await registeredTools.get('swarm_wait').execute(
    { since: readRes.last_read_seq, mentions_only: true },
    {
      agent: callerAgent,
      concludeTurn() { turnConcluded = true },
    },
  )
  assert.equal(waitRes.ok, true)
  assert.equal(waitRes.status, 'DONE')
  assert.equal(turnConcluded, true)
}

async function test_host_sibling_event_liveness() {
  const listeners = new Map()
  const fakeCtx = {
    on(ev, fn) {
      listeners.set(ev, fn)
      return () => listeners.delete(ev)
    },
    effect(fn) { return fn() },
    get() { return undefined },
  }
  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-liveness') }, { log: () => {}, warn: () => {} })
  runtime.store.initSwarm('s-live', { title: 'Live', concurrency_confirmed: true })
  runtime.store.registerMemberWithBrief('s-live', {
    name: 'worker-a',
    session_id: 'sess-wa',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })

  const handler = listeners.get('session/event')
  handler({ id: 'sess-wa' }, { type: 'turn/start', seq: 1 })
  handler({ id: 'sess-wa' }, { type: 'tool/call', seq: 2, data: { name: 'read_file', arguments: '{"path":"a.js"}' } })

  const liveness = runtime.getMemberLiveness('s-live', 'worker-a')
  assert.equal(liveness.status, 'working')
  assert.match(liveness.stepSummary, /read_file/)
}

// dup-ok: smoke test exercising client.js tokenizeBoardText
async function test_client_tokenize_board_text() {
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  let loadedMod = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          loadedMod = spec.factory(() => null)
        },
      },
    },
    console: { info() {}, warn() {}, error() {} },
    Set,
    Map,
    Object,
    Array,
    Number,
    String,
    Symbol,
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  assert.ok(loadedMod, 'client.js did not register with window.__ModuleLoader__')
  assert.deepEqual([...loadedMod.inject], ['slots'])

  const tokens = loadedMod.tokenizeBoardText('Please @verifier review #5 and #6 in @#render channel')
  assert.equal(tokens.some(t => t.kind === 'mention' && t.target === 'verifier'), true)
  assert.equal(tokens.some(t => t.kind === 'ref' && t.seq === 5), true)
  assert.equal(tokens.some(t => t.kind === 'ref' && t.seq === 6), true)
  assert.equal(tokens.some(t => t.kind === 'channel' && t.channel === 'render'), true)
}

async function test_client_graph_replay_aggregation() {
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  let loadedMod = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) { loadedMod = spec.factory(() => null) },
      },
    },
    console: { info() {}, warn() {}, error() {} },
    Set,
    Map,
    Object,
    Array,
    Number,
    String,
    Symbol,
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })

  const events = [
    { seq: 1, from: 'coordinator', to: 'worker-1', kind: 'brief' },
    { seq: 5, from: 'worker-1', to: 'verifier', kind: 'report' },
    { seq: 12, from: 'verifier', to: 'worker-1', kind: 'review' },
    { seq: 15, from: 'worker-1', to: 'verifier', kind: 'report' },
  ]
  const wave1 = loadedMod.computeGraphEdges(events, 6)
  assert.equal(wave1.edges.length, 2)
  const full = loadedMod.computeGraphEdges(events, 20)
  const w2v = full.edges.find(e => e.from === 'worker-1' && e.to === 'verifier')
  assert.equal(w2v.count, 2)
}

async function test_slash_command_and_rightbar_registration() {
  // 1. Verify Host ctx.inject(['commands']) and ctx.inject(['webServer'])
  let registeredCmd = null
  const registeredRoutes = new Map()
  const injectCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get() { return undefined },
    inject(deps, cb) {
      if (deps.includes('commands')) {
        cb({
          commands: {
            register(def) { registeredCmd = def; return () => {} },
          },
          effect(fn) { return fn() },
        })
      } else if (deps.includes('webServer')) {
        cb({
          webServer: {
            register(route) { registeredRoutes.set(route.path, route); return () => {} },
          },
          effect(fn) { return fn() },
        })
      }
    },
  }
  applyWith(injectCtx, { swarmDir: path.join(tempRoot, 'e2e-cmd-web') }, { log: () => {}, warn: () => {} })

  assert.ok(registeredCmd, '/swarm command must register via ctx.inject(["commands"])')
  assert.equal(registeredCmd.name, 'swarm')
  assert.ok(registeredCmd.input && typeof registeredCmd.input.hint === 'string', '/swarm must declare input.hint for the / menu')

  const steered = []
  const cmdRes = await registeredCmd.handler({
    rawInput: 'Fix PDF font export',
    attachments: [],
    agent: { id: 'sess-slash-1', steer(m) { steered.push(m) } },
  })
  assert.equal(cmdRes.kind, 'success')
  assert.equal(steered.length, 1)

  assert.equal(registeredRoutes.has('/api/dsh-swarm/state'), true)
  assert.equal(registeredRoutes.has('/api/dsh-swarm/action'), false, 'Browser UI must stay read-only; no /api/dsh-swarm/action route')

  // 2. Verify Client rightbar tab registration into sidebarRightTabs & sidebar.right.pane.tab
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  let loadedMod = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) { loadedMod = spec.factory(() => null) },
      },
    },
    console: { info() {}, warn() {}, error() {} },
    Set,
    Map,
    Object,
    Array,
    Number,
    String,
    Symbol,
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })

  const registeredTabs = []
  const registeredSlotKeys = []
  const mockSlots = {
    inject(_name, fn) { return fn() },
    register(spec) {
      registeredSlotKeys.push(`${spec.name}:${spec.key || spec.id}`)
      return () => {}
    },
  }
  const mockClientCtx = {
    slots: mockSlots,
    effect(fn) { return fn() },
    inject(deps, cb) {
      if (deps.includes('sidebarRightTabs')) {
        cb({
          slots: mockSlots,
          sidebarRightTabs: {
            register(def) { registeredTabs.push(def); return () => {} },
          },
          sidebarRight: {
            openTab() {},
            isExpanded() { return false },
            active() { return null },
          },
          effect(fn) { return fn() },
        })
      }
    },
  }
  loadedMod.apply(mockClientCtx)
  assert.equal(registeredTabs.length, 1)
  assert.equal(registeredTabs[0].id, 'dsh-swarm')
  assert.equal(registeredTabs[0].kind, 'swarm')
  assert.equal(registeredSlotKeys.includes('sidebar.right.pane.tab:dsh-swarm'), true)
  assert.equal(registeredSlotKeys.includes('sidebar.right.pane.tab.title:dsh-swarm'), true)
}

async function test_subagent_creation_inherits_real_model_preset_and_durable_address() {
  const parentEvents = []
  const childEvents = []
  let presetComposed = false
  let createdOptions = null

  const rootAgent = {
    id: 'session-parent-1',
    options: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', maxTokens: 384000 },
    ctx: {
      get(name) {
        if (name === 'agentPresets') {
          return {
            composedPreset() { return 'coding' },
          }
        }
        if (name === 'permissionPresets') {
          return { current() { return 'auto' } }
        }
        return undefined
      },
    },
    session: {
      header: { id: 'session-parent-1', cwd: tempRoot, delegationDepth: 0, agentPreset: 'coding' },
      requestHeader() {
        return { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', maxTokens: 384000 } }
      },
      append(type, data) {
        parentEvents.push({ type, data })
      },
    },
  }

  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'llm') {
        return {
          listProviders() { return [{ id: 'opencode-go', name: 'OpenCode Go' }] },
          async listModels() {
            return [
              { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
              { id: 'glm-5', name: 'GLM 5' },
            ]
          },
        }
      }
      if (name === 'agents') {
        return {
          get(id) { return id === rootAgent.id ? rootAgent : undefined },
          async create(opts) {
            createdOptions = opts
            const childAgent = {
              id: opts.sessionId,
              session: {
                header: { id: opts.sessionId, createdAt: 1700000000000, parentSession: rootAgent.id, origin: 'subagent' },
                append(type, data) { childEvents.push({ type, data }) },
              },
              steer() {},
            }
            const childCtx = {
              get(svc) {
                if (svc === 'agentPresets') {
                  return {
                    composeFrom(_cCtx, pCtx) {
                      if (pCtx === rootAgent.ctx) presetComposed = true
                    },
                  }
                }
                if (svc === 'systemPrompt') return { section() {} }
                if (svc === 'tools') return { restrict() {} }
                return undefined
              },
            }
            if (typeof opts.setup === 'function') opts.setup(childCtx, childAgent)
            return { agent: childAgent, async dispose() {} }
          },
        }
      }
      return undefined
    },
  }

  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-subagent-fix') }, { log: () => {}, warn: () => {} })
  runtime.store.initSwarm(rootAgent.id, {
    title: 'Real Model & Durable Address Test',
    concurrency_limit: 4,
    concurrency_confirmed: true,
  })
  const { member, briefPost } = runtime.store.registerMemberWithBrief(rootAgent.id, {
    name: 'engine-core',
    session_id: `${rootAgent.id}__engine-core`,
    role: 'worker',
    provider: 'internal', // Even if LLM hallucinated "internal", resolveModelRoute must fix it to "opencode-go"
    model: 'inherit',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })

  await runtime.spawnMemberAgent({
    swarmId: rootAgent.id,
    memberName: 'engine-core',
    member,
    briefPost,
    fullBrief: member.brief ?? '',
    rootAgent,
  })

  assert.equal(createdOptions.agentOptions.provider, 'opencode-go')
  assert.equal(createdOptions.agentOptions.model, 'deepseek-v4.1-flash')
  assert.equal(presetComposed, true, 'Child agent must compose parent agentPreset so write/bash tools exist')
  assert.equal(childEvents.some(e => e.type === 'subagent/descriptor' && e.data.version === 3 && e.data.mode === 'continuable'), true)
  assert.equal(parentEvents.some(e => e.type === 'subagent/catalog' && e.data.childId === `${rootAgent.id}__engine-core` && e.data.mode === 'continuable'), true)
}

async function test_r0_to_r8_error_observability_monitor_deps_and_archive() {
  const listeners = new Map()
  const registeredTools = new Map()
  const fakeCtx = {
    on(ev, fn) {
      listeners.set(ev, fn)
      return () => listeners.delete(ev)
    },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') {
        return {
          register(t) { registeredTools.set(t.name, t); return () => {} },
        }
      }
      return undefined
    },
  }

  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-r0-r8') }, { log: () => {}, warn: () => {} })
  const callerAgent = {
    id: 'sess-r0',
    options: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    session: { header: { id: 'sess-r0', cwd: tempRoot } },
  }

  // R0 & R1: swarm_init prints runtime fingerprint and resolves real route from parent options even when llm is absent
  const initRes = await registeredTools.get('swarm_init').execute(
    { title: 'R0-R8 Test', concurrency_limit: 4, default_provider: 'internal', default_model: 'inherit' },
    { agent: callerAgent },
  )
  assert.equal(initRes.ok, true)
  assert.ok(initRes.text.includes(`dsh-swarm v${PLUGIN_VERSION}`))
  assert.equal(initRes.swarm.default_provider, 'opencode-go')
  assert.equal(initRes.swarm.default_model, 'deepseek-v4.1-flash')

  // R6: @monitor can be mentioned in post_board;
  // verifier waiting on a silent worker must NOT be false-flagged as stalled!
  runtime.store.registerMemberWithBrief('sess-r0', {
    name: 'worker-1',
    session_id: 'sess-r0__worker-1',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })
  runtime.store.registerMemberWithBrief('sess-r0', {
    name: 'verifier-1',
    session_id: 'sess-r0__verifier-1',
    role: 'verifier',
    brief: '[OWNERSHIP] test\n[FORBIDDEN] src\n[DONE_CRITERIA] wait for worker-1 report',
  })

  const stallWhileWorkerSilent = detectSwarmStall({
    store: runtime.store,
    swarmId: 'sess-r0',
    getMemberLiveness: (name, m) => runtime.getMemberLiveness('sess-r0', name, m),
  })
  assert.equal(stallWhileWorkerSilent.stalled, true)
  assert.equal(stallWhileWorkerSilent.target, 'worker-1', 'Verifier must not be blamed while worker-1 has last_post_seq=0')

  const mentionMonitorCheck = validatePostBoard(
    { title: 'Acknowledge watchdog status', text: '@monitor acknowledged status, continuing wait', mentions: ['monitor'] },
    runtime.store.readMembers('sess-r0'),
    'coordinator',
  )
  assert.equal(mentionMonitorCheck.ok, true)

  // R2 & R3: Simulating a Turn-1 NO_ADAPTER error event on worker-1 marks status='error' and posts [RUNTIME_ERROR] alert
  const onSessionEvent = listeners.get('session/event')
  onSessionEvent(
    { id: 'sess-r0__worker-1' },
    {
      type: 'turn/end',
      seq: 15,
      data: {
        turn: 1,
        reason: {
          kind: 'error',
          error: { code: 'NO_ADAPTER', message: 'no adapter registered for provider "internal"' },
        },
      },
    },
  )

  const w1Live = runtime.getMemberLiveness('sess-r0', 'worker-1')
  assert.equal(w1Live.status, 'error')
  assert.match(w1Live.stepSummary, /NO_ADAPTER/)

  const statusRes = await registeredTools.get('swarm_status').execute({}, { agent: callerAgent })
  assert.equal(statusRes.ok, true)
  assert.ok(statusRes.text.includes(`Runtime: dsh-swarm v${PLUGIN_VERSION}`))
  assert.match(statusRes.text, /status=error/)
  assert.match(statusRes.text, /LLM In-Flight Slots:/)
  assert.match(statusRes.text, /Watchdog:/)

  // R8: Posting [done] archives the SSOT 2-file store (events.jsonl + offsets.json) into swarm/archive/<id>_.../
  const doneRes = await registeredTools.get('post_board').execute(
    { title: 'Close swarm and archive artifacts', text: '[done] Test run complete and archived', kind: 'done', mentions: ['coordinator'] },
    { agent: callerAgent },
  )
  assert.equal(doneRes.ok, true)
  assert.ok(doneRes.archive_path && fs.existsSync(path.join(doneRes.archive_path, 'events.jsonl')), 'Archive directory must contain events.jsonl')
  assert.ok(fs.existsSync(path.join(doneRes.archive_path, 'offsets.json')), 'Archive directory must contain offsets.json')
}

// ---------------------------------------------------------------------------
// 8. v0.3.0 P0/P1 Reliability, Watchdog, Noise Filtering, Merge Gate & Subdir Git
// ---------------------------------------------------------------------------

function assertStrictlyLosslessJson(value, label = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true, `${label} must be finite number`)
    return
  }
  if (Array.isArray(value)) {
    const ownKeys = Object.getOwnPropertyNames(value).filter(k => k !== 'length')
    assert.equal(ownKeys.length, value.length, `${label} array must have no extra own properties (found: ${ownKeys.join(',')})`)
    value.forEach((item, i) => assertStrictlyLosslessJson(item, `${label}[${i}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assert.notEqual(v, undefined, `${label}.${k} must not be undefined`)
      assertStrictlyLosslessJson(v, `${label}.${k}`)
    }
    return
  }
  assert.fail(`${label} has non-JSON type ${typeof value}`)
}

async function test_tool_outputs_are_strictly_lossless_json() {
  const dirtyArr = ['worker-1']
  Object.defineProperty(dirtyArr, 'unreachable', { value: ['ghost'], enumerable: false })
  const cleaned = toLosslessJson({ ok: true, woken: dirtyArr, undefField: undefined, badNum: NaN })
  assertStrictlyLosslessJson(cleaned, 'cleaned')
  assert.equal('undefField' in cleaned, false)
  assert.equal(cleaned.badNum, null)
  assert.deepEqual(cleaned.woken, ['worker-1'])
}

async function test_concurrent_post_board_and_session_events_zero_duplicates() {
  const listeners = new Map()
  const registeredTools = new Map()
  const fakeCtx = {
    on(ev, fn) { listeners.set(ev, fn); return () => listeners.delete(ev) },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      return undefined
    },
  }
  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-stress-d01') }, { log: () => {}, warn: () => {} })
  const coordAgent = { id: 'sess-stress', session: { header: { id: 'sess-stress', cwd: tempRoot } } }

  await registeredTools.get('swarm_init').execute({ title: 'Stress D01', concurrency_limit: 4 }, { agent: coordAgent })
  for (let i = 1; i <= 4; i += 1) {
    await registeredTools.get('swarm_add').execute(
      { name: `w-${i}`, role: 'worker', brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c' },
      { agent: coordAgent },
    )
  }

  const onEvent = listeners.get('session/event')
  const postTool = registeredTools.get('post_board')
  const jobs = []
  for (let w = 1; w <= 4; w += 1) {
    const wAgent = { id: `sess-stress__w-${w}` }
    for (let k = 1; k <= 10; k += 1) {
      // Interleave concurrent session/event tool calls right alongside post_board calls
      onEvent({ id: `sess-stress__w-${w}` }, { type: 'tool/call', seq: k, data: { name: 'read', arguments: '{}' } })
      jobs.push(postTool.execute(
        { title: `Worker ${w} step ${k} milestone`, text: `@coordinator worker ${w} step ${k} completed cleanly`, mentions: ['coordinator'], kind: 'report' },
        { agent: wAgent },
      ))
    }
  }
  const outcomes = await Promise.all(jobs)
  for (const res of outcomes) {
    assert.equal(res.ok, true)
    assert.equal(res.deduplicated, false)
    assertStrictlyLosslessJson(res, 'post_board_res')
  }
  // 4 opening briefs + 40 unique posts = 44 exact records, zero drops, zero duplicates
  assert.equal(runtime.store.readBoard('sess-stress').length, 44)

  // Retry identical post -> deduplicated cleanly without creating #45!
  const dupRes = await postTool.execute(
    { title: 'Worker 1 step 1 milestone', text: '@coordinator worker 1 step 1 completed cleanly', mentions: ['coordinator'], kind: 'report' },
    { agent: { id: 'sess-stress__w-1' } },
  )
  assert.equal(dupRes.ok, true)
  assert.equal(dupRes.deduplicated, true)
  assert.equal(runtime.store.readBoard('sess-stress').length, 44)
}

async function test_atomic_swarm_add_rollback_and_never_started_kill_releases_name() {
  const registeredTools = new Map()
  let shouldFailCreate = true
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      if (name === 'agents') {
        return {
          async create(opts) {
            if (shouldFailCreate) throw new Error('Simulated spawn failure (EPERM)')
            return {
              agent: {
                id: opts.sessionId,
                status: 'idle',
                session: { header: { id: opts.sessionId, createdAt: Date.now() }, append() {} },
                steer() {},
              },
              async dispose() {},
            }
          },
        }
      }
      return undefined
    },
  }

  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-atomic-add') }, { log: () => {}, warn: () => {} })
  const coordAgent = { id: 'sess-atom', session: { header: { id: 'sess-atom', cwd: tempRoot } } }
  await registeredTools.get('swarm_init').execute({ title: 'Atomic Spawn', concurrency_limit: 4 }, { agent: coordAgent })

  // 1. Spawn fails -> must rollback cleanly with 0 board posts and 0 zombie in members.json
  const failRes = await registeredTools.get('swarm_add').execute(
    { name: 'arch-v2', role: 'architect', brief: '[OWNERSHIP] docs/\n[FORBIDDEN] src/\n[DONE_CRITERIA] arch' },
    { agent: coordAgent },
  )
  assert.equal(failRes.ok, false)
  assert.match(failRes.text, /rolled back/)
  assert.equal(runtime.store.readMembers('sess-atom')['arch-v2'], undefined)
  assert.equal(runtime.store.readBoard('sess-atom').length, 0)

  // 2. Retry with the SAME name `arch-v2` succeeds because rollback released it!
  shouldFailCreate = false
  const okRes = await registeredTools.get('swarm_add').execute(
    { name: 'arch-v2', role: 'architect', brief: '[OWNERSHIP] docs/\n[FORBIDDEN] src/\n[DONE_CRITERIA] arch' },
    { agent: coordAgent },
  )
  assert.equal(okRes.ok, true)
  assert.equal(okRes.active_members, 2)
  assert.equal(okRes.llm_slots, 4)

  // Freshly created member with turns=0 must report `starting`, NOT `waiting`!
  const liveness = runtime.getMemberLiveness('sess-atom', 'arch-v2')
  assert.equal(liveness.status, 'starting')

  // 3. Killing a never-started member (turns=0, post=0) releases its name for direct reuse
  const killRes = await registeredTools.get('swarm_kill').execute({ name: 'arch-v2' }, { agent: coordAgent })
  assert.equal(killRes.ok, true)
  assert.equal(killRes.name_released, true)
  assert.equal(runtime.store.readMembers('sess-atom')['arch-v2'], undefined)
}

async function test_watchdog_catches_zombie_while_peers_working() {
  const store = new SwarmStore(path.join(tempRoot, 'watchdog-zombie'))
  store.initSwarm('s-wd', { title: 'Zombie Watchdog', concurrency_confirmed: true })
  store.registerMemberWithBrief('s-wd', {
    name: 'impl-busy',
    session_id: 's-wd__impl-busy',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })
  store.registerMemberWithBrief('s-wd', {
    name: 'arch-zombie',
    session_id: 's-wd__arch-zombie',
    role: 'architect',
    brief: '[OWNERSHIP] docs\n[FORBIDDEN] src\n[DONE_CRITERIA] arch',
  })
  // Backdate arch-zombie created_at by 90 seconds so it exceeds the 60s startup grace window
  store.updateMember('s-wd', 'arch-zombie', m => ({
    ...m,
    created_at: new Date(Date.now() - 90_000).toISOString(),
    turn_count: 0,
    last_post_seq: 0,
  }))

  const diag = detectSwarmStall({
    store,
    swarmId: 's-wd',
    getMemberLiveness: (name) => (
      name === 'impl-busy'
        ? { status: 'working', stepSummary: 'Running tests' }
        : { status: 'zombie', stepSummary: 'Never started' }
    ),
  })
  assert.equal(diag.stalled, true)
  assert.equal(diag.kind, 'member_zombie')
  assert.equal(diag.memberName, 'arch-zombie')
  assert.equal(diag.target, 'coordinator')
}

async function test_noise_reduction_wake_kinds_escalate_silent_and_prose_mentions() {
  const registeredTools = new Map()
  const wokenByAgent = new Map()
  const coordAgent = {
    id: 'sess-noise',
    status: 'idle',
    session: { header: { id: 'sess-noise', cwd: tempRoot } },
    steer(msg) {
      wokenByAgent.set('coordinator', (wokenByAgent.get('coordinator') ?? 0) + 1)
      return msg
    },
  }
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      if (name === 'agents') return { get(id) { return id === 'sess-noise' ? coordAgent : undefined } }
      return undefined
    },
  }

  applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-noise') }, { log: () => {}, warn: () => {} })
  await registeredTools.get('swarm_init').execute({ title: 'Noise Control', concurrency_limit: 4 }, { agent: coordAgent })
  await registeredTools.get('swarm_add').execute(
    { name: 'impl-a', role: 'worker', brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c' },
    { agent: coordAgent },
  )
  const rb = await registeredTools.get('read_board').execute({}, { agent: coordAgent })
  // Coordinator parks with wake_kinds excluding routine `report`
  const waitRes = await registeredTools.get('swarm_wait').execute(
    { since: rb.last_read_seq, mentions_only: true, wake_kinds: ['alert', 'question', 'decision', 'review'] },
    { agent: coordAgent, concludeTurn() {} },
  )
  assert.equal(waitRes.ok, true)
  assert.equal(waitRes.status, 'DONE')

  const workerAgent = { id: 'sess-noise__impl-a' }
  // 1. Routine report @coordinator -> filtered by wake_kinds, does NOT wake Coordinator!
  const repRes = await registeredTools.get('post_board').execute(
    { title: 'Routine core progress with future QA note', text: '@coordinator Routine progress note; next wave @future-qa will review', mentions: ['coordinator'], kind: 'report' },
    { agent: workerAgent },
  )
  assert.equal(repRes.ok, true)
  assert.deepEqual(repRes.woken, [])
  assert.deepEqual(repRes.silent_mentions, ['coordinator'])
  assert.deepEqual(repRes.ignored_prose_mentions, ['future-qa'])
  assert.equal(wokenByAgent.get('coordinator') ?? 0, 0)

  // 2. Same kind `report` with `escalate: true` -> bypasses wake_kinds and wakes Coordinator!
  const escRes = await registeredTools.get('post_board').execute(
    { title: 'Escalation: test port conflict blocks run', text: '@coordinator Urgent escalation: port conflict needs decision', mentions: ['coordinator'], kind: 'report', escalate: true },
    { agent: workerAgent },
  )
  assert.equal(escRes.ok, true)
  assert.deepEqual(escRes.woken, ['coordinator'])
  assert.equal(wokenByAgent.get('coordinator'), 1)

  // 3. Silent log post with empty mentions -> allowed!
  const silentRes = await registeredTools.get('post_board').execute(
    { title: 'Saved intermediate trace log to scratch', text: 'Intermediate test log saved to scratch/out.log', silent: true, kind: 'report' },
    { agent: workerAgent },
  )
  assert.equal(silentRes.ok, true)
  assert.deepEqual(silentRes.woken, [])
}

async function test_merge_gate_reject_approve_override_and_supersedes_read_filter() {
  const registeredTools = new Map()
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      return undefined
    },
  }
  applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-gate') }, { log: () => {}, warn: () => {} })
  const coordAgent = { id: 'sess-gate', session: { header: { id: 'sess-gate', cwd: tempRoot } } }
  await registeredTools.get('swarm_init').execute({ title: 'Gate & Supersedes', concurrency_limit: 4 }, { agent: coordAgent })
  await registeredTools.get('swarm_add').execute(
    { name: 'qa-gate', role: 'verifier', brief: '[OWNERSHIP] tests/\n[FORBIDDEN] src/\n[DONE_CRITERIA] qa' },
    { agent: coordAgent },
  )
  await registeredTools.get('swarm_add').execute(
    { name: 'impl-core', role: 'worker', brief: '[OWNERSHIP] src/\n[FORBIDDEN] tests/\n[DONE_CRITERIA] core' },
    { agent: coordAgent },
  )

  const qaAgent = { id: 'sess-gate__qa-gate' }
  const postTool = registeredTools.get('post_board')
  const readTool = registeredTools.get('read_board')

  // QA posts a rejection
  const rejRes = await postTool.execute(
    { title: 'REJECT: tower range assertion failed', text: '@impl-core [REJECT] Tower range assertion failed; please fix', mentions: ['impl-core'], kind: 'review', verdict: 'reject' },
    { agent: qaAgent },
  )
  assert.equal(rejRes.ok, true)

  // Coordinator tries to post `[done]` while rejection is open -> BLOCKED by runtime gate!
  const blockedDone = await postTool.execute(
    { title: 'Attempt premature swarm close', text: '[done] Trying to close before fix', kind: 'done', mentions: ['coordinator'] },
    { agent: coordAgent },
  )
  assert.equal(blockedDone.ok, false)
  assert.match(blockedDone.text, /GATE_BLOCKED/)

  // QA posts a new decision superseding the rejection AND approves
  const appRes = await postTool.execute(
    { title: 'ALL PASS: range fix verified across suite', text: '@coordinator [VERDICT: ALL PASS] Retest passed', mentions: ['coordinator'], kind: 'review', verdict: 'approve', supersedes: [rejRes.seq] },
    { agent: qaAgent },
  )
  assert.equal(appRes.ok, true)

  // `read_board` marks superseded floor and `hide_superseded: true` omits it
  const fullRead = await readTool.execute({ since: 0, kinds: ['review'] }, { agent: coordAgent })
  assert.equal(fullRead.posts.length, 2)
  assert.equal(fullRead.posts[0].superseded_by, appRes.seq)
  assert.match(fullRead.text, /SUPERSEDED by/)

  const filteredRead = await readTool.execute({ since: 0, kinds: ['review'], hide_superseded: true }, { agent: coordAgent })
  assert.equal(filteredRead.posts.length, 1)
  assert.equal(filteredRead.posts[0].seq, appRes.seq)

  // Now `[done]` succeeds!
  const okDone = await postTool.execute(
    { title: 'All gates passed; closing and archiving swarm', text: '[done] All gates passed; archived', kind: 'done', mentions: ['coordinator'] },
    { agent: coordAgent },
  )
  assert.equal(okDone.ok, true)
}

async function test_project_root_subdir_git_worktree_isolation() {
  const parentDir = path.join(tempRoot, 'parent-non-git')
  const subRepo = path.join(parentDir, 'sub-app')
  fs.mkdirSync(subRepo, { recursive: true })
  await runGit(['init'], { cwd: subRepo })
  await runGit(['config', 'user.name', 'Test'], { cwd: subRepo })
  await runGit(['config', 'user.email', 'test@local'], { cwd: subRepo })
  fs.writeFileSync(path.join(subRepo, 'app.js'), 'export const v = 1\n', 'utf8')
  await runGit(['add', 'app.js'], { cwd: subRepo })
  await runGit(['commit', '-m', 'init'], { cwd: subRepo })

  const registeredTools = new Map()
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      return undefined
    },
  }
  applyWith(
    fakeCtx,
    { swarmDir: path.join(tempRoot, 'e2e-subdir-git'), worktreesDir: path.join(tempRoot, 'e2e-subdir-wt') },
    { log: () => {}, warn: () => {} },
  )
  const coordAgent = { id: 'sess-subgit', session: { header: { id: 'sess-subgit', cwd: parentDir } } }

  // 1. First init at parentDir discovers child git repo `sub-app`
  const probeInit = await registeredTools.get('swarm_init').execute(
    { title: 'Subdir Probe', concurrency_limit: 4 },
    { agent: coordAgent },
  )
  assert.equal(probeInit.ok, true)
  assert.equal(probeInit.git_worktree_available, false)
  assert.equal(probeInit.discovered_child_git_repos.includes('sub-app'), true)

  // 2. Re-init with `project_root: 'sub-app'` unlocks `workspace: 'share'` worktree isolation!
  const realInit = await registeredTools.get('swarm_init').execute(
    { title: 'Subdir Worktree', concurrency_limit: 4, project_root: 'sub-app' },
    { agent: coordAgent },
  )
  assert.equal(realInit.ok, true)
  assert.equal(realInit.git_worktree_available, true)

  const addShare = await registeredTools.get('swarm_add').execute(
    { name: 'impl-iso', role: 'worker', workspace: 'share', brief: '[OWNERSHIP] app.js\n[FORBIDDEN] none\n[DONE_CRITERIA] edit' },
    { agent: coordAgent },
  )
  assert.equal(addShare.ok, true)
  assert.equal(addShare.created[0].workspace, 'share')

  const killClean = await registeredTools.get('swarm_kill').execute({ name: 'impl-iso', force: true }, { agent: coordAgent })
  assert.equal(killClean.ok, true)
}

// ---------------------------------------------------------------------------
// 9. v0.3.1 Meaningful Titles, Round-Table Topology Aging, and Zero-CJK Guard
// ---------------------------------------------------------------------------

async function test_validator_enforces_meaningful_post_title() {
  const members = {
    coordinator: { role: 'coordinator', killed: false },
    'impl-1': { role: 'worker', killed: false },
  }
  const missingTitle = validatePostBoard(
    { text: '@coordinator Completed work cleanly', mentions: ['coordinator'] },
    members,
    'impl-1',
  )
  assert.equal(missingTitle.ok, false)
  assert.match(missingTitle.error, /title/)

  const genericTitle = validatePostBoard(
    { title: 'Update', text: '@coordinator Completed work cleanly', mentions: ['coordinator'] },
    members,
    'impl-1',
  )
  assert.equal(genericTitle.ok, false)
  assert.match(genericTitle.error, /generic/i)

  const goodTitle = validatePostBoard(
    { title: 'Freeze combat tick API and pass 24 smoke tests', text: '@coordinator Ready for QA review', mentions: ['coordinator'] },
    members,
    'impl-1',
  )
  assert.equal(goodTitle.ok, true)
  assert.equal(goodTitle.value.title, 'Freeze combat tick API and pass 24 smoke tests')
}

async function test_client_round_table_edge_aging_and_layout() {
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  let loadedMod = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) { loadedMod = spec.factory(() => null) },
      },
    },
    console: { info() {}, warn() {}, error() {} },
    Set,
    Map,
    Object,
    Array,
    Number,
    String,
    Symbol,
    Math,
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })

  // 1. Verify aging style: step 0 = bright yellow #facc15 @ opacity 1, older steps darken & fade out, >= 8 disappears
  const latest = loadedMod.computeEdgeVisualStyle(0)
  assert.equal(latest.visible, true)
  assert.equal(latest.isLatest, true)
  assert.equal(latest.color, '#facc15')
  assert.equal(latest.opacity, 1.0)

  let prevOpacity = latest.opacity
  for (let age = 1; age < 8; age += 1) {
    const st = loadedMod.computeEdgeVisualStyle(age)
    assert.equal(st.visible, true)
    assert.equal(st.isLatest, false)
    assert.ok(st.opacity < prevOpacity, `opacity must strictly decrease at age=${age}`)
    prevOpacity = st.opacity
  }
  const gone = loadedMod.computeEdgeVisualStyle(8)
  assert.equal(gone.visible, false)
  assert.equal(gone.opacity, 0)

  // 2. Verify Round-Table layout pins coordinator at 12 o'clock and orders latest yellow edge last (top z-order)
  const members = [
    { name: 'impl-ui', role: 'worker', status: 'working', killed: false },
    { name: 'coordinator', role: 'coordinator', status: 'waiting', killed: false },
    { name: 'arch-lead', role: 'architect', status: 'waiting', killed: false },
    { name: 'qa-gate', role: 'verifier', status: 'waiting', killed: false },
  ]
  const events = []
  for (let seq = 1; seq <= 10; seq += 1) {
    events.push({
      seq,
      from: seq % 2 === 0 ? 'arch-lead' : 'impl-ui',
      to: seq % 2 === 0 ? 'impl-ui' : 'qa-gate',
      kind: 'report',
      title: `Round ${seq} update`,
    })
  }
  const layout = loadedMod.computeRoundTableLayout(members, events, 10)
  assert.equal(layout.seats[0].name, 'coordinator', 'Coordinator must sit at 12 o\'clock (index 0)')
  assert.equal(layout.seats.length, 4)
  // Floors 1 and 2 are >= 8 steps old (ages 9 and 8) and must have faded out completely!
  assert.equal(layout.edges.some(e => e.seq <= 2), false)
  assert.equal(layout.edges.length, 8)
  const topEdge = layout.edges[layout.edges.length - 1]
  assert.equal(topEdge.seq, 10)
  assert.equal(topEdge.style.isLatest, true)
  assert.equal(topEdge.style.color, '#facc15')

  // 3. Verify `@all` broadcast edges route to `__table__` without creating a `__table__` seat
  const bcEvents = [
    ...events,
    { seq: 11, from: 'coordinator', to: '__table__', broadcast: true, kind: 'decision', title: 'Global freeze announcement' },
  ]
  const bcLayout = loadedMod.computeRoundTableLayout(members, bcEvents, 11)
  assert.equal(bcLayout.seats.some(s => s.name === '__table__'), false)
  assert.equal(bcLayout.latestEdges.length, 1)
  assert.equal(bcLayout.latestEdges[0].to, '__table__')
  assert.equal(bcLayout.latestEdges[0].broadcast, true)
}

async function test_round_table_preserves_peer_and_killed_edges_and_broadcast_to_center() {
  const registeredTools = new Map()
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      return undefined
    },
  }
  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-rt-edges') }, { log: () => {}, warn: () => {} })
  const coordAgent = { id: 'sess-rt', session: { header: { id: 'sess-rt', cwd: tempRoot } } }

  await registeredTools.get('swarm_init').execute({ title: 'RT Edges', concurrency_limit: 4 }, { agent: coordAgent })
  await registeredTools.get('swarm_add').execute(
    { name: 'arch-lead', role: 'architect', brief: '[OWNERSHIP] docs\n[FORBIDDEN] src\n[DONE_CRITERIA] arch' },
    { agent: coordAgent },
  )
  await registeredTools.get('swarm_add').execute(
    { name: 'impl-ui', role: 'worker', brief: '[OWNERSHIP] ui\n[FORBIDDEN] docs\n[DONE_CRITERIA] ui' },
    { agent: coordAgent },
  )

  const postTool = registeredTools.get('post_board')
  // Peer-to-peer post from impl-ui to arch-lead (coordinator has wake_mode='anything' by default!)
  const p2p = await postTool.execute(
    { title: 'UI interface proposal for combat HUD', text: '@arch-lead Please review UI state proposal', mentions: ['arch-lead'], kind: 'question' },
    { agent: { id: 'sess-rt__impl-ui' } },
  )
  assert.equal(p2p.ok, true)

  // @all broadcast from coordinator -> must route to `__table__` center
  const bc = await postTool.execute(
    { title: 'Wave 1 freeze announcement to all', text: '@all Freeze wave 1 scope now', mentions: ['all'], kind: 'decision' },
    { agent: coordAgent },
  )
  assert.equal(bc.ok, true)

  // Retire impl-ui (killed: true) and verify historical peer edge impl-ui -> arch-lead is STILL preserved!
  await registeredTools.get('swarm_kill').execute({ name: 'impl-ui' }, { agent: coordAgent })
  const statusRes = await registeredTools.get('swarm_status').execute({}, { agent: coordAgent })
  const edges = statusRes.snapshot.edgeEvents

  const p2pEdges = edges.filter(e => e.seq === p2p.seq)
  assert.equal(p2pEdges.length, 1, 'Peer post must NOT fan out spuriously to coordinator')
  assert.equal(p2pEdges[0].from, 'impl-ui')
  assert.equal(p2pEdges[0].to, 'arch-lead')

  const bcEdges = edges.filter(e => e.seq === bc.seq)
  assert.equal(bcEdges.length, 1)
  assert.equal(bcEdges[0].from, 'coordinator')
  assert.equal(bcEdges[0].to, '__table__')
  assert.equal(bcEdges[0].broadcast, true)
}

async function test_round_table_restores_historical_active_seats_across_waves() {
  const registeredTools = new Map()
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      return undefined
    },
  }
  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-rt-waves') }, { log: () => {}, warn: () => {} })
  const coordAgent = { id: 'sess-waves', session: { header: { id: 'sess-waves', cwd: tempRoot } } }

  await registeredTools.get('swarm_init').execute({ title: 'Multi-Wave Replay', concurrency_limit: 4 }, { agent: coordAgent })
  // Wave 1: seq #1 (impl-w1 brief), #2 (qa-w1 brief)
  await registeredTools.get('swarm_add').execute(
    { name: 'impl-w1', role: 'worker', brief: '[OWNERSHIP] src\n[FORBIDDEN] tests\n[DONE_CRITERIA] done' },
    { agent: coordAgent },
  )
  await registeredTools.get('swarm_add').execute(
    { name: 'qa-w1', role: 'verifier', brief: '[OWNERSHIP] tests\n[FORBIDDEN] src\n[DONE_CRITERIA] verify' },
    { agent: coordAgent },
  )
  // seq #3: impl-w1 -> qa-w1, seq #4: qa-w1 -> coordinator
  await registeredTools.get('post_board').execute(
    { title: 'Wave 1 implementation complete', text: '@qa-w1 ready for check', mentions: ['qa-w1'], kind: 'report' },
    { agent: { id: 'sess-waves__impl-w1' } },
  )
  await registeredTools.get('post_board').execute(
    { title: 'Wave 1 QA approved', text: '@coordinator [VERDICT: ALL PASS]', mentions: ['coordinator'], kind: 'review', verdict: 'approve' },
    { agent: { id: 'sess-waves__qa-w1' } },
  )
  // Retire Wave 1 members at headSeq #4
  await registeredTools.get('swarm_kill').execute({ name: 'impl-w1' }, { agent: coordAgent })
  await registeredTools.get('swarm_kill').execute({ name: 'qa-w1' }, { agent: coordAgent })

  // Also test legacy swarm fallback: erase killed_at_seq on qa-w1 to verify inference from board.jsonl!
  runtime.store.updateMember('sess-waves', 'qa-w1', m => ({ ...m, killed_at_seq: null }))

  // Wave 2: seq #5 (arch-w2 brief), #6 (impl-w2 brief), #7 (impl-w2 -> arch-w2)
  await registeredTools.get('swarm_add').execute(
    { name: 'arch-w2', role: 'architect', brief: '[OWNERSHIP] docs\n[FORBIDDEN] src\n[DONE_CRITERIA] adr' },
    { agent: coordAgent },
  )
  await registeredTools.get('swarm_add').execute(
    { name: 'impl-w2', role: 'worker', brief: '[OWNERSHIP] src\n[FORBIDDEN] docs\n[DONE_CRITERIA] code' },
    { agent: coordAgent },
  )
  await registeredTools.get('post_board').execute(
    { title: 'Wave 2 interface objection', text: '@arch-w2 please review boundary', mentions: ['arch-w2'], kind: 'question' },
    { agent: { id: 'sess-waves__impl-w2' } },
  )

  const snap = (await registeredTools.get('swarm_status').execute({}, { agent: coordAgent })).snapshot

  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  let loadedMod = null
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { loadedMod = spec.factory(() => null) } } },
    console: { info() {}, warn() {}, error() {} },
    Set, Map, Object, Array, Number, String, Symbol, Math,
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })

  // Replay Wave 1 at floor #3 -> ONLY coordinator + impl-w1 + qa-w1 (3 seats, NO Wave 2 members!)
  const wave1Layout = loadedMod.computeRoundTableLayout(snap.members, snap.edgeEvents, 3)
  assert.deepEqual(
    Array.from(wave1Layout.seats.map(s => s.name)).sort(),
    ['coordinator', 'impl-w1', 'qa-w1'],
    'Wave 1 replay at #3 must show exact historical Wave 1 active seats',
  )
  assert.equal(wave1Layout.seats.every(s => !s.killed), true, 'Wave 1 seats were alive at #3')
  assert.equal(wave1Layout.latestEdges[0].from, 'impl-w1')
  assert.equal(wave1Layout.latestEdges[0].to, 'qa-w1')

  // Replay Wave 2 at floor #7 -> ONLY coordinator + arch-w2 + impl-w2 (3 seats, NO retired Wave 1 members!)
  const wave2Layout = loadedMod.computeRoundTableLayout(snap.members, snap.edgeEvents, 7)
  assert.deepEqual(
    Array.from(wave2Layout.seats.map(s => s.name)).sort(),
    ['arch-w2', 'coordinator', 'impl-w2'],
    'Wave 2 replay at #7 must exclude retired Wave 1 members (both explicit and legacy-inferred)',
  )
  assert.equal(wave2Layout.latestEdges[0].from, 'impl-w2')
  assert.equal(wave2Layout.latestEdges[0].to, 'arch-w2')
}

async function test_kafka_event_log_replays_exact_state_by_offset_and_timestamp() {
  const store = new SwarmStore(path.join(tempRoot, 'kafka-events'))
  store.initSwarm('sw-kafka', { title: 'Kafka Replay', concurrency_limit: 4, concurrency_confirmed: true })

  // Deterministic synthetic timestamps for time-travel verification
  const eventsDir = store.pathsOf('sw-kafka').eventsJsonl
  assert.equal(fs.existsSync(eventsDir), true, 'events.jsonl must be created on swarm init')

  store.registerMemberWithBrief('sw-kafka', {
    name: 'impl-w1',
    session_id: 'sw-kafka__impl-w1',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })
  store.registerMemberWithBrief('sw-kafka', {
    name: 'qa-w1',
    session_id: 'sw-kafka__qa-w1',
    role: 'verifier',
    brief: '[OWNERSHIP] tests\n[FORBIDDEN] a\n[DONE_CRITERIA] test',
  })
  store.appendBoardRecord('sw-kafka', {
    type: 'post',
    agent: 'impl-w1',
    title: 'Wave 1 core complete',
    mentions: ['qa-w1'],
    kind: 'report',
    text: '@qa-w1 please verify',
  })
  const w1Events = store.readEventLog('sw-kafka')
  const w1PostOffset = w1Events[w1Events.length - 1].offset
  const w1PostTs = w1Events[w1Events.length - 1].ts_ms

  // Wait 15ms so Wave 2 events have a strictly greater timestamp
  await new Promise(resolve => setTimeout(resolve, 15))
  store.appendEvent('sw-kafka', { type: 'member.kill', actor: 'coordinator', seq: 3, payload: { name: 'impl-w1', released: false } })
  store.appendEvent('sw-kafka', { type: 'member.kill', actor: 'coordinator', seq: 3, payload: { name: 'qa-w1', released: false } })
  store.registerMemberWithBrief('sw-kafka', {
    name: 'arch-w2',
    session_id: 'sw-kafka__arch-w2',
    role: 'architect',
    brief: '[OWNERSHIP] docs\n[FORBIDDEN] src\n[DONE_CRITERIA] adr',
  })
  store.appendBoardRecord('sw-kafka', {
    type: 'post',
    agent: 'coordinator',
    title: 'Global Wave 2 kickoff',
    mentions: ['all'],
    kind: 'decision',
    text: '@all Wave 2 begins now',
  })

  const fullEvents = store.readEventLog('sw-kafka')

  // 1. Host replay by offset AND by timestamp at Wave 1 post
  const atW1ByOffset = replaySwarmEvents(fullEvents, { atOffset: w1PostOffset })
  assert.deepEqual(atW1ByOffset.activeMembers.map(m => m.name).sort(), ['coordinator', 'impl-w1', 'qa-w1'])
  const atW1ByTime = replaySwarmEvents(fullEvents, { atTsMs: w1PostTs })
  assert.deepEqual(atW1ByTime.activeMembers.map(m => m.name).sort(), ['coordinator', 'impl-w1', 'qa-w1'])

  // 2. Host replay at latest offset -> Wave 1 retired, only coordinator + arch-w2 active, latest edge is @all -> __table__
  const atEnd = replaySwarmEvents(fullEvents)
  assert.deepEqual(atEnd.activeMembers.map(m => m.name).sort(), ['arch-w2', 'coordinator'])
  const lastEdge = atEnd.edgeEvents[atEnd.edgeEvents.length - 1]
  assert.equal(lastEdge.to, '__table__')
  assert.equal(lastEdge.broadcast, true)

  // 3. Client `computeRoundTableFromEvents` replays identical seats at Wave 1 offset vs latest offset
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  let loadedMod = null
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { loadedMod = spec.factory(() => null) } } },
    console: { info() {}, warn() {}, error() {} },
    Set, Map, Object, Array, Number, String, Symbol, Math,
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })

  const clientW1 = loadedMod.computeRoundTableFromEvents(fullEvents, [], w1PostOffset)
  assert.deepEqual(Array.from(clientW1.seats.map(s => s.name)).sort(), ['coordinator', 'impl-w1', 'qa-w1'])
  assert.equal(clientW1.latestEdges[0].from, 'impl-w1')
  assert.equal(clientW1.latestEdges[0].to, 'qa-w1')

  const clientEnd = loadedMod.computeRoundTableFromEvents(fullEvents, [], null)
  assert.deepEqual(Array.from(clientEnd.seats.map(s => s.name)).sort(), ['arch-w2', 'coordinator'])
  assert.equal(clientEnd.latestEdges[0].to, '__table__')
  assert.equal(clientEnd.latestEdges[0].broadcast, true)
}

async function test_ssot_two_file_storage_no_duplicate_facts() {
  const baseDir = path.join(tempRoot, 'ssot-check')
  const store = new SwarmStore(baseDir)
  store.initSwarm('sw-ssot', { title: 'SSOT Invariant', concurrency_limit: 3, concurrency_confirmed: true })
  store.registerMemberWithBrief('sw-ssot', {
    name: 'impl-a',
    session_id: 'sw-ssot__impl-a',
    role: 'worker',
    applied_model: 'deepseek-chat',
    brief: '[OWNERSHIP] src\n[FORBIDDEN] docs\n[DONE_CRITERIA] ok',
  })
  store.writePlan('sw-ssot', { goal: 'Verify zero duplication', waves: [{ id: 1 }] })
  store.appendBoardRecord('sw-ssot', {
    type: 'post',
    agent: 'impl-a',
    title: 'Initial SSOT report',
    kind: 'report',
    mentions: ['coordinator'],
    text: '@coordinator done',
  })
  store.updateMember('sw-ssot', 'impl-a', m => ({
    ...m,
    last_read_seq: 2,
    turn_count: 3,
    tool_call_count: 5,
    last_tool_name: 'post_board',
    applied_model: 'deepseek-reasoner',
  }))

  // On-disk invariant: ONLY events.jsonl and offsets.json exist (ZERO legacy duplicate files!)
  const files = fs.readdirSync(store.dirOf('sw-ssot')).sort()
  assert.deepEqual(files, ['events.jsonl', 'offsets.json'], `Expected strictly 2 SSOT files, got: ${files.join(', ')}`)

  // offsets.json must contain ONLY mutable consumer cursor & runtime telemetry (ZERO domain facts!)
  const offsetsRaw = JSON.parse(fs.readFileSync(store.pathsOf('sw-ssot').offsetsJson, 'utf8'))
  const wOffset = offsetsRaw['impl-a']
  assert.equal(wOffset.last_read_seq, 2)
  assert.equal(wOffset.turn_count, 3)
  assert.equal(wOffset.tool_call_count, 5)
  for (const forbiddenDomainKey of ['role', 'killed', 'brief_seq', 'applied_model', 'session_id', 'title', 'text']) {
    assert.equal(forbiddenDomainKey in wOffset, false, `offsets.json must NOT duplicate domain field "${forbiddenDomainKey}"`)
  }

  // Cold-cache read from a brand-new SwarmStore instance must faithfully reconstruct all projections
  const coldStore = new SwarmStore(baseDir)
  assert.equal(coldStore.readSwarm('sw-ssot').title, 'SSOT Invariant')
  assert.equal(coldStore.readPlan('sw-ssot').goal, 'Verify zero duplication')
  assert.equal(coldStore.readBoard('sw-ssot').length, 2)
  const coldMember = coldStore.readMembers('sw-ssot')['impl-a']
  assert.equal(coldMember.role, 'worker')
  assert.equal(coldMember.applied_model, 'deepseek-reasoner')
  assert.equal(coldMember.last_read_seq, 2)
  assert.equal(coldMember.turn_count, 3)
}

async function test_client_flicker_free_polling_and_yellow_arrival_highlight() {
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  let loadedMod = null
  let currentPayload = {
    ok: true,
    resolvedSwarmId: 'sw-ui',
    swarms: [{ swarm_id: 'sw-ui', title: 'UI Flicker Test', head_seq: 1 }],
    concurrency: { active: 0, limit: 3 },
    snapshot: {
      swarm_id: 'sw-ui',
      headSeq: 1,
      headOffset: 3,
      memberSummary: { active: 1, working: 0, waiting: 1, killed: 0 },
      activeRejections: [],
      plan: { updated_at: '2026-01-01T00:00:00.000Z' },
      members: [{ name: 'w1', status: 'waiting', killed: false, last_read_seq: 1, wait_since: 1, last_post_seq: 0, turn_count: 1, tool_call_count: 1, stepSummary: 'waiting' }],
      posts: [{ seq: 1, type: 'post', agent: 'coordinator', title: 'Opening brief', text: '@w1 start', time: '2026-01-01T00:00:00.000Z' }],
      events: [],
    },
  }
  const scheduledTimers = []
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { loadedMod = spec.factory(() => null) } } },
    console: { info() {}, warn() {}, error() {} },
    fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(currentPayload)) }),
    setTimeout: (fn, ms) => { scheduledTimers.push({ fn, ms }); return scheduledTimers.length },
    clearTimeout: () => {},
    Set, Map, Object, Array, Number, String, Symbol, Math, JSON, Date, Promise, encodeURIComponent,
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })

  let notifyCount = 0
  loadedMod.uiStore.subscribe(() => { notifyCount += 1 })

  // Poll 1: initial hydration -> notifies once, historical #1 must NOT flash as fresh
  await loadedMod.fetchSwarmState('sw-ui')
  assert.equal(notifyCount, 1, 'Initial poll must hydrate store once')
  assert.equal(Boolean(loadedMod.uiStore.getSnapshot().freshPostSeqs[1]), false, 'Initial load must not flash historical posts')

  // Polls 2 & 3: identical server snapshot -> 0 extra store notifications (ZERO flicker!)
  await loadedMod.fetchSwarmState('sw-ui')
  await loadedMod.fetchSwarmState('sw-ui')
  assert.equal(notifyCount, 1, 'Unchanged polls must trigger 0 extra uiStore updates')

  // Poll 4: real new board post #2 arrives -> notifies once and flags #2 for yellow arrival animation
  currentPayload.snapshot.headSeq = 2
  currentPayload.snapshot.headOffset = 4
  currentPayload.snapshot.posts.push({ seq: 2, type: 'post', agent: 'w1', title: 'New progress update', text: '@coordinator ready', time: '2026-01-01T00:00:05.000Z' })
  await loadedMod.fetchSwarmState('sw-ui')
  assert.equal(notifyCount, 2, 'New post arrival must update store once')
  assert.equal(loadedMod.uiStore.getSnapshot().freshPostSeqs[2], true, 'Newly arrived post #2 must trigger yellow highlight animation')
  assert.equal(Boolean(loadedMod.uiStore.getSnapshot().freshPostSeqs[1]), false, 'Older post #1 must stay unhighlighted')

  // Firing the scheduled clear timer removes the temporary fresh highlight cleanly
  assert.ok(scheduledTimers.length >= 1, 'Fresh highlight must schedule an auto-clear timer')
  scheduledTimers[scheduledTimers.length - 1].fn()
  assert.equal(Boolean(loadedMod.uiStore.getSnapshot().freshPostSeqs[2]), false, 'Auto-clear timer must remove fresh highlight after animation completes')
}

async function test_projector_auto_checkpoints_and_replays_from_second_newest() {
  const store = new SwarmStore(path.join(tempRoot, 'projector-checkpoints'), { checkpointInterval: 50 })
  store.initSwarm('sw-cp', { title: 'Checkpoint Scale Test', concurrency_limit: 4, concurrency_confirmed: true })

  // Wave 1 spawns + channel creation + 165 board posts across waves + Wave 1 retirement + Wave 2 spawn
  store.registerMemberWithBrief('sw-cp', {
    name: 'impl-w1',
    session_id: 'sw-cp__impl-w1',
    role: 'worker',
    brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c',
  })
  store.registerMemberWithBrief('sw-cp', {
    name: 'qa-w1',
    session_id: 'sw-cp__qa-w1',
    role: 'verifier',
    brief: '[OWNERSHIP] tests\n[FORBIDDEN] a\n[DONE_CRITERIA] verify',
  })
  store.appendBoardRecord('sw-cp', {
    type: 'control',
    action: 'channel.create',
    agent: 'coordinator',
    channel: 'perf',
  })
  store.writePlan('sw-cp', { goal: 'Scale to thousands safely', current_wave: 1, waves: [{ id: 1 }, { id: 2 }] })

  for (let i = 1; i <= 165; i += 1) {
    if (i === 75) {
      store.appendEvent('sw-cp', { type: 'member.kill', actor: 'coordinator', seq: store.headSeq('sw-cp'), payload: { name: 'impl-w1', released: false } })
      store.registerMemberWithBrief('sw-cp', {
        name: 'arch-w2',
        session_id: 'sw-cp__arch-w2',
        role: 'architect',
        brief: '[OWNERSHIP] docs\n[FORBIDDEN] src\n[DONE_CRITERIA] adr',
      })
    }
    store.appendBoardRecord('sw-cp', {
      type: 'post',
      agent: i < 75 ? 'impl-w1' : 'arch-w2',
      title: `Milestone update #${i}`,
      kind: 'report',
      mentions: ['qa-w1'],
      text: `@qa-w1 progress step ${i}`,
    })
  }

  const allEvents = store.readEventLog('sw-cp')
  const checkpoints = allEvents.filter(e => e.type === 'state.checkpoint')
  assert.ok(checkpoints.length >= 3, `Expected >= 3 auto checkpoints at 50-event intervals, got ${checkpoints.length}`)

  // 1. State projection MUST anchor on the SECOND-NEWEST checkpoint and skip earlier events!
  const secondNewestCp = checkpoints[checkpoints.length - 2]
  const projected = SwarmStateProjector.projectState(allEvents, { includeBoard: false })
  assert.equal(
    projected.replayMeta.usedCheckpointOffset,
    secondNewestCp.offset,
    'Projector must automatically anchor on the second-newest valid checkpoint',
  )
  assert.ok(
    projected.replayMeta.replayedEvents < 120,
    `Expected O(1)-bounded tail replay (<120 events), actually replayed ${projected.replayMeta.replayedEvents}`,
  )

  // 2. Projected state MUST be bit-for-bit equivalent to a full genesis replay with ALL checkpoints removed!
  const domainOnly = allEvents.filter(e => e.type !== 'state.checkpoint')
  const fullGenesis = SwarmStateProjector.projectState(domainOnly, { includeBoard: false })
  assert.equal(fullGenesis.replayMeta.usedCheckpointOffset, null)
  assert.equal(projected.headSeq, fullGenesis.headSeq)
  assert.equal(projected.postCount, fullGenesis.postCount)
  assert.deepEqual(projected.swarm, fullGenesis.swarm)
  assert.deepEqual(projected.plan, fullGenesis.plan)
  assert.deepEqual(projected.channels.sort(), fullGenesis.channels.sort())
  assert.deepEqual(
    projected.activeMembers.map(m => m.name).sort(),
    fullGenesis.activeMembers.map(m => m.name).sort(),
  )
  assert.deepEqual(projected.members, fullGenesis.members)

  // 3. Even if the newest checkpoint is corrupted, projector still recovers identically from the second-newest!
  const withCorruptedLatest = allEvents.map(ev =>
    ev.offset === checkpoints[checkpoints.length - 1].offset
      ? { ...ev, payload: { broken: true } }
      : ev,
  )
  const recovered = SwarmStateProjector.projectState(withCorruptedLatest, { includeBoard: false })
  assert.equal(recovered.headSeq, fullGenesis.headSeq)
  assert.deepEqual(recovered.members, fullGenesis.members)
  assert.equal(recovered.replayMeta.usedCheckpointOffset, checkpoints[checkpoints.length - 3].offset)
}

async function test_swarm_concurrency_tool_coordinator_only_and_validation() {
  const registeredTools = new Map()
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      return undefined
    },
  }
  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-conc-tool') }, { log: () => {}, warn: () => {} })
  const coordAgent = { id: 'sess-conc', session: { header: { id: 'sess-conc', cwd: tempRoot } } }

  assert.equal(registeredTools.has('swarm_init'), true, 'Only swarm_init must be registered globally at startup')
  assert.equal(registeredTools.has('swarm_concurrency'), false, 'swarm_concurrency must stay hidden before swarm_init')

  await registeredTools.get('swarm_init').execute({ title: 'AI Managed Concurrency', concurrency_limit: 4 }, { agent: coordAgent })
  assert.equal(registeredTools.has('swarm_concurrency'), true, 'swarm_concurrency must unlock after swarm_init')
  await registeredTools.get('swarm_add').execute(
    { name: 'impl-c1', role: 'worker', brief: '[OWNERSHIP] a\n[FORBIDDEN] b\n[DONE_CRITERIA] c' },
    { agent: coordAgent },
  )

  // 1. Coordinator scales slots up to 8 -> updates both ConcurrencyGate and events.jsonl SSOT
  const okRes = await registeredTools.get('swarm_concurrency').execute(
    { limit: 8, reason: 'Scale up for Wave 2 parallel verification' },
    { agent: coordAgent },
  )
  assert.equal(okRes.ok, true)
  assert.equal(okRes.previous_limit, 4)
  assert.equal(okRes.limit, 8)
  assert.equal(runtime.concurrencyGate.snapshot().configuredLimit, 8)
  assert.equal(runtime.store.readSwarm('sess-conc').concurrency_limit, 8)

  // 2. Invalid non-positive limit rejected
  const badRes = await registeredTools.get('swarm_concurrency').execute({ limit: 0 }, { agent: coordAgent })
  assert.equal(badRes.ok, false)
  assert.match(badRes.text, /FORMAT_ERROR/)

  // 3. Non-coordinator worker is rejected
  const workerRes = await registeredTools.get('swarm_concurrency').execute(
    { limit: 16 },
    { agent: { id: 'sess-conc__impl-c1' } },
  )
  assert.equal(workerRes.ok, false)
  assert.match(workerRes.text, /PERMISSION_ERROR/)
}

async function test_scoped_lazy_tool_unlock_on_swarm_init() {
  const globalTools = new Map()
  const listeners = new Map()
  const fakeCtx = {
    on(evt, fn) { listeners.set(evt, fn); return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') {
        return {
          register(t) { globalTools.set(t.name, t); return () => { globalTools.delete(t.name) } },
          get(n) { return globalTools.get(n) },
        }
      }
      return undefined
    },
  }

  function makeScopedAgent(id) {
    const localTools = new Map()
    const denied = new Set()
    const toolsSvc = {
      register(t) { localTools.set(t.name, t); return () => { localTools.delete(t.name) } },
      restrict(filter) {
        for (const n of filter.deny ?? []) denied.add(n)
        return () => {}
      },
      get(n) { return localTools.get(n) ?? (denied.has(n) ? undefined : globalTools.get(n)) },
      visibleNames() {
        const names = new Set()
        for (const n of globalTools.keys()) if (!denied.has(n)) names.add(n)
        for (const n of localTools.keys()) names.add(n)
        return [...names].sort()
      },
    }
    return {
      id,
      session: { header: { id, cwd: tempRoot } },
      ctx: {
        tools: toolsSvc,
        get(name) { return name === 'tools' ? toolsSvc : undefined },
      },
    }
  }

  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-lazy-tools') }, { log: () => {}, warn: () => {} })

  // 1. At mount time, ONLY `swarm_init` is registered globally!
  assert.deepEqual([...globalTools.keys()], ['swarm_init'])

  const agentA = makeScopedAgent('sess-lazy-a')
  const agentB = makeScopedAgent('sess-lazy-b')
  assert.deepEqual(agentA.ctx.tools.visibleNames(), ['swarm_init'])
  assert.deepEqual(agentB.ctx.tools.visibleNames(), ['swarm_init'])

  // 2. Agent A calls `swarm_init` -> unlocks all 10 Swarm tools ONLY on Agent A's scope!
  const initRes = await globalTools.get('swarm_init').execute(
    { title: 'Lazy Scoped Swarm', concurrency_limit: 4 },
    { agent: agentA },
  )
  assert.equal(initRes.ok, true)
  assert.deepEqual([...globalTools.keys()], ['swarm_init'], 'Global layer must remain clean with ONLY swarm_init')
  assert.deepEqual(agentA.ctx.tools.visibleNames(), [
    'post_board',
    'read_board',
    'swarm_add',
    'swarm_concurrency',
    'swarm_init',
    'swarm_kill',
    'swarm_land',
    'swarm_model',
    'swarm_plan',
    'swarm_status',
    'swarm_wait',
  ])
  // Unrelated Agent B STILL sees ONLY `swarm_init`!
  assert.deepEqual(agentB.ctx.tools.visibleNames(), ['swarm_init'])

  // 3. Child worker setup denies `swarm_init` and mounts ONLY the 5 worker tools
  const childW1 = makeScopedAgent('sess-lazy-a__w1')
  const setup = runtime.buildChildSetup({
    memberName: 'w1',
    member: { role: 'worker' },
    rolePrompt: 'worker sop',
    resolvedRoute: {},
    rootAgent: agentA,
    isCreate: true,
  })
  setup(childW1.ctx, childW1)
  assert.deepEqual(childW1.ctx.tools.visibleNames(), [
    'post_board',
    'read_board',
    'swarm_model',
    'swarm_status',
    'swarm_wait',
  ])

  // 4. Resuming Agent A after restart via `agent/created` automatically re-enables its 10 coordinator tools!
  const resumedA = makeScopedAgent('sess-lazy-a')
  assert.deepEqual(resumedA.ctx.tools.visibleNames(), ['swarm_init'])
  listeners.get('agent/created')({ agent: resumedA, source: 'resume' })
  assert.equal(resumedA.ctx.tools.visibleNames().length, 11)
}

async function test_lore_master_role_and_tier_b_guardrails() {
  const { renderRolePrompt, COORDINATOR_SOP_PROMPT } = await import('../src/host/prompts.js')
  assert.equal(COORDINATOR_SOP_PROMPT.includes('2026-11-23'), false, 'Prompt must not contain attribution meta-history')
  const lorePrompt = renderRolePrompt('lore_master', { memberName: 'nic-lore', cwd: '/repo', briefSeq: 1, brief: 'NIC spec oracle' })
  assert.match(lorePrompt, /LORE MASTER/)
  assert.match(lorePrompt, /Exact Citations Only/)

  // Create a clean real git repo to test Tier-B guardrails end-to-end
  const gitDir = path.join(tempRoot, 'tier-b-repo')
  fs.mkdirSync(gitDir, { recursive: true })
  await runGit(['init'], { cwd: gitDir })
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: gitDir })
  await runGit(['config', 'user.name', 'Test'], { cwd: gitDir })
  fs.writeFileSync(path.join(gitDir, 'README.md'), '# NIC Driver\n', 'utf8')
  await runGit(['add', '.'], { cwd: gitDir })
  await runGit(['commit', '-m', 'init'], { cwd: gitDir })

  const registeredTools = new Map()
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      return undefined
    },
  }
  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-tier-b') }, { log: () => {}, warn: () => {} })
  const coordAgent = { id: 'sess-tier-b', session: { header: { id: 'sess-tier-b', cwd: gitDir } } }

  await registeredTools.get('swarm_init').execute({ title: 'NIC Driver Tier-B Test', concurrency_limit: 4 }, { agent: coordAgent })

  // 1. `lore_master` spawns cleanly on inherit with can_block_merge=false
  const loreAdd = await registeredTools.get('swarm_add').execute(
    {
      name: 'nic-lore',
      role: 'lore_master',
      brief: '[OWNERSHIP]\nRead-only NIC spec lookup\n[FORBIDDEN]\nEditing code\n[DONE_CRITERIA]\nAnswer register queries with exact citations',
    },
    { agent: coordAgent },
  )
  assert.equal(loreAdd.ok, true)
  const loreMember = runtime.store.readMembers('sess-tier-b')['nic-lore']
  assert.equal(loreMember.role, 'lore_master')
  assert.equal(loreMember.can_block_merge, false)
  assert.equal(loreMember.workspace_mode, 'inherit')

  // 2. Worker with omitted `workspace` inside a Git repo defaults automatically to `workspace="share"`!
  const workerAutoShare = await registeredTools.get('swarm_add').execute(
    {
      name: 'impl-tx',
      role: 'worker',
      brief: '[OWNERSHIP]\nsrc/tx/\n[FORBIDDEN]\nsrc/rx/\n[DONE_CRITERIA]\nTX ring passes smoke tests',
    },
    { agent: coordAgent },
  )
  assert.equal(workerAutoShare.ok, true)
  assert.equal(runtime.store.readMembers('sess-tier-b')['impl-tx'].workspace_mode, 'share')

  // 3. Explicit `workspace="inherit"` on a worker is still respected
  const workerExplicitInherit = await registeredTools.get('swarm_add').execute(
    {
      name: 'impl-doc',
      role: 'worker',
      workspace: 'inherit',
      brief: '[OWNERSHIP]\ndocs/\n[FORBIDDEN]\nsrc/\n[DONE_CRITERIA]\nDocs updated',
    },
    { agent: coordAgent },
  )
  assert.equal(workerExplicitInherit.ok, true)
  assert.equal(runtime.store.readMembers('sess-tier-b')['impl-doc'].workspace_mode, 'inherit')

  // 4. `swarm_status` flags high tool call counts (>= 80) with [BUDGET_WARN]
  runtime.store.flushOffsets('sess-tier-b', { 'impl-tx': { tool_call_count: 85 } })
  const statusRes = await registeredTools.get('swarm_status').execute({}, { agent: coordAgent })
  assert.equal(statusRes.ok, true)
  assert.match(statusRes.text, /BUDGET_WARN: 85 tool calls/)

  // 5. `post_board(kind="done")` warns when leftover scratch/ files exist in project_root
  fs.mkdirSync(path.join(gitDir, 'scratch'), { recursive: true })
  fs.writeFileSync(path.join(gitDir, 'scratch', 'junk.log'), 'temp', 'utf8')
  const doneRes = await registeredTools.get('post_board').execute(
    { title: 'Close NIC Swarm with leftover scratch', kind: 'done', mentions: ['coordinator'], text: '[done] Finished work' },
    { agent: coordAgent },
  )
  assert.equal(doneRes.ok, true)
  assert.equal(doneRes.release_hygiene.has_scratch_artifacts, true)
  assert.match(doneRes.text, /RELEASE_HYGIENE_WARN/)

  // Clean up worktree
  await registeredTools.get('swarm_kill').execute({ name: 'impl-tx', force: true }, { agent: coordAgent })
}

async function test_parameterized_role_registry_auto_covers_stop_hook_and_gates() {
  const { registerRole, unregisterRole, getSpawnableRoles, getRoleSpec, renderRolePrompt } = await import('../src/host/prompts.js')
  try {
    registerRole('nic_auditor', {
      prompt: '# [SWARM: NIC AUDITOR (@{{MEMBER_NAME}})]\nCheck PCIe DMA rings.',
      canBlockMerge: true,
      priorityTier: 'high',
    })

    // 1. Dynamically appears in spawnable roles and passes validateSwarmAdd without touching validators.js
    assert.equal(getSpawnableRoles().includes('nic_auditor'), true)
    assert.equal(getRoleSpec('nic_auditor').requireParkOnStop, true)
    const val = validateSwarmAdd(
      {
        name: 'dma-audit',
        role: 'nic_auditor',
        brief: '[OWNERSHIP]\nDMA rings\n[FORBIDDEN]\nEdits\n[DONE_CRITERIA]\nAudit report',
      },
      { swarm_id: 'sw-role', status: 'ACTIVE', concurrency_confirmed: true, concurrency_limit: 4 },
      {},
      'coordinator',
    )
    assert.equal(val.ok, true)
    assert.equal(val.value.can_block_merge, true)

    // 2. Custom prompt renders directly from registry
    const rendered = renderRolePrompt('nic_auditor', { memberName: 'dma-audit' })
    assert.match(rendered, /NIC AUDITOR \(@dma-audit\)/)

    // 3. Stop-Hook unparked protection covers custom role automatically with zero hardcoded checks
    const store = new SwarmStore(path.join(tempRoot, 'role-registry-stop'))
    store.initSwarm('sw-role', { title: 'Role Registry', concurrency_confirmed: true })
    store.registerMemberWithBrief('sw-role', {
      name: 'dma-audit',
      session_id: 'sw-role__dma-audit',
      role: 'nic_auditor',
      brief: '[OWNERSHIP] dma\n[FORBIDDEN] src\n[DONE_CRITERIA] audit',
    })
    assert.equal(store.readMembers('sw-role')['dma-audit'].can_block_merge, true)

    const steered = []
    const stopRes = handleTurnStopping({
      store,
      swarmId: 'sw-role',
      memberName: 'dma-audit',
      agent: { steer(msg) { steered.push(msg) } },
      turnState: { calledSwarmWait: false, unparkedBlockCount: 0 },
    })
    assert.equal(stopRes.blocked, true)
    assert.equal(stopRes.reason, 'missing_swarm_wait')
    assert.equal(steered.length, 1)
  } finally {
    unregisterRole('nic_auditor')
  }
}

async function test_review_meta_rules_2d_array_drives_prompt_and_user_wakeup() {
  const {
    ARCHITECT_REVIEW_RULES,
    registerRole,
    unregisterRole,
    renderRolePrompt,
    formatReviewRules,
  } = await import('../src/host/prompts.js')

  // 1. Verify ARCHITECT_REVIEW_RULES is a 2D [[title, detail], ...] array with C1..C10
  assert.equal(Array.isArray(ARCHITECT_REVIEW_RULES), true)
  assert.equal(ARCHITECT_REVIEW_RULES.length, 10)
  for (const row of ARCHITECT_REVIEW_RULES) {
    assert.equal(Array.isArray(row) && row.length === 2, true)
    assert.ok(row[0].startsWith('C') && row[1].length > 10)
  }

  // 2. Rendered architect prompt expands all 8 rules from the 2D array
  const archPrompt = renderRolePrompt('architect', { memberName: 'arch-1', cwd: '/repo', briefSeq: 1, brief: 'review' })
  for (const [title] of ARCHITECT_REVIEW_RULES) {
    assert.ok(archPrompt.includes(title), `Architect system prompt must render ${title}`)
  }

  // 3. Dynamic user-side wakeup anchor injects titles from roleSpec.reviewRules with zero hardcoding!
  try {
    const customRules = [
      ['N1:no-hotpath-alloc', 'Zero heap allocations in TX/RX datapath.'],
      ['N2:spec-register-match', 'Bitfields must match NIC hardware register table.'],
    ]
    registerRole('nic_reviewer', {
      prompt: '# [SWARM: NIC REVIEWER]\n{{REVIEW_RULES}}',
      canBlockMerge: true,
      reviewRules: customRules,
    })

    const customPrompt = renderRolePrompt('nic_reviewer', { memberName: 'nic-rev' })
    assert.match(customPrompt, /N1:no-hotpath-alloc/)
    assert.match(customPrompt, /N2:spec-register-match/)
    assert.equal(
      formatReviewRules(customRules, 'anchor'),
      'Check (N1:no-hotpath-alloc | N2:spec-register-match) -> start review with 1-line OK/FAIL per rule.',
    )

    // Verify dispatchPostWakeups attaches the user-side anchor automatically for roles with reviewRules (and NOT for worker)
    const steeredRev = []
    const steeredWorker = []
    const fakeAgents = new Map([
      ['sw-meta__nic-rev', { id: 'sw-meta__nic-rev', status: 'idle', steer(m) { steeredRev.push(m) } }],
      ['sw-meta__impl-1', { id: 'sw-meta__impl-1', status: 'idle', steer(m) { steeredWorker.push(m) } }],
    ])
    const fakeCtx = {
      on() { return () => {} },
      effect(fn) { return fn() },
      get(name) {
        if (name === 'agents') return { get(id) { return fakeAgents.get(id) } }
        return undefined
      },
    }
    const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-meta-rules') }, { log: () => {}, warn: () => {} })
    runtime.store.initSwarm('sw-meta', { title: 'Meta Rules Wakeup', concurrency_confirmed: true })
    runtime.store.registerMemberWithBrief('sw-meta', {
      name: 'nic-rev',
      session_id: 'sw-meta__nic-rev',
      role: 'nic_reviewer',
      brief: '[OWNERSHIP] review\n[FORBIDDEN] edit\n[DONE_CRITERIA] ok',
    })
    runtime.store.registerMemberWithBrief('sw-meta', {
      name: 'impl-1',
      session_id: 'sw-meta__impl-1',
      role: 'worker',
      brief: '[OWNERSHIP] tx\n[FORBIDDEN] rx\n[DONE_CRITERIA] ok',
    })

    const post = runtime.store.appendBoardRecord('sw-meta', {
      type: 'post',
      agent: 'coordinator',
      title: 'Please review TX ring patch',
      kind: 'report',
      mentions: ['nic-rev', 'impl-1'],
      text: '@nic-rev @impl-1 ready',
    })
    await runtime.dispatchPostWakeups('sw-meta', post)

    assert.equal(steeredRev.length, 1)
    assert.match(steeredRev[0].content[0].text, /Check \(N1:no-hotpath-alloc \| N2:spec-register-match\)/)
    assert.equal(steeredWorker.length, 1)
    assert.equal(steeredWorker[0].content[0].text.includes('Check ('), false, 'Worker without reviewRules must not get review anchor')
  } finally {
    unregisterRole('nic_reviewer')
  }
}

async function test_blind_audit_alert_two_round_escalation_and_unparked_idle_whip() {
  const registeredTools = new Map()
  const steeredByAgent = new Map()
  const fakeAgents = new Map()
  for (const id of ['sw-whip', 'sw-whip__arch-1', 'sw-whip__impl-1']) {
    steeredByAgent.set(id, [])
    fakeAgents.set(id, {
      id,
      status: 'idle',
      session: { header: { id, cwd: tempRoot } },
      steer(m) { steeredByAgent.get(id).push(m) },
    })
  }
  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      if (name === 'agents') return { get(id) { return fakeAgents.get(id) } }
      return undefined
    },
  }
  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-whip') }, { log: () => {}, warn: () => {} })
  const coordAgent = fakeAgents.get('sw-whip')

  await registeredTools.get('swarm_init').execute({ title: 'Whip & Blind Audit Test', concurrency_limit: 4 }, { agent: coordAgent })
  await registeredTools.get('swarm_add').execute(
    { name: 'arch-1', role: 'architect', brief: '[OWNERSHIP]\nreview\n[FORBIDDEN]\nedit\n[DONE_CRITERIA]\ngate' },
    { agent: coordAgent },
  )
  await registeredTools.get('swarm_add').execute(
    { name: 'impl-1', role: 'worker', brief: '[OWNERSHIP]\nsrc\n[FORBIDDEN]\ntests\n[DONE_CRITERIA]\ncode' },
    { agent: coordAgent },
  )

  // 1. Worker posts leading/contaminating message to @arch-1 -> ONLY reviewer receives [BLIND_AUDIT_ALERT], sender NEVER sees it!
  const workerPost = await registeredTools.get('post_board').execute(
    {
      title: 'Closing round check: already verified and all green',
      kind: 'report',
      mentions: ['arch-1'],
      text: '@arch-1 This is the final round, all tests passed with rc=0, just confirm it is fixed.',
    },
    { agent: fakeAgents.get('sw-whip__impl-1') },
  )
  assert.equal(workerPost.ok, true)
  assert.equal(workerPost.text.includes('BLIND_AUDIT'), false, 'Sender must NEVER see BLIND_AUDIT_ALERT')
  const archWakeups = steeredByAgent.get('sw-whip__arch-1')
  assert.equal(archWakeups.length, 1)
  const archWakeText = archWakeups[0].content[0].text
  assert.match(archWakeText, /\[BLIND_AUDIT_ALERT\]/)
  assert.match(archWakeText, /NEVER mention this alert/)
  assert.match(archWakeText, /C9:global-conflict-and-switches/)
  assert.match(archWakeText, /C10:real-pushback-and-gaps/)
  assert.equal(archWakeText.includes('final round'), false, 'Alert must NOT disclose the matched trigger keyword')

  // 2. Two consecutive rejects by @arch-1 -> triggers [ESCALATE_TO_HUMAN] in post_board, coordinator wakeup, and swarm_status!
  const rej1 = await registeredTools.get('post_board').execute(
    { title: 'Reject round 1: hardcoded list', kind: 'review', verdict: 'reject', mentions: ['impl-1'], text: '@impl-1 fix C3' },
    { agent: fakeAgents.get('sw-whip__arch-1') },
  )
  assert.equal(rej1.consecutive_rejects, 1)
  assert.equal(rej1.text.includes('ESCALATE_TO_HUMAN'), false)

  const rej2 = await registeredTools.get('post_board').execute(
    { title: 'Reject round 2: still patching locally', kind: 'review', verdict: 'reject', mentions: ['impl-1', 'coordinator'], text: '@impl-1 @coordinator still broken' },
    { agent: fakeAgents.get('sw-whip__arch-1') },
  )
  assert.equal(rej2.consecutive_rejects, 2)
  assert.match(rej2.text, /\[ESCALATE_TO_HUMAN\]/)
  const coordWakeups = steeredByAgent.get('sw-whip')
  assert.ok(coordWakeups.some(m => /\[ESCALATE_TO_HUMAN\]/.test(m.content[0].text)), 'Coordinator wakeup must surface ESCALATE_TO_HUMAN on 2nd consecutive reject')

  const statusAfterRej2 = await registeredTools.get('swarm_status').execute({}, { agent: coordAgent })
  assert.match(statusAfterRej2.text, /x2 ESCALATE_TO_HUMAN/)

  // 3. State-machine anti-slacking detector: worker with turns>0, wake_mode='working', idle agent -> `unparked_idle`!
  runtime.store.flushOffsets('sw-whip', { 'impl-1': { turn_count: 3, wake_mode: 'working' } })
  const slackerMember = runtime.store.readMembers('sw-whip')['impl-1']
  const slackerLiveness = statusOf(slackerMember, {
    liveAgent: { status: 'idle' },
    sessionEvents: [{ type: 'turn/end', data: { turn: 3, reason: { kind: 'stop' } } }],
  })
  assert.equal(slackerLiveness.status, 'unparked_idle', 'Worker that stopped without swarm_wait must be flagged unparked_idle, NOT waiting')

  // Watchdog healthTick: 1st hit whips slacker directly; 2nd hit within 10m (even after turn_count changes!) posts board alert to @member + @coordinator; 3rd hit within 10m is suppressed; >10m resets cleanly!
  const autoNudges = []
  const escalatedAlerts = []
  const wd = new SwarmMonitorDaemon({
    store: runtime.store,
    swarmId: 'sw-whip',
    getMemberLiveness: (name) => (name === 'impl-1' ? slackerLiveness : { status: 'working', stepSummary: 'busy' }),
    onAutoNudge: async (memberName, prompt) => { autoNudges.push({ memberName, prompt }); return true },
    onPostStall: async (alert) => { escalatedAlerts.push(alert) },
  })
  const t0 = 1_000_000
  const tick1 = await wd.healthTick(t0)
  assert.equal(tick1.action, 'auto_nudged_unparked_idle')
  assert.equal(autoNudges.length, 1)
  assert.equal(autoNudges[0].memberName, 'impl-1')
  assert.match(autoNudges[0].prompt, /Watchdog Auto-Resume/)

  // Simulate worker arguing with watchdog (turn_count increments 3 -> 4) and dropping unparked again 2 min later!
  runtime.store.flushOffsets('sw-whip', { 'impl-1': { turn_count: 4, wake_mode: 'working' } })
  const tick2 = await wd.healthTick(t0 + 120_000)
  assert.equal(tick2.action, 'health_alert')
  assert.equal(escalatedAlerts.length, 1)
  assert.equal(escalatedAlerts[0].target, 'coordinator')
  assert.deepEqual(escalatedAlerts[0].targets, ['coordinator', 'impl-1'])
  assert.match(escalatedAlerts[0].text, /unparked_idle >=2 times within 10m/)
  assert.match(escalatedAlerts[0].text, /explanation/)

  // 30s later inside the same 10m window -> suppressed without spamming the board
  const tick3 = await wd.healthTick(t0 + 150_000)
  assert.equal(tick3.action, 'suppressed_duplicate')
  assert.equal(escalatedAlerts.length, 1)

  // >10m later -> sliding window resets cleanly to 1st-hit direct whip
  const tick4 = await wd.healthTick(t0 + 800_000)
  assert.equal(tick4.action, 'auto_nudged_unparked_idle')
  assert.equal(autoNudges.length, 2)
}

async function test_verifier_review_rules_heterogeneous_model_keywords_and_kill_brake() {
  const { VERIFIER_REVIEW_RULES, COORDINATOR_SOP_PROMPT, renderRolePrompt } = await import('../src/host/prompts.js')

  // 1. VERIFIER_REVIEW_RULES is a 2D [[title, detail], ...] array (V1..V5) rendered into VERIFIER_SOP_PROMPT
  assert.equal(Array.isArray(VERIFIER_REVIEW_RULES), true)
  assert.equal(VERIFIER_REVIEW_RULES.length, 5)
  const qaPrompt = renderRolePrompt('verifier', { memberName: 'qa-1', cwd: '/repo', briefSeq: 1, brief: 'black-box QA' })
  for (const [title, detail] of VERIFIER_REVIEW_RULES) {
    assert.ok(title.startsWith('V') && detail.length > 10)
    assert.ok(qaPrompt.includes(title), `Verifier prompt must expand ${title}`)
  }
  assert.match(COORDINATOR_SOP_PROMPT, /apology loop/)
  assert.match(COORDINATOR_SOP_PROMPT, /fresh replacement session/)

  // 2. Role-level case-insensitive keyword matching (`glm`, `auto`) + Verifier user-side wakeup anchor + running-member kill brake
  const registeredTools = new Map()
  const steeredByAgent = new Map()
  const fakeAgents = new Map()
  let availableProviders = [
    { id: 'corp', models: [{ id: 'deepseek-r1', name: 'DeepSeek R1' }, { id: 'Auto', name: 'GLM-5.3 Auto' }] },
  ]

  const fakeCtx = {
    on() { return () => {} },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'tools') return { register(t) { registeredTools.set(t.name, t); return () => {} } }
      if (name === 'agents') {
        return {
          get(id) { return fakeAgents.get(id) },
          async create(opts) {
            const sid = opts.sessionId
            steeredByAgent.set(sid, [])
            const child = {
              id: sid,
              status: 'idle',
              options: opts.agentOptions,
              session: { header: { id: sid, cwd: tempRoot }, append() {} },
              steer(m) { steeredByAgent.get(sid).push(m) },
            }
            fakeAgents.set(sid, child)
            return { agent: child, async dispose() { child.status = 'disposed' } }
          },
        }
      }
      if (name === 'llm') {
        return {
          listProviders() { return availableProviders.map(p => ({ id: p.id })) },
          async listModels(pid) { return availableProviders.find(p => p.id === pid)?.models ?? [] },
        }
      }
      return undefined
    },
  }

  const runtime = applyWith(fakeCtx, { swarmDir: path.join(tempRoot, 'e2e-v0313') }, { log: () => {}, warn: () => {} })
  const coordAgent = {
    id: 'sess-v0313',
    options: { provider: 'corp', model: 'deepseek-r1' },
    session: { header: { id: 'sess-v0313', cwd: tempRoot }, append() {} },
  }
  fakeAgents.set(coordAgent.id, coordAgent)

  await registeredTools.get('swarm_init').execute({ title: 'v0.3.13 Guardrails Test', concurrency_limit: 4 }, { agent: coordAgent })

  // 2a. Verifier & Architect auto-select `corp/Auto` (case-insensitive `auto`), while Worker inherits `corp/deepseek-r1`
  await registeredTools.get('swarm_add').execute(
    { name: 'qa-auto', role: 'verifier', brief: '[OWNERSHIP]\nqa\n[FORBIDDEN]\nsrc\n[DONE_CRITERIA]\nverify' },
    { agent: coordAgent },
  )
  await registeredTools.get('swarm_add').execute(
    { name: 'arch-auto', role: 'architect', brief: '[OWNERSHIP]\narch\n[FORBIDDEN]\nsrc\n[DONE_CRITERIA]\nreview' },
    { agent: coordAgent },
  )
  await registeredTools.get('swarm_add').execute(
    { name: 'impl-live', role: 'worker', brief: '[OWNERSHIP]\nsrc\n[FORBIDDEN]\nqa\n[DONE_CRITERIA]\ncode' },
    { agent: coordAgent },
  )
  // Explicit model override always beats role preferredModelKeywords
  await registeredTools.get('swarm_add').execute(
    { name: 'qa-explicit', role: 'verifier', model: 'deepseek-r1', brief: '[OWNERSHIP]\nqa2\n[FORBIDDEN]\nsrc\n[DONE_CRITERIA]\nverify' },
    { agent: coordAgent },
  )

  const mAfter = runtime.store.readMembers('sess-v0313')
  assert.equal(mAfter['qa-auto'].applied_model, 'Auto', 'Verifier must auto-match case-insensitive `auto` route')
  assert.equal(mAfter['arch-auto'].applied_model, 'Auto', 'Architect must auto-match case-insensitive `auto` route')
  assert.equal(mAfter['impl-live'].applied_model, 'deepseek-r1', 'Worker must stay on parent DeepSeek route')
  assert.equal(mAfter['qa-explicit'].applied_model, 'deepseek-r1', 'Explicit model override must win over preferredModelKeywords')

  // 2b. Keyword priority: `glm` takes precedence over `auto` when both exist; single-model setup degrades cleanly to parent
  availableProviders = [
    { id: 'corp', models: [{ id: 'deepseek-r1', name: 'DeepSeek R1' }, { id: 'auto', name: 'Auto' }] },
    { id: 'zhipu', models: [{ id: 'GLM-5.3', name: 'GLM 5.3' }] },
  ]
  const glmRoute = await runtime.resolveModelRoute({ requestedModel: 'inherit', role: 'verifier', rootAgent: coordAgent })
  assert.equal(glmRoute.provider, 'zhipu')
  assert.equal(glmRoute.model, 'GLM-5.3')

  availableProviders = [
    { id: 'corp', models: [{ id: 'deepseek-r1', name: 'DeepSeek R1' }] },
  ]
  const fallbackRoute = await runtime.resolveModelRoute({ requestedModel: 'inherit', role: 'verifier', rootAgent: coordAgent })
  assert.equal(fallbackRoute.provider, 'corp')
  assert.equal(fallbackRoute.model, 'deepseek-r1')

  // 3. Verifier receives automatic user-side V1..V5 anchor on board wakeup
  steeredByAgent.get('sess-v0313__qa-auto').length = 0
  await registeredTools.get('post_board').execute(
    { title: 'Implementation ready for black-box QA', kind: 'report', mentions: ['qa-auto'], text: '@qa-auto ready to test' },
    { agent: fakeAgents.get('sess-v0313__impl-live') },
  )
  const qaWakeups = steeredByAgent.get('sess-v0313__qa-auto')
  assert.equal(qaWakeups.length, 1)
  assert.match(qaWakeups[0].content[0].text, /V1:clean-room-entrypoints \| V2:log-keyword-scan \| V3:zero-hook-journey \| V4:no-circular-evidence \| V5:tmp-mutations/)

  // 4. `swarm_kill` blocks killing a currently `working` member without `force: true` and suggests handover ("last words")
  const liveImpl = fakeAgents.get('sess-v0313__impl-live')
  liveImpl.status = 'running'
  const blockedKill = await registeredTools.get('swarm_kill').execute({ name: 'impl-live' }, { agent: coordAgent })
  assert.equal(blockedKill.ok, false)
  assert.equal(blockedKill.blocked_running, true)
  assert.equal(blockedKill.status, 'working')
  assert.match(blockedKill.text, /KILL_BLOCKED/)
  assert.match(blockedKill.text, /last words/)
  assert.match(blockedKill.text, /handover summary/)
  assert.equal(runtime.store.readMembers('sess-v0313')['impl-live'].killed, false, 'Blocked kill must leave member alive')

  // Passing `force: true` overrides the running brake and cleanly retires the member
  const forcedKill = await registeredTools.get('swarm_kill').execute({ name: 'impl-live', force: true }, { agent: coordAgent })
  assert.equal(forcedKill.ok, true)
  assert.equal(runtime.store.readMembers('sess-v0313')['impl-live'].killed, true)
}

async function test_plugin_runtime_contains_zero_cjk_characters() {
  const rootDir = fileURLToPath(new URL('..', import.meta.url))
  const runtimeFiles = [
    'index.js',
    'client.js',
    'src/host/projector.js',
    'src/host/store.js',
    'src/host/validators.js',
    'src/host/stop-hook.js',
    'src/host/monitor.js',
    'src/host/prompts.js',
    'src/host/tools.js',
    'src/host/worktree.js',
    'src/host/concurrency-gate.js',
  ]
  const cjkRegex = /[\u4e00-\u9fff]/
  for (const rel of runtimeFiles) {
    const content = fs.readFileSync(path.join(rootDir, rel), 'utf8')
    const match = cjkRegex.exec(content)
    assert.equal(match, null, `${rel} must contain zero CJK characters (found "${match?.[0]}" at index ${match?.index})`)
  }
}

// Run all tests
try {
  await runTest('test_atomic_store_roundtrip', test_atomic_store_roundtrip)
  await runTest('test_init_preserves_existing_board', test_init_preserves_existing_board)
  await runTest('test_event_sourced_channels_replay', test_event_sourced_channels_replay)
  await runTest('test_post_board_group_and_cursor', test_post_board_group_and_cursor)
  await runTest('test_new_worker_cursor_skips_opening_noise', test_new_worker_cursor_skips_opening_noise)
  await runTest('test_plan_json_size_guard', test_plan_json_size_guard)
  await runTest('test_validator_rejects_excessive_concurrency', test_validator_rejects_excessive_concurrency)
  await runTest('test_validator_blocks_add_before_concurrency_confirmed', test_validator_blocks_add_before_concurrency_confirmed)
  await runTest('test_validator_rejects_killed_name_reuse', test_validator_rejects_killed_name_reuse)
  await runTest('test_validator_enforces_three_part_brief', test_validator_enforces_three_part_brief)
  await runTest('test_validator_rejects_unaddressed_worker_post', test_validator_rejects_unaddressed_worker_post)
  await runTest('test_validator_rejects_channel_main_broadcast', test_validator_rejects_channel_main_broadcast)
  await runTest('test_validator_rejects_mentioning_killed_member', test_validator_rejects_mentioning_killed_member)
  await runTest('test_validator_blocks_wait_ahead_of_last_read_seq', test_validator_blocks_wait_ahead_of_last_read_seq)
  await runTest('test_concurrency_gate_abort_releases_waiter', test_concurrency_gate_abort_releases_waiter)
  await runTest('test_concurrency_gate_priority_and_bounds', test_concurrency_gate_priority_and_bounds)
  await runTest('test_concurrency_gate_aimd_backoff_and_recovery', test_concurrency_gate_aimd_backoff_and_recovery)
  await runTest('test_stop_hook_blocks_on_race_message', test_stop_hook_blocks_on_race_message)
  await runTest('test_stop_hook_catches_worker_forgetting_swarm_wait', test_stop_hook_catches_worker_forgetting_swarm_wait)
  await runTest('test_liveness_reads_transcript_over_wake_mode', test_liveness_reads_transcript_over_wake_mode)
  await runTest('test_worktree_git_no_shell_spawn', test_worktree_git_no_shell_spawn)
  await runTest('test_worktree_syncs_dirty_files_and_isolates_worker_diff', test_worktree_syncs_dirty_files_and_isolates_worker_diff)
  await runTest('test_worktree_land_conflict_preflight', test_worktree_land_conflict_preflight)
  await runTest('test_monitor_uses_last_post_seq_not_wait_since', test_monitor_uses_last_post_seq_not_wait_since)
  await runTest('test_monitor_skips_when_member_queued_for_concurrency', test_monitor_skips_when_member_queued_for_concurrency)
  await runTest('test_monitor_three_strike_cap_and_auto_sleep', test_monitor_three_strike_cap_and_auto_sleep)
  await runTest('test_swarm_wait_concludes_turn', test_swarm_wait_concludes_turn)
  await runTest('test_host_sibling_event_liveness', test_host_sibling_event_liveness)
  await runTest('test_client_tokenize_board_text', test_client_tokenize_board_text)
  await runTest('test_client_graph_replay_aggregation', test_client_graph_replay_aggregation)
  await runTest('test_slash_command_and_rightbar_registration', test_slash_command_and_rightbar_registration)
  await runTest('test_subagent_creation_inherits_real_model_preset_and_durable_address', test_subagent_creation_inherits_real_model_preset_and_durable_address)
  await runTest('test_r0_to_r8_error_observability_monitor_deps_and_archive', test_r0_to_r8_error_observability_monitor_deps_and_archive)
  await runTest('test_tool_outputs_are_strictly_lossless_json', test_tool_outputs_are_strictly_lossless_json)
  await runTest('test_concurrent_post_board_and_session_events_zero_duplicates', test_concurrent_post_board_and_session_events_zero_duplicates)
  await runTest('test_atomic_swarm_add_rollback_and_never_started_kill_releases_name', test_atomic_swarm_add_rollback_and_never_started_kill_releases_name)
  await runTest('test_watchdog_catches_zombie_while_peers_working', test_watchdog_catches_zombie_while_peers_working)
  await runTest('test_noise_reduction_wake_kinds_escalate_silent_and_prose_mentions', test_noise_reduction_wake_kinds_escalate_silent_and_prose_mentions)
  await runTest('test_merge_gate_reject_approve_override_and_supersedes_read_filter', test_merge_gate_reject_approve_override_and_supersedes_read_filter)
  await runTest('test_project_root_subdir_git_worktree_isolation', test_project_root_subdir_git_worktree_isolation)
  await runTest('test_validator_enforces_meaningful_post_title', test_validator_enforces_meaningful_post_title)
  await runTest('test_client_round_table_edge_aging_and_layout', test_client_round_table_edge_aging_and_layout)
  await runTest('test_round_table_preserves_peer_and_killed_edges_and_broadcast_to_center', test_round_table_preserves_peer_and_killed_edges_and_broadcast_to_center)
  await runTest('test_round_table_restores_historical_active_seats_across_waves', test_round_table_restores_historical_active_seats_across_waves)
  await runTest('test_kafka_event_log_replays_exact_state_by_offset_and_timestamp', test_kafka_event_log_replays_exact_state_by_offset_and_timestamp)
  await runTest('test_ssot_two_file_storage_no_duplicate_facts', test_ssot_two_file_storage_no_duplicate_facts)
  await runTest('test_client_flicker_free_polling_and_yellow_arrival_highlight', test_client_flicker_free_polling_and_yellow_arrival_highlight)
  await runTest('test_projector_auto_checkpoints_and_replays_from_second_newest', test_projector_auto_checkpoints_and_replays_from_second_newest)
  await runTest('test_swarm_concurrency_tool_coordinator_only_and_validation', test_swarm_concurrency_tool_coordinator_only_and_validation)
  await runTest('test_scoped_lazy_tool_unlock_on_swarm_init', test_scoped_lazy_tool_unlock_on_swarm_init)
  await runTest('test_lore_master_role_and_tier_b_guardrails', test_lore_master_role_and_tier_b_guardrails)
  await runTest('test_parameterized_role_registry_auto_covers_stop_hook_and_gates', test_parameterized_role_registry_auto_covers_stop_hook_and_gates)
  await runTest('test_review_meta_rules_2d_array_drives_prompt_and_user_wakeup', test_review_meta_rules_2d_array_drives_prompt_and_user_wakeup)
  await runTest('test_blind_audit_alert_two_round_escalation_and_unparked_idle_whip', test_blind_audit_alert_two_round_escalation_and_unparked_idle_whip)
  await runTest('test_verifier_review_rules_heterogeneous_model_keywords_and_kill_brake', test_verifier_review_rules_heterogeneous_model_keywords_and_kill_brake)
  await runTest('test_plugin_runtime_contains_zero_cjk_characters', test_plugin_runtime_contains_zero_cjk_characters)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
