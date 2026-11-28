// Pure stateless Swarm event-sourcing projector and checkpointing utility.
//
// Design:
//   - Zero hidden in-memory cache: state is computed deterministically on demand
//     by folding `events.jsonl` through `SwarmStateProjector`.
//   - To keep replay strictly O(1)-bounded even when a swarm accumulates thousands
//     of messages, the store emits a compact `state.checkpoint` frame into
//     `events.jsonl` every `CHECKPOINT_INTERVAL` (50) domain events.
//   - On every projection, `selectAnchorCheckpoint()` automatically picks the
//     SECOND-NEWEST valid checkpoint (falling back to earlier valid checkpoints
//     or genesis if fewer than 2 exist). This guarantees:
//       1. Crash resilience if the newest checkpoint were ever partially written;
//       2. A natural sliding window (~50..100 raw events) of fresh recent history;
//       3. Strictly bounded replay work regardless of total event log length.

import { getRoleSpec } from './prompts.js'

export const CHECKPOINT_INTERVAL = 50
export const CHECKPOINT_RECENT_EDGES_LIMIT = 64

export const DOMAIN_MEMBER_FIELDS = Object.freeze([
  'desired_state',
  'desired_provider',
  'desired_model',
  'applied_provider',
  'applied_model',
  'workspace_mode',
  'worktree_path',
  'base_commit',
  'baseline_tree',
  'last_snapshot_commit',
  'owned_paths',
  'forbidden_paths',
  'adopted_from',
  'worktree_handed_over',
  'review_target',
  'killed',
  'killed_at_seq',
  'handover_to',
  'kill_reason',
  'landed',
  'created_at',
  'role',
  'can_block_merge',
])

/** Format a timestamp in readable ISO-like local/UTC form. */
export function formatTime(now = new Date()) {
  return now.toISOString().replace('T', ' ').slice(0, 19)
}

