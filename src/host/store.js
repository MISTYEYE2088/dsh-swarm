// Two-file Single-Source-of-Truth (SSOT) Swarm store:
//   1. `<rootDir>/<swarmId>/events.jsonl`  — Kafka-style append-only immutable log
//      (SINGLE source of truth for ALL domain facts: swarm config, plan, members,
//      spawns, kills, model switches, board posts, channel control frames, closure).
//   2. `<rootDir>/<swarmId>/offsets.json`  — Mutable per-member consumer offsets
//      & ephemeral runtime telemetry ONLY (read/wait/nudge cursors, wake_mode,
//      wake_kinds, turn/tool counts, last_error). ZERO domain facts duplicated here!
//
// Also seamlessly reads legacy pre-v0.3.4 directories (`swarm.json` / `board.jsonl`
// / `members.json` / `plan.json`) by synthesizing an equivalent event stream.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CHECKPOINT_INTERVAL,
  DOMAIN_MEMBER_FIELDS,
  SwarmStateProjector,
  deriveFallbackTitle,
  formatTime,
  replaySwarmEvents,
} from './projector.js'

export {
  CHECKPOINT_INTERVAL,
  SwarmStateProjector,
  deriveFallbackTitle,
  formatTime,
  replaySwarmEvents,
}

export const PLAN_MAX_BYTES = 65_536
export const VALID_POST_KINDS = Object.freeze(['brief', 'report', 'question', 'review', 'decision', 'alert', 'done'])
export const VALID_VERDICTS = Object.freeze(['approve', 'reject', 'override'])

export const OFFSET_FIELDS = Object.freeze([
  'wake_mode',
  'wake_kinds',
  'wait_since',
  'last_read_seq',
  'last_nudged_seq',
  'last_park_blocked_seq',
  'turn_count',
  'tool_call_count',
  'last_turn_at',
  'last_tool_call_at',
  'last_tool_name',
  'last_error',
  'phase',
])
const OFFSET_FIELD_SET = new Set(OFFSET_FIELDS)

const RETRYABLE_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms) {
  if (ms <= 0) return
  try {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Fallback busy wait only if Atomics.wait is disallowed on main thread
    }
  }
}

/** Resolve default swarm storage root under DSH_HOME or ~/.dsh/swarm. */
export function defaultSwarmRoot(env = process.env) {
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'swarm')
}

// #FUNC Atomically write a JSON object to disk using a sibling temp file and Windows-NTFS-resilient rename.
// #NOT  Does not leave orphaned `.tmp` files behind or fail permanently on transient Windows `EPERM`/`EBUSY` rename locks.
// #EDGE-IN Concurrent writes to the same path are serialized by the caller's mutex and retry transient EPERM → test_atomic_store_roundtrip
// #WHY  `renameSync` replaces the destination atomically on POSIX and NTFS, while bounded backoff + fallback avoids transient Windows indexer/AV `EPERM` lock failures.
export function writeJsonAtomicSync(filePath, value) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  const payload = JSON.stringify(value, null, 2) + '\n'
  fs.writeFileSync(tempPath, payload, 'utf8')

  const delays = [5, 12, 25, 45, 75, 100]
  try {
    let lastErr = null
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        fs.renameSync(tempPath, filePath)
        return
      } catch (err) {
        lastErr = err
        if (!RETRYABLE_FS_CODES.has(err?.code)) throw err
        if (attempt < delays.length) sleepSync(delays[attempt])
      }
    }
    if (lastErr && RETRYABLE_FS_CODES.has(lastErr.code)) {
      fs.writeFileSync(filePath, payload, 'utf8')
      return
    }
    throw lastErr
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch {
      // Best-effort temp cleanup
    }
  }
}

/** Read and parse a JSON file, returning fallback if the file does not exist. */
export function readJsonSync(filePath, fallback = undefined) {
  if (!fs.existsSync(filePath)) return fallback
  const text = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(text)
}

/** Read and parse a newline-delimited JSONL file, ignoring truncated trailing lines. */
export function readJsonlSync(filePath) {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf8')
  const lines = raw.split('\n').filter(line => line.trim().length > 0)
  const records = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      // Ignore truncated trailing line on crash recovery
    }
  }
  return records
}

// #FUNC Replay control frames up to `atSeq` to compute existing channels and member subscriptions.
// #NOT  Does not trust cached channel lists as historical truth.
// #EDGE-IN Archiving a channel removes it from active channels at later seqs → test_event_sourced_channels_replay
// #WHY  `type === 'control'` frames allow the UI and router to reconstruct channel visibility at any historical floor.
export function replayChannelsAt(records, atSeq = Infinity) {
  const activeChannels = new Set(['main'])
  const archivedChannels = new Set()
  const subscriptions = new Map()

  function ensureMember(name) {
    if (!subscriptions.has(name)) subscriptions.set(name, new Set(['main']))
    return subscriptions.get(name)
  }

  for (const rec of records) {
    if (!rec || typeof rec.seq !== 'number' || rec.seq > atSeq) continue
    if (rec.agent && typeof rec.agent === 'string') ensureMember(rec.agent)
    if (rec.type !== 'control') continue
    const ch = typeof rec.channel === 'string' ? rec.channel.replace(/^#/, '') : ''
    if (!ch || ch === 'main') continue

    if (rec.action === 'channel.create') {
      archivedChannels.delete(ch)
      activeChannels.add(ch)
      if (rec.agent) ensureMember(rec.agent).add(ch)
    } else if (rec.action === 'channel.subscribe') {
      const target = rec.target || rec.agent
      if (activeChannels.has(ch) && target) ensureMember(target).add(ch)
    } else if (rec.action === 'channel.unsubscribe') {
      const target = rec.target || rec.agent
      if (target) ensureMember(target).delete(ch)
    } else if (rec.action === 'channel.archive') {
      activeChannels.delete(ch)
      archivedChannels.add(ch)
      for (const set of subscriptions.values()) set.delete(ch)
    }
  }

  return {
    channels: [...activeChannels],
    archived: [...archivedChannels],
    subscriptionsOf(memberName) {
      const set = subscriptions.get(memberName)
      return set ? [...set] : ['main']
    },
  }
}

/** Extract `@name` and `@#channel` mentions from markdown text. */
export function extractMentionsFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return { members: [], channels: [] }
  const members = new Set()
  const channels = new Set()
  const regex = /(?:^|[^a-zA-Z0-9_/-])@(#?[a-z0-9][a-z0-9_-]*)/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const token = match[1]
    if (token.startsWith('#')) {
      channels.add(token.slice(1))
    } else {
      members.add(token)
    }
  }
  return { members: [...members], channels: [...channels] }
}

