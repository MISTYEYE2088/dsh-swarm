// Diagnostic log exporter for both Swarm sessions (Blackboard + all member
// transcripts) and regular DSH conversations (root session + subagents).
//
// Strictly English-only and zero external npm dependencies. Reads committed DSH
// session logs through official Host services (`sessions`, `sessionPersistence`,
// `sessionQuery`) with graceful fallbacks for in-memory or test hosts.

import { getRoleSpec } from './prompts.js'

export const DIAGNOSTIC_EXPORT_FORMAT = 'dsh-swarm-diagnostic-log/v1'
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 4000
export const COMPACT_MAX_TOOL_ARG_CHARS = 320
export const COMPACT_MAX_OK_RESULT_CHARS = 280
export const COMPACT_MAX_ERR_RESULT_CHARS = 2000

/** Build a filesystem-safe download filename for a Swarm or conversation diagnostic export. */
export function safeExportFilename(prefix, id, ext, now = new Date()) {
  const safePrefix = String(prefix || 'dsh-log').replace(/[^A-Za-z0-9_-]/g, '_')
  const safeId = String(id || 'session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'session'
  const safeExt = ext === 'json' ? 'json' : 'md'
  const pad = n => String(n).padStart(2, '0')
  const stamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    '-',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('')
  return `${safePrefix}-${safeId}-${stamp}.${safeExt}`
}

/** Truncate long text cleanly while reporting omitted character count. */
function truncateText(text, maxChars) {
  const raw = String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0 || raw.length <= maxChars) return raw
  const omitted = raw.length - maxChars
  return `${raw.slice(0, maxChars)}\n... (truncated ${omitted} chars)`
}

/** Extract semantic text, reasoning, tool calls, and attachment descriptors from DSH content blocks. */
function unpackContentBlocks(content) {
  const textParts = []
  const reasoningParts = []
  const toolCalls = []
  const attachments = []
  if (!Array.isArray(content)) {
    return { text: '', reasoning: '', toolCalls, attachments }
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      textParts.push(block.text)
    } else if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0) {
      reasoningParts.push(block.text)
    } else if (block.type === 'tool-call') {
      toolCalls.push({
        id: String(block.id ?? ''),
        name: String(block.name ?? 'tool'),
        arguments: typeof block.arguments === 'string'
          ? block.arguments
          : JSON.stringify(block.arguments ?? {}),
      })
    } else if (block.type === 'image' && block.attachment) {
      attachments.push(`[image: ${block.attachment.attachmentId ?? 'unknown'} (${block.attachment.mediaType ?? 'image'})]`)
    } else if (block.type === 'file' && block.attachment) {
      attachments.push(`[file: ${block.attachment.name ?? block.attachment.attachmentId ?? 'unknown'} (${block.attachment.bytes ?? 0}B)]`)
    }
  }
  return {
    text: textParts.join('\n').trim(),
    reasoning: reasoningParts.join('\n').trim(),
    toolCalls,
    attachments,
  }
}

/** Format an integer token count compactly (e.g. `42.0k`). */
export function formatCompactTokens(tokens) {
  const n = Number(tokens)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/** Format a Unix epoch ms or ISO string cleanly as UTC ISO timestamp. */
function formatTimestamp(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    return new Date(ts).toISOString()
  }
  if (typeof ts === 'string' && ts.trim()) return ts.trim()
  return ''
}

