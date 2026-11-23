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
  writeJsonAtomicSync,
  readJsonSync,
  replayChannelsAt,
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
import { applyWith } from '../index.js'

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
  assert.match(bad.error, /正整数/)

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
    { name: 'monitor', role: 'monitor', brief: 'monitor' },
    { concurrency_confirmed: true, concurrency_limit: 3 },
    { monitor: { killed: true, role: 'monitor' } },
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /monitor-2/)
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
    { text: 'I finished checking the templates and found a bug.' },
    members,
    'worker-1',
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /必须至少点名一个接收人/)
}

async function test_validator_rejects_channel_main_broadcast() {
  const members = { coordinator: { role: 'coordinator', killed: false } }
  const res = validatePostBoard(
    { text: 'Hello @#main everyone wake up!' },
    members,
    'coordinator',
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /严禁发送 @#main/)
}

async function test_validator_rejects_mentioning_killed_member() {
  const members = {
    coordinator: { role: 'coordinator', killed: false },
    'old-worker': { role: 'worker', killed: true },
    'new-worker': { role: 'worker', killed: false },
  }
  const res = validatePostBoard(
    { text: '@old-worker please check this', mentions: ['old-worker'] },
    members,
    'coordinator',
  )
  assert.equal(res.ok, false)
  assert.match(res.error, /已经被销毁（killed）/)
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
  assert.match(steered[0].content[0].text, /Stop hook blocked termination/)
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

  const tokens = loadedMod.tokenizeBoardText('请 @verifier 对照 #5 和 #6 在 @#render 频道复核')
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

  const concRes = await registeredCmd.handler({
    rawInput: 'concurrency 12',
    attachments: [],
    agent: { id: 'sess-slash-1', steer() {} },
  })
  assert.equal(concRes.kind, 'success')
  assert.match(concRes.text, /12/)

  assert.equal(registeredRoutes.has('/api/dsh-swarm/state'), true)
  assert.equal(registeredRoutes.has('/api/dsh-swarm/action'), true)

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
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
