// Deterministic anti-deadlock & zombie health watchdog (`SwarmMonitorDaemon`).
//
// Runs purely as deterministic host-side JS (0 token cost; NOT an LLM roster member):
//   1. Fast per-member health check (`detectMemberHealthIssues`, default every 30s):
//      runs EVEN WHILE OTHER MEMBERS ARE `working`! Immediately detects:
//        - `last_error` runtime/adapter failures
//        - `zombie` / never-started members (`turns === 0 && last_post_seq === 0` past 60s
//          or missing expected live session handle)
//   2. Global swarm stall check (`detectSwarmStall`, when no member is `working` or `queued`):
//      inspects unanswered `@mentions` via `last_post_seq` (not `wait_since`),
//      orphan reports, and all-idle stalls, while never false-alarming a `verifier`
//      on its opening brief while upstream workers have not posted yet.
//   3. Enforces 3-strike nudge limit per signature and 5-tick auto-sleep on inactivity.

import { statusOf, DEFAULT_STARTUP_GRACE_MS } from './stop-hook.js'

export const MAX_NUDGES_PER_STALL = 3
export const AUTO_SLEEP_QUIET_TICKS = 5

/**
 * Inspect per-member crash / zombie conditions independently of whether sibling
 * members are currently `working`.
 */
export function detectMemberHealthIssues({
  store,
  swarmId,
  getMemberLiveness,
  nowMs = Date.now(),
  startupTimeoutMs = DEFAULT_STARTUP_GRACE_MS,
}) {
  const swarm = store.readSwarm(swarmId)
  if (!swarm || swarm.status !== 'ACTIVE') return []
  const members = store.readMembers(swarmId)
  const issues = []

  for (const [name, member] of Object.entries(members)) {
    if (!member || member.killed || member.role === 'coordinator' || member.role === 'monitor') continue
    const liveness = typeof getMemberLiveness === 'function'
      ? getMemberLiveness(name, member)
      : statusOf(member, { nowMs, startupGraceMs: startupTimeoutMs })

    if (member.last_error || liveness.status === 'error') {
      const errCode = member.last_error?.code || 'ERROR'
      const errMsg = member.last_error?.message || liveness.stepSummary || 'Unknown error'
      issues.push({
        kind: 'member_error',
        memberName: name,
        target: 'coordinator',
        seq: member.brief_seq ?? 0,
        signature: `member_error:${name}:${errCode}`,
        prompt: `@coordinator [WATCHDOG_ALERT] 成员 @${name} 执行异常中止 (${errCode}: ${errMsg})，turns=${member.turn_count ?? 0}，last_post_seq=${member.last_post_seq ?? 0}。请调用 swarm_status 查看详情，执行模型热切 (swarm_model) 或 swarm_kill 清理后降级处理。`,
      })
      continue
    }

    if (liveness.status === 'working' || liveness.status === 'queued') continue

    const createdMs = member.created_at ? Date.parse(member.created_at) : NaN
    const ageMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : 0
    const isZombie = liveness.status === 'zombie'
      || ((member.turn_count ?? 0) === 0 && (member.last_post_seq ?? 0) === 0 && ageMs >= startupTimeoutMs)

    if (isZombie) {
      issues.push({
        kind: 'member_zombie',
        memberName: name,
        target: 'coordinator',
        seq: member.brief_seq ?? 0,
        signature: `member_zombie:${name}:${member.brief_seq ?? 0}`,
        prompt: `@coordinator [WATCHDOG_ALERT] 成员 @${name} 疑似僵尸/未启动（status=${liveness.status}, turns=${member.turn_count ?? 0}, post=#${member.last_post_seq ?? 0}, 已创建 ${Math.round(ageMs / 1000)}s）。请调用 swarm_status 核查，并用 swarm_kill 清理（从未启动的成员将直接释放原名可立即重建）。`,
      })
    }
  }

  return issues
}

