// Stop-Hook race lock (`agent/turn-stopping`) and transcript-based liveness (`statusOf`).
//
// Implements the two core anti-polling mechanisms:
// 1. When an agent is about to finish its turn (either after `swarm_wait` or
//    natural completion), `handleTurnStopping` atomically checks `board.jsonl`:
//      a) If new matching posts arrived after `Math.max(last_read_seq, wait_since)`
//         (respecting `wake_kinds` + `escalate`), it updates `last_park_blocked_seq`
//         and steers a `[board]` wake reminder into `agent.inbox.nextStep`.
//      b) If a worker/architect/verifier forgot to call `swarm_wait`, it blocks
//         termination up to `maxUnparkedBlocks` times to force proper board handoff.
// 2. `statusOf` derives member liveness from the real session transcript tail,
//    `liveAgent`, and `ConcurrencyGate`, explicitly distinguishing `starting`
//    and `zombie` from healthy `waiting`.

import { randomUUID } from 'node:crypto'
import { getRoleSpec } from './prompts.js'

export const DEFAULT_STARTUP_GRACE_MS = 60_000

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
// #NOT  Never infinite-loops: unparked-worker reminders are capped at `maxUnparkedBlocks` per turn, and `wake_kinds` filters out non-subscribed noise.
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

  const baselineSeq = Math.max(member.last_read_seq ?? 0, member.wait_since ?? 0)
  const mentionsOnly = member.wake_mode !== 'anything'
  const unreadMatching = store.queryVisiblePosts(swarmId, memberName, baselineSeq, {
    mentionsOnly,
    wakeKinds: member.wake_kinds,
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
    const notice = `Stop hook: unread ${seqList} -> call read_board(since=${member.last_read_seq ?? 0}).`
    agent.steer(buildSwarmSystemMessage(notice, `Stop hook: unread ${seqList}`))
    return {
      blocked: true,
      reason: 'unread_messages',
      last_park_blocked_seq: newestSeq,
      message: notice,
    }
  }

  // Case 2: Safeguard — any role with `requireParkOnStop` (all non-coordinator roles by default) finished without `swarm_wait`.
  if (
    getRoleSpec(member.role).requireParkOnStop
    && turnState
    && turnState.calledSwarmWait !== true
    && (turnState.unparkedBlockCount ?? 0) < maxUnparkedBlocks
  ) {
    turnState.unparkedBlockCount = (turnState.unparkedBlockCount ?? 0) + 1
    const notice = `Stop hook: unparked -> post handoff if needed, then call swarm_wait(since=${member.last_read_seq ?? 0}).`
    agent.steer(buildSwarmSystemMessage(notice, 'Stop hook: unparked'))
    return {
      blocked: true,
      reason: 'missing_swarm_wait',
      message: notice,
    }
  }

  return { blocked: false }
}

// #FUNC Derive a member's real liveness and current tool step from its session transcript tail, live handle, and concurrency queue.
// #NOT  Never masks a never-started or unreachable zombie member as healthy `waiting`.
// #EDGE-IN A member with `wake_mode: "mentions"` whose transcript ends with an active `tool/call` is reported as `working` → test_liveness_reads_transcript_over_wake_mode
// #WHY  `statusOf` inspects `sessionEvents`, `liveAgent`, `turn_count`, and `concurrencyGate` directly so Coordinator and Watchdog can distinguish `starting`/`zombie` from `waiting`.
export function statusOf(member, {
  liveAgent,
  concurrencyGate,
  sessionEvents = [],
  nowMs = Date.now(),
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
} = {}) {
  if (!member) return { status: 'unknown', stepSummary: null }
  if (member.killed) return { status: 'killed', stepSummary: 'Killed (retired)' }
  if (member.role === 'monitor' && member.system_builtin) {
    return { status: 'daemon', stepSummary: 'Background watchdog timer (0 token standby)' }
  }

  if (member.last_error) {
    const code = member.last_error.code || 'ERROR'
    const msg = member.last_error.message || String(member.last_error)
    return {
      status: 'error',
      stepSummary: `ERROR [${code}]: ${msg}`,
    }
  }

  const sessionId = member.session_id
  if (concurrencyGate && sessionId) {
    const pos = concurrencyGate.queuePositionOf(sessionId)
    if (pos > 0) {
      return {
        status: 'queued',
        stepSummary: `Waiting for LLM slot (#${pos} in queue)`,
      }
    }
    if (concurrencyGate.isStreaming(sessionId)) {
      return {
        status: 'working',
        stepSummary: `Streaming LLM response (${member.applied_model || 'model'})`,
      }
    }
  }

  let latestStepSummary = null
  let lastTurnClosed = true
  let lastTurnError = null
  let lastBatchHadSwarmWaitDone = false

  for (let i = sessionEvents.length - 1; i >= 0; i -= 1) {
    const ev = sessionEvents[i]
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'turn/end') {
      lastTurnClosed = true
      if (ev.data?.reason?.kind === 'error') {
        const err = ev.data.reason.error ?? ev.data.reason.failure
        lastTurnError = err?.message ?? 'Turn ended with error'
      }
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

  if (lastTurnError) {
    return {
      status: 'error',
      stepSummary: `ERROR: ${lastTurnError}`,
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

  const turns = member.turn_count ?? 0
  const lastPost = member.last_post_seq ?? 0
  const createdMs = member.created_at ? Date.parse(member.created_at) : NaN
  const ageMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : 0

  if (member.role !== 'coordinator' && turns === 0 && lastPost === 0) {
    if (member.spawned_live_agent === true && !liveAgent) {
      return {
        status: 'zombie',
        stepSummary: 'Zombie (live session lost before Turn 1; turns=0)',
      }
    }
    if (ageMs >= startupGraceMs) {
      return {
        status: 'zombie',
        stepSummary: `Zombie (never started after ${Math.round(ageMs / 1000)}s; turns=0, live=${Boolean(liveAgent)})`,
      }
    }
    return {
      status: 'starting',
      stepSummary: `Starting Turn 1 (${Math.round(ageMs / 1000)}s elapsed, turns=0)`,
    }
  }

  if (
    getRoleSpec(member.role).requireParkOnStop
    && member.wake_mode === 'working'
    && !lastBatchHadSwarmWaitDone
  ) {
    return {
      status: 'unparked_idle',
      stepSummary: `Unparked idle (stopped after ${turns} turn(s) without swarm_wait; post=#${lastPost})`,
    }
  }

  const wakeLabel = member.wake_mode === 'anything' ? 'anything' : 'mentions'
  const kindsNote = Array.isArray(member.wake_kinds) && member.wake_kinds.length > 0
    ? `, kinds=${member.wake_kinds.join('|')}`
    : ''
  return {
    status: 'waiting',
    stepSummary: `Parked since #${member.wait_since ?? member.last_read_seq ?? 0} (wake=${wakeLabel}${kindsNote}, turns=${turns})`,
  }
}
