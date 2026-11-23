// Stop-Hook race lock (`agent/turn-stopping`) and transcript-based liveness (`statusOf`).
//
// Implements the two core anti-polling mechanisms from the AGY Swarm design:
// 1. When an agent is about to finish its turn (either after `swarm_wait` or
//    natural completion), `handleTurnStopping` atomically checks `board.jsonl`:
//      a) If new matching posts arrived after `Math.max(last_read_seq, wait_since)`,
//         it updates `last_park_blocked_seq = headSeq` and steers a `[board]`
//         wake reminder into `agent.inbox.nextStep`, blocking termination.
//      b) If a `glm5.3` / `deepseek4.1f` worker/verifier forgot to call `swarm_wait`
//         and forgot to post a report during its turn, it blocks termination up to
//         `maxUnparkedBlocks` times to force proper board handoff.
// 2. `statusOf` derives member liveness from the real session transcript tail
//    and the `ConcurrencyGate` queue rather than blindly trusting `wake_mode`.

import { randomUUID } from 'node:crypto'

/** Construct a DSH UserMessage suitable for `agent.steer()` or `agent.inject()`. */
export function buildSwarmSystemMessage(text, summary = 'Swarm board notification') {
  return {
    id: `msg_${randomUUID()}`,
    role: 'user',
    source: {
      kind: 'user',
      form: 'notice',
      summary,
    },
    content: [{ type: 'text', text }],
  }
}

// #FUNC Block turn termination on `agent/turn-stopping` when unread board messages arrived or a worker forgot `swarm_wait`.
// #NOT  Never infinite-loops: unparked-worker reminders are capped at `maxUnparkedBlocks` per turn.
// #EDGE-IN A new board mention arriving right after `swarm_wait(10)` sets `last_park_blocked_seq: 11` and steers the agent → test_stop_hook_blocks_on_race_message
// #EDGE-IN A worker ending its turn without calling `swarm_wait` is intercepted and told to post/park → test_stop_hook_catches_worker_forgetting_swarm_wait
// #WHY  `last_park_blocked_seq` records the exact floor where the Stop Hook prevented a missed-wakeup race condition.
export function handleTurnStopping({
  store,
  swarmId,
  memberName,
  agent,
  turnState,
  maxUnparkedBlocks = 2,
}) {
  if (!store || !swarmId || !memberName || !agent) return { blocked: false }
  const swarm = store.readSwarm(swarmId)
  if (!swarm || swarm.status !== 'ACTIVE') return { blocked: false }

  const members = store.readMembers(swarmId)
  const member = members[memberName]
  if (!member || member.killed) return { blocked: false }

  const headSeq = store.headSeq(swarmId)
  const baselineSeq = Math.max(member.last_read_seq ?? 0, member.wait_since ?? 0)
  const mentionsOnly = member.wake_mode !== 'anything'
  const unreadMatching = store.queryVisiblePosts(swarmId, memberName, baselineSeq, {
    mentionsOnly,
  })

  // Case 1: New relevant messages landed on `board.jsonl` before the turn closed!
  if (unreadMatching.length > 0) {
    const newestSeq = unreadMatching[unreadMatching.length - 1].seq
    const seqList = unreadMatching.map(p => `#${p.seq}`).join(', ')
    store.updateMember(swarmId, memberName, current => ({
      ...current,
      last_park_blocked_seq: newestSeq,
      last_nudged_seq: Math.max(current.last_nudged_seq ?? 0, newestSeq),
      wake_mode: 'working',
    }))
    const notice = `Stop hook blocked termination: [board] new messages arrived (${seqList}); call read_board({"since": ${member.last_read_seq ?? 0}}) before waiting again.`
    agent.steer(buildSwarmSystemMessage(notice, `Stop hook: unread board posts ${seqList}`))
    return {
      blocked: true,
      reason: 'unread_messages',
      last_park_blocked_seq: newestSeq,
      message: notice,
    }
  }

  // Case 2: Safeguard for glm5.3 / deepseek4.1f — worker or verifier finished its step
  // without calling `swarm_wait` AND without posting `[done]`.
  if (
    (member.role === 'worker' || member.role === 'verifier')
    && turnState
    && turnState.calledSwarmWait !== true
    && (turnState.unparkedBlockCount ?? 0) < maxUnparkedBlocks
  ) {
    turnState.unparkedBlockCount = (turnState.unparkedBlockCount ?? 0) + 1
    const notice = `Stop hook blocked termination: 你尚未调用 post_board 汇报结果，也没有调用 swarm_wait({"since": ${member.last_read_seq ?? 0}}) 进入休眠！请先发帖点名 @verifier 或 @coordinator，然后必须调用 swarm_wait 结束本轮。`
    agent.steer(buildSwarmSystemMessage(notice, 'Stop hook: missing swarm_wait'))
    return {
      blocked: true,
      reason: 'missing_swarm_wait',
      message: notice,
    }
  }

  return { blocked: false }
}