// #FUNC Diagnose whether an active swarm has hit a member health failure (crash/zombie) or global deadlock condition.
// #NOT  Never suppresses per-member `error`/`zombie` alerts just because sibling workers are `working`, and never flags a global stall while a member is `working` or `queued`.
// #EDGE-IN A member mentioned at `#14` whose `wait_since` moved to `14` on a failed turn but `last_post_seq` is still `0` is flagged as `mentioned_silent` → test_monitor_uses_last_post_seq_not_wait_since
// #EDGE-IN When a member is queued in `ConcurrencyGate`, `detectSwarmStall` returns `{ stalled: false, reason: 'member_busy_or_queued' }` → test_monitor_skips_when_member_queued_for_concurrency
// #EDGE-IN A zombie member (`turns=0` past 60s) is flagged even while sibling workers are actively `working` → test_watchdog_catches_zombie_while_peers_working
// #WHY  Checking per-member health before the `member_busy_or_queued` early return prevents a dead teammate from stalling downstream dependents silently for the entire wave.
export function detectSwarmStall({
  store,
  swarmId,
  getMemberLiveness,
  nowMs = Date.now(),
  startupTimeoutMs = DEFAULT_STARTUP_GRACE_MS,
}) {
  const swarm = store.readSwarm(swarmId)
  if (!swarm || swarm.status !== 'ACTIVE') {
    return { stalled: false, reason: 'swarm_not_active' }
  }

  const posts = store.readBoard(swarmId)
  const members = store.readMembers(swarmId)
  const nonControlPosts = posts.filter(p => p.type !== 'control')
  const latestPost = nonControlPosts.length > 0 ? nonControlPosts[nonControlPosts.length - 1] : null

  if (latestPost && (latestPost.kind === 'done' || String(latestPost.text).includes('[done]'))) {
    return { stalled: false, reason: 'already_done', done: true }
  }

  // Condition 0 (ALWAYS runs, even if other peers are working!): crashed or zombie members
  const healthIssues = detectMemberHealthIssues({
    store,
    swarmId,
    getMemberLiveness,
    nowMs,
    startupTimeoutMs,
  })
  if (healthIssues.length > 0) {
    const first = healthIssues[0]
    return {
      stalled: true,
      kind: first.kind,
      memberName: first.memberName,
      target: first.target,
      seq: first.seq || latestPost?.seq || 0,
      signature: first.signature,
      prompt: first.prompt,
    }
  }

  // For global stall checks, skip (0 token cost) if ANY non-monitor member is currently working, queued, or freshly starting
  for (const [name, member] of Object.entries(members)) {
    if (member.killed || member.role === 'monitor') continue
    const liveness = typeof getMemberLiveness === 'function'
      ? getMemberLiveness(name, member)
      : statusOf(member, { nowMs, startupGraceMs: startupTimeoutMs })
    if (liveness.status === 'working' || liveness.status === 'queued') {
      return {
        stalled: false,
        reason: 'member_busy_or_queued',
        busyMember: name,
        busyStatus: liveness.status,
      }
    }
  }

  if (!latestPost) {
    return {
      stalled: true,
      kind: 'all_idle_no_posts',
      target: 'coordinator',
      seq: 0,
      signature: 'all_idle_no_posts:coordinator:0',
      prompt: '@coordinator [stall] 黑板尚无任何任务帖子且全员处于空闲状态，请派发任务或结束 Swarm。',
    }
  }

  // Condition 1: Latest non-silent post forgot to @mention anyone (orphan report)
  const latestMentions = latestPost.mentions ?? []
  const latestChannelMentions = latestPost.channel_mentions ?? []
  if (
    latestPost.agent !== 'coordinator'
    && latestPost.silent !== true
    && latestMentions.length === 0
    && latestChannelMentions.length === 0
  ) {
    const verifierName = Object.keys(members).find(n => !members[n].killed && members[n].role === 'verifier')
    const target = verifierName ?? 'coordinator'
    return {
      stalled: true,
      kind: 'orphan_report',
      target,
      seq: latestPost.seq,
      signature: `orphan_report:${target}:${latestPost.seq}`,
      prompt: `@${target} [stall] @${latestPost.agent} 在 #${latestPost.seq} 提交了结果但未点名接收人，请查阅 #${latestPost.seq} 并推进。`,
    }
  }

  // Condition 2: Coordinator has unread posts addressed to it
  const coord = members.coordinator
  if (coord && !coord.killed) {
    const postsToCoord = nonControlPosts.filter(
      p => p.agent !== 'coordinator' && p.silent !== true && ((p.mentions ?? []).includes('coordinator') || (p.mentions ?? []).includes('all')),
    )
    const newestToCoord = postsToCoord.length > 0 ? postsToCoord[postsToCoord.length - 1] : null
    if (newestToCoord && (coord.last_post_seq ?? 0) < newestToCoord.seq && (coord.last_read_seq ?? 0) < newestToCoord.seq) {
      return {
        stalled: true,
        kind: 'coordinator_unread',
        target: 'coordinator',
        seq: newestToCoord.seq,
        signature: `coordinator_unread:coordinator:${newestToCoord.seq}`,
        prompt: `@coordinator [stall] 成员 @${newestToCoord.agent} 已在 #${newestToCoord.seq} 向你汇报，全组当前处于等待状态，请调用 read_board 查阅并推进。`,
      }
    }
  }

  // Condition 3: A member was @mentioned at #M, is now waiting, and its `last_post_seq < M`
  const hasSilentActiveWorkers = Object.values(members).some(
    m => !m.killed && m.role === 'worker' && (m.last_post_seq ?? 0) === 0,
  )
  for (let i = nonControlPosts.length - 1; i >= 0; i -= 1) {
    const post = nonControlPosts[i]
    if (post.silent === true) continue
    const targets = store.resolveTargetsForPost(swarmId, post)
    for (const targetName of targets) {
      const targetMember = members[targetName]
      if (!targetMember || targetMember.killed || targetMember.role === 'monitor') continue
      // Do NOT false-alarm a verifier on its opening brief while upstream workers have not posted any report yet!
      if (targetMember.role === 'verifier' && post.kind === 'brief' && hasSilentActiveWorkers) {
        continue
      }
      if ((targetMember.last_post_seq ?? 0) < post.seq) {
        return {
          stalled: true,
          kind: 'mentioned_silent',
          target: targetName,
          seq: post.seq,
          signature: `mentioned_silent:${targetName}:${post.seq}`,
          prompt: `@${targetName} [stall] 你在 #${post.seq} 被 @${post.agent} 点名，但至今尚未发帖回复（last_post_seq=${targetMember.last_post_seq ?? 0}）。请调用 read_board({"since": ${targetMember.last_read_seq ?? 0}}) 查看并交卷，或 @coordinator 说明阻塞原因。`,
        }
      }
    }
  }

  // Condition 4 & 5: All members idle with no pending unanswered mentions -> nudge coordinator
  return {
    stalled: true,
    kind: 'all_idle',
    target: 'coordinator',
    seq: latestPost.seq,
    signature: `all_idle:coordinator:${latestPost.seq}`,
    prompt: `@coordinator [stall] 全组停在 #${latestPost.seq} 且无活跃成员在运行，请检查 git status 或各成员进度，推进下一波或发 [done] 收官。`,
  }
}