// #FUNC Transform a raw DSH session header and `SessionEvent[]` log into a clean, stream-stripped diagnostic transcript with real token/context accounting.
// #NOT  Never embeds raw `assistant/message.data.stream` SSE chunk arrays that inflate exports by orders of magnitude.
// #EDGE-IN A session with `request/context` (`contextWindow`), `assistant/message` (`usage`, `reasoning`, `stream`), `tool/call`, and errored `tool/result` yields accurate `context_pct`, strips `stream`, and respects `includeReasoning` → test_log_export_normal_conversation_with_subagents_and_usage
// #WHY  Stripping `data.stream` while preserving `usage`, `contextWindow`, tool arguments/results, and abnormal `turn/end` reasons keeps exports compact enough for human review and cross-AI pathology diagnosis.
export function extractSessionTranscript(header, events, options = {}) {
  const includeReasoning = options.includeReasoning !== false
  const detail = options.detail === 'full' ? 'full' : 'compact'
  const explicitCap = options.maxToolResultChars !== undefined ? Number(options.maxToolResultChars) : null
  const maxToolArgChars = explicitCap !== null
    ? explicitCap
    : (detail === 'full' ? DEFAULT_MAX_TOOL_RESULT_CHARS : COMPACT_MAX_TOOL_ARG_CHARS)
  const maxOkResultChars = explicitCap !== null
    ? explicitCap
    : (detail === 'full' ? DEFAULT_MAX_TOOL_RESULT_CHARS : COMPACT_MAX_OK_RESULT_CHARS)
  const maxErrResultChars = explicitCap !== null
    ? explicitCap
    : (detail === 'full' ? DEFAULT_MAX_TOOL_RESULT_CHARS : COMPACT_MAX_ERR_RESULT_CHARS)
  const safeEvents = Array.isArray(events) ? events : []

  const models = []
  const seenModels = new Set()
  const rememberModel = (provider, model) => {
    const label = provider && model ? `${provider}/${model}` : (model || provider || '')
    if (!label || seenModels.has(label)) return
    seenModels.add(label)
    models.push(label)
  }

  let contextWindow = 0
  let lastInputTokens = 0
  let peakInputTokens = 0
  let totalOutputTokens = 0
  let turns = 0
  let steps = 0
  let toolCallsCount = 0
  let toolErrorsCount = 0
  let errorsCount = 0
  let compactionsCount = 0
  let labelFromDescriptor = ''

  const toolNameByCallId = new Map()
  const entries = []

  for (const ev of safeEvents) {
    if (!ev || typeof ev !== 'object') continue
    const ts = formatTimestamp(ev.time)
    const seq = typeof ev.seq === 'number' ? ev.seq : null
    const data = ev.data ?? {}

    switch (ev.type) {
      case 'request/context': {
        rememberModel(data.provider, data.model)
        if (typeof data.contextWindow === 'number' && data.contextWindow > 0) {
          contextWindow = data.contextWindow
        }
        break
      }
      case 'request/header': {
        const cfg = data.header?.config
        if (cfg) rememberModel(cfg.provider, cfg.model)
        break
      }
      case 'subagent/descriptor': {
        if (typeof data.label === 'string' && data.label.trim()) {
          labelFromDescriptor = data.label.trim()
        }
        rememberModel(data.agentProvider, data.agentModel)
        break
      }
      case 'turn/start': {
        turns = Math.max(turns + 1, Number(data.turn) || 0)
        break
      }
      case 'step/start': {
        steps += 1
        break
      }
      case 'user/message': {
        const unpacked = unpackContentBlocks(data.content)
        const src = data.source ?? {}
        const sourceTag = [src.kind, src.form].filter(Boolean).join(':') || 'user'
        entries.push({
          kind: 'user',
          seq,
          time: ts,
          source: sourceTag,
          ...(typeof src.summary === 'string' && src.summary ? { summary: src.summary } : {}),
          text: unpacked.text,
          ...(unpacked.attachments.length > 0 ? { attachments: unpacked.attachments } : {}),
        })
        break
      }
      case 'assistant/message': {
        const msg = data.message ?? {}
        const src = msg.source ?? {}
        rememberModel(src.provider, src.model)
        const unpacked = unpackContentBlocks(msg.content)
        for (const tc of unpacked.toolCalls) {
          if (tc.id && tc.name) toolNameByCallId.set(tc.id, tc.name)
        }
        const usage = data.usage && typeof data.usage === 'object' ? data.usage : null
        if (usage) {
          const inp = Number(usage.inputTokens) || 0
          const out = Number(usage.outputTokens) || 0
          if (inp > 0) {
            lastInputTokens = inp
            if (inp > peakInputTokens) peakInputTokens = inp
          }
          if (out > 0) totalOutputTokens += out
        }
        entries.push({
          kind: 'assistant',
          seq,
          time: ts,
          turn: data.turn ?? null,
          step: data.step ?? null,
          model: src.provider && src.model ? `${src.provider}/${src.model}` : (src.model || ''),
          text: unpacked.text,
          ...(includeReasoning && unpacked.reasoning ? { reasoning: unpacked.reasoning } : {}),
          ...(unpacked.toolCalls.length > 0 ? { tool_calls: unpacked.toolCalls } : {}),
          ...(unpacked.attachments.length > 0 ? { attachments: unpacked.attachments } : {}),
          ...(usage ? {
            usage: {
              input_tokens: Number(usage.inputTokens) || 0,
              output_tokens: Number(usage.outputTokens) || 0,
              ...(Number(usage.cacheReadTokens) > 0 ? { cache_read_tokens: Number(usage.cacheReadTokens) } : {}),
              ...(Number(usage.reasoningTokens) > 0 ? { reasoning_tokens: Number(usage.reasoningTokens) } : {}),
            },
          } : {}),
          ...(data.interrupted === true ? { interrupted: true } : {}),
        })
        break
      }
      case 'tool/call': {
        toolCallsCount += 1
        const callId = String(data.callId ?? '')
        const name = String(data.name ?? 'tool')
        if (callId) toolNameByCallId.set(callId, name)
        entries.push({
          kind: 'tool_call',
          seq,
          time: ts,
          turn: data.turn ?? null,
          step: data.step ?? null,
          call_id: callId,
          name,
          arguments: truncateText(
            typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
            maxToolArgChars,
          ),
        })
        break
      }
      case 'tool/result': {
        const msg = data.message ?? {}
        const callId = String(msg.toolCallId ?? msg.source?.callId ?? '')
        const toolName = toolNameByCallId.get(callId) ?? 'tool'
        const isError = msg.isError === true || Boolean(data.error)
        if (isError) toolErrorsCount += 1
        const unpacked = unpackContentBlocks(msg.content)
        entries.push({
          kind: 'tool_result',
          seq,
          time: ts,
          turn: data.turn ?? null,
          step: data.step ?? null,
          call_id: callId,
          name: toolName,
          is_error: isError,
          ...(data.error ? { error: data.error } : {}),
          text: truncateText(unpacked.text, isError ? maxErrResultChars : maxOkResultChars),
          ...(unpacked.attachments.length > 0 ? { attachments: unpacked.attachments } : {}),
        })
        break
      }
      case 'turn/end': {
        const reason = data.reason ?? { kind: 'completed' }
        if (reason.kind === 'error') errorsCount += 1
        if (reason.kind && reason.kind !== 'completed') {
          entries.push({
            kind: 'turn_end',
            seq,
            time: ts,
            turn: data.turn ?? null,
            reason_kind: reason.kind,
            ...(reason.error ? { error: { code: reason.error.code ?? 'ERROR', message: reason.error.message ?? String(reason.error) } } : {}),
            ...(reason.reason ? { cancel_cause: reason.reason } : {}),
          })
        }
        break
      }
      case 'compaction/start':
      case 'compaction/end':
      case 'compaction/summary': {
        if (ev.type === 'compaction/start') compactionsCount += 1
        if (ev.type === 'compaction/end' && data.error) errorsCount += 1
        entries.push({
          kind: 'compaction',
          event_type: ev.type,
          seq,
          time: ts,
          ...(data.turn !== undefined ? { turn: data.turn } : {}),
          ...(data.error ? { error: String(data.error) } : {}),
        })
        break
      }
      default:
        break
    }
  }

  const contextPct = contextWindow > 0 && lastInputTokens > 0
    ? Math.round((lastInputTokens / contextWindow) * 1000) / 10
    : null
  const peakContextPct = contextWindow > 0 && peakInputTokens > 0
    ? Math.round((peakInputTokens / contextWindow) * 1000) / 10
    : null

  return {
    session_id: header?.id ?? options.sessionId ?? '',
    label: options.explicitLabel || labelFromDescriptor || options.label || header?.id || options.sessionId || '',
    cwd: header?.cwd ?? null,
    created_at: formatTimestamp(header?.createdAt),
    origin: header?.origin ?? 'main',
    parent_session: header?.parentSession ?? null,
    delegation_depth: header?.delegationDepth ?? 0,
    agent_preset: header?.agentPreset ?? null,
    models,
    stats: {
      raw_events: safeEvents.length,
      entries: entries.length,
      turns,
      steps,
      tool_calls: toolCallsCount,
      tool_errors: toolErrorsCount,
      errors: errorsCount,
      compactions: compactionsCount,
      last_input_tokens: lastInputTokens,
      peak_input_tokens: peakInputTokens,
      total_output_tokens: totalOutputTokens,
      context_window: contextWindow,
      context_pct: contextPct,
      peak_context_pct: peakContextPct,
    },
    entries,
  }
}