// #FUNC Derive a member's real liveness and current tool step from its session transcript tail and concurrency queue.
// #NOT  Does not blindly trust `member.wake_mode`, because a human message or callback can wake a sleeping agent without flipping `wake_mode`.
// #EDGE-IN A member with `wake_mode: "mentions"` whose transcript ends with an active `tool/call` is reported as `working` → test_liveness_reads_transcript_over_wake_mode
// #WHY  `statusOf` inspects `sessionEvents` and `concurrencyGate` directly so the UI and `@monitor` never misclassify a running tool or queued LLM call as sleeping.
export function statusOf(member, { liveAgent, concurrencyGate, sessionEvents = [] } = {}) {
  if (!member) return { status: 'unknown', stepSummary: null }
  if (member.killed) return { status: 'killed', stepSummary: 'Killed (retired)' }

  const sessionId = member.session_id
  if (concurrencyGate && sessionId) {
    const pos = concurrencyGate.queuePositionOf(sessionId)
    if (pos > 0) {
      return {
        status: 'queued',
        stepSummary: `Waiting for concurrency slot (#${pos} in queue)`,
      }
    }
    if (concurrencyGate.isStreaming(sessionId)) {
      return {
        status: 'working',
        stepSummary: `Streaming response (${member.applied_model || 'model'})`,
      }
    }
  }

  // Inspect tail of sessionEvents (analogous to reading the tail of transcript.jsonl)
  let latestStepSummary = null
  let lastTurnClosed = true
  let lastBatchHadSwarmWaitDone = false

  for (let i = sessionEvents.length - 1; i >= 0; i -= 1) {
    const ev = sessionEvents[i]
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'turn/end') {
      lastTurnClosed = true
      break
    }
    if (ev.type === 'turn/start' || ev.type === 'step/start') {
      lastTurnClosed = false
      break
    }
    if (ev.type === 'tool/result') {
      const data = ev.data || {}
      const text = JSON.stringify(data.content ?? '')
      if (text.includes('"status":"DONE"') || text.includes('parked_at_seq')) {
        lastBatchHadSwarmWaitDone = true
      }
    }
    if (ev.type === 'tool/call' && !latestStepSummary) {
      const data = ev.data || {}
      const toolName = data.name || 'tool'
      if (toolName === 'swarm_wait') {
        lastBatchHadSwarmWaitDone = true
      } else {
        const argPreview = typeof data.arguments === 'string'
          ? data.arguments.slice(0, 60)
          : JSON.stringify(data.arguments ?? {}).slice(0, 60)
        latestStepSummary = `${toolName}: ${argPreview}`
      }
    }
  }

  if (liveAgent && liveAgent.status === 'running' && !lastBatchHadSwarmWaitDone) {
    return {
      status: 'working',
      stepSummary: latestStepSummary ?? 'Running turn',
    }
  }

  if (!lastTurnClosed && !lastBatchHadSwarmWaitDone) {
    return {
      status: 'working',
      stepSummary: latestStepSummary ?? 'Executing step',
    }
  }

  return {
    status: 'waiting',
    stepSummary: `Waiting since #${member.wait_since ?? member.last_read_seq ?? 0} (${member.wake_mode ?? 'mentions'})`,
  }
}