/**
 * Stateful per-swarm deterministic Watchdog controller with fast 30s health probes,
 * 3-strike escalation, and 5-tick auto-sleep.
 */
export class SwarmMonitorDaemon {
  constructor({
    store,
    swarmId,
    intervalMs = 120_000,
    healthIntervalMs = 30_000,
    startupTimeoutMs = DEFAULT_STARTUP_GRACE_MS,
    onPostStall,
    onAutoNudge,
    getMemberLiveness,
  }) {
    this.store = store
    this.swarmId = swarmId
    this.intervalMs = intervalMs
    this.healthIntervalMs = healthIntervalMs
    this.startupTimeoutMs = startupTimeoutMs
    this.onPostStall = onPostStall
    this.onAutoNudge = onAutoNudge
    this.getMemberLiveness = getMemberLiveness

    this.nudgeCounts = new Map() // signature -> count
    this.autoNudgedZombies = new Set() // signature -> already retried once
    this.quietTicks = 0
    this.alertsPosted = 0
    this.lastCheckAt = null
    this.lastSeenHeadSeq = this.store ? this.store.headSeq(this.swarmId) : 0
    this.sleeping = false
    this.timer = null
    this.healthTimer = null
  }

  start() {
    this.sleeping = false
    this.quietTicks = 0
    this.lastSeenHeadSeq = this.store.headSeq(this.swarmId)
    if (this.timer) clearInterval(this.timer)
    if (this.healthTimer) clearInterval(this.healthTimer)

    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()

    this.healthTimer = setInterval(() => {
      void this.healthTick()
    }, this.healthIntervalMs)
    if (typeof this.healthTimer.unref === 'function') this.healthTimer.unref()
  }

  stop() {
    this.sleeping = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
  }

  status() {
    return {
      active: !this.sleeping,
      healthIntervalSec: Math.round(this.healthIntervalMs / 1000),
      stallIntervalSec: Math.round(this.intervalMs / 1000),
      quietTicks: this.quietTicks,
      alertsPosted: this.alertsPosted,
      lastCheckAt: this.lastCheckAt,
    }
  }

  /** Called whenever a new post lands on `board.jsonl`; wakes the daemon if it had auto-slept. */
  notifyBoardActivity(postRecord) {
    if (!postRecord) return
    if (postRecord.kind === 'done' || String(postRecord.text ?? '').includes('[done]')) {
      this.stop()
      return
    }
    this.quietTicks = 0
    this.lastSeenHeadSeq = postRecord.seq
    if (this.sleeping) {
      this.start()
    }
  }

