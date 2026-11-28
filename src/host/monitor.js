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
export const UNPARKED_IDLE_WINDOW_MS = 10 * 60 * 1000
export const CONTEXT_PRESSURE_THRESHOLD = 0.80
export const CONSECUTIVE_TOOL_ERROR_THRESHOLD = 3

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
      ? getMemberLiveness(name, member, { nowMs, startupGraceMs: startupTimeoutMs })
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
        title: `Watchdog alert: @${name} crashed (${errCode})`,
        prompt: `@coordinator [WATCHDOG_ALERT] Member @${name} aborted with an error (${errCode}: ${errMsg}), turns=${member.turn_count ?? 0}, last_post_seq=${member.last_post_seq ?? 0}. Inspect via swarm_status, hot-swap via swarm_model, or retire via swarm_kill.`,
      })
      continue
    }

    if (liveness.status === 'working' || liveness.status === 'queued') {
      const tele = liveness.telemetry || {}
      const ctxWin = Number(tele.context_window ?? member.context_window) || 0
      const ctxUsed = Number(tele.last_input_tokens ?? member.last_input_tokens) || 0
      const ctxRatio = ctxWin > 0 ? ctxUsed / ctxWin : 0
      if (ctxRatio >= CONTEXT_PRESSURE_THRESHOLD) {
        const pct = Math.round(ctxRatio * 100)
        issues.push({
          kind: 'member_context_pressure',
          advisory: true,
          memberName: name,
          target: 'coordinator',
          seq: member.last_post_seq || member.brief_seq || 0,
          signature: `member_context_pressure:${name}:${Math.floor(pct / 10) * 10}`,
          title: `Watchdog advisory: @${name} context pressure (${pct}%)`,
          prompt: `@coordinator [CONTEXT_PRESSURE_ALERT] Member @${name} reached ${pct}% context usage (${ctxUsed}/${ctxWin} tokens, tc=${member.tool_call_count ?? 0}). Consider lossless rotation via swarm_add({"adopt_worktree_from": "${name}", ...}) before context degradation.`,
        })
      }
      const errStreak = Number(tele.consecutive_tool_errors ?? member.consecutive_tool_errors) || 0
      if (errStreak >= CONSECUTIVE_TOOL_ERROR_THRESHOLD) {
        const errTool = tele.last_tool_error_name || member.last_tool_error_name || member.last_tool_name || 'tool'
        issues.push({
          kind: 'member_tool_loop',
          advisory: true,
          memberName: name,
          target: 'coordinator',
          seq: member.last_post_seq || member.brief_seq || 0,
          signature: `member_tool_loop:${name}:${errTool}:${Math.floor(errStreak / CONSECUTIVE_TOOL_ERROR_THRESHOLD)}`,
          title: `Watchdog advisory: @${name} hit ${errStreak} consecutive ${errTool} errors`,
          prompt: `@coordinator [TOOL_LOOP_ALERT] Member @${name} hit ${errStreak} consecutive ${errTool} failures (tc=${member.tool_call_count ?? 0}). Inspect and redirect or replace via swarm_kill / swarm_add(adopt_worktree_from).`,
        })
      }
      continue
    }

    if (liveness.status === 'unparked_idle') {
      issues.push({
        kind: 'member_unparked_idle',
        memberName: name,
        target: 'coordinator',
        targets: ['coordinator', name],
        seq: member.last_post_seq || member.brief_seq || 0,
        signature: `member_unparked_idle:${name}:${member.turn_count ?? 0}:${member.last_post_seq ?? 0}`,
        title: `Watchdog alert: @${name} unparked_idle repeatedly (explanation required)`,
        nudgePrompt: `[Watchdog Auto-Resume] @${name} stopped mid-task without calling swarm_wait (turns=${member.turn_count ?? 0}, post=#${member.last_post_seq ?? 0}). Execute your pending step now, post results to the board, and call swarm_wait(since=${member.last_read_seq ?? 0}).`,
        prompt: `@${name} @coordinator [WATCHDOG_ALERT] Member @${name} hit unparked_idle >=2 times within 10m (turns=${member.turn_count ?? 0}, post=#${member.last_post_seq ?? 0}). @${name}: post a concise explanation of your status/blocker on the board now. @coordinator: decide next action (redirect, swarm_model, or swarm_kill + spawn a fresh session).`,
      })
      continue
    }

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
        title: `Watchdog alert: @${name} zombie/never-started`,
        prompt: `@coordinator [WATCHDOG_ALERT] Member @${name} appears to be a zombie / never started (status=${liveness.status}, turns=${member.turn_count ?? 0}, post=#${member.last_post_seq ?? 0}, age=${Math.round(ageMs / 1000)}s). Inspect via swarm_status and clean up via swarm_kill (never-started members release their name for reuse).`,
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
  skipSignatures = null,
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
  }).filter(issue => issue.advisory !== true)
  if (healthIssues.length > 0) {
    const selected = (skipSignatures instanceof Set)
      ? (healthIssues.find(issue => !skipSignatures.has(issue.signature)) ?? healthIssues[0])
      : healthIssues[0]
    return {
      stalled: true,
      kind: selected.kind,
      memberName: selected.memberName,
      target: selected.target,
      seq: selected.seq || latestPost?.seq || 0,
      signature: selected.signature,
      title: selected.title,
      prompt: selected.prompt,
    }
  }

  for (const [name, member] of Object.entries(members)) {
    if (member.killed || member.role === 'monitor') continue
    const liveness = typeof getMemberLiveness === 'function'
      ? getMemberLiveness(name, member, { nowMs, startupGraceMs: startupTimeoutMs })
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
      title: 'Stall alert: empty board and all members idle',
      prompt: '@coordinator [stall] The board has no posts yet and all members are idle. Dispatch tasks or close the Swarm.',
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
      title: `Stall alert: unaddressed post #${latestPost.seq} by @${latestPost.agent}`,
      prompt: `@${target} [stall] @${latestPost.agent} posted #${latestPost.seq} without addressing a recipient. Please inspect #${latestPost.seq} and advance the workflow.`,
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
        title: `Stall alert: unread report #${newestToCoord.seq} for @coordinator`,
        prompt: `@coordinator [stall] Member @${newestToCoord.agent} reported to you at #${newestToCoord.seq} while the entire team is idle. Call read_board and advance.`,
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
          title: `Stall alert: @${targetName} has not replied to #${post.seq}`,
          prompt: `@${targetName} [stall] You were mentioned by @${post.agent} at #${post.seq} but have not replied (last_post_seq=${targetMember.last_post_seq ?? 0}). Call read_board({"since": ${targetMember.last_read_seq ?? 0}}) and respond, or @coordinator if blocked.`,
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
    title: `Stall alert: all members idle after #${latestPost.seq}`,
    prompt: `@coordinator [stall] All members are idle at #${latestPost.seq}. Check progress, launch the next wave, or post [done] to close.`,
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
    unparkedIdleWindowMs = UNPARKED_IDLE_WINDOW_MS,
    onPostStall,
    onAutoNudge,
    getMemberLiveness,
  }) {
    this.store = store
    this.swarmId = swarmId
    this.intervalMs = intervalMs
    this.healthIntervalMs = healthIntervalMs
    this.startupTimeoutMs = startupTimeoutMs
    this.unparkedIdleWindowMs = unparkedIdleWindowMs
    this.onPostStall = onPostStall
    this.onAutoNudge = onAutoNudge
    this.getMemberLiveness = getMemberLiveness

    this.nudgeCounts = new Map()
    this.autoNudgedZombies = new Set()
    this.unparkedIdleHits = new Map()
    this.unparkedIdleEscalatedAt = new Map()
    this.quietTicks = 0
    this.alertsPosted = 0
    this.lastCheckAt = null
    this.lastHealthTickMs = null
    this.sleepGraceBonusMs = 0
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

  // #FUNC Run one fast per-member health inspection across all failing members, compensating for OS sleep jumps and auto-resuming/escalating `unparked_idle`, `zombie`, and `error` seats without alert starvation.
  // #NOT  Never returns early on `issues[0]` suppression when `issues[1..N]` still need nudges or alerts, and never spams repeated 30s board alerts during the same 10-minute window.
  // #EDGE-IN Two `unparked_idle` hits by the same member within 10 minutes post a board alert requiring `@member` explanation and `@coordinator` decision, while a hit after >10 minutes resets cleanly to a direct auto-resume whip → test_blind_audit_alert_two_round_escalation_and_unparked_idle_whip
  // #EDGE-IN When member A is already suppressed at `MAX_NUDGES_PER_STALL` or in its 10m cooldown, `healthTick` still alerts for member B in the same tick → test_watchdog_multi_member_no_starvation_and_sleep_grace
  // #EDGE-IN A wall-clock jump exceeding `healthIntervalMs * 4` extends `sleepGraceBonusMs` so a waking laptop does not false-flag `starting` members as `zombie` → test_watchdog_multi_member_no_starvation_and_sleep_grace
  // #WHY  Iterating all `issues` with `sleepGraceBonusMs` prevents one suppressed member from starving sibling alerts and prevents host sleep pauses from triggering false zombie kills.
  async healthTick(nowMs = Date.now()) {
    if (this.sleeping) return { action: 'sleeping' }
    if (this.lastHealthTickMs !== null) {
      const tickDelta = nowMs - this.lastHealthTickMs
      if (tickDelta > this.healthIntervalMs * 4) {
        this.sleepGraceBonusMs += (tickDelta - this.healthIntervalMs)
      }
    }
    this.lastHealthTickMs = nowMs
    this.lastCheckAt = new Date(nowMs).toISOString()

    const effectiveStartupTimeoutMs = this.startupTimeoutMs + this.sleepGraceBonusMs
    const issues = detectMemberHealthIssues({
      store: this.store,
      swarmId: this.swarmId,
      getMemberLiveness: this.getMemberLiveness,
      nowMs,
      startupTimeoutMs: effectiveStartupTimeoutMs,
    })
    if (issues.length === 0) return { action: 'healthy' }

    const handled = []
    const suppressed = []

    for (const issue of issues) {
      if (issue.kind === 'member_unparked_idle') {
        const lastEscAt = this.unparkedIdleEscalatedAt.get(issue.memberName)
        if (lastEscAt !== undefined && (nowMs - lastEscAt) <= this.unparkedIdleWindowMs) {
          suppressed.push({
            action: 'suppressed_duplicate',
            kind: issue.kind,
            memberName: issue.memberName,
            signature: issue.signature,
          })
          continue
        }

        const recentHits = (this.unparkedIdleHits.get(issue.memberName) ?? [])
          .filter(ts => (nowMs - ts) <= this.unparkedIdleWindowMs)
        recentHits.push(nowMs)
        this.unparkedIdleHits.set(issue.memberName, recentHits)

        if (recentHits.length === 1 && typeof this.onAutoNudge === 'function') {
          const nudged = await this.onAutoNudge(issue.memberName, issue.nudgePrompt ?? null)
          if (nudged) {
            handled.push({
              action: 'auto_nudged_unparked_idle',
              memberName: issue.memberName,
              signature: issue.signature,
              hitsInWindow: 1,
            })
            continue
          }
        }

        this.unparkedIdleEscalatedAt.set(issue.memberName, nowMs)
        this.unparkedIdleHits.delete(issue.memberName)

        if (typeof this.onPostStall === 'function') {
          this.alertsPosted += 1
          await this.onPostStall({
            target: issue.target,
            targets: issue.targets ?? [issue.target, issue.memberName],
            title: issue.title,
            text: issue.prompt,
            kind: 'alert',
            escalate: true,
            refs: issue.seq > 0 ? [issue.seq] : [],
            signature: issue.signature,
            attempt: recentHits.length,
          })
          this.lastSeenHeadSeq = this.store.headSeq(this.swarmId)
        }

        handled.push({
          action: 'health_alert',
          kind: issue.kind,
          memberName: issue.memberName,
          target: issue.target,
          targets: issue.targets ?? [issue.target, issue.memberName],
          signature: issue.signature,
          hitsInWindow: recentHits.length,
          attempt: recentHits.length,
        })
        continue
      }

      if (
        issue.kind === 'member_zombie'
        && !this.autoNudgedZombies.has(issue.signature)
        && typeof this.onAutoNudge === 'function'
      ) {
        this.autoNudgedZombies.add(issue.signature)
        const nudged = await this.onAutoNudge(issue.memberName, issue.nudgePrompt ?? null)
        if (nudged) {
          handled.push({
            action: 'auto_nudged_zombie',
            memberName: issue.memberName,
            signature: issue.signature,
          })
          continue
        }
      }

      const maxStrikes = issue.advisory ? 1 : MAX_NUDGES_PER_STALL
      const prevCount = this.nudgeCounts.get(issue.signature) ?? 0
      if (prevCount >= maxStrikes) {
        suppressed.push({
          action: 'suppressed_duplicate',
          kind: issue.kind,
          memberName: issue.memberName,
          signature: issue.signature,
          count: prevCount + 1,
        })
        continue
      }

      const count = prevCount + 1
      this.nudgeCounts.set(issue.signature, count)

      if (typeof this.onPostStall === 'function') {
        this.alertsPosted += 1
        await this.onPostStall({
          target: issue.target,
          targets: issue.targets,
          title: issue.title,
          text: issue.prompt,
          kind: 'alert',
          escalate: true,
          refs: issue.seq > 0 ? [issue.seq] : [],
          signature: issue.signature,
          attempt: count,
        })
        this.lastSeenHeadSeq = this.store.headSeq(this.swarmId)
      }

      handled.push({
        action: 'health_alert',
        kind: issue.kind,
        memberName: issue.memberName,
        target: issue.target,
        signature: issue.signature,
        attempt: count,
      })
    }

    const primary = handled[0] ?? suppressed[0] ?? { action: 'healthy' }
    return {
      ...primary,
      handled,
      suppressed,
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

    const skipSignatures = new Set()
    for (const [sig, cnt] of this.nudgeCounts.entries()) {
      if (cnt >= MAX_NUDGES_PER_STALL) skipSignatures.add(sig)
    }

    const diagnosis = detectSwarmStall({
      store: this.store,
      swarmId: this.swarmId,
      getMemberLiveness: this.getMemberLiveness,
      nowMs,
      startupTimeoutMs: this.startupTimeoutMs + this.sleepGraceBonusMs,
      skipSignatures,
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
    let title = diagnosis.title || `Stall alert: ${diagnosis.kind}`
    let target = diagnosis.target
    if (count === MAX_NUDGES_PER_STALL && target !== 'coordinator') {
      target = 'coordinator'
      title = `Stall escalation: @${diagnosis.target} unresponsive after ${MAX_NUDGES_PER_STALL} nudges`
      text = `@coordinator [stall] Member @${diagnosis.target} did not respond to #${diagnosis.seq} after ${MAX_NUDGES_PER_STALL} nudges. Check git status, hot-swap model via swarm_model, or replace via swarm_kill + swarm_add.`
    }

    if (typeof this.onPostStall === 'function') {
      this.alertsPosted += 1
      await this.onPostStall({
        target,
        title,
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
