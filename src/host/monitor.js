// Anti-deadlock background watchdog (`@monitor`).
//
// Runs a non-blocking periodic check (default every 3 minutes) that:
//   1. Immediately skips (0 token cost) if ANY member is currently `working` OR
//      `queued` in `ConcurrencyGate` waiting for an LLM concurrency slot.
//   2. Inspects the 5 stall conditions using `last_post_seq` (not `wait_since`,
//      because a failed model round can advance `wait_since` without posting!).
//   3. Limits reminders for the same stall signature to at most 3 nudges.
//   4. Auto-sleeps after 5 quiet ticks (15 minutes) with no board activity or
//      when `[done]` is posted, and automatically wakes when new board posts arrive.

import { statusOf } from './stop-hook.js'

export const MAX_NUDGES_PER_STALL = 3
export const AUTO_SLEEP_QUIET_TICKS = 5

// #FUNC Diagnose whether an idle swarm has hit one of the 5 deadlock conditions.
// #NOT  Never flags a stall while any member is `working` or `queued` for a concurrency slot.
// #EDGE-IN A member mentioned at `#14` whose `wait_since` moved to `14` on a failed turn but `last_post_seq` is still `0` is flagged as `mentioned_silent` → test_monitor_uses_last_post_seq_not_wait_since
// #EDGE-IN When a member is queued in `ConcurrencyGate`, `detectSwarmStall` returns `{ stalled: false, reason: 'member_busy_or_queued' }` → test_monitor_skips_when_member_queued_for_concurrency
// #WHY  `last_post_seq` is the only reliable proof that a mentioned member actually delivered a reply to `board.jsonl`.
export function detectSwarmStall({ store, swarmId, getMemberLiveness }) {
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

  // First check if ANY non-monitor member is currently working or queued for an LLM slot
  for (const [name, member] of Object.entries(members)) {
    if (member.killed || member.role === 'monitor') continue
    const liveness = typeof getMemberLiveness === 'function'
      ? getMemberLiveness(name, member)
      : statusOf(member)
    if (liveness.status === 'working' || liveness.status === 'queued') {
      return {
        stalled: false,
        reason: 'member_busy_or_queued',
        busyMember: name,
        busyStatus: liveness.status,
      }
    }
  }

  // Condition 0: A member crashed with a runtime/adapter error (`last_error`) -> alert Coordinator immediately
  for (const [name, member] of Object.entries(members)) {
    if (member.killed || member.role === 'monitor' || member.role === 'coordinator') continue
    if (member.last_error) {
      const errCode = member.last_error.code || 'ERROR'
      const errMsg = member.last_error.message || String(member.last_error)
      return {
        stalled: true,
        kind: 'member_error',
        target: 'coordinator',
        seq: latestPost?.seq ?? 0,
        signature: `member_error:${name}:${errCode}`,
        prompt: `@coordinator [stall] 成员 @${name} 执行异常中止 (${errCode}: ${errMsg})，turn_count=${member.turn_count ?? 0}，last_post_seq=${member.last_post_seq ?? 0}。请调用 swarm_status 查看详情，执行模型热切 (swarm_model)、重建成员或降级处理。`,
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

  // Condition 1: Latest post forgot to @mention anyone (orphan report)
  const latestMentions = latestPost.mentions ?? []
  const latestChannelMentions = latestPost.channel_mentions ?? []
  if (
    latestPost.agent !== 'coordinator'
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
      p => p.agent !== 'coordinator' && ((p.mentions ?? []).includes('coordinator') || (p.mentions ?? []).includes('all')),
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
    const targets = store.resolveTargetsForPost(swarmId, post)
    for (const targetName of targets) {
      const targetMember = members[targetName]
      if (!targetMember || targetMember.killed || targetMember.role === 'monitor') continue
      // R6: Do NOT false-alarm a verifier on its opening brief while upstream workers have not posted any report yet!
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
 * Stateful per-swarm Monitor controller with 3-strike escalation and 5-tick auto-sleep.
 */
export class SwarmMonitorDaemon {
  constructor({ store, swarmId, intervalMs = 180_000, onPostStall, getMemberLiveness }) {
    this.store = store
    this.swarmId = swarmId
    this.intervalMs = intervalMs
    this.onPostStall = onPostStall
    this.getMemberLiveness = getMemberLiveness

    this.nudgeCounts = new Map() // signature -> count
    this.quietTicks = 0
    this.lastSeenHeadSeq = this.store ? this.store.headSeq(this.swarmId) : 0
    this.sleeping = false
    this.timer = null
  }

  start() {
    this.sleeping = false
    this.quietTicks = 0
    this.lastSeenHeadSeq = this.store.headSeq(this.swarmId)
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop() {
    this.sleeping = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
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

  // #FUNC Execute one monitor inspection tick, enforcing the 3-nudge cap and 5-tick auto-sleep rule.
  // #NOT  Does not keep posting after `MAX_NUDGES_PER_STALL` or after `AUTO_SLEEP_QUIET_TICKS` idle cycles.
  // #EDGE-OUT Reaching 3 nudges for the same stall escalates to `@coordinator` and stops repeating → test_monitor_three_strike_cap_and_auto_sleep
  // #WHY  `AUTO_SLEEP_QUIET_TICKS` prevents an abandoned swarm from firing daemon checks forever.
  async tick() {
    if (this.sleeping) return { action: 'sleeping' }
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
      await this.onPostStall({
        target,
        text,
        kind: 'alert',
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
