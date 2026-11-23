// Four-file plain-text Swarm store:
//   <rootDir>/<swarmId>/swarm.json
//   <rootDir>/<swarmId>/board.jsonl
//   <rootDir>/<swarmId>/members.json
//   <rootDir>/<swarmId>/plan.json
//
// Also owns event-sourced channel replay (`channelsAt` / `activeAt`) from
// `type: "control"` frames embedded inside `board.jsonl`, post superseding maps,
// merge-gate rejection tracking, and Windows-NTFS-resilient atomic JSON writes.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PLAN_MAX_BYTES = 65_536
export const VALID_POST_KINDS = Object.freeze(['brief', 'report', 'question', 'review', 'decision', 'alert', 'done'])
export const VALID_VERDICTS = Object.freeze(['approve', 'reject', 'override'])

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

/** Format a timestamp in readable ISO-like local/UTC form. */
export function formatTime(now = new Date()) {
  return now.toISOString().replace('T', ' ').slice(0, 19)
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
    // Final Windows-NTFS fallback: if antivirus/indexer held a rename lock on the target,
    // write directly in place so we never lose state or crash after board.jsonl succeeded.
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

// #FUNC Replay control frames up to `atSeq` to compute existing channels and member subscriptions.
// #NOT  Does not trust `members.json` channel lists as historical truth; `members.json` is only a cache.
// #EDGE-IN Archiving a channel removes it from active channels at later seqs → test_event_sourced_channels_replay
// #WHY  `type === 'control'` frames inside `board.jsonl` allow the UI and router to reconstruct visibility at any historical floor.
export function replayChannelsAt(records, atSeq = Infinity) {
  const activeChannels = new Set(['main'])
  const archivedChannels = new Set()
  const subscriptions = new Map() // memberName -> Set<channel>

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

/**
 * Per-Swarm store managing `swarm.json`, `board.jsonl`, `members.json`, and `plan.json`
 * inside `<baseDir>/<swarmId>/`.
 */
export class SwarmStore {
  constructor(baseDir = defaultSwarmRoot()) {
    this.baseDir = baseDir
    this.locks = new Map()
  }

  dirOf(swarmId) {
    const safeId = String(swarmId).replace(/[^a-zA-Z0-9_.-]/g, '_')
    return path.join(this.baseDir, safeId)
  }

  pathsOf(swarmId) {
    const dir = this.dirOf(swarmId)
    return {
      dir,
      swarmJson: path.join(dir, 'swarm.json'),
      boardJsonl: path.join(dir, 'board.jsonl'),
      membersJson: path.join(dir, 'members.json'),
      planJson: path.join(dir, 'plan.json'),
    }
  }

  /** Serialize async mutations per swarmId so board seqs and cursor updates never race. */
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
    return Boolean(swarmId) && fs.existsSync(this.pathsOf(swarmId).swarmJson)
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
      const swarmJsonPath = path.join(this.baseDir, entry.name, 'swarm.json')
      if (!fs.existsSync(swarmJsonPath)) continue
      try {
        const meta = readJsonSync(swarmJsonPath, null)
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

  // #FUNC Initialize the 3 core blackboard files (`swarm.json`, `board.jsonl`, `members.json`) for a coordinator session.
  // #NOT  Does not allow `swarm_add` until `concurrency_confirmed` is set true, and does not insert a fake `monitor` LLM member into `members.json`.
  // #EDGE-IN Calling `initSwarm` on an existing swarm updates title/concurrency without wiping `board.jsonl` → test_init_preserves_existing_board
  // #WHY  `concurrency_confirmed` gates member creation so the coordinator confirms concurrency before spawning, while the Watchdog runs deterministically outside the LLM roster.
  initSwarm(swarmId, options = {}) {
    const paths = this.pathsOf(swarmId)
    fs.mkdirSync(paths.dir, { recursive: true })
    const nowIso = new Date().toISOString()
    const existing = readJsonSync(paths.swarmJson, null)

    const isReinitAfterDone = existing?.status === 'DONE' && options.status === 'ACTIVE'
    const nextGeneration = isReinitAfterDone
      ? (Number(existing?.generation) || 1) + 1
      : (Number(options.generation ?? existing?.generation) || 1)

    const swarmMeta = {
      version: 1,
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
    writeJsonAtomicSync(paths.swarmJson, swarmMeta)

    if (!fs.existsSync(paths.boardJsonl)) {
      fs.writeFileSync(paths.boardJsonl, '', 'utf8')
    }

    const members = readJsonSync(paths.membersJson, {})
    let membersChanged = false
    if (!members.coordinator) {
      members.coordinator = {
        session_id: swarmId,
        role: 'coordinator',
        group: null,
        parent: null,
        can_block_merge: false,
        desired_state: 'RUNNING',
        phase: 'RUNNING',
        desired_provider: swarmMeta.default_provider,
        desired_model: swarmMeta.coordinator_model,
        applied_provider: swarmMeta.default_provider,
        applied_model: swarmMeta.coordinator_model,
        workspace_mode: 'inherit',
        worktree_path: null,
        base_commit: null,
        wake_mode: 'anything',
        wake_kinds: null,
        channels: ['main'],
        wait_since: 0,
        last_read_seq: 0,
        last_nudged_seq: 0,
        last_park_blocked_seq: 0,
        last_post_seq: 0,
        turn_count: 0,
        tool_call_count: 0,
        last_turn_at: null,
        last_tool_call_at: null,
        last_tool_name: null,
        last_error: null,
        killed: false,
        created_at: nowIso,
      }
      membersChanged = true
    }
    if (membersChanged) {
      writeJsonAtomicSync(paths.membersJson, members)
    }

    return { swarm: swarmMeta, members }
  }

  readSwarm(swarmId) {
    return readJsonSync(this.pathsOf(swarmId).swarmJson, null)
  }

  updateSwarm(swarmId, patch) {
    const paths = this.pathsOf(swarmId)
    const current = this.readSwarm(swarmId)
    if (!current) throw new Error(`Swarm "${swarmId}" is not initialized`)
    const updated = {
      ...current,
      ...patch,
      updated_at: new Date().toISOString(),
    }
    writeJsonAtomicSync(paths.swarmJson, updated)
    return updated
  }

  readMembers(swarmId) {
    return readJsonSync(this.pathsOf(swarmId).membersJson, {})
  }

  writeMembers(swarmId, members) {
    writeJsonAtomicSync(this.pathsOf(swarmId).membersJson, members)
    return members
  }

  updateMember(swarmId, name, updater) {
    const members = this.readMembers(swarmId)
    const current = members[name]
    if (!current) throw new Error(`Member "${name}" not found in members.json`)
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater }
    members[name] = next
    this.writeMembers(swarmId, members)
    return next
  }

  /** Remove a never-started or rolled-back member entry from `members.json` so its name is not locked. */
  removeMemberRecord(swarmId, name) {
    const members = this.readMembers(swarmId)
    if (!members[name]) return false
    delete members[name]
    this.writeMembers(swarmId, members)
    return true
  }

  readBoard(swarmId) {
    const { boardJsonl } = this.pathsOf(swarmId)
    if (!fs.existsSync(boardJsonl)) return []
    const raw = fs.readFileSync(boardJsonl, 'utf8')
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

  headSeq(swarmId) {
    const records = this.readBoard(swarmId)
    return records.length === 0 ? 0 : records[records.length - 1].seq
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

  // #FUNC Append one post or channel control frame to `board.jsonl` with a monotonic `seq`.
  // #NOT  Does not allow duplicate seq numbers or multi-line unescaped JSON records.
  // #EDGE-IN Mentioning `@group` expands to all active members of that group → test_post_board_group_and_cursor
  // #WHY  `last_post_seq` is updated on the author's member record here so the Watchdog can distinguish real replies from failed turns.
  appendBoardRecord(swarmId, entry) {
    const paths = this.pathsOf(swarmId)
    const records = this.readBoard(swarmId)
    const nextSeq = records.length === 0 ? 1 : records[records.length - 1].seq + 1
    const nowText = entry.time ?? formatTime()
    const nowMs = typeof entry.created_ms === 'number' ? entry.created_ms : Date.now()

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

      record = {
        seq: nextSeq,
        type: 'post',
        agent: entry.agent,
        channel: (entry.channel ?? 'main').replace(/^#/, ''),
        mentions: allMemberMentions,
        ...(allChannelMentions.length > 0 ? { channel_mentions: allChannelMentions } : {}),
        refs,
        kind: entry.kind ?? 'report',
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
    }

    fs.mkdirSync(paths.dir, { recursive: true })
    fs.appendFileSync(paths.boardJsonl, JSON.stringify(record) + '\n', 'utf8')

    // Sync cached channel subscriptions and author's last_post_seq in members.json
    const members = this.readMembers(swarmId)
    const allRecords = [...records, record]
    const channelState = replayChannelsAt(allRecords, nextSeq)

    for (const [name, member] of Object.entries(members)) {
      member.channels = channelState.subscriptionsOf(name)
    }
    if (record.agent && members[record.agent]) {
      members[record.agent].last_post_seq = nextSeq
      if (record.type === 'post') {
        members[record.agent].last_read_seq = Math.max(members[record.agent].last_read_seq ?? 0, nextSeq)
      }
    }
    this.writeMembers(swarmId, members)

    return record
  }

  // #FUNC Register a new member in `members.json` and post its public brief to `board.jsonl`.
  // #NOT  Never reuses a name that already exists in `members.json`, even if `killed === true`.
  // #EDGE-IN Adding multiple workers at startup sets each worker's `last_read_seq` past earlier opening briefs → test_new_worker_cursor_skips_opening_noise
  // #WHY  `last_read_seq` is initialized to the brief's `seq` (and bulk-bumped across opening briefs) so a new worker does not waste tokens reading other workers' briefs.
  registerMemberWithBrief(swarmId, spec) {
    const members = this.readMembers(swarmId)
    if (members[spec.name]) {
      throw new Error(`Member name "${spec.name}" is permanently locked in members.json and cannot be reused`)
    }
    const swarm = this.readSwarm(swarmId)
    const nowIso = new Date().toISOString()
    const role = spec.role ?? 'worker'
    const canBlockMerge = spec.can_block_merge !== undefined
      ? Boolean(spec.can_block_merge)
      : (role === 'verifier' || role === 'architect')

    // First post the public brief on board.jsonl so every member and verifier can cite its #seq
    const briefPost = this.appendBoardRecord(swarmId, {
      type: 'post',
      agent: spec.parent ?? 'coordinator',
      channel: spec.channel ?? 'main',
      mentions: [spec.name],
      skip_prose_mention_extraction: true,
      kind: 'brief',
      text: `@${spec.name} ${spec.brief}`,
    })

    const updatedMembers = this.readMembers(swarmId)
    updatedMembers[spec.name] = {
      session_id: spec.session_id,
      role,
      can_block_merge: canBlockMerge,
      group: spec.group ?? null,
      parent: spec.parent ?? 'coordinator',
      desired_state: 'RUNNING',
      phase: 'RUNNING',
      desired_provider: spec.provider ?? swarm?.default_provider ?? 'inherit',
      desired_model: spec.model ?? swarm?.default_model ?? 'inherit',
      applied_provider: spec.provider ?? swarm?.default_provider ?? 'inherit',
      applied_model: spec.model ?? swarm?.default_model ?? 'inherit',
      workspace_mode: spec.workspace_mode ?? 'inherit',
      worktree_path: spec.worktree_path ?? null,
      base_commit: spec.base_commit ?? null,
      baseline_tree: spec.baseline_tree ?? null,
      fork_from: spec.fork_from ?? null,
      spawned_live_agent: spec.spawned_live_agent === true,
      wake_mode: 'working',
      wake_kinds: null,
      channels: ['main'],
      brief_seq: briefPost.seq,
      wait_since: briefPost.seq,
      last_read_seq: briefPost.seq,
      last_nudged_seq: briefPost.seq,
      last_park_blocked_seq: 0,
      last_post_seq: 0,
      turn_count: 0,
      tool_call_count: 0,
      last_turn_at: null,
      last_tool_call_at: null,
      last_tool_name: null,
      last_error: null,
      killed: false,
      created_at: nowIso,
    }

    // Opening-brief noise guard: any sibling worker that hasn't posted yet and hasn't read beyond
    // the opening brief batch gets its `last_read_seq` bumped past this brief too.
    const records = this.readBoard(swarmId)
    const allBriefsSoFar = records.every(r => r.type === 'control' || r.kind === 'brief')
    if (allBriefsSoFar) {
      for (const m of Object.values(updatedMembers)) {
        if (m.role !== 'coordinator' && !m.killed && m.last_post_seq === 0) {
          m.last_read_seq = briefPost.seq
          m.wait_since = briefPost.seq
        }
      }
    }

    this.writeMembers(swarmId, updatedMembers)
    return { member: updatedMembers[spec.name], briefPost }
  }

  /**
   * Compute unresolved `[REJECT]` merge-gate blocks from active members with `can_block_merge === true`.
   * A reviewer's rejection stays active until that reviewer posts `verdict: "approve"` (or a review
   * containing `[VERDICT: ALL PASS]` / `[APPROVE]`) or until the rejection post is superseded.
   */
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

  // #FUNC Write `plan.json` (static Overview state) while enforcing the 64 KB zero-trust size limit.
  // #NOT  Does not overwrite an existing valid `plan.json` if the new payload exceeds `PLAN_MAX_BYTES`.
  // #EDGE-IN Plan payload over 64 KB is rejected and preserves previous valid plan → test_plan_json_size_guard
  // #WHY  `PLAN_MAX_BYTES` prevents a verbose model from dumping megabytes of logs into `plan.json` and freezing the web overview.
  writePlan(swarmId, planData) {
    const serialized = JSON.stringify(planData, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > PLAN_MAX_BYTES) {
      throw new Error(`plan.json exceeds 64 KB limit (${Buffer.byteLength(serialized, 'utf8')} bytes)`)
    }
    const paths = this.pathsOf(swarmId)
    writeJsonAtomicSync(paths.planJson, {
      version: 1,
      updated_at: new Date().toISOString(),
      ...planData,
    })
    return readJsonSync(paths.planJson, null)
  }

  readPlan(swarmId) {
    return readJsonSync(this.pathsOf(swarmId).planJson, null)
  }

  /**
   * Copy `swarm.json`, `board.jsonl`, `members.json`, and `plan.json` into
   * `<baseDir>/archive/<swarmId>_gen<gen>_<timestamp>_<reason>/` so evidence
   * is preserved even after a swarm closes or resets.
   */
  archiveSwarm(swarmId, reason = 'done') {
    if (!this.exists(swarmId)) return null
    const srcPaths = this.pathsOf(swarmId)
    const meta = this.readSwarm(swarmId)
    const gen = meta?.generation ?? 1
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeId = String(swarmId).replace(/[^a-zA-Z0-9_.-]/g, '_')
    const archiveDir = path.join(this.baseDir, 'archive', `${safeId}_gen${gen}_${stamp}_${reason}`)
    fs.mkdirSync(archiveDir, { recursive: true })
    for (const fileName of ['swarm.json', 'board.jsonl', 'members.json', 'plan.json']) {
      const srcFile = path.join(srcPaths.dir, fileName)
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(archiveDir, fileName))
      }
    }
    return archiveDir
  }

  /**
   * Resolve which active members are addressed by a board post,
   * accounting for `@name`, `@group`, `@#channel` (via event-sourced `replayChannelsAt`),
   * `@all`, and members with `wake_mode === 'anything'`.
   */
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
      if (name === postRecord.agent) continue // Never self-wake

      // 1. Direct @name
      if (mentionedTokens.has(name)) {
        targets.add(name)
        continue
      }
      // 2. Sharded group @group (e.g. @fixer wakes fixer-1, fixer-2)
      if (member.group && mentionedTokens.has(member.group)) {
        targets.add(name)
        continue
      }
      // 3. @#channel (wakes members subscribed to that channel at this seq)
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
      // 4. @all (wakes everyone except monitor)
      if (isAll && member.role !== 'monitor') {
        targets.add(name)
        continue
      }
      // 5. Members sleeping in `anything` mode on a subscribed channel
      if (member.wake_mode === 'anything' && subs.has(postRecord.channel || 'main')) {
        targets.add(name)
      }
    }

    return [...targets]
  }

  /**
   * Partition addressed members into `wakeTargets` vs `silentTargets` using each recipient's
   * `wake_kinds` filter (from `swarm_wait`) and the post's `escalate` flag.
   */
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

  /**
   * Query unread posts for `memberName` after `sinceSeq` on subscribed channels
   * (or any post that directly `@mentioned` the member), optionally filtering by `wakeKinds`.
   */
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