/** Read one DSH session's header and full event log using official DSH services with clean fallbacks. */
async function loadDshSession({ ctx, runtime, sessionId, signal }) {
  if (!sessionId) return { found: false, header: null, events: [], source: 'none' }
  const sessionsSvc = ctx?.get?.('sessions')
  const persistenceSvc = ctx?.get?.('sessionPersistence')
  const querySvc = ctx?.get?.('sessionQuery')
  const agentsSvc = ctx?.get?.('agents')

  // 1. Flush any live in-memory session so persistence observes the complete prefix.
  const liveSession = sessionsSvc?.get?.(sessionId) ?? agentsSvc?.get?.(sessionId)?.session ?? null
  if (liveSession && typeof sessionsSvc?.flush === 'function') {
    try {
      await sessionsSvc.flush(liveSession)
    } catch {
      // Fall through to read whatever is durable or in-memory.
    }
  }

  // 2. Primary durable read through `sessionPersistence.open(id, 'read')` (supports zstd JSONL, SQLite, etc.).
  if (persistenceSvc && typeof persistenceSvc.open === 'function') {
    let handle = null
    try {
      handle = await persistenceSvc.open(sessionId, 'read', signal ? { signal } : {})
      const res = await handle.read(0, undefined, signal ? { signal } : {})
      return {
        found: true,
        header: handle.header ?? liveSession?.header ?? { id: sessionId },
        events: Array.isArray(res?.events) ? res.events : [],
        source: 'sessionPersistence',
      }
    } catch (err) {
      if (err?.name !== 'SessionPersistenceNotFoundError' && err?.code !== 'SESSION_NOT_FOUND') {
        // Fall through to query / live fallbacks when storage read fails.
      }
    } finally {
      if (handle && typeof handle.close === 'function') {
        try { await handle.close() } catch {}
      }
    }
  }

  // 3. Secondary durable read through `sessionQuery.readSession(id)`.
  if (querySvc && typeof querySvc.readSession === 'function') {
    try {
      const snap = await querySvc.readSession(sessionId)
      if (snap && Array.isArray(snap.events)) {
        return {
          found: true,
          header: snap.session ?? liveSession?.header ?? { id: sessionId },
          events: snap.events,
          source: 'sessionQuery',
        }
      }
    } catch {
      // Fall through to live in-memory session.
    }
  }

  // 4. Live in-memory Session snapshot or runtime ring buffer fallback.
  if (liveSession) {
    const events = typeof liveSession.snapshotEvents === 'function'
      ? liveSession.snapshotEvents()
      : (typeof liveSession.events === 'function' ? liveSession.events() : [])
    return {
      found: true,
      header: liveSession.header ?? { id: sessionId },
      events: Array.isArray(events) ? [...events] : [],
      source: 'liveSession',
    }
  }

  const buffered = runtime?.sessionEventsByAgent?.get?.(sessionId)
  if (Array.isArray(buffered) && buffered.length > 0) {
    return {
      found: true,
      header: { id: sessionId },
      events: [...buffered],
      source: 'telemetryBuffer',
    }
  }

  return { found: false, header: null, events: [], source: 'missing' }
}