/** Extract `#12` floor reference integers from markdown text. */
export function extractRefsFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const refs = new Set()
  const regex = /(?:^|[^a-zA-Z0-9_&#/-])#([1-9][0-9]*)\b/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const num = Number(match[1])
    if (Number.isSafeInteger(num) && num >= 1) refs.add(num)
  }
  return [...refs]
}

/** Extract `Screenshot: <path> | <caption>` entries for the Overview Progress Reel. */
export function extractScreenshotsFromPosts(posts) {
  const reel = []
  const regex = /^Screenshot:\s*([^|\n]+?)\s*\|\s*(.+)$/gm
  for (const post of posts) {
    if (!post || post.type === 'control' || typeof post.text !== 'string') continue
    let match
    while ((match = regex.exec(post.text)) !== null) {
      reel.push({
        seq: post.seq,
        agent: post.agent,
        path: match[1].trim(),
        caption: match[2].trim(),
        time: post.time,
      })
    }
  }
  return reel
}

/** Compute a map of `supersededSeq -> supersedingSeq` from `supersedes` fields in board records. */
export function computeSupersededMap(records) {
  const supersededBy = new Map()
  for (const rec of records) {
    if (!rec || rec.type === 'control' || !Array.isArray(rec.supersedes)) continue
    for (const oldSeq of rec.supersedes) {
      const n = Number(oldSeq)
      if (Number.isSafeInteger(n) && n >= 1 && n < rec.seq) {
        supersededBy.set(n, rec.seq)
      }
    }
  }
  return supersededBy
}

/** Pick only consumer-offset / live-telemetry keys for `offsets.json` (zero domain facts!). */
function extractOffsetFields(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const key of OFFSET_FIELDS) {
    if (obj[key] !== undefined) out[key] = obj[key]
  }
  return out
}

function defaultOffsetsForRole(role, briefSeq = 0) {
  return {
    wake_mode: role === 'coordinator' ? 'anything' : 'working',
    wake_kinds: null,
    wait_since: briefSeq,
    last_read_seq: briefSeq,
    last_nudged_seq: briefSeq,
    last_park_blocked_seq: 0,
    turn_count: 0,
    tool_call_count: 0,
    last_turn_at: null,
    last_tool_call_at: null,
    last_tool_name: null,
    last_error: null,
    phase: 'RUNNING',
  }
}

/**
 * Per-Swarm SSOT store:
 *   - `events.jsonl`: Single source of truth for all immutable domain facts.
 *   - `offsets.json`: Consumer read/wait cursors and runtime telemetry only.
 */
export class SwarmStore {
  constructor(baseDir = defaultSwarmRoot(), options = {}) {
    this.baseDir = baseDir
    this.locks = new Map()
    this.checkpointInterval = typeof options.checkpointInterval === 'number'
      ? options.checkpointInterval
      : CHECKPOINT_INTERVAL
  }

  dirOf(swarmId) {
    const safeId = String(swarmId).replace(/[^a-zA-Z0-9_.-]/g, '_')
    return path.join(this.baseDir, safeId)
  }

  pathsOf(swarmId) {
    const dir = this.dirOf(swarmId)
    return {
      dir,
      eventsJsonl: path.join(dir, 'events.jsonl'),
      offsetsJson: path.join(dir, 'offsets.json'),
      // Legacy pre-v0.3.4 paths (read-only fallback for old sessions on disk)
      legacySwarmJson: path.join(dir, 'swarm.json'),
      legacyBoardJsonl: path.join(dir, 'board.jsonl'),
      legacyMembersJson: path.join(dir, 'members.json'),
      legacyPlanJson: path.join(dir, 'plan.json'),
    }
  }