  /** Fast deterministic per-member health check (runs every 30s even while other members are busy). */
  async healthTick(nowMs = Date.now()) {
    if (this.sleeping) return { action: 'sleeping' }
    this.lastCheckAt = new Date(nowMs).toISOString()
    const issues = detectMemberHealthIssues({
      store: this.store,
      swarmId: this.swarmId,
      getMemberLiveness: this.getMemberLiveness,
      nowMs,
      startupTimeoutMs: this.startupTimeoutMs,
    })
    if (issues.length === 0) return { action: 'healthy' }

    const first = issues[0]
    if (first.kind === 'member_zombie' && !this.autoNudgedZombies.has(first.signature) && typeof this.onAutoNudge === 'function') {
      this.autoNudgedZombies.add(first.signature)
      const nudged = await this.onAutoNudge(first.memberName)
      if (nudged) {
        return { action: 'auto_nudged_zombie', memberName: first.memberName, signature: first.signature }
      }
    }

    const count = (this.nudgeCounts.get(first.signature) ?? 0) + 1
    this.nudgeCounts.set(first.signature, count)
    if (count > MAX_NUDGES_PER_STALL) {
      return { action: 'suppressed_duplicate', signature: first.signature, count }
    }

    if (typeof this.onPostStall === 'function') {
      this.alertsPosted += 1
      await this.onPostStall({
        target: first.target,
        text: first.prompt,
        kind: 'alert',
        escalate: true,
        refs: first.seq > 0 ? [first.seq] : [],
        signature: first.signature,
        attempt: count,
      })
      this.lastSeenHeadSeq = this.store.headSeq(this.swarmId)
    }

    return {
      action: 'health_alert',
      kind: first.kind,
      memberName: first.memberName,
      target: first.target,
      signature: first.signature,
      attempt: count,
    }
  }

  // #FUNC Execute one monitor inspection tick, enforcing the 3-nudge cap and 5-tick auto-sleep rule.
  // #NOT  Does not keep posting after `MAX_NUDGES_PER_STALL` or after `AUTO_SLEEP_QUIET_TICKS` idle cycles.
  // #EDGE-OUT Reaching 3 nudges for the same stall escalates to `@coordinator` and stops repeating → test_monitor_three_strike_cap_and_auto_sleep
  // #WHY  `AUTO_SLEEP_QUIET_TICKS` prevents an abandoned swarm from firing daemon checks forever.
  async tick(nowMs = Date.now()) {
    if (this.sleeping) return { action: 'sleeping' }
    this.lastCheckAt = new Date(nowMs).toISOString()
    const headSeq = this.store.headSeq(this.swarmId)
    if (headSeq === this.lastSeenHeadSeq) {
      this.quietTicks += 1
    } else {
      this.quietTicks = 0
      this.lastSeenHeadSeq = headSeq
    }

    const diagnosis = detectSwarmStall({
      store: this.store,
      swarmId: this.swarmId,
      getMemberLiveness: this.getMemberLiveness,
      nowMs,
      startupTimeoutMs: this.startupTimeoutMs,
    })

    if (diagnosis.done) {
      this.stop()
      return { action: 'stopped_on_done' }
    }

    if (!diagnosis.stalled) {
      if (this.quietTicks >= AUTO_SLEEP_QUIET_TICKS) {
        this.stop()
        return { action: 'auto_slept' }
      }
      return { action: 'ok', reason: diagnosis.reason }
    }

    const count = (this.nudgeCounts.get(diagnosis.signature) ?? 0) + 1
    this.nudgeCounts.set(diagnosis.signature, count)

    if (count > MAX_NUDGES_PER_STALL) {
      if (this.quietTicks >= AUTO_SLEEP_QUIET_TICKS) {
        this.stop()
        return { action: 'auto_slept_after_max_nudges', signature: diagnosis.signature }
      }
      return { action: 'suppressed_duplicate', signature: diagnosis.signature, count }
    }

    let text = diagnosis.prompt
    let target = diagnosis.target
    if (count === MAX_NUDGES_PER_STALL && target !== 'coordinator') {
      target = 'coordinator'
      text = `@coordinator [stall] 成员 @${diagnosis.target} 针对 #${diagnosis.seq} 已连续催醒 ${MAX_NUDGES_PER_STALL} 次仍无响应，可能模型卡死或异常退出。请检查 git status 或调用 swarm_model / 新建成员接替。`
    }

    if (typeof this.onPostStall === 'function') {
      this.alertsPosted += 1
      await this.onPostStall({
        target,
        text,
        kind: 'alert',
        escalate: true,
        refs: diagnosis.seq > 0 ? [diagnosis.seq] : [],
        signature: diagnosis.signature,
        attempt: count,
      })
      this.lastSeenHeadSeq = this.store.headSeq(this.swarmId)
    }

    if (this.quietTicks >= AUTO_SLEEP_QUIET_TICKS) {
      this.stop()
    }

    return {
      action: 'nudged',
      target,
      signature: diagnosis.signature,
      attempt: count,
      text,
    }
  }
}