/** Collect all subagent descendant session IDs via `ctx.sessionQuery.traceSession`. */
async function collectDescendantSessionIds({ ctx, sessionId, signal }) {
  const querySvc = ctx?.get?.('sessionQuery')
  if (!sessionId || !querySvc || typeof querySvc.traceSession !== 'function') return []
  try {
    const lineage = await querySvc.traceSession(sessionId, signal)
    const ids = []
    const seen = new Set([sessionId])
    const walk = (nodes) => {
      if (!Array.isArray(nodes)) return
      for (const node of nodes) {
        const id = node?.session?.header?.id
        if (id && !seen.has(id)) {
          seen.add(id)
          ids.push(id)
        }
        walk(node?.descendants)
      }
    }
    walk(lineage?.descendants)
    return ids
  } catch {
    return []
  }
}

// #FUNC Collect a complete diagnostic log bundle for either a Swarm (blackboard + roster + all member sessions) or a regular DSH conversation (root session + native subagents).
// #NOT  Never falls back to an unrelated Swarm when exporting a normal non-Swarm conversation.
// #EDGE-IN Exporting a normal conversation while an unrelated Swarm exists on disk returns `mode: "session"` with only that conversation and its own subagents → test_log_export_normal_conversation_with_subagents_and_usage
// #EDGE-IN Exporting from a Swarm member's session ID resolves the owning Swarm and bundles the blackboard plus coordinator and member transcripts → test_log_export_swarm_blackboard_members_and_context_telemetry
// #WHY  Strict `resolveSwarmId(sessionId, { fallbackLatest: false })` prevents cross-session contamination while sharing one unified exporter for Swarm and regular chats.
export async function collectDiagnosticExport({
  ctx,
  store,
  runtime,
  sessionId = '',
  swarmId = '',
  detail = 'compact',
  includeSubagents = true,
  includeReasoning = true,
  maxToolResultChars,
  signal,
} = {}) {
  const effectiveDetail = detail === 'full' ? 'full' : 'compact'
  const reqSessionId = String(sessionId ?? '').trim()
  const explicitSwarmId = String(swarmId ?? '').trim()

  let resolvedSwarmId = null
  if (explicitSwarmId && store?.exists?.(explicitSwarmId)) {
    resolvedSwarmId = explicitSwarmId
  } else if (reqSessionId && typeof store?.resolveSwarmId === 'function') {
    resolvedSwarmId = store.resolveSwarmId(reqSessionId, { fallbackLatest: false })
  }

  const mode = resolvedSwarmId ? 'swarm' : 'session'
  const rootSessionId = resolvedSwarmId || reqSessionId
  if (!rootSessionId) {
    return { ok: false, status: 400, error: 'Missing sessionId or swarmId query parameter.' }
  }

  const exportedAt = new Date().toISOString()
  const sessionsOut = []
  const seenSessionIds = new Set()

  const addSessionTranscript = async (sid, meta = {}) => {
    if (!sid || seenSessionIds.has(sid)) return null
    seenSessionIds.add(sid)
    const loaded = await loadDshSession({ ctx, runtime, sessionId: sid, signal })
    const transcript = extractSessionTranscript(loaded.header ?? { id: sid }, loaded.events, {
      sessionId: sid,
      explicitLabel: meta.explicitLabel,
      label: meta.label,
      detail: effectiveDetail,
      includeReasoning,
      ...(maxToolResultChars !== undefined ? { maxToolResultChars } : {}),
    })
    const entry = {
      ...transcript,
      found: loaded.found,
      source: loaded.source,
      ...(meta.memberName ? { member_name: meta.memberName } : {}),
      ...(meta.role ? { role: meta.role } : {}),
      ...(meta.killed !== undefined ? { killed: meta.killed } : {}),
    }
    sessionsOut.push(entry)
    return entry
  }

  let swarmSection = null
  if (mode === 'swarm') {
    const { events, projection } = store.projectState(resolvedSwarmId)
    const membersMap = store.readMembers(resolvedSwarmId)
    const activeRejections = store.computeActiveRejections(resolvedSwarmId)
    const watchdog = typeof runtime?.getWatchdogStatus === 'function'
      ? runtime.getWatchdogStatus(resolvedSwarmId)
      : null

    const roster = []
    for (const [name, raw] of Object.entries(membersMap)) {
      if (!raw || (raw.system_builtin === true && raw.role === 'monitor')) continue
      const overlay = typeof runtime?.getMemberTelemetry === 'function'
        ? runtime.getMemberTelemetry(raw.session_id)
        : null
      const m = overlay ? { ...raw, ...overlay } : raw
      const liveness = typeof runtime?.getMemberLiveness === 'function'
        ? runtime.getMemberLiveness(resolvedSwarmId, name, m)
        : { status: m.killed ? 'killed' : 'waiting', stepSummary: null }
      roster.push({
        name,
        session_id: m.session_id,
        role: m.role,
        can_block_merge: m.can_block_merge === true || getRoleSpec(m.role).canBlockMerge,
        applied_provider: m.applied_provider ?? 'inherit',
        applied_model: m.applied_model ?? 'inherit',
        workspace_mode: m.workspace_mode ?? 'inherit',
        status: liveness.status,
        step_summary: liveness.stepSummary ?? null,
        killed: m.killed === true,
        turn_count: m.turn_count ?? 0,
        tool_call_count: m.tool_call_count ?? 0,
        last_read_seq: m.last_read_seq ?? 0,
        last_post_seq: m.last_post_seq ?? 0,
        last_input_tokens: m.last_input_tokens ?? 0,
        context_window: m.context_window ?? 0,
        last_error: m.last_error ?? null,
      })
    }

    const domainEvents = events.filter(ev => ev && ev.type !== 'state.checkpoint')
    swarmSection = {
      swarm: projection.swarm,
      head_seq: projection.headSeq,
      plan: projection.plan,
      watchdog,
      active_rejections: activeRejections,
      roster,
      events: domainEvents,
    }

    // Load Coordinator session first, then all Swarm members, then any extra native subagents.
    const coordRow = roster.find(r => r.name === 'coordinator')
    await addSessionTranscript(coordRow?.session_id || resolvedSwarmId, {
      explicitLabel: '@coordinator (coordinator)',
      memberName: 'coordinator',
      role: 'coordinator',
      killed: false,
    })

    if (includeSubagents) {
      for (const row of roster) {
        if (row.name === 'coordinator' || !row.session_id) continue
        await addSessionTranscript(row.session_id, {
          explicitLabel: `@${row.name} (${row.role})`,
          memberName: row.name,
          role: row.role,
          killed: row.killed,
        })
      }
      const extraDescendants = await collectDescendantSessionIds({ ctx, sessionId: resolvedSwarmId, signal })
      for (const childId of extraDescendants) {
        await addSessionTranscript(childId, { label: `subagent:${childId}` })
      }
    }
  } else {
    const rootEntry = await addSessionTranscript(rootSessionId, { label: `main:${rootSessionId}` })
    if (!rootEntry || !rootEntry.found) {
      return { ok: false, status: 404, error: `Session "${rootSessionId}" not found.` }
    }
    if (includeSubagents) {
      const descendants = await collectDescendantSessionIds({ ctx, sessionId: rootSessionId, signal })
      for (const childId of descendants) {
        await addSessionTranscript(childId, { label: `subagent:${childId}` })
      }
    }
  }

  const totals = {
    sessions: sessionsOut.length,
    sessions_with_transcript: sessionsOut.filter(s => s.found).length,
    turns: sessionsOut.reduce((sum, s) => sum + (s.stats?.turns ?? 0), 0),
    tool_calls: sessionsOut.reduce((sum, s) => sum + (s.stats?.tool_calls ?? 0), 0),
    tool_errors: sessionsOut.reduce((sum, s) => sum + (s.stats?.tool_errors ?? 0), 0),
    errors: sessionsOut.reduce((sum, s) => sum + (s.stats?.errors ?? 0), 0),
    compactions: sessionsOut.reduce((sum, s) => sum + (s.stats?.compactions ?? 0), 0),
  }

  return {
    ok: true,
    status: 200,
    bundle: {
      format: DIAGNOSTIC_EXPORT_FORMAT,
      exported_at: exportedAt,
      mode,
      root_session_id: rootSessionId,
      requested_session_id: reqSessionId || rootSessionId,
      options: {
        detail: effectiveDetail,
        include_subagents: includeSubagents,
        include_reasoning: includeReasoning,
        ...(maxToolResultChars !== undefined ? { max_tool_result_chars: maxToolResultChars } : {}),
      },
      totals,
      ...(swarmSection ? { swarm: swarmSection } : {}),
      sessions: sessionsOut,
    },
  }
}