/** Derive a concise fallback title from the first meaningful line of a post body. */
export function deriveFallbackTitle(text, fallback = 'Board update') {
  if (typeof text !== 'string' || text.trim().length === 0) return fallback
  const firstLine = text
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0) || ''
  const cleaned = firstLine
    .replace(/^(?:@#?[a-z0-9][a-z0-9_-]*\s*)+/i, '')
    .replace(/^#+\s*/, '')
    .trim()
  if (cleaned.length >= 4) return cleaned.slice(0, 96)
  return firstLine.slice(0, 96) || fallback
}

/** Validate whether an event record is a usable version-1 `state.checkpoint` frame. */
export function isValidCheckpointEvent(ev) {
  if (!ev || typeof ev !== 'object' || ev.type !== 'state.checkpoint') return false
  const p = ev.payload
  if (!p || typeof p !== 'object') return false
  if (p.version !== 1) return false
  if (typeof p.headSeq !== 'number' || !Number.isFinite(p.headSeq)) return false
  if (!p.members || typeof p.members !== 'object' || Array.isArray(p.members)) return false
  if (!Array.isArray(p.activeMemberNames)) return false
  if (!Array.isArray(p.channels) || !Array.isArray(p.archivedChannels)) return false
  return true
}

function createEmptyAccumulator() {
  return {
    swarm: null,
    plan: null,
    membersByName: new Map(),
    activeMembers: new Map(),
    activeChannels: new Set(['main']),
    archivedChannels: new Set(),
    subscriptions: new Map(),
    edgeEvents: [],
    board: [],
    lastEvent: null,
    headSeq: 0,
    postCount: 0,
  }
}

function ensureSub(acc, name) {
  if (!acc.subscriptions.has(name)) acc.subscriptions.set(name, new Set(['main']))
  return acc.subscriptions.get(name)
}

function hydrateAccumulatorFromCheckpoint(cpEvent) {
  const p = cpEvent.payload
  const acc = createEmptyAccumulator()
  acc.swarm = p.swarm ? { ...p.swarm } : null
  acc.plan = p.plan
    ? {
        ...p.plan,
        waves: Array.isArray(p.plan.waves) ? p.plan.waves.map(w => ({ ...w })) : [],
        tracks: Array.isArray(p.plan.tracks) ? p.plan.tracks.map(t => ({ ...t })) : [],
      }
    : null
  acc.headSeq = p.headSeq ?? 0
  acc.postCount = p.postCount ?? 0
  acc.lastEvent = cpEvent

  acc.activeChannels = new Set(Array.isArray(p.channels) && p.channels.length > 0 ? p.channels : ['main'])
  acc.archivedChannels = new Set(Array.isArray(p.archivedChannels) ? p.archivedChannels : [])

  const activeSet = new Set(Array.isArray(p.activeMemberNames) ? p.activeMemberNames : [])
  for (const [name, raw] of Object.entries(p.members || {})) {
    if (!raw || typeof raw !== 'object') continue
    const cloned = { ...raw }
    const subs = Array.isArray(cloned.channels) ? cloned.channels : ['main']
    delete cloned.channels
    acc.membersByName.set(name, cloned)
    acc.subscriptions.set(name, new Set(subs.length > 0 ? subs : ['main']))
    if (activeSet.has(name) && cloned.killed !== true) {
      acc.activeMembers.set(name, cloned)
    }
  }

  if (Array.isArray(p.recentEdges)) {
    acc.edgeEvents = p.recentEdges.map(ed => ({ ...ed }))
  }

  return acc
}

function isWithinBounds(ev, { atOffset = Infinity, atTsMs = Infinity, atSeq = Infinity }) {
  if (!ev || typeof ev !== 'object') return false
  if (typeof ev.offset === 'number' && ev.offset > atOffset) return false
  if (typeof ev.ts_ms === 'number' && ev.ts_ms > atTsMs) return false
  if (typeof ev.seq === 'number' && ev.seq > 0 && ev.seq > atSeq) return false
  return true
}

function buildControlRecord(ev, fallbackSeq) {
  const p = ev.payload || {}
  const seq = p.seq ?? ev.seq ?? fallbackSeq
  const ch = typeof p.channel === 'string' ? p.channel.replace(/^#/, '') : ''
  return {
    seq,
    type: 'control',
    action: p.action,
    agent: p.agent ?? ev.actor ?? 'coordinator',
    channel: ch,
    ...(p.target ? { target: p.target } : {}),
    time: p.time || ev.time || formatTime(new Date(ev.ts_ms || Date.now())),
    created_ms: p.created_ms ?? ev.ts_ms ?? 0,
  }
}

function buildPostRecord(ev, fallbackSeq) {
  const p = ev.payload || {}
  const seq = p.seq ?? ev.seq ?? fallbackSeq
  const from = p.agent ?? ev.actor ?? 'coordinator'
  const title = p.title || deriveFallbackTitle(p.text, p.kind || 'post')
  const rawMentions = Array.isArray(p.mentions) ? p.mentions : []
  const rawChannels = Array.isArray(p.channel_mentions) ? p.channel_mentions : []
  return {
    seq,
    type: 'post',
    agent: from,
    channel: (p.channel ?? 'main').replace(/^#/, ''),
    mentions: rawMentions,
    ...(rawChannels.length > 0 ? { channel_mentions: rawChannels } : {}),
    refs: Array.isArray(p.refs) ? p.refs : [],
    kind: p.kind ?? 'report',
    title,
    ...(p.verdict ? { verdict: p.verdict } : {}),
    ...(p.target_member ? { target_member: p.target_member } : {}),
    ...(p.reviewed_diff_hash ? { reviewed_diff_hash: p.reviewed_diff_hash } : {}),
    ...(p.reviewed_diff_hashes && typeof p.reviewed_diff_hashes === 'object' ? { reviewed_diff_hashes: p.reviewed_diff_hashes } : {}),
    ...(p.artifact && typeof p.artifact === 'object' ? { artifact: p.artifact } : {}),
    ...(Array.isArray(p.supersedes) && p.supersedes.length > 0 ? { supersedes: p.supersedes } : {}),
    ...(p.escalate === true ? { escalate: true } : {}),
    ...(p.silent === true ? { silent: true } : {}),
    ...(p.idempotency_key ? { idempotency_key: p.idempotency_key } : {}),
    text: p.text ?? '',
    time: p.time || ev.time || formatTime(new Date(ev.ts_ms || Date.now())),
    created_ms: p.created_ms ?? ev.ts_ms ?? 0,
    origin: p.origin ?? `${from}@local`,
    actor_kind: p.actor_kind ?? 'AGENT',
  }
}

/**
 * Stateless Swarm state computation & checkpointing utility.
 * Computes current or point-in-time state cleanly on demand from `events.jsonl`
 * by anchoring on the second-newest valid `state.checkpoint` frame.
 */
export class SwarmStateProjector {
  // #FUNC Choose the second-newest valid `state.checkpoint` within bounds so replay stays O(1)-bounded and resilient to a torn newest checkpoint.
  // #NOT  Never selects a checkpoint newer than the requested `atOffset`/`atTsMs`/`atSeq` boundary or a malformed checkpoint frame.
  // #EDGE-IN With 3 checkpoints at offsets 50, 100, 150, selects the second-newest at offset 100 and skips earlier events → test_projector_auto_checkpoints_and_replays_from_second_newest
  // #WHY  Anchoring on the second-newest `state.checkpoint` guarantees both crash resilience and a fresh 50..100-event sliding replay window.
  static selectAnchorCheckpoint(events, bounds = {}, interval = CHECKPOINT_INTERVAL) {
    const list = Array.isArray(events) ? events : []
    const validIndices = []
    for (let i = 0; i < list.length; i += 1) {
      const ev = list[i]
      if (!ev || typeof ev !== 'object') continue
      if (!isWithinBounds(ev, bounds)) break
      if (isValidCheckpointEvent(ev)) validIndices.push(i)
    }
    if (validIndices.length >= 2) {
      return validIndices[validIndices.length - 2]
    }
    if (validIndices.length === 1 && list.length - validIndices[0] > interval) {
      return validIndices[0]
    }
    return -1
  }

  /** Apply one domain event onto a mutable projection accumulator. */
  static applyEvent(acc, ev, { collectBoard = false } = {}) {
    if (!ev || typeof ev !== 'object' || ev.type === 'state.checkpoint') return
    acc.lastEvent = ev
    if (typeof ev.seq === 'number' && ev.seq > acc.headSeq) acc.headSeq = ev.seq
    const p = ev.payload || {}
    const evIso = ev.iso_time || (typeof ev.ts_ms === 'number' ? new Date(ev.ts_ms).toISOString() : new Date().toISOString())

    if (ev.type === 'swarm.init') {
      acc.swarm = {
        version: 1,
        swarm_id: p.swarm_id ?? acc.swarm?.swarm_id ?? 'default-swarm',
        generation: p.generation ?? acc.swarm?.generation ?? 1,
        title: p.title ?? acc.swarm?.title ?? 'Untitled Swarm',
        backend: p.backend ?? acc.swarm?.backend ?? 'local',
        status: p.status ?? 'ACTIVE',
        project_root: p.project_root !== undefined ? p.project_root : (acc.swarm?.project_root ?? null),
        concurrency_confirmed: p.concurrency_confirmed ?? acc.swarm?.concurrency_confirmed ?? false,
        concurrency_limit: p.concurrency_limit ?? acc.swarm?.concurrency_limit ?? 4,
        default_provider: p.default_provider ?? acc.swarm?.default_provider ?? 'inherit',
        default_model: p.default_model ?? acc.swarm?.default_model ?? 'inherit',
        coordinator_model: p.coordinator_model ?? acc.swarm?.coordinator_model ?? 'inherit',
        anchors: Array.isArray(p.anchors) ? p.anchors : (acc.swarm?.anchors ?? []),
        created_at: acc.swarm?.created_at ?? p.created_at ?? evIso,
        updated_at: p.updated_at ?? evIso,
      }
      if (!acc.membersByName.has('coordinator')) {
        const coord = {
          name: 'coordinator',
          session_id: acc.swarm.swarm_id,
          role: 'coordinator',
          can_block_merge: false,
          group: null,
          parent: null,
          desired_state: 'RUNNING',
          desired_provider: acc.swarm.default_provider,
          desired_model: acc.swarm.coordinator_model,
          applied_provider: acc.swarm.default_provider,
          applied_model: acc.swarm.coordinator_model,
          workspace_mode: 'inherit',
          worktree_path: null,
          base_commit: null,
          baseline_tree: null,
          fork_from: null,
          spawned_live_agent: true,
          brief_seq: 0,
          born_seq: 0,
          born_offset: ev.offset,
          born_ts_ms: ev.ts_ms,
          last_post_seq: 0,
          killed: false,
          killed_at_seq: null,
          retired_seq: null,
          landed: false,
          created_at: acc.swarm.created_at,
        }
        acc.membersByName.set('coordinator', coord)
        acc.activeMembers.set('coordinator', coord)
        ensureSub(acc, 'coordinator')
      }
    } else if (ev.type === 'swarm.update') {
      if (acc.swarm) {
        acc.swarm = { ...acc.swarm, ...p, updated_at: p.updated_at ?? evIso }
      }
    } else if (ev.type === 'plan.update') {
      acc.plan = {
        version: 1,
        updated_at: p.updated_at ?? evIso,
        goal: p.goal ?? '',
        current_wave: p.current_wave ?? 1,
        anchors: Array.isArray(p.anchors) ? p.anchors : [],
        waves: Array.isArray(p.waves) ? p.waves : [],
        tracks: Array.isArray(p.tracks) ? p.tracks : [],
      }
    } else if (ev.type === 'member.spawn' && p.name) {
      const role = p.role || 'worker'
      const member = {
        name: p.name,
        session_id: p.session_id ?? `${acc.swarm?.swarm_id ?? 'swarm'}__${p.name}`,
        role,
        can_block_merge: p.can_block_merge !== undefined ? Boolean(p.can_block_merge) : getRoleSpec(role).canBlockMerge,
        group: p.group ?? null,
        parent: p.parent ?? 'coordinator',
        desired_state: 'RUNNING',
        desired_provider: p.provider ?? acc.swarm?.default_provider ?? 'inherit',
        desired_model: p.model ?? acc.swarm?.default_model ?? 'inherit',
        applied_provider: p.provider ?? acc.swarm?.default_provider ?? 'inherit',
        applied_model: p.model ?? acc.swarm?.default_model ?? 'inherit',
        workspace_mode: p.workspace_mode ?? 'inherit',
        worktree_path: p.worktree_path ?? null,
        base_commit: p.base_commit ?? null,
        baseline_tree: p.baseline_tree ?? null,
        last_snapshot_commit: p.last_snapshot_commit ?? null,
        owned_paths: Array.isArray(p.owned_paths) ? p.owned_paths : [],
        forbidden_paths: Array.isArray(p.forbidden_paths) ? p.forbidden_paths : [],
        adopted_from: p.adopted_from ?? null,
        worktree_handed_over: p.worktree_handed_over === true,
        review_target: p.review_target ?? null,
        fork_from: p.fork_from ?? null,
        spawned_live_agent: p.spawned_live_agent === true,
        brief_seq: p.brief_seq ?? ev.seq ?? acc.headSeq,
        born_seq: p.brief_seq ?? ev.seq ?? acc.headSeq,
        born_offset: ev.offset,
        born_ts_ms: ev.ts_ms,
        last_post_seq: 0,
        killed: false,
        killed_at_seq: null,
        retired_seq: null,
        handover_to: null,
        kill_reason: null,
        landed: false,
        created_at: p.created_at ?? evIso,
      }
      acc.membersByName.set(p.name, member)
      acc.activeMembers.set(p.name, member)
      ensureSub(acc, p.name)
    } else if (ev.type === 'member.kill' && p.name) {
      acc.activeMembers.delete(p.name)
      if (p.released === true) {
        acc.membersByName.delete(p.name)
      } else {
        const m = acc.membersByName.get(p.name)
        if (m) {
          m.desired_state = 'KILLED'
          m.killed = true
          m.killed_at_seq = p.killed_at_seq ?? ev.seq ?? acc.headSeq
          m.retired_seq = m.killed_at_seq
          m.retired_offset = ev.offset
          m.retired_ts_ms = ev.ts_ms
          if (p.handover_to) m.handover_to = p.handover_to
          if (p.reason) m.kill_reason = p.reason
        }
      }
    } else if (ev.type === 'member.release' && p.name) {
      acc.activeMembers.delete(p.name)
      acc.membersByName.delete(p.name)
    } else if (ev.type === 'member.model_switch' && p.name) {
      const m = acc.membersByName.get(p.name)
      if (m) {
        if (p.desired_provider || p.provider) m.desired_provider = p.desired_provider || p.provider
        if (p.desired_model || p.model) m.desired_model = p.desired_model || p.model
        if (p.applied_provider || p.provider) m.applied_provider = p.applied_provider || p.provider
        if (p.applied_model || p.model) m.applied_model = p.applied_model || p.model
      }
    } else if (ev.type === 'member.patch' && p.name) {
      const m = acc.membersByName.get(p.name)
      if (m) {
        for (const field of DOMAIN_MEMBER_FIELDS) {
          if (p[field] !== undefined) m[field] = p[field]
        }
        if (m.killed === true) {
          acc.activeMembers.delete(p.name)
          m.retired_seq = m.killed_at_seq ?? m.retired_seq ?? acc.headSeq
        }
      }
    } else if (ev.type === 'board.control') {
      const ctrlRec = buildControlRecord(ev, acc.postCount + 1)
      if (ctrlRec.seq > acc.headSeq) acc.headSeq = ctrlRec.seq
      acc.postCount += 1
      if (collectBoard) acc.board.push(ctrlRec)
      if (ctrlRec.agent && acc.membersByName.has(ctrlRec.agent)) {
        acc.membersByName.get(ctrlRec.agent).last_post_seq = Math.max(
          acc.membersByName.get(ctrlRec.agent).last_post_seq ?? 0,
          ctrlRec.seq,
        )
      }
      const ch = ctrlRec.channel
      if (ch && ch !== 'main') {
        if (p.action === 'channel.create') {
          acc.archivedChannels.delete(ch)
          acc.activeChannels.add(ch)
          if (ctrlRec.agent) ensureSub(acc, ctrlRec.agent).add(ch)
        } else if (p.action === 'channel.subscribe') {
          const target = p.target || ctrlRec.agent
          if (acc.activeChannels.has(ch) && target) ensureSub(acc, target).add(ch)
        } else if (p.action === 'channel.unsubscribe') {
          const target = p.target || ctrlRec.agent
          if (target) ensureSub(acc, target).delete(ch)
        } else if (p.action === 'channel.archive') {
          acc.activeChannels.delete(ch)
          acc.archivedChannels.add(ch)
          for (const set of acc.subscriptions.values()) set.delete(ch)
        }
      }
    } else if (ev.type === 'board.post') {
      const postRec = buildPostRecord(ev, acc.postCount + 1)
      if (postRec.seq > acc.headSeq) acc.headSeq = postRec.seq
      acc.postCount += 1
      if (collectBoard) acc.board.push(postRec)
      const from = postRec.agent
      if (acc.membersByName.has(from)) {
        acc.membersByName.get(from).last_post_seq = Math.max(
          acc.membersByName.get(from).last_post_seq ?? 0,
          postRec.seq,
        )
      }

      const rawMentions = postRec.mentions
      const rawChannels = Array.isArray(postRec.channel_mentions) ? postRec.channel_mentions : []
      if (postRec.silent === true || rawMentions.includes('all')) {
        acc.edgeEvents.push({
          offset: ev.offset,
          ts_ms: ev.ts_ms,
          time: postRec.time,
          seq: postRec.seq,
          from,
          to: '__table__',
          broadcast: true,
          kind: postRec.kind,
          title: postRec.title,
        })
      } else {
        const targets = new Set()
        for (const token of rawMentions) {
          if (!token || token === from || token === 'monitor') continue
          if (acc.activeMembers.has(token) || acc.membersByName.has(token)) {
            targets.add(token)
            continue
          }
          for (const [mName, mObj] of acc.activeMembers.entries()) {
            if (mName !== from && mObj.group === token) targets.add(mName)
          }
        }
        if (rawChannels.length > 0) {
          for (const mName of acc.activeMembers.keys()) {
            if (mName === from) continue
            const subs = ensureSub(acc, mName)
            if (rawChannels.some(ch => ch !== 'main' && subs.has(ch))) targets.add(mName)
          }
        }
        if (targets.size === 0) {
          acc.edgeEvents.push({
            offset: ev.offset,
            ts_ms: ev.ts_ms,
            time: postRec.time,
            seq: postRec.seq,
            from,
            to: '__table__',
            broadcast: true,
            kind: postRec.kind,
            title: postRec.title,
          })
        } else {
          for (const t of targets) {
            acc.edgeEvents.push({
              offset: ev.offset,
              ts_ms: ev.ts_ms,
              time: postRec.time,
              seq: postRec.seq,
              from,
              to: t,
              broadcast: false,
              kind: postRec.kind,
              title: postRec.title,
            })
          }
        }
      }
    } else if (ev.type === 'swarm.done') {
      if (acc.swarm) acc.swarm = { ...acc.swarm, status: 'DONE', updated_at: evIso }
    }
  }

  /** Extract board post/control records cleanly from the event log without re-folding full state. */
  static extractBoard(events, bounds = {}) {
    const list = Array.isArray(events) ? events : []
    const board = []
    for (const ev of list) {
      if (!ev || typeof ev !== 'object') continue
      if (!isWithinBounds(ev, bounds)) break
      if (ev.type === 'board.control') {
        board.push(buildControlRecord(ev, board.length + 1))
      } else if (ev.type === 'board.post') {
        board.push(buildPostRecord(ev, board.length + 1))
      }
    }
    return board
  }

  // #FUNC Fold `events.jsonl` into materialized Swarm state starting from the second-newest valid `state.checkpoint` (or genesis).
  // #NOT  Never caches mutable state in memory across calls and never leaks future or retired seats into an earlier point in time.
  // #EDGE-IN Replaying by offset or timestamp across Wave 1 spawn, peer posts, Wave 1 kill, and Wave 2 spawn restores exact historical seats at every point → test_kafka_event_log_replays_exact_state_by_offset_and_timestamp
  // #WHY  Separating stateless event projection into `SwarmStateProjector` keeps storage simple while bounding replay cost via automatic checkpoints.
  static projectState(events, { atOffset = Infinity, atTsMs = Infinity, atSeq = Infinity, includeBoard = false } = {}) {
    const list = Array.isArray(events) ? events : []
    const bounds = { atOffset, atTsMs, atSeq }
    const anchorIdx = SwarmStateProjector.selectAnchorCheckpoint(list, bounds)

    let acc
    let startIdx = 0
    let usedCheckpointOffset = null
    if (anchorIdx >= 0) {
      acc = hydrateAccumulatorFromCheckpoint(list[anchorIdx])
      usedCheckpointOffset = list[anchorIdx].offset ?? null
      startIdx = anchorIdx + 1
    } else {
      acc = createEmptyAccumulator()
    }

    let replayedEvents = 0
    const collectInline = includeBoard && anchorIdx < 0
    for (let i = startIdx; i < list.length; i += 1) {
      const ev = list[i]
      if (!ev || typeof ev !== 'object') continue
      if (!isWithinBounds(ev, bounds)) break
      if (ev.type === 'state.checkpoint') continue
      SwarmStateProjector.applyEvent(acc, ev, { collectBoard: collectInline })
      replayedEvents += 1
    }

    const board = includeBoard
      ? (collectInline ? acc.board : SwarmStateProjector.extractBoard(list, bounds))
      : []

    const membersObj = {}
    for (const [name, m] of acc.membersByName.entries()) {
      const subs = acc.subscriptions.get(name)
      membersObj[name] = {
        ...m,
        channels: subs ? [...subs] : ['main'],
      }
    }

    return {
      offset: acc.lastEvent?.offset ?? 0,
      ts_ms: acc.lastEvent?.ts_ms ?? 0,
      time: acc.lastEvent?.time ?? '',
      headSeq: acc.headSeq,
      postCount: acc.postCount,
      status: acc.swarm?.status ?? 'ACTIVE',
      swarm: acc.swarm,
      plan: acc.plan,
      board,
      members: membersObj,
      activeMembers: [...acc.activeMembers.values()],
      channels: [...acc.activeChannels],
      archivedChannels: [...acc.archivedChannels],
      edgeEvents: acc.edgeEvents,
      lastEvent: acc.lastEvent,
      replayMeta: {
        usedCheckpointOffset,
        replayedEvents,
        totalEvents: list.length,
      },
    }
  }

  /** Build a compact, self-contained `state.checkpoint` payload from a projected state. */
  static createCheckpointPayload(projection) {
    return {
      version: 1,
      checkpoint_at_offset: projection.offset,
      headSeq: projection.headSeq,
      postCount: projection.postCount,
      swarm: projection.swarm ? { ...projection.swarm } : null,
      plan: projection.plan ? { ...projection.plan } : null,
      members: projection.members || {},
      activeMemberNames: Array.isArray(projection.activeMembers)
        ? projection.activeMembers.map(m => m.name)
        : [],
      channels: Array.isArray(projection.channels) ? [...projection.channels] : ['main'],
      archivedChannels: Array.isArray(projection.archivedChannels) ? [...projection.archivedChannels] : [],
      recentEdges: Array.isArray(projection.edgeEvents)
        ? projection.edgeEvents.slice(-CHECKPOINT_RECENT_EDGES_LIMIT)
        : [],
    }
  }

  /** Return true when `interval` or more domain events have been appended since the latest valid checkpoint. */
  static shouldEmitCheckpoint(events, interval = CHECKPOINT_INTERVAL) {
    if (!Number.isFinite(interval) || interval <= 0) return false
    const list = Array.isArray(events) ? events : []
    let domainCountSinceCheckpoint = 0
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const ev = list[i]
      if (!ev || typeof ev !== 'object') continue
      if (isValidCheckpointEvent(ev)) break
      if (ev.type !== 'state.checkpoint') domainCountSinceCheckpoint += 1
    }
    return domainCountSinceCheckpoint >= interval
  }
}

/** Backwards-compatible functional alias for `SwarmStateProjector.projectState(..., { includeBoard: true })`. */
export function replaySwarmEvents(events, opts = {}) {
  return SwarmStateProjector.projectState(events, {
    ...opts,
    includeBoard: opts.includeBoard !== false,
  })
}