  /** Serialize async mutations per swarmId so offsets and board seqs never race. */
  async withLock(swarmId, fn) {
    const prev = this.locks.get(swarmId) ?? Promise.resolve()
    let release
    const gate = new Promise(resolve => { release = resolve })
    this.locks.set(swarmId, prev.then(() => gate, () => gate))
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(swarmId) === gate) this.locks.delete(swarmId)
    }
  }

  exists(swarmId) {
    if (!swarmId) return false
    const p = this.pathsOf(swarmId)
    return fs.existsSync(p.eventsJsonl) || fs.existsSync(p.legacySwarmJson)
  }

  // #FUNC Ensure legacy pre-v0.3.4 swarms are losslessly migrated into `events.jsonl` before appending new events.
  // #NOT  Never overwrites an already-valid `events.jsonl` that contains a `swarm.init` frame.
  // #EDGE-IN Calling `updateSwarm` (e.g. clicking Adjust slots) on a legacy swarm preserves 100% of legacy board/member/plan history → test_legacy_swarm_mutation_preserves_full_history_and_self_heals
  // #WHY  Appending a bare `swarm.update` into a brand-new `events.jsonl` without migrating `swarm.json`/`board.jsonl` first would shadow legacy history.
  _ensureLegacyMigrated(swarmId) {
    const paths = this.pathsOf(swarmId)
    const raw = this.readRawEvents(swarmId)
    if (!fs.existsSync(paths.legacySwarmJson)) return raw
    if (raw.length > 0 && raw.some(e => e && e.type === 'swarm.init')) return raw

    const merged = this.readEventLog(swarmId)
    if (merged.length > 0) {
      const payload = merged.map(ev => JSON.stringify(ev)).join('\n') + '\n'
      const tempPath = `${paths.eventsJsonl}.${process.pid}.${Date.now()}.migrate.tmp`
      fs.writeFileSync(tempPath, payload, 'utf8')
      try {
        fs.renameSync(tempPath, paths.eventsJsonl)
      } catch {
        fs.writeFileSync(paths.eventsJsonl, payload, 'utf8')
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath) } catch {}
      }
      if (!fs.existsSync(paths.offsetsJson) && fs.existsSync(paths.legacyMembersJson)) {
        this.writeOffsets(swarmId, this.readOffsets(swarmId))
      }
    }
    return merged
  }

  /** Append one immutable Kafka-style event to `events.jsonl` and emit a `state.checkpoint` every `checkpointInterval` domain events. */
  appendEvent(swarmId, { type, actor = 'coordinator', seq = null, ts_ms = Date.now(), time = null, payload = {} }) {
    const paths = this.pathsOf(swarmId)
    fs.mkdirSync(paths.dir, { recursive: true })
    const existing = this._ensureLegacyMigrated(swarmId)
    const nextOffset = existing.length === 0 ? 1 : existing[existing.length - 1].offset + 1
    const eventTime = time || formatTime(new Date(ts_ms))
    const frame = {
      offset: nextOffset,
      ts_ms,
      time: eventTime,
      type,
      ...(typeof seq === 'number' && seq > 0 ? { seq } : {}),
      actor,
      payload,
    }
    fs.appendFileSync(paths.eventsJsonl, JSON.stringify(frame) + '\n', 'utf8')

    // Automatically emit a compact `state.checkpoint` frame every `checkpointInterval` domain events
    // so state computation stays strictly O(1)-bounded even on multi-thousand-event swarms.
    if (type !== 'state.checkpoint' && this.checkpointInterval > 0) {
      const updatedEvents = [...existing, frame]
      if (SwarmStateProjector.shouldEmitCheckpoint(updatedEvents, this.checkpointInterval)) {
        const projection = SwarmStateProjector.projectState(updatedEvents, { includeBoard: false })
        const cpTs = Date.now()
        const cpFrame = {
          offset: nextOffset + 1,
          ts_ms: Math.max(ts_ms, cpTs),
          time: formatTime(new Date(Math.max(ts_ms, cpTs))),
          type: 'state.checkpoint',
          ...(projection.headSeq > 0 ? { seq: projection.headSeq } : {}),
          actor: 'system',
          payload: SwarmStateProjector.createCheckpointPayload(projection),
        }
        fs.appendFileSync(paths.eventsJsonl, JSON.stringify(cpFrame) + '\n', 'utf8')
      }
    }

    return frame
  }

  /** Read raw events from `events.jsonl` without legacy synthesis. */
  readRawEvents(swarmId) {
    return readJsonlSync(this.pathsOf(swarmId).eventsJsonl)
  }

  /** Read consumer offsets / live telemetry from `offsets.json` (or fallback from legacy `members.json`). */
  readOffsets(swarmId) {
    const p = this.pathsOf(swarmId)
    if (fs.existsSync(p.offsetsJson)) {
      return readJsonSync(p.offsetsJson, {})
    }
    if (fs.existsSync(p.legacyMembersJson)) {
      const legacy = readJsonSync(p.legacyMembersJson, {})
      const extracted = {}
      for (const [name, m] of Object.entries(legacy)) {
        if (m && typeof m === 'object') extracted[name] = extractOffsetFields(m)
      }
      return extracted
    }
    return {}
  }

  /** Persist consumer offsets / live telemetry ONLY to `offsets.json` (never domain facts). */
  writeOffsets(swarmId, offsetsMap) {
    const cleaned = {}
    for (const [name, entry] of Object.entries(offsetsMap || {})) {
      cleaned[name] = extractOffsetFields(entry)
    }
    writeJsonAtomicSync(this.pathsOf(swarmId).offsetsJson, cleaned)
    return cleaned
  }

  /** Update consumer offsets/telemetry for one or more members atomically in `offsets.json`. */
  flushOffsets(swarmId, updatesByMember) {
    const offsets = this.readOffsets(swarmId)
    let changed = false
    for (const [name, patch] of Object.entries(updatesByMember || {})) {
      const filtered = extractOffsetFields(patch)
      if (Object.keys(filtered).length === 0) continue
      offsets[name] = { ...(offsets[name] || {}), ...filtered }
      changed = true
    }
    if (changed) this.writeOffsets(swarmId, offsets)
    return offsets
  }

  /** Read the ordered Kafka-style event log for `swarmId` (auto-synthesizing & self-healing legacy pre-v0.3.4 dirs). */
  readEventLog(swarmId) {
    const raw = this.readRawEvents(swarmId)
    const p = this.pathsOf(swarmId)
    const hasLegacy = fs.existsSync(p.legacySwarmJson)
    if (raw.length > 0 && (!hasLegacy || raw.some(e => e && e.type === 'swarm.init'))) {
      return raw
    }
    if (!hasLegacy) return raw

    const synthesized = this._synthesizeLegacyEvents(swarmId)
    if (raw.length === 0) return synthesized

    // Self-heal: merge any orphaned post-migration events (e.g. `swarm.update` appended before migration) after the legacy stream.
    let nextOffset = synthesized.length + 1
    for (const ev of raw) {
      if (!ev || typeof ev !== 'object') continue
      synthesized.push({ ...ev, offset: nextOffset++ })
    }
    return synthesized
  }

  /** Synthesize an ordered event stream from pre-v0.3.4 legacy files (`swarm.json`, `board.jsonl`, `members.json`, `plan.json`). */
  _synthesizeLegacyEvents(swarmId) {
    const p = this.pathsOf(swarmId)
    if (!fs.existsSync(p.legacySwarmJson)) return []

    const swarm = readJsonSync(p.legacySwarmJson, null)
    const members = readJsonSync(p.legacyMembersJson, {})
    const board = readJsonlSync(p.legacyBoardJsonl)
    const plan = readJsonSync(p.legacyPlanJson, null)
    const synthesized = []
    let offset = 1

    const initTs = swarm?.created_at ? Date.parse(swarm.created_at) : Date.now()
    const baseTs = Number.isFinite(initTs) ? initTs : Date.now()
    synthesized.push({
      offset: offset++,
      ts_ms: baseTs,
      time: formatTime(new Date(baseTs)),
      type: 'swarm.init',
      actor: 'coordinator',
      payload: {
        swarm_id: swarm?.swarm_id ?? swarmId,
        title: swarm?.title || 'Swarm',
        generation: swarm?.generation ?? 1,
        status: swarm?.status ?? 'ACTIVE',
        project_root: swarm?.project_root ?? null,
        concurrency_confirmed: swarm?.concurrency_confirmed ?? true,
        concurrency_limit: swarm?.concurrency_limit ?? 4,
        default_provider: swarm?.default_provider || 'inherit',
        default_model: swarm?.default_model || 'inherit',
        coordinator_model: swarm?.coordinator_model || 'inherit',
        created_at: swarm?.created_at,
      },
    })

    if (plan) {
      synthesized.push({
        offset: offset++,
        ts_ms: baseTs + 1,
        time: formatTime(new Date(baseTs + 1)),
        type: 'plan.update',
        actor: 'coordinator',
        payload: plan,
      })
    }

    const lastActiveSeq = new Map()
    for (const rec of board) {
      if (!rec || rec.type === 'control') continue
      if (rec.agent) lastActiveSeq.set(rec.agent, rec.seq)
      if (Array.isArray(rec.mentions)) {
        for (const mName of rec.mentions) lastActiveSeq.set(mName, rec.seq)
      }
    }

    const spawnedSet = new Set(['coordinator'])
    const retiredAtSeq = new Map()
    for (const [mName, m] of Object.entries(members)) {
      if (!m || mName === 'coordinator' || (m.system_builtin && m.role === 'monitor')) continue
      if (m.killed === true) {
        const retSeq = (typeof m.killed_at_seq === 'number' && m.killed_at_seq > 0)
          ? m.killed_at_seq
          : (lastActiveSeq.get(mName) ?? m.brief_seq ?? 0)
        if (!retiredAtSeq.has(retSeq)) retiredAtSeq.set(retSeq, [])
        retiredAtSeq.get(retSeq).push({ name: mName, member: m })
      }
    }

    for (const rec of board) {
      if (!rec) continue
      const recTs = typeof rec.created_ms === 'number'
        ? rec.created_ms
        : (rec.time ? Date.parse(String(rec.time).replace(' ', 'T') + 'Z') : Date.now())
      const tsMs = Number.isFinite(recTs) ? recTs : Date.now()

      if (rec.type === 'control') {
        synthesized.push({
          offset: offset++,
          ts_ms: tsMs,
          time: rec.time || formatTime(new Date(tsMs)),
          type: 'board.control',
          seq: rec.seq,
          actor: rec.agent || 'coordinator',
          payload: { ...rec },
        })
      } else {
        if (rec.kind === 'brief' && Array.isArray(rec.mentions)) {
          for (const mName of rec.mentions) {
            const m = members[mName]
            if (m && !spawnedSet.has(mName)) {
              spawnedSet.add(mName)
              synthesized.push({
                offset: offset++,
                ts_ms: Math.max(0, tsMs - 1),
                time: rec.time || formatTime(new Date(tsMs)),
                type: 'member.spawn',
                seq: rec.seq,
                actor: m.parent || 'coordinator',
                payload: {
                  name: mName,
                  session_id: m.session_id,
                  role: m.role || 'worker',
                  can_block_merge: m.can_block_merge,
                  group: m.group ?? null,
                  parent: m.parent || 'coordinator',
                  provider: m.applied_provider || 'inherit',
                  model: m.applied_model || 'inherit',
                  workspace_mode: m.workspace_mode || 'inherit',
                  worktree_path: m.worktree_path ?? null,
                  brief_seq: rec.seq,
                  created_at: m.created_at,
                },
              })
            }
          }
        }
        synthesized.push({
          offset: offset++,
          ts_ms: tsMs,
          time: rec.time || formatTime(new Date(tsMs)),
          type: 'board.post',
          seq: rec.seq,
          actor: rec.agent || 'coordinator',
          payload: {
            ...rec,
            title: rec.title || deriveFallbackTitle(rec.text, rec.kind || 'post'),
          },
        })
      }

      const retiringHere = retiredAtSeq.get(rec.seq)
      if (retiringHere) {
        for (const item of retiringHere) {
          synthesized.push({
            offset: offset++,
            ts_ms: tsMs + 1,
            time: rec.time || formatTime(new Date(tsMs)),
            type: 'member.kill',
            seq: rec.seq,
            actor: 'coordinator',
            payload: {
              name: item.name,
              released: false,
              killed_at_seq: rec.seq,
              handover_to: item.member.handover_to ?? null,
              reason: item.member.kill_reason ?? null,
            },
          })
        }
      }
    }

    return synthesized
  }

  /** Compute current state cleanly on demand via `SwarmStateProjector` (anchored on the second-newest checkpoint). */
  projectState(swarmId, { includeBoard = true } = {}) {
    const events = this.readEventLog(swarmId)
    const projection = SwarmStateProjector.projectState(events, { includeBoard })
    return { events, projection }
  }

  /** List all initialized Swarms on disk sorted by most recently updated first. */
  listSwarms() {
    if (!fs.existsSync(this.baseDir)) return []
    let entries = []
    try {
      entries = fs.readdirSync(this.baseDir, { withFileTypes: true })
    } catch {
      return []
    }
    const items = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'archive') continue
      const dir = path.join(this.baseDir, entry.name)
      if (!fs.existsSync(path.join(dir, 'events.jsonl')) && !fs.existsSync(path.join(dir, 'swarm.json'))) continue
      try {
        const meta = this.readSwarm(entry.name)
        if (!meta) continue
        items.push({
          swarm_id: meta.swarm_id ?? entry.name,
          title: meta.title ?? entry.name,
          status: meta.status ?? 'ACTIVE',
          concurrency_limit: meta.concurrency_limit ?? 4,
          updated_at: meta.updated_at ?? meta.created_at ?? '',
        })
      } catch {
        // Ignore unreadable directory entry
      }
    }
    items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    return items
  }

  /** Resolve a root sessionId or child worker sessionId (`<swarmId>__<member>`) to an existing swarmId on disk. */
  resolveSwarmId(sessionId) {
    if (sessionId && this.exists(sessionId)) return sessionId
    if (typeof sessionId === 'string' && sessionId.includes('__')) {
      const prefix = sessionId.split('__')[0]
      if (prefix && this.exists(prefix)) return prefix
    }
    const all = this.listSwarms()
    if (sessionId) {
      for (const item of all) {
        const members = this.readMembers(item.swarm_id)
        for (const m of Object.values(members)) {
          if (m && m.session_id === sessionId) return item.swarm_id
        }
      }
    }
    return all.length > 0 ? all[0].swarm_id : null
  }

  // #FUNC Initialize or update a Swarm in the single append-only `events.jsonl` log and ensure `coordinator` exists in `offsets.json`.
  // #NOT  Does not duplicate swarm metadata into separate `swarm.json` or `members.json` files.
  // #EDGE-IN Calling `initSwarm` on an existing swarm updates title/concurrency without wiping board history → test_init_preserves_existing_board
  // #WHY  Appending `swarm.init` into `events.jsonl` keeps initialization and generation bumps inside the single event-sourced truth.
  initSwarm(swarmId, options = {}) {
    const existing = this.exists(swarmId) ? this.readSwarm(swarmId) : null
    const nowIso = new Date().toISOString()

    const isReinitAfterDone = existing?.status === 'DONE' && options.status === 'ACTIVE'
    const nextGeneration = isReinitAfterDone
      ? (Number(existing?.generation) || 1) + 1
      : (Number(options.generation ?? existing?.generation) || 1)

    const payload = {
      swarm_id: swarmId,
      generation: nextGeneration,
      title: options.title ?? existing?.title ?? 'Untitled Swarm',
      backend: options.backend ?? existing?.backend ?? 'local',
      status: options.status ?? existing?.status ?? 'ACTIVE',
      project_root: options.project_root !== undefined ? options.project_root : (existing?.project_root ?? null),
      concurrency_confirmed: options.concurrency_confirmed ?? existing?.concurrency_confirmed ?? false,
      concurrency_limit: options.concurrency_limit ?? existing?.concurrency_limit ?? 4,
      default_provider: options.default_provider ?? existing?.default_provider ?? 'inherit',
      default_model: options.default_model ?? existing?.default_model ?? 'inherit',
      coordinator_model: options.coordinator_model ?? existing?.coordinator_model ?? 'inherit',
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    }
    this.appendEvent(swarmId, {
      type: 'swarm.init',
      actor: 'coordinator',
      payload,
    })

    const offsets = this.readOffsets(swarmId)
    if (!offsets.coordinator) {
      offsets.coordinator = defaultOffsetsForRole('coordinator', 0)
      this.writeOffsets(swarmId, offsets)
    }

    return {
      swarm: this.readSwarm(swarmId),
      members: this.readMembers(swarmId),
    }
  }

  // dup-ok: thin projection field accessor returning swarm metadata or null
  readSwarm(swarmId) {
    if (!this.exists(swarmId)) return null
    return this.projectState(swarmId, { includeBoard: false }).projection.swarm
  }

  updateSwarm(swarmId, patch) {
    if (!this.exists(swarmId)) throw new Error(`Swarm "${swarmId}" is not initialized`)
    this.appendEvent(swarmId, {
      type: 'swarm.update',
      actor: 'coordinator',
      payload: { ...patch, updated_at: new Date().toISOString() },
    })
    return this.readSwarm(swarmId)
  }

  /** Project members from `events.jsonl` merged with per-member consumer offsets from `offsets.json`. */
  readMembers(swarmId) {
    if (!this.exists(swarmId)) return {}
    const domainMembers = this.projectState(swarmId, { includeBoard: false }).projection.members
    const offsets = this.readOffsets(swarmId)
    const merged = {}
    for (const [name, dm] of Object.entries(domainMembers)) {
      const defaults = defaultOffsetsForRole(dm.role, dm.brief_seq ?? 0)
      const off = offsets[name] || {}
      merged[name] = {
        ...defaults,
        ...dm,
        ...off,
        // Domain facts ALWAYS win over offsets if any legacy key existed
        role: dm.role,
        killed: dm.killed,
        last_post_seq: dm.last_post_seq,
        channels: dm.channels,
        phase: dm.killed ? 'KILLED' : (off.last_error ? 'ERROR' : (off.phase || 'RUNNING')),
      }
    }
    return merged
  }

  /** Persist consumer offset/telemetry updates for the member map into `offsets.json`. */
  writeMembers(swarmId, members) {
    this.writeOffsets(swarmId, members)
    return members
  }

  /** Update a member: domain-fact diffs append to `events.jsonl`; cursor/telemetry diffs write ONLY to `offsets.json`. */
  updateMember(swarmId, name, updater) {
    const members = this.readMembers(swarmId)
    const current = members[name]
    if (!current) throw new Error(`Member "${name}" not found in Swarm "${swarmId}"`)
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater }

    const domainDiff = {}
    let hasDomainDiff = false
    for (const field of DOMAIN_MEMBER_FIELDS) {
      if (next[field] !== current[field]) {
        domainDiff[field] = next[field]
        hasDomainDiff = true
      }
    }

    const offsetDiff = {}
    let hasOffsetDiff = false
    for (const field of OFFSET_FIELDS) {
      if (next[field] !== current[field]) {
        offsetDiff[field] = next[field]
        hasOffsetDiff = true
      }
    }

    if (hasDomainDiff) {
      this.appendEvent(swarmId, {
        type: 'member.patch',
        actor: 'coordinator',
        seq: this.headSeq(swarmId),
        payload: { name, ...domainDiff },
      })
    }
    if (hasOffsetDiff) {
      const offsets = this.readOffsets(swarmId)
      offsets[name] = { ...(offsets[name] || defaultOffsetsForRole(current.role, current.brief_seq ?? 0)), ...offsetDiff }
      this.writeOffsets(swarmId, offsets)
    }

    return this.readMembers(swarmId)[name] ?? next
  }

  /** Remove a never-started or rolled-back member so its name is released for reuse. */
  removeMemberRecord(swarmId, name, { actor = 'coordinator', seq = null, reason = null } = {}) {
    const current = this.readMembers(swarmId)[name]
    if (!current) return false
    this.appendEvent(swarmId, {
      type: 'member.kill',
      actor,
      seq: seq ?? this.headSeq(swarmId),
      payload: {
        name,
        released: true,
        reason,
      },
    })
    const offsets = this.readOffsets(swarmId)
    if (offsets[name]) {
      delete offsets[name]
      this.writeOffsets(swarmId, offsets)
    }
    return true
  }

  readBoard(swarmId) {
    if (!this.exists(swarmId)) return []
    return SwarmStateProjector.extractBoard(this.readEventLog(swarmId))
  }

  // dup-ok: thin projection field accessor returning numeric headSeq default 0
  headSeq(swarmId) {
    if (!this.exists(swarmId)) return 0
    return this.projectState(swarmId, { includeBoard: false }).projection.headSeq
  }

  /** Check whether an identical post (by `idempotency_key` or same agent/channel/kind/text within `windowMs`) already landed. */
  findDuplicatePost(swarmId, entry, windowMs = 60_000) {
    if (!entry || entry.type === 'control') return null
    const records = this.readBoard(swarmId)
    const nowMs = Date.now()
    const channel = (entry.channel ?? 'main').replace(/^#/, '')
    const kind = entry.kind ?? 'report'
    const text = String(entry.text ?? '')
    const idemKey = typeof entry.idempotency_key === 'string' && entry.idempotency_key.trim()
      ? entry.idempotency_key.trim()
      : null

    for (let i = records.length - 1; i >= 0; i -= 1) {
      const rec = records[i]
      if (!rec || rec.type === 'control') continue
      if (idemKey && rec.idempotency_key === idemKey) return rec
      const recMs = typeof rec.created_ms === 'number' ? rec.created_ms : 0
      if (recMs > 0 && nowMs - recMs > windowMs) break
      if (
        rec.agent === entry.agent
        && (rec.channel || 'main') === channel
        && (rec.kind || 'report') === kind
        && rec.text === text
      ) {
        return rec
      }
    }
    return null
  }

  // #FUNC Append one post (with a meaningful `title`) or channel control frame to `events.jsonl` with a monotonic `seq`.
  // #NOT  Does not duplicate posts into a separate `board.jsonl` file.
  // #EDGE-IN Mentioning `@group` expands to all active members of that group → test_post_board_group_and_cursor
  // #WHY  Storing `board.post` and `board.control` directly inside `events.jsonl` makes every floor part of the single append-only source of truth.
  appendBoardRecord(swarmId, entry) {
    const records = this.readBoard(swarmId)
    const nextSeq = records.length === 0 ? 1 : records[records.length - 1].seq + 1
    const nowMs = typeof entry.created_ms === 'number' ? entry.created_ms : Date.now()
    const nowText = entry.time ?? formatTime(new Date(nowMs))

    let record
    if (entry.type === 'control') {
      record = {
        seq: nextSeq,
        type: 'control',
        action: entry.action,
        agent: entry.agent ?? 'coordinator',
        channel: (entry.channel ?? '').replace(/^#/, ''),
        ...(entry.target ? { target: entry.target } : {}),
        time: nowText,
        created_ms: nowMs,
      }
      this.appendEvent(swarmId, {
        type: 'board.control',
        actor: record.agent,
        seq: record.seq,
        ts_ms: nowMs,
        time: nowText,
        payload: record,
      })
    } else {
      const explicitMentions = Array.isArray(entry.mentions)
        ? entry.mentions.map(m => String(m).replace(/^@/, '').trim()).filter(Boolean)
        : []
      const explicitChannelMentions = Array.isArray(entry.channel_mentions)
        ? entry.channel_mentions.map(c => String(c).replace(/^#/, '').trim()).filter(Boolean)
        : []
      const parsedTextMentions = entry.skip_prose_mention_extraction
        ? { members: [], channels: [] }
        : extractMentionsFromText(entry.text ?? '')
      const allMemberMentions = [...new Set([
        ...explicitMentions.filter(m => !m.startsWith('#')),
        ...parsedTextMentions.members,
      ])]
      const allChannelMentions = [...new Set([
        ...explicitChannelMentions,
        ...explicitMentions.filter(m => m.startsWith('#')).map(m => m.slice(1)),
        ...parsedTextMentions.channels,
      ])]
      const parsedRefs = extractRefsFromText(entry.text ?? '')
      const explicitRefs = Array.isArray(entry.refs)
        ? entry.refs.map(Number).filter(n => Number.isSafeInteger(n) && n >= 1)
        : []
      const refs = [...new Set([...explicitRefs, ...parsedRefs])]
      const supersedes = Array.isArray(entry.supersedes)
        ? [...new Set(entry.supersedes.map(Number).filter(n => Number.isSafeInteger(n) && n >= 1 && n < nextSeq))]
        : []
      const resolvedTitle = typeof entry.title === 'string' && entry.title.trim().length > 0
        ? entry.title.trim().slice(0, 100)
        : deriveFallbackTitle(entry.text, entry.kind ? `${entry.kind} update` : 'Board update')

      record = {
        seq: nextSeq,
        type: 'post',
        agent: entry.agent,
        channel: (entry.channel ?? 'main').replace(/^#/, ''),
        mentions: allMemberMentions,
        ...(allChannelMentions.length > 0 ? { channel_mentions: allChannelMentions } : {}),
        refs,
        kind: entry.kind ?? 'report',
        title: resolvedTitle,
        ...(entry.verdict && VALID_VERDICTS.includes(entry.verdict) ? { verdict: entry.verdict } : {}),
        ...(supersedes.length > 0 ? { supersedes } : {}),
        ...(entry.escalate === true ? { escalate: true } : {}),
        ...(entry.silent === true ? { silent: true } : {}),
        ...(entry.idempotency_key ? { idempotency_key: String(entry.idempotency_key) } : {}),
        text: entry.text,
        time: nowText,
        created_ms: nowMs,
        origin: entry.origin ?? `${entry.agent}@local`,
        actor_kind: entry.actor_kind ?? 'AGENT',
      }
      this.appendEvent(swarmId, {
        type: 'board.post',
        actor: record.agent,
        seq: record.seq,
        ts_ms: nowMs,
        time: nowText,
        payload: record,
      })

      // Advance ONLY the author's consumer read cursor in offsets.json
      const offsets = this.readOffsets(swarmId)
      if (record.agent && offsets[record.agent]) {
        offsets[record.agent].last_read_seq = Math.max(offsets[record.agent].last_read_seq ?? 0, nextSeq)
        this.writeOffsets(swarmId, offsets)
      }
    }

    return record
  }

  // #FUNC Register a new member via `member.spawn` + opening brief `board.post` in `events.jsonl` and initialize its cursors in `offsets.json`.
  // #NOT  Never reuses a name that already exists in `events.jsonl`, even if `killed === true`.
  // #EDGE-IN Adding multiple workers at startup sets each worker's `last_read_seq` past earlier opening briefs → test_new_worker_cursor_skips_opening_noise
  // #WHY  `last_read_seq` is initialized in `offsets.json` to the brief's `seq` (and bulk-bumped across opening briefs) so new workers skip sibling opening brief noise.
  registerMemberWithBrief(swarmId, spec) {
    const members = this.readMembers(swarmId)
    if (members[spec.name]) {
      throw new Error(`Member name "${spec.name}" is permanently locked and cannot be reused`)
    }
    const swarm = this.readSwarm(swarmId)
    const nowIso = new Date().toISOString()
    const role = spec.role ?? 'worker'
    const canBlockMerge = spec.can_block_merge !== undefined
      ? Boolean(spec.can_block_merge)
      : (role === 'verifier' || role === 'architect')

    const briefTitle = typeof spec.title === 'string' && spec.title.trim()
      ? spec.title.trim().slice(0, 100)
      : `Brief: @${spec.name} (${role})`

    const plannedBriefSeq = this.headSeq(swarmId) + 1
    this.appendEvent(swarmId, {
      type: 'member.spawn',
      actor: spec.parent ?? 'coordinator',
      seq: plannedBriefSeq,
      payload: {
        name: spec.name,
        session_id: spec.session_id,
        role,
        can_block_merge: canBlockMerge,
        group: spec.group ?? null,
        parent: spec.parent ?? 'coordinator',
        provider: spec.provider ?? swarm?.default_provider ?? 'inherit',
        model: spec.model ?? swarm?.default_model ?? 'inherit',
        workspace_mode: spec.workspace_mode ?? 'inherit',
        worktree_path: spec.worktree_path ?? null,
        base_commit: spec.base_commit ?? null,
        baseline_tree: spec.baseline_commit ?? spec.baseline_tree ?? null,
        fork_from: spec.fork_from ?? null,
        spawned_live_agent: spec.spawned_live_agent === true,
        brief_seq: plannedBriefSeq,
        created_at: nowIso,
      },
    })

    const briefPost = this.appendBoardRecord(swarmId, {
      type: 'post',
      agent: spec.parent ?? 'coordinator',
      channel: spec.channel ?? 'main',
      mentions: [spec.name],
      skip_prose_mention_extraction: true,
      kind: 'brief',
      title: briefTitle,
      text: `@${spec.name} ${spec.brief}`,
    })

    const offsets = this.readOffsets(swarmId)
    offsets[spec.name] = defaultOffsetsForRole(role, briefPost.seq)

    const allMembersNow = this.projectState(swarmId).projection.members
    const records = this.readBoard(swarmId)
    const allBriefsSoFar = records.every(r => r.type === 'control' || r.kind === 'brief')
    if (allBriefsSoFar) {
      for (const [mName, m] of Object.entries(allMembersNow)) {
        if (m.role !== 'coordinator' && !m.killed && (m.last_post_seq ?? 0) === 0) {
          offsets[mName] = {
            ...(offsets[mName] || defaultOffsetsForRole(m.role, briefPost.seq)),
            last_read_seq: briefPost.seq,
            wait_since: briefPost.seq,
          }
        }
      }
    }
    this.writeOffsets(swarmId, offsets)

    return { member: this.readMembers(swarmId)[spec.name], briefPost }
  }

  /** Compute unresolved `[REJECT]` merge-gate blocks from active members with `can_block_merge === true`. */
  computeActiveRejections(swarmId) {
    const records = this.readBoard(swarmId)
    const members = this.readMembers(swarmId)
    const supersededBy = computeSupersededMap(records)
    const byReviewer = new Map()

    for (const rec of records) {
      if (!rec || rec.type === 'control') continue
      const author = members[rec.agent]
      if (!author || author.killed) continue
      const canBlock = author.can_block_merge === true
        || author.role === 'verifier'
        || author.role === 'architect'
      if (!canBlock) continue

      const text = String(rec.text ?? '')
      const isReject = rec.verdict === 'reject'
        || (rec.kind === 'review' && /\[REJECT\b/i.test(text) && rec.verdict !== 'approve')
      const isApprove = rec.verdict === 'approve'
        || (rec.kind === 'review' && (/\[VERDICT:\s*ALL\s*PASS\]/i.test(text) || /\[APPROVE\b/i.test(text)) && !/\[REJECT\b/i.test(text))

      if (isReject) {
        if (!supersededBy.has(rec.seq)) {
          byReviewer.set(rec.agent, {
            seq: rec.seq,
            reviewer: rec.agent,
            role: author.role,
            title: rec.title || deriveFallbackTitle(text, 'Rejection'),
            mentions: rec.mentions ?? [],
            time: rec.time,
            summary: text.slice(0, 180),
          })
        }
      } else if (isApprove) {
        byReviewer.delete(rec.agent)
      }
    }

    return [...byReviewer.values()]
  }

  // #FUNC Append a `plan.update` event to `events.jsonl` while enforcing the 64 KB zero-trust size limit.
  // #NOT  Does not duplicate plan state into a separate `plan.json` file or corrupt previous valid plans if oversized.
  // #EDGE-IN Plan payload over 64 KB is rejected and preserves previous valid plan → test_plan_json_size_guard
  // #WHY  `PLAN_MAX_BYTES` prevents a verbose model from dumping megabytes of logs into the event stream and freezing the web overview.
  writePlan(swarmId, planData) {
    const serialized = JSON.stringify(planData, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > PLAN_MAX_BYTES) {
      throw new Error(`plan.json exceeds 64 KB limit (${Buffer.byteLength(serialized, 'utf8')} bytes)`)
    }
    this.appendEvent(swarmId, {
      type: 'plan.update',
      actor: 'coordinator',
      payload: {
        version: 1,
        updated_at: new Date().toISOString(),
        ...planData,
      },
    })
    return this.readPlan(swarmId)
  }

  readPlan(swarmId) {
    if (!this.exists(swarmId)) return null
    return this.projectState(swarmId, { includeBoard: false }).projection.plan
  }

  /** Copy SSOT files (`events.jsonl`, `offsets.json`) into `<baseDir>/archive/<swarmId>_gen<gen>_<timestamp>_<reason>/`. */
  archiveSwarm(swarmId, reason = 'done') {
    if (!this.exists(swarmId)) return null
    const srcPaths = this.pathsOf(swarmId)
    const meta = this.readSwarm(swarmId)
    const gen = meta?.generation ?? 1
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeId = String(swarmId).replace(/[^a-zA-Z0-9_.-]/g, '_')
    const archiveDir = path.join(this.baseDir, 'archive', `${safeId}_gen${gen}_${stamp}_${reason}`)
    fs.mkdirSync(archiveDir, { recursive: true })
    for (const fileName of ['events.jsonl', 'offsets.json', 'swarm.json', 'board.jsonl', 'members.json', 'plan.json']) {
      const srcFile = path.join(srcPaths.dir, fileName)
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(archiveDir, fileName))
      }
    }
    return archiveDir
  }

  /** Resolve which active members are addressed by a board post for live wakeups. */
  resolveTargetsForPost(swarmId, postRecord) {
    if (!postRecord || postRecord.type === 'control') return []
    if (postRecord.silent === true) return []
    const members = this.readMembers(swarmId)
    const records = this.readBoard(swarmId)
    const channelState = replayChannelsAt(records, postRecord.seq)

    const mentionedTokens = new Set(postRecord.mentions ?? [])
    const mentionedChannels = new Set(postRecord.channel_mentions ?? [])
    const isAll = mentionedTokens.has('all')
    const targets = new Set()

    for (const [name, member] of Object.entries(members)) {
      if (member.killed) continue
      if (name === postRecord.agent) continue

      if (mentionedTokens.has(name)) {
        targets.add(name)
        continue
      }
      if (member.group && mentionedTokens.has(member.group)) {
        targets.add(name)
        continue
      }
      const subs = new Set(channelState.subscriptionsOf(name))
      let channelHit = false
      for (const ch of mentionedChannels) {
        if (ch !== 'main' && subs.has(ch)) {
          channelHit = true
          break
        }
      }
      if (channelHit) {
        targets.add(name)
        continue
      }
      if (isAll && member.role !== 'monitor') {
        targets.add(name)
        continue
      }
      if (member.wake_mode === 'anything' && subs.has(postRecord.channel || 'main')) {
        targets.add(name)
      }
    }

    return [...targets]
  }

  /** Partition addressed members into `wakeTargets` vs `silentTargets` using `wake_kinds` and `escalate`. */
  resolveWakeRoutingForPost(swarmId, postRecord) {
    if (!postRecord || postRecord.type === 'control' || postRecord.silent === true) {
      return { wakeTargets: [], silentTargets: [] }
    }
    const members = this.readMembers(swarmId)
    const candidates = this.resolveTargetsForPost(swarmId, postRecord)
    const postKind = postRecord.kind || 'report'
    const forceEscalate = postRecord.escalate === true

    const wakeTargets = []
    const silentTargets = []

    for (const name of candidates) {
      const m = members[name]
      if (!m || m.killed) continue
      const filterKinds = Array.isArray(m.wake_kinds) && m.wake_kinds.length > 0 ? m.wake_kinds : null
      if (!forceEscalate && filterKinds && !filterKinds.includes(postKind)) {
        silentTargets.push(name)
      } else {
        wakeTargets.push(name)
      }
    }
    return { wakeTargets, silentTargets }
  }

  /** Query unread posts for `memberName` after `sinceSeq` on subscribed channels. */
  queryVisiblePosts(swarmId, memberName, sinceSeq = 0, options = {}) {
    const records = this.readBoard(swarmId)
    const members = this.readMembers(swarmId)
    const member = members[memberName]
    const mentionsOnly = options.mentionsOnly === true
    const wakeKinds = Array.isArray(options.wakeKinds) && options.wakeKinds.length > 0
      ? options.wakeKinds
      : null

    const results = []
    for (const rec of records) {
      if (!rec || rec.seq <= sinceSeq) continue
      if (rec.type === 'control') {
        if (!mentionsOnly && !wakeKinds) results.push(rec)
        continue
      }
      if (mentionsOnly && rec.silent === true) continue

      const channelState = replayChannelsAt(records, rec.seq)
      const subs = new Set(channelState.subscriptionsOf(memberName))
      const directMention = (rec.mentions ?? []).includes(memberName)
        || (member?.group && (rec.mentions ?? []).includes(member.group))
        || ((rec.mentions ?? []).includes('all') && member?.role !== 'monitor')
        || ((rec.channel_mentions ?? []).some(ch => ch !== 'main' && subs.has(ch)))

      const visible = mentionsOnly
        ? (directMention && rec.agent !== memberName)
        : (directMention || subs.has(rec.channel || 'main'))
      if (!visible) continue

      if (wakeKinds && rec.escalate !== true && !wakeKinds.includes(rec.kind || 'report')) {
        continue
      }
      results.push(rec)
    }
    return results
  }
}