/** Render a diagnostic log bundle as clean, AI- and human-readable Markdown. */
export function formatDiagnosticMarkdown(bundle) {
  if (!bundle || typeof bundle !== 'object') return ''
  const lines = []
  const isSwarm = bundle.mode === 'swarm' && bundle.swarm
  const rootSession = Array.isArray(bundle.sessions) && bundle.sessions.length > 0 ? bundle.sessions[0] : null
  const title = isSwarm
    ? `Swarm Diagnostic Log: ${bundle.swarm.swarm?.title || bundle.root_session_id}`
    : `Session Diagnostic Log: ${bundle.root_session_id}`

  lines.push(`# ${title}`)
  lines.push('')
  lines.push('| Field | Value |')
  lines.push('| --- | --- |')
  lines.push(`| Format | \`${bundle.format}\` |`)
  lines.push(`| Mode | \`${bundle.mode}\` |`)
  lines.push(`| Root Session | \`${bundle.root_session_id}\` |`)
  if (bundle.requested_session_id && bundle.requested_session_id !== bundle.root_session_id) {
    lines.push(`| Requested Session | \`${bundle.requested_session_id}\` |`)
  }
  const cwd = (isSwarm ? bundle.swarm.swarm?.project_root : null) || rootSession?.cwd || '-'
  lines.push(`| CWD / Project Root | \`${cwd}\` |`)
  lines.push(`| Exported At | ${bundle.exported_at} |`)
  const t = bundle.totals ?? {}
  lines.push(`| Sessions Included | ${t.sessions ?? 0} (${t.sessions_with_transcript ?? 0} with transcript) |`)
  lines.push(`| Totals | turns=${t.turns ?? 0}, tool_calls=${t.tool_calls ?? 0}, tool_errors=${t.tool_errors ?? 0}, errors=${t.errors ?? 0}, compactions=${t.compactions ?? 0} |`)
  lines.push('')

  if (isSwarm) {
    const sw = bundle.swarm
    lines.push('## Swarm Overview & Roster')
    lines.push('')
    lines.push(`- **Status**: \`${sw.swarm?.status || 'UNKNOWN'}\` | **Head Floor**: \`#${sw.head_seq ?? 0}\` | **Concurrency Limit**: ${sw.swarm?.concurrency_limit ?? '-'}`)
    if (sw.active_rejections && sw.active_rejections.length > 0) {
      lines.push(`- **Active Merge-Gate Rejections (${sw.active_rejections.length})**: ${sw.active_rejections.map(r => `#${r.seq} @${r.reviewer} (x${r.consecutive_rejects ?? 1}): ${r.title}`).join('; ')}`)
    }
    if (sw.plan?.goal) {
      lines.push(`- **Plan Goal**: ${sw.plan.goal}`)
    }
    lines.push('')
    if (Array.isArray(sw.roster) && sw.roster.length > 0) {
      lines.push('| Member | Role | Model | Workspace | Status | Turns | Tools | Context | Last Post | Error |')
      lines.push('| --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- |')
      for (const r of sw.roster) {
        const ctxStr = r.context_window > 0 && r.last_input_tokens > 0
          ? `${formatCompactTokens(r.last_input_tokens)}/${formatCompactTokens(r.context_window)} (${Math.round((r.last_input_tokens / r.context_window) * 100)}%)`
          : '-'
        const errStr = r.last_error ? `${r.last_error.code}: ${r.last_error.message}`.replace(/\|/g, '/') : '-'
        lines.push(`| @${r.name} | ${r.role}${r.can_block_merge ? ':gate' : ''} | ${r.applied_provider}/${r.applied_model} | ${r.workspace_mode} | ${r.status}${r.killed ? ' (killed)' : ''} | ${r.turn_count} | ${r.tool_call_count} | ${ctxStr} | #${r.last_post_seq} | ${errStr} |`)
      }
      lines.push('')
    }

    lines.push('## Swarm Blackboard Timeline (`events.jsonl`)')
    lines.push('')
    for (const ev of sw.events ?? []) {
      const timeStr = formatTimestamp(ev.ts_ms)
      if (ev.type === 'board.post') {
        const p = ev.payload ?? {}
        const mentionsStr = Array.isArray(p.mentions) && p.mentions.length > 0
          ? ` -> ${p.mentions.map(m => '@' + m).join(' ')}`
          : ''
        const verdictStr = p.verdict ? ` [verdict=${p.verdict}]` : ''
        const chStr = p.channel && p.channel !== 'main' ? ` #${p.channel}` : ''
        lines.push(`### #${p.seq ?? ev.seq} @${p.agent || ev.actor} (${p.kind || 'post'}${chStr})${verdictStr}${mentionsStr}`)
        lines.push(`*${timeStr}*${p.title ? ` — **${p.title}**` : ''}`)
        lines.push('')
        lines.push(String(p.text ?? '').trim())
        lines.push('')
      } else if (ev.type === 'member.spawn' || ev.type === 'member.kill' || ev.type === 'member.model_switch' || ev.type === 'swarm.done' || ev.type === 'plan.update') {
        const p = ev.payload ?? {}
        const summary = ev.type === 'member.spawn'
          ? `spawned @${p.name} (${p.role}, ${p.applied_provider || p.provider || 'inherit'}/${p.applied_model || p.model || 'inherit'}, ws=${p.workspace_mode || 'inherit'})`
          : ev.type === 'member.kill'
            ? `retired @${p.name}${p.handover_to ? ' -> @' + p.handover_to : ''}${p.reason ? ' (' + p.reason + ')' : ''}`
            : ev.type === 'member.model_switch'
              ? `switched @${p.name} to ${p.applied_provider}/${p.applied_model} (${p.reason || ''})`
              : ev.type === 'plan.update'
                ? `updated plan: ${p.goal || ''}`
                : `closed swarm (${p.status || 'DONE'})`
        lines.push(`- **[${ev.type}]** (${timeStr}, seq #${ev.seq ?? 0}, by @${ev.actor || 'system'}): ${summary}`)
      }
    }
    lines.push('')
  }

  lines.push('## Session Transcripts')
  lines.push('')
  for (const s of bundle.sessions ?? []) {
    const st = s.stats ?? {}
    const ctxNote = st.context_window > 0 && st.last_input_tokens > 0
      ? ` | ctx=${formatCompactTokens(st.last_input_tokens)}/${formatCompactTokens(st.context_window)} (${st.context_pct}%${st.peak_context_pct && st.peak_context_pct !== st.context_pct ? ', peak ' + st.peak_context_pct + '%' : ''})`
      : (st.last_input_tokens > 0 ? ` | last_in=${formatCompactTokens(st.last_input_tokens)}` : '')
    const modelNote = Array.isArray(s.models) && s.models.length > 0 ? ` | models=${s.models.join(', ')}` : ''
    lines.push(`### Session: ${s.label || s.session_id}`)
    lines.push(`- **ID**: \`${s.session_id}\` | **Origin**: \`${s.origin}\` | **Source**: \`${s.source}\`${modelNote}${ctxNote}`)
    lines.push(`- **Stats**: turns=${st.turns ?? 0}, steps=${st.steps ?? 0}, tool_calls=${st.tool_calls ?? 0}, tool_errors=${st.tool_errors ?? 0}, errors=${st.errors ?? 0}, compactions=${st.compactions ?? 0}`)
    lines.push('')

    if (!s.found || !Array.isArray(s.entries) || s.entries.length === 0) {
      lines.push(`*(No transcript entries recorded for this session.)*`)
      lines.push('')
      continue
    }

    for (const entry of s.entries) {
      const tsPrefix = entry.time ? `[${entry.time.slice(11, 19)}] ` : ''
      if (entry.kind === 'user') {
        const tag = entry.source && entry.source !== 'user' ? ` (${entry.source}${entry.summary ? ': ' + entry.summary : ''})` : ''
        lines.push(`#### ${tsPrefix}USER${tag}`)
        if (entry.text) lines.push(entry.text)
        if (entry.attachments) lines.push(entry.attachments.join(' '))
        lines.push('')
      } else if (entry.kind === 'assistant') {
        const metaParts = []
        if (entry.turn !== null && entry.turn !== undefined) metaParts.push(`T${entry.turn}.S${entry.step ?? 0}`)
        if (entry.model) metaParts.push(entry.model)
        if (entry.usage) {
          metaParts.push(`in=${formatCompactTokens(entry.usage.input_tokens)} out=${formatCompactTokens(entry.usage.output_tokens)}`)
        }
        if (entry.interrupted) metaParts.push('INTERRUPTED')
        lines.push(`#### ${tsPrefix}ASSISTANT${metaParts.length > 0 ? ' (' + metaParts.join(' | ') + ')' : ''}`)
        if (entry.reasoning) {
          lines.push('<details><summary>Reasoning</summary>')
          lines.push('')
          lines.push(entry.reasoning)
          lines.push('')
          lines.push('</details>')
          lines.push('')
        }
        if (entry.text) lines.push(entry.text)
        if (entry.tool_calls && entry.tool_calls.length > 0 && !s.entries.some(e => e.kind === 'tool_call' && e.call_id === entry.tool_calls[0].id)) {
          for (const tc of entry.tool_calls) {
            lines.push(`- **Tool Call** \`${tc.name}\`: \`${tc.arguments}\``)
          }
        }
        if (entry.attachments) lines.push(entry.attachments.join(' '))
        lines.push('')
      } else if (entry.kind === 'tool_call') {
        if (bundle.options?.detail === 'compact') {
          const singleArg = String(entry.arguments || '{}').replace(/\s+/g, ' ')
          lines.push(`> \`${entry.name}\`(${singleArg})`)
        } else {
          lines.push(`> **Tool Call** \`${entry.name}\` (${tsPrefix.trim() || 'call'}):`)
          lines.push('```json')
          lines.push(entry.arguments || '{}')
          lines.push('```')
          lines.push('')
        }
      } else if (entry.kind === 'tool_result') {
        const statusLabel = entry.is_error ? 'ERROR' : 'OK'
        const errInfo = entry.error ? ` (${entry.error.code || entry.error.name}: ${entry.error.reason || ''})` : ''
        if (bundle.options?.detail === 'compact' && !entry.is_error) {
          const preview = String(entry.text || '').replace(/\s+/g, ' ').trim()
          lines.push(`> -> \`${entry.name}\` [OK]${preview ? ': ' + preview : ''}`)
          lines.push('')
        } else {
          lines.push(`> **Tool Result** \`${entry.name}\` [${statusLabel}]${errInfo}:`)
          if (entry.text) {
            lines.push('```text')
            lines.push(entry.text)
            lines.push('```')
          }
          if (entry.attachments) lines.push(entry.attachments.join(' '))
          lines.push('')
        }
      } else if (entry.kind === 'turn_end') {
        const errText = entry.error ? ` — ${entry.error.code}: ${entry.error.message}` : ''
        lines.push(`> **[TURN_END: ${entry.reason_kind}]** (turn=${entry.turn ?? '?'}${errText})`)
        lines.push('')
      } else if (entry.kind === 'compaction') {
        lines.push(`> **[${entry.event_type}]**${entry.error ? ' ERROR: ' + entry.error : ''}`)
        lines.push('')
      }
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}
