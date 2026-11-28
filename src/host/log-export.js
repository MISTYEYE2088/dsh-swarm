// AI-first programmatic JSONL forensic log exporter for both Swarm sessions
// and regular DSH conversations, with automatic compaction epoch file splitting
// and zero-dependency standard ZIP packaging (`node:zlib`).
//
// Strictly English-only and zero external npm dependencies. Reads committed DSH
// session logs through official Host services (`sessions`, `sessionPersistence`,
// `sessionQuery`) with graceful fallbacks for in-memory or test hosts.

import zlib from 'node:zlib'
import { getRoleSpec } from './prompts.js'

export const DIAGNOSTIC_EXPORT_FORMAT = 'dsh-swarm-forensic-log/v2'
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 4000
export const COMPACT_MAX_TOOL_ARG_CHARS = 320
export const COMPACT_MAX_OK_RESULT_CHARS = 280
export const COMPACT_MAX_ERR_RESULT_CHARS = 2000
export const COMPACT_MAX_RELAY_CHARS = 600

/** Build a filesystem-safe export basename or filename with UTC timestamp. */
export function safeExportFilename(prefix, id, ext, now = new Date()) {
  const safePrefix = String(prefix || 'dsh-log').replace(/[^A-Za-z0-9_-]/g, '_')
  const safeId = String(id || 'session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'session'
  const allowedExts = { zip: 'zip', jsonl: 'jsonl', json: 'json' }
  const safeExt = allowedExts[ext] || 'zip'
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

/** Format an integer token count compactly (e.g. `42.0k`). */
export function formatCompactTokens(tokens) {
  const n = Number(tokens)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/** Truncate long text cleanly while reporting omitted character count. */
function truncateText(text, maxChars) {
  const raw = String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0 || raw.length <= maxChars) return raw
  const omitted = raw.length - maxChars
  return `${raw.slice(0, maxChars)} ... (truncated ${omitted} chars)`
}

/** Collapse whitespace into a compact single-line preview for timeline/index rows. */
function compactPreview(text, maxChars = 140) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxChars) return oneLine
  return `${oneLine.slice(0, maxChars - 3)}...`
}

/** Sanitize a label into a safe short directory slug. */
function slugifySegment(raw, maxLen = 28) {
  const cleaned = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
  return cleaned || 'session'
}

/** Normalize epoch ms or ISO timestamp into `{ ts, ts_ms }`. */
function normalizeTime(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { ts: new Date(raw).toISOString(), ts_ms: Math.floor(raw) }
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) {
      return { ts: new Date(parsed).toISOString(), ts_ms: parsed }
    }
    return { ts: raw.trim(), ts_ms: 0 }
  }
  return { ts: '', ts_ms: 0 }
}

/** Classify a DSH `user/message` source so genuine human prompts never mix with repetitive harness snapshots. */
function classifyUserSource(source) {
  const src = source && typeof source === 'object' ? source : {}
  const kind = String(src.kind ?? 'user')
  const form = String(src.form ?? '')
  const tag = form ? `${kind}:${form}` : kind
  if (kind === 'compact-checkpoint') return { category: 'compaction_checkpoint', tag }
  if (kind === 'user' && form === 'notice') return { category: 'swarm_notice', tag }
  if (kind === 'user' || kind === 'goal') return { category: 'human', tag }
  if (kind === 'subagent-settled' || kind === 'agent-message') return { category: 'relay', tag }
  return { category: 'harness_inject', tag }
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
      attachments.push({ type: 'image', id: String(block.attachment.attachmentId ?? ''), media_type: String(block.attachment.mediaType ?? '') })
    } else if (block.type === 'file' && block.attachment) {
      attachments.push({ type: 'file', id: String(block.attachment.attachmentId ?? ''), name: String(block.attachment.name ?? ''), bytes: Number(block.attachment.bytes) || 0 })
    }
  }
  return {
    text: textParts.join('\n').trim(),
    reasoning: reasoningParts.join('\n').trim(),
    toolCalls,
    attachments,
  }
}

/** Build a new mutable compaction epoch accumulator. */
function createEpochBucket(epochIndex) {
  return {
    epoch: epochIndex,
    file_name: `epoch-${String(epochIndex).padStart(2, '0')}.jsonl`,
    start_seq: null,
    end_seq: null,
    start_ts: '',
    start_ts_ms: 0,
    end_ts: '',
    end_ts_ms: 0,
    retained_from_epoch: null,
    retained_lines: 0,
    retained_seq_range: null,
    human_prompts: 0,
    turns: 0,
    tool_calls: 0,
    tool_errors: 0,
    errors: 0,
    peak_input_tokens: 0,
    peak_context_pct: null,
    first_human_preview: '',
    summary_preview: '',
    entries: [],
  }
}

/** Extract the exact verbatim-retained tail entries from `prevEpoch` left unshadowed by DSH compaction (`shadowedSeqs` / `shadowedRange`). */
function extractRetainedTail(prevEpoch, summaryData) {
  if (!prevEpoch || !Array.isArray(prevEpoch.entries) || prevEpoch.entries.length === 0) return []
  const shadowedSeqs = Array.isArray(summaryData?.shadowedSeqs)
    ? summaryData.shadowedSeqs.map(Number).filter(Number.isFinite)
    : []
  const shadowedEnd = Number(summaryData?.shadowedRange?.end)
  if (shadowedSeqs.length === 0 && !Number.isFinite(shadowedEnd)) return []

  const shadowedSet = new Set(shadowedSeqs)
  let cutIdx = -1
  for (let i = 0; i < prevEpoch.entries.length; i += 1) {
    const seq = prevEpoch.entries[i]?.seq
    if (typeof seq !== 'number') continue
    if (shadowedSet.has(seq) || (Number.isFinite(shadowedEnd) && seq === shadowedEnd)) {
      cutIdx = i
    }
  }
  if (cutIdx === -1 && Number.isFinite(shadowedEnd)) {
    for (let i = 0; i < prevEpoch.entries.length; i += 1) {
      const seq = prevEpoch.entries[i]?.seq
      if (typeof seq === 'number' && seq <= shadowedEnd) cutIdx = i
    }
    if (cutIdx === -1) {
      return prevEpoch.entries.filter(e =>
        typeof e.seq === 'number'
        && e.seq > shadowedEnd
        && e.kind !== 'compaction'
        && e.kind !== 'compaction_checkpoint',
      )
    }
  }
  if (cutIdx === -1 || cutIdx >= prevEpoch.entries.length - 1) return []
  return prevEpoch.entries.slice(cutIdx + 1)
}

// #FUNC Transform a raw DSH session header and `SessionEvent[]` log into compaction-split JSONL epochs that preserve DSH's exact verbatim-retained tail overlap across adjacent epochs.
// #NOT  Never embeds raw `assistant/message.data.stream` SSE delta arrays, never mixes `skill-catalog`/`runtime-context` injections into `kind="human"`, and never double-counts carried-over retained tail entries in stats or timeline.
// #EDGE-IN A session whose `compaction/summary` shadows `seq 4..8` while retaining `seq 9..12` duplicates `seq 9..12` verbatim at the top of `epoch-01.jsonl` tagged with `retained_from_epoch: 0` right after `compaction_checkpoint` → test_log_export_normal_conversation_epochs_zip_and_timeline
// #WHY  Replaying DSH's exact unshadowed tail (`shadowedRange`/`shadowedSeqs`) into the next epoch file lets an AI inspect a single `epoch-XX.jsonl` and see the true verbatim context window the model actually saw after compaction.
export function extractSessionTranscript(header, events, options = {}) {
  const includeReasoning = options.includeReasoning === true
  const includeInjections = options.includeInjections === true
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
  const maxRelayChars = detail === 'full' ? DEFAULT_MAX_TOOL_RESULT_CHARS : COMPACT_MAX_RELAY_CHARS
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
  let humanPromptsCount = 0
  let toolCallsCount = 0
  let toolErrorsCount = 0
  let errorsCount = 0
  let compactionsCount = 0
  let omittedInjections = 0
  const omittedBySource = {}
  let labelFromDescriptor = ''
  let currentTurn = 0

  const toolNameByCallId = new Map()
  const epochs = [createEpochBucket(0)]
  let currentEpoch = epochs[0]
  let splitCompactionId = null
  let pendingRetainedTail = null

  const flushPendingRetainedTail = () => {
    if (!pendingRetainedTail) return
    const { fromEpoch, entries } = pendingRetainedTail
    pendingRetainedTail = null
    if (!Array.isArray(entries) || entries.length === 0) return
    currentEpoch.retained_from_epoch = fromEpoch
    currentEpoch.retained_lines = entries.length
    const seqs = entries.map(e => e.seq).filter(n => typeof n === 'number')
    if (seqs.length > 0) {
      currentEpoch.retained_seq_range = [seqs[0], seqs[seqs.length - 1]]
    }
    for (const orig of entries) {
      const line = currentEpoch.entries.length + 1
      currentEpoch.entries.push({
        ...orig,
        line,
        epoch: currentEpoch.epoch,
        retained_from_epoch: orig.retained_from_epoch ?? fromEpoch,
      })
    }
  }

  const pushEntry = (record, seq, timeObj) => {
    const line = currentEpoch.entries.length + 1
    const stamped = {
      line,
      epoch: currentEpoch.epoch,
      ...(seq !== null ? { seq } : {}),
      ...(timeObj.ts ? { ts: timeObj.ts, ts_ms: timeObj.ts_ms } : {}),
      ...record,
    }
    currentEpoch.entries.push(stamped)
    if (seq !== null) {
      if (currentEpoch.start_seq === null) currentEpoch.start_seq = seq
      currentEpoch.end_seq = seq
    }
    if (timeObj.ts_ms > 0) {
      if (currentEpoch.start_ts_ms === 0) {
        currentEpoch.start_ts = timeObj.ts
        currentEpoch.start_ts_ms = timeObj.ts_ms
      }
      currentEpoch.end_ts = timeObj.ts
      currentEpoch.end_ts_ms = timeObj.ts_ms
    }
    return stamped
  }

  const openNextEpochIfNeeded = () => {
    if (currentEpoch.entries.length === 0) return false
    const nextBucket = createEpochBucket(epochs.length)
    epochs.push(nextBucket)
    currentEpoch = nextBucket
    return true
  }

  for (const ev of safeEvents) {
    if (!ev || typeof ev !== 'object') continue
    const timeObj = normalizeTime(ev.time)
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
        currentTurn = Number(data.turn) || (currentTurn + 1)
        turns = Math.max(turns + 1, currentTurn)
        currentEpoch.turns += 1
        break
      }
      case 'step/start': {
        steps += 1
        break
      }
      case 'compaction/summary': {
        flushPendingRetainedTail()
        compactionsCount += 1
        const prevEpoch = currentEpoch
        const retainedEntries = extractRetainedTail(prevEpoch, data)
        const prevCtxPct = contextWindow > 0 && lastInputTokens > 0
          ? Math.round((lastInputTokens / contextWindow) * 1000) / 10
          : null
        const didSplit = openNextEpochIfNeeded()
        splitCompactionId = data.compactionId ?? '__active__'
        const summaryUnpacked = Array.isArray(data.summary)
          ? unpackContentBlocks(data.summary).text
          : (typeof data.summary === 'string' ? data.summary : '')
        const summaryText = truncateText(summaryUnpacked, maxErrResultChars)
        if (summaryText) currentEpoch.summary_preview = compactPreview(summaryText, 160)
        const retainedSeqs = retainedEntries.map(e => e.seq).filter(n => typeof n === 'number')
        pushEntry({
          kind: 'compaction',
          event_type: 'compaction/summary',
          compaction_id: data.compactionId ?? null,
          ...(data.shadowedRange ? { shadowed_range: data.shadowedRange } : {}),
          ...(typeof data.shadowedTokenCount === 'number' ? { shadowed_tokens: data.shadowedTokenCount } : {}),
          ...(prevCtxPct !== null ? { ctx_before_pct: prevCtxPct } : {}),
          ...(didSplit && retainedEntries.length > 0 ? {
            retained_from_epoch: prevEpoch.epoch,
            retained_lines: retainedEntries.length,
            ...(retainedSeqs.length > 0 ? { retained_seq_range: [retainedSeqs[0], retainedSeqs[retainedSeqs.length - 1]] } : {}),
          } : {}),
          ...(summaryText ? { summary: summaryText } : {}),
        }, seq, timeObj)
        if (didSplit && retainedEntries.length > 0) {
          pendingRetainedTail = { fromEpoch: prevEpoch.epoch, entries: retainedEntries }
        }
        break
      }
      case 'compaction/end': {
        flushPendingRetainedTail()
        if (data.error) {
          errorsCount += 1
          currentEpoch.errors += 1
          pushEntry({
            kind: 'compaction_error',
            event_type: 'compaction/end',
            compaction_id: data.compactionId ?? null,
            error: String(data.error),
          }, seq, timeObj)
        }
        splitCompactionId = null
        break
      }
      case 'user/message': {
        const unpacked = unpackContentBlocks(data.content)
        const src = data.source ?? {}
        const { category, tag } = classifyUserSource(src)
        if (category === 'compaction_checkpoint') {
          if (!splitCompactionId) {
            compactionsCount += 1
            openNextEpochIfNeeded()
          }
          const cpText = truncateText(unpacked.text, maxErrResultChars)
          if (cpText && !currentEpoch.summary_preview) {
            currentEpoch.summary_preview = compactPreview(cpText, 160)
          }
          pushEntry({
            kind: 'compaction_checkpoint',
            source: tag,
            text: cpText,
          }, seq, timeObj)
          // Place the verbatim-retained tail immediately after the checkpoint summary so the epoch mirrors the exact model context order.
          flushPendingRetainedTail()
          break
        }
        flushPendingRetainedTail()
        if (category === 'harness_inject') {
          if (!includeInjections) {
            omittedInjections += 1
            omittedBySource[tag] = (omittedBySource[tag] || 0) + 1
            break
          }
          pushEntry({
            kind: 'harness_inject',
            source: tag,
            ...(typeof src.summary === 'string' && src.summary ? { summary: src.summary } : {}),
            text: truncateText(unpacked.text, maxOkResultChars),
          }, seq, timeObj)
          break
        }
        if (category === 'relay') {
          pushEntry({
            kind: 'relay',
            source: tag,
            ...(src.senderSessionId ? { sender_session_id: String(src.senderSessionId) } : {}),
            ...(typeof src.summary === 'string' && src.summary ? { summary: src.summary } : {}),
            text: truncateText(unpacked.text, maxRelayChars),
          }, seq, timeObj)
          break
        }
        if (category === 'swarm_notice') {
          pushEntry({
            kind: 'swarm_notice',
            source: tag,
            ...(typeof src.summary === 'string' && src.summary ? { summary: src.summary } : {}),
            text: unpacked.text,
          }, seq, timeObj)
          break
        }
        // Genuine human prompt!
        humanPromptsCount += 1
        currentEpoch.human_prompts += 1
        if (!currentEpoch.first_human_preview && unpacked.text) {
          currentEpoch.first_human_preview = compactPreview(unpacked.text, 140)
        }
        pushEntry({
          kind: 'human',
          turn: currentTurn || null,
          source: tag,
          text: unpacked.text,
          ...(unpacked.attachments.length > 0 ? { attachments: unpacked.attachments } : {}),
        }, seq, timeObj)
        break
      }
      case 'assistant/message': {
        flushPendingRetainedTail()
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
            if (inp > currentEpoch.peak_input_tokens) {
              currentEpoch.peak_input_tokens = inp
              if (contextWindow > 0) {
                currentEpoch.peak_context_pct = Math.round((inp / contextWindow) * 1000) / 10
              }
            }
          }
          if (out > 0) totalOutputTokens += out
        }
        const hasVisibleContent = Boolean(unpacked.text)
          || (includeReasoning && Boolean(unpacked.reasoning))
          || unpacked.attachments.length > 0
          || data.interrupted === true
        if (!hasVisibleContent && unpacked.toolCalls.length > 0) {
          // Pure tool-dispatch assistant turn without prose: subsequent `tool/call` records carry the exact call details.
          break
        }
        pushEntry({
          kind: 'assistant',
          turn: data.turn ?? currentTurn ?? null,
          step: data.step ?? null,
          model: src.provider && src.model ? `${src.provider}/${src.model}` : (src.model || ''),
          ...(unpacked.text ? { text: unpacked.text } : {}),
          ...(includeReasoning && unpacked.reasoning ? { reasoning: unpacked.reasoning } : {}),
          ...(unpacked.attachments.length > 0 ? { attachments: unpacked.attachments } : {}),
          ...(usage ? {
            usage: {
              input_tokens: Number(usage.inputTokens) || 0,
              output_tokens: Number(usage.outputTokens) || 0,
              ...(Number(usage.cacheReadTokens) > 0 ? { cache_read_tokens: Number(usage.cacheReadTokens) } : {}),
            },
          } : {}),
          ...(data.interrupted === true ? { interrupted: true } : {}),
        }, seq, timeObj)
        break
      }
      case 'tool/call': {
        toolCallsCount += 1
        currentEpoch.tool_calls += 1
        const callId = String(data.callId ?? '')
        const name = String(data.name ?? 'tool')
        if (callId) toolNameByCallId.set(callId, name)
        pushEntry({
          kind: 'tool_call',
          turn: data.turn ?? currentTurn ?? null,
          step: data.step ?? null,
          call_id: callId,
          name,
          arguments: truncateText(
            typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
            maxToolArgChars,
          ),
        }, seq, timeObj)
        break
      }
      case 'tool/result': {
        const msg = data.message ?? {}
        const callId = String(msg.toolCallId ?? msg.source?.callId ?? '')
        const toolName = toolNameByCallId.get(callId) ?? 'tool'
        const isError = msg.isError === true || Boolean(data.error)
        if (isError) {
          toolErrorsCount += 1
          currentEpoch.tool_errors += 1
        }
        const unpacked = unpackContentBlocks(msg.content)
        pushEntry({
          kind: 'tool_result',
          turn: data.turn ?? currentTurn ?? null,
          step: data.step ?? null,
          call_id: callId,
          name: toolName,
          is_error: isError,
          ...(data.error ? { error: data.error } : {}),
          text: truncateText(unpacked.text, isError ? maxErrResultChars : maxOkResultChars),
          ...(unpacked.attachments.length > 0 ? { attachments: unpacked.attachments } : {}),
        }, seq, timeObj)
        break
      }
      case 'turn/end': {
        const reason = data.reason ?? { kind: 'completed' }
        if (reason.kind === 'error') {
          errorsCount += 1
          currentEpoch.errors += 1
        }
        if (reason.kind && reason.kind !== 'completed') {
          pushEntry({
            kind: 'turn_end',
            turn: data.turn ?? currentTurn ?? null,
            reason_kind: reason.kind,
            ...(reason.error ? { error: { code: reason.error.code ?? 'ERROR', message: reason.error.message ?? String(reason.error) } } : {}),
            ...(reason.reason ? { cancel_cause: reason.reason } : {}),
          }, seq, timeObj)
        }
        break
      }
      default:
        break
    }
  }
  flushPendingRetainedTail()

  const contextPct = contextWindow > 0 && lastInputTokens > 0
    ? Math.round((lastInputTokens / contextWindow) * 1000) / 10
    : null
  const peakContextPct = contextWindow > 0 && peakInputTokens > 0
    ? Math.round((peakInputTokens / contextWindow) * 1000) / 10
    : null
  const created = normalizeTime(header?.createdAt)
  const totalEntries = epochs.reduce((sum, ep) => sum + ep.entries.length, 0)
  const firstTsMs = epochs.find(ep => ep.start_ts_ms > 0)?.start_ts_ms || created.ts_ms
  const lastTsMs = [...epochs].reverse().find(ep => ep.end_ts_ms > 0)?.end_ts_ms || firstTsMs

  return {
    session_id: header?.id ?? options.sessionId ?? '',
    label: options.explicitLabel || labelFromDescriptor || options.label || header?.id || options.sessionId || '',
    cwd: header?.cwd ?? null,
    created_at: created.ts,
    created_ts_ms: created.ts_ms,
    start_ts: firstTsMs > 0 ? new Date(firstTsMs).toISOString() : created.ts,
    start_ts_ms: firstTsMs,
    end_ts: lastTsMs > 0 ? new Date(lastTsMs).toISOString() : created.ts,
    end_ts_ms: lastTsMs,
    origin: header?.origin ?? 'main',
    parent_session: header?.parentSession ?? null,
    delegation_depth: header?.delegationDepth ?? 0,
    agent_preset: header?.agentPreset ?? null,
    models,
    stats: {
      raw_events: safeEvents.length,
      entries: totalEntries,
      epochs: epochs.length,
      human_prompts: humanPromptsCount,
      turns,
      steps,
      tool_calls: toolCallsCount,
      tool_errors: toolErrorsCount,
      errors: errorsCount,
      compactions: compactionsCount,
      omitted_injections: omittedInjections,
      ...(omittedInjections > 0 ? { omitted_by_source: omittedBySource } : {}),
      last_input_tokens: lastInputTokens,
      peak_input_tokens: peakInputTokens,
      total_output_tokens: totalOutputTokens,
      context_window: contextWindow,
      context_pct: contextPct,
      peak_context_pct: peakContextPct,
    },
    epochs,
  }
}

/** Read one DSH session's header and full event log using official DSH services with clean fallbacks. */
async function loadDshSession({ ctx, runtime, sessionId, signal }) {
  if (!sessionId) return { found: false, header: null, events: [], source: 'none' }
  const sessionsSvc = ctx?.get?.('sessions')
  const persistenceSvc = ctx?.get?.('sessionPersistence')
  const querySvc = ctx?.get?.('sessionQuery')
  const agentsSvc = ctx?.get?.('agents')

  const liveSession = sessionsSvc?.get?.(sessionId) ?? agentsSvc?.get?.(sessionId)?.session ?? null
  if (liveSession && typeof sessionsSvc?.flush === 'function') {
    try {
      await sessionsSvc.flush(liveSession)
    } catch {}
  }

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
    } catch {
      // Fall through to secondary readers.
    } finally {
      if (handle && typeof handle.close === 'function') {
        try { await handle.close() } catch {}
      }
    }
  }

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
    } catch {}
  }

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

/** Serialize an array of objects as newline-terminated JSONL. */
function toJsonl(records) {
  if (!Array.isArray(records) || records.length === 0) return ''
  return `${records.map(r => JSON.stringify(r)).join('\n')}\n`
}

// #FUNC Collect a complete AI-first programmatic forensic bundle (`manifest.json`, chronological `timeline.jsonl` with `{file, line}` pointers, `swarm/board.jsonl`, and compaction-split `sessions/*/epoch-XX.jsonl` files).
// #NOT  Never falls back to an unrelated Swarm when exporting a normal non-Swarm conversation, and never merges multiple compaction epochs into one giant file.
// #EDGE-IN Exporting a normal conversation with a compaction event and native subagent splits main into `epoch-00.jsonl` + `epoch-01.jsonl` and populates `timeline.jsonl` with exact `{file, line}` jump pointers → test_log_export_normal_conversation_epochs_zip_and_timeline
// #EDGE-IN Exporting a Swarm preserves chronological multi-agent spawn/board/model_switch/kill choreography in `timeline.jsonl` alongside `swarm/board.jsonl` and per-member epoch files → test_log_export_swarm_blackboard_members_and_context_telemetry
// #WHY  Combining a tiny `manifest.json`, chronological `timeline.jsonl` pointers, and compaction-split JSONL files lets an AI audit multi-day 100+ subagent sessions programmatically without exploding context.
export async function collectDiagnosticExport({
  ctx,
  store,
  runtime,
  sessionId = '',
  swarmId = '',
  detail = 'compact',
  includeSubagents = true,
  includeReasoning = false,
  includeInjections = false,
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
  const sessionsRaw = []
  const seenSessionIds = new Set()
  let subIdx = 0

  const addSession = async (sid, meta = {}) => {
    if (!sid || seenSessionIds.has(sid)) return null
    seenSessionIds.add(sid)
    const loaded = await loadDshSession({ ctx, runtime, sessionId: sid, signal })
    const transcript = extractSessionTranscript(loaded.header ?? { id: sid }, loaded.events, {
      sessionId: sid,
      explicitLabel: meta.explicitLabel,
      label: meta.label,
      detail: effectiveDetail,
      includeReasoning,
      includeInjections,
      ...(maxToolResultChars !== undefined ? { maxToolResultChars } : {}),
    })
    let sessionKey = 'main'
    let dirName = 'main'
    if (!meta.isRoot) {
      subIdx += 1
      const num = `S${String(subIdx).padStart(3, '0')}`
      sessionKey = num
      const slug = slugifySegment(meta.memberName || transcript.label || sid)
      dirName = `${num}-${slug}`
    }
    const entry = {
      key: sessionKey,
      dir: `sessions/${dirName}`,
      ...transcript,
      found: loaded.found,
      source: loaded.source,
      ...(meta.memberName ? { member_name: meta.memberName } : {}),
      ...(meta.role ? { role: meta.role } : {}),
      ...(meta.killed !== undefined ? { killed: meta.killed } : {}),
    }
    sessionsRaw.push(entry)
    return entry
  }

  let swarmSection = null
  const memberKeyByName = new Map()
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

    const coordRow = roster.find(r => r.name === 'coordinator')
    await addSession(coordRow?.session_id || resolvedSwarmId, {
      isRoot: true,
      explicitLabel: '@coordinator (coordinator)',
      memberName: 'coordinator',
      role: 'coordinator',
      killed: false,
    })
    memberKeyByName.set('coordinator', { key: 'main', dir: 'sessions/main' })

    if (includeSubagents) {
      for (const row of roster) {
        if (row.name === 'coordinator' || !row.session_id) continue
        const s = await addSession(row.session_id, {
          explicitLabel: `@${row.name} (${row.role})`,
          memberName: row.name,
          role: row.role,
          killed: row.killed,
        })
        if (s) memberKeyByName.set(row.name, { key: s.key, dir: s.dir })
      }
      const extraDescendants = await collectDescendantSessionIds({ ctx, sessionId: resolvedSwarmId, signal })
      for (const childId of extraDescendants) {
        await addSession(childId, { label: `subagent:${childId}` })
      }
    }

    const domainEvents = events.filter(ev => ev && ev.type !== 'state.checkpoint')
    swarmSection = {
      swarm: projection.swarm,
      head_seq: projection.headSeq,
      plan: projection.plan,
      watchdog,
      active_rejections: activeRejections,
      board_file: 'swarm/board.jsonl',
      roster: roster.map(r => ({
        ...r,
        session_key: memberKeyByName.get(r.name)?.key ?? null,
        session_dir: memberKeyByName.get(r.name)?.dir ?? null,
      })),
      events: domainEvents,
    }
  } else {
    const rootEntry = await addSession(rootSessionId, { isRoot: true, label: `main:${rootSessionId}` })
    if (!rootEntry || !rootEntry.found) {
      return { ok: false, status: 404, error: `Session "${rootSessionId}" not found.` }
    }
    if (includeSubagents) {
      const descendants = await collectDescendantSessionIds({ ctx, sessionId: rootSessionId, signal })
      for (const childId of descendants) {
        await addSession(childId, { label: `subagent:${childId}` })
      }
    }
  }

  // Build chronological `timeline.jsonl`, file list, and compact `manifest.json` index.
  const files = []
  const timeline = []
  let timelineOrder = 0
  const pushTimeline = (tsMs, rec) => {
    timelineOrder += 1
    const norm = normalizeTime(tsMs)
    timeline.push({
      _order: timelineOrder,
      ts: norm.ts,
      ts_ms: norm.ts_ms,
      ...rec,
    })
  }

  // 1. Swarm board.jsonl + chronological multi-agent lifecycle & communication timeline
  let boardJsonl = ''
  if (swarmSection) {
    const boardRecords = []
    for (let i = 0; i < swarmSection.events.length; i += 1) {
      const ev = swarmSection.events[i]
      const boardLine = i + 1
      const norm = normalizeTime(ev.ts_ms)
      const p = ev.payload ?? {}
      const boardRow = {
        line: boardLine,
        offset: ev.offset ?? i,
        seq: ev.seq ?? p.seq ?? 0,
        ts: norm.ts,
        ts_ms: norm.ts_ms,
        type: ev.type,
        actor: ev.actor ?? p.agent ?? 'system',
        ...p,
      }
      boardRecords.push(boardRow)

      if (ev.type === 'board.post') {
        pushTimeline(norm.ts_ms, {
          type: 'board.post',
          seq: p.seq ?? ev.seq ?? 0,
          agent: p.agent || ev.actor || 'system',
          kind: p.kind || 'post',
          ...(p.verdict ? { verdict: p.verdict } : {}),
          mentions: Array.isArray(p.mentions) ? p.mentions : [],
          title: p.title || compactPreview(p.text, 90),
          board_file: 'swarm/board.jsonl',
          board_line: boardLine,
        })
      } else if (ev.type === 'member.spawn') {
        const ref = memberKeyByName.get(p.name)
        pushTimeline(norm.ts_ms, {
          type: 'swarm.spawn',
          agent: p.name,
          role: p.role,
          model: `${p.applied_provider || p.provider || 'inherit'}/${p.applied_model || p.model || 'inherit'}`,
          workspace: p.workspace_mode || 'inherit',
          ...(ref ? { session_key: ref.key, file: `${ref.dir}/epoch-00.jsonl` } : {}),
          board_file: 'swarm/board.jsonl',
          board_line: boardLine,
        })
      } else if (ev.type === 'member.kill') {
        pushTimeline(norm.ts_ms, {
          type: 'swarm.kill',
          agent: p.name,
          ...(p.handover_to ? { handover_to: p.handover_to } : {}),
          ...(p.reason ? { reason: p.reason } : {}),
          board_file: 'swarm/board.jsonl',
          board_line: boardLine,
        })
      } else if (ev.type === 'member.model_switch') {
        pushTimeline(norm.ts_ms, {
          type: 'swarm.model_switch',
          agent: p.name,
          to: `${p.applied_provider || ''}/${p.applied_model || ''}`,
          ...(p.reason ? { reason: p.reason } : {}),
          board_file: 'swarm/board.jsonl',
          board_line: boardLine,
        })
      } else if (ev.type === 'swarm.init' || ev.type === 'plan.update' || ev.type === 'swarm.done') {
        pushTimeline(norm.ts_ms, {
          type: ev.type,
          actor: ev.actor || 'coordinator',
          ...(p.title ? { title: p.title } : {}),
          ...(p.goal ? { goal: compactPreview(p.goal, 120) } : {}),
          ...(p.status ? { status: p.status } : {}),
          board_file: 'swarm/board.jsonl',
          board_line: boardLine,
        })
      }
    }
    boardJsonl = toJsonl(boardRecords)
    files.push({ path: 'swarm/board.jsonl', content: boardJsonl })
  }

  // 2. Per-session compaction-split `epoch-XX.jsonl` files + exact `{file, line}` timeline pointers
  const toolErrorCountsByName = {}
  const sessionManifestRows = []

  for (const s of sessionsRaw) {
    const epochManifestRows = []
    if (s.key !== 'main') {
      pushTimeline(s.start_ts_ms || s.created_ts_ms, {
        type: 'session.start',
        session_key: s.key,
        session_id: s.session_id,
        label: s.label,
        ...(s.role ? { role: s.role } : {}),
        ...(s.models.length > 0 ? { model: s.models[0] } : {}),
        dir: s.dir,
        file: `${s.dir}/${s.epochs[0]?.file_name || 'epoch-00.jsonl'}`,
      })
    }

    for (const ep of s.epochs) {
      const filePath = `${s.dir}/${ep.file_name}`
      const jsonlText = toJsonl(ep.entries)
      files.push({ path: filePath, content: jsonlText })

      epochManifestRows.push({
        epoch: ep.epoch,
        file: filePath,
        lines: ep.entries.length,
        bytes: Buffer.byteLength(jsonlText, 'utf8'),
        start_seq: ep.start_seq,
        end_seq: ep.end_seq,
        start_ts: ep.start_ts,
        end_ts: ep.end_ts,
        ...(ep.retained_lines > 0 ? {
          retained_from_epoch: ep.retained_from_epoch,
          retained_lines: ep.retained_lines,
          retained_seq_range: ep.retained_seq_range,
        } : {}),
        human_prompts: ep.human_prompts,
        turns: ep.turns,
        tool_calls: ep.tool_calls,
        tool_errors: ep.tool_errors,
        errors: ep.errors,
        peak_context_pct: ep.peak_context_pct,
        ...(ep.first_human_preview ? { first_human_preview: ep.first_human_preview } : {}),
        ...(ep.summary_preview ? { compaction_summary_preview: ep.summary_preview } : {}),
      })

      for (const entry of ep.entries) {
        // Carried-over retained tail entries belong to their birth epoch in `timeline.jsonl` (avoid duplicate timeline events).
        if (entry.retained_from_epoch !== undefined && entry.kind !== 'compaction') continue
        if (entry.kind === 'human') {
          pushTimeline(entry.ts_ms, {
            type: 'human.prompt',
            session_key: s.key,
            epoch: ep.epoch,
            turn: entry.turn ?? null,
            seq: entry.seq ?? null,
            file: filePath,
            line: entry.line,
            preview: compactPreview(entry.text, 140),
          })
        } else if (entry.kind === 'compaction' || (entry.kind === 'compaction_checkpoint' && ep.epoch > 0 && entry.line === 1)) {
          pushTimeline(entry.ts_ms, {
            type: 'compaction',
            session_key: s.key,
            from_epoch: Math.max(0, ep.epoch - 1),
            to_epoch: ep.epoch,
            seq: entry.seq ?? null,
            ...(entry.shadowed_range ? { shadowed_range: entry.shadowed_range } : {}),
            ...(entry.shadowed_tokens !== undefined ? { shadowed_tokens: entry.shadowed_tokens } : {}),
            ...(entry.ctx_before_pct !== undefined ? { ctx_before_pct: entry.ctx_before_pct } : {}),
            ...(entry.retained_lines ? {
              retained_from_epoch: entry.retained_from_epoch,
              retained_lines: entry.retained_lines,
              ...(entry.retained_seq_range ? { retained_seq_range: entry.retained_seq_range } : {}),
            } : {}),
            file: filePath,
            line: entry.line,
          })
        } else if (entry.kind === 'turn_end') {
          pushTimeline(entry.ts_ms, {
            type: 'error.turn',
            session_key: s.key,
            epoch: ep.epoch,
            turn: entry.turn ?? null,
            seq: entry.seq ?? null,
            reason: entry.reason_kind,
            ...(entry.error ? { code: entry.error.code, message: compactPreview(entry.error.message, 120) } : {}),
            file: filePath,
            line: entry.line,
          })
        } else if (entry.kind === 'tool_result' && entry.is_error) {
          toolErrorCountsByName[entry.name] = (toolErrorCountsByName[entry.name] || 0) + 1
          pushTimeline(entry.ts_ms, {
            type: 'error.tool',
            session_key: s.key,
            epoch: ep.epoch,
            turn: entry.turn ?? null,
            seq: entry.seq ?? null,
            tool: entry.name,
            ...(entry.error?.code ? { code: entry.error.code } : {}),
            preview: compactPreview(entry.error?.reason || entry.text, 120),
            file: filePath,
            line: entry.line,
          })
        }
      }
    }

    if (s.key !== 'main' && s.end_ts_ms > 0) {
      pushTimeline(s.end_ts_ms, {
        type: 'session.end',
        session_key: s.key,
        label: s.label,
        turns: s.stats.turns,
        tool_calls: s.stats.tool_calls,
        tool_errors: s.stats.tool_errors,
        errors: s.stats.errors,
        ...(s.stats.peak_context_pct !== null ? { peak_context_pct: s.stats.peak_context_pct } : {}),
      })
    }

    sessionManifestRows.push({
      key: s.key,
      session_id: s.session_id,
      label: s.label,
      ...(s.member_name ? { member_name: s.member_name } : {}),
      ...(s.role ? { role: s.role } : {}),
      ...(s.killed !== undefined ? { killed: s.killed } : {}),
      origin: s.origin,
      found: s.found,
      source: s.source,
      cwd: s.cwd,
      models: s.models,
      dir: s.dir,
      stats: s.stats,
      epochs: epochManifestRows,
    })
  }

  // Sort timeline strictly chronologically (preserving stable order on ties) and strip internal `_order`.
  timeline.sort((a, b) => (a.ts_ms - b.ts_ms) || (a._order - b._order))
  const cleanTimeline = timeline.map((item, idx) => {
    const copy = { timeline_line: idx + 1, ...item }
    delete copy._order
    return copy
  })
  const timelineJsonl = toJsonl(cleanTimeline)

  const topErrorTools = Object.entries(toolErrorCountsByName)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool, count]) => ({ tool, count }))

  const totals = {
    sessions: sessionsRaw.length,
    sessions_with_transcript: sessionsRaw.filter(s => s.found).length,
    epochs: sessionsRaw.reduce((sum, s) => sum + s.epochs.length, 0),
    timeline_events: cleanTimeline.length,
    human_prompts: sessionsRaw.reduce((sum, s) => sum + (s.stats?.human_prompts ?? 0), 0),
    turns: sessionsRaw.reduce((sum, s) => sum + (s.stats?.turns ?? 0), 0),
    tool_calls: sessionsRaw.reduce((sum, s) => sum + (s.stats?.tool_calls ?? 0), 0),
    tool_errors: sessionsRaw.reduce((sum, s) => sum + (s.stats?.tool_errors ?? 0), 0),
    errors: sessionsRaw.reduce((sum, s) => sum + (s.stats?.errors ?? 0), 0),
    compactions: sessionsRaw.reduce((sum, s) => sum + (s.stats?.compactions ?? 0), 0),
    omitted_injections: sessionsRaw.reduce((sum, s) => sum + (s.stats?.omitted_injections ?? 0), 0),
  }

  const rootCwd = (swarmSection?.swarm?.project_root) || sessionsRaw[0]?.cwd || null
  const manifest = {
    format: DIAGNOSTIC_EXPORT_FORMAT,
    ai_guide: [
      '1. Inspect manifest.json for session/epoch file paths, compaction counts, peak context %, and Swarm roster.',
      '2. Filter timeline.jsonl programmatically by type (human.prompt | board.post | swarm.spawn | swarm.kill | compaction | session.start | error.turn | error.tool) or ts_ms window.',
      '3. Jump directly to the exact {file, line} in sessions/<key>/epoch-XX.jsonl or swarm/board.jsonl instead of loading all files at once.',
    ],
    exported_at: exportedAt,
    mode,
    root_session_id: rootSessionId,
    requested_session_id: reqSessionId || rootSessionId,
    cwd: rootCwd,
    options: {
      detail: effectiveDetail,
      include_subagents: includeSubagents,
      include_reasoning: includeReasoning,
      include_injections: includeInjections,
      ...(maxToolResultChars !== undefined ? { max_tool_result_chars: maxToolResultChars } : {}),
    },
    totals,
    anomalies: {
      top_error_tools: topErrorTools,
      high_tool_sessions: sessionManifestRows
        .filter(s => (s.stats?.tool_calls ?? 0) >= 80)
        .map(s => ({ key: s.key, label: s.label, tool_calls: s.stats.tool_calls, tool_errors: s.stats.tool_errors })),
      ...(swarmSection ? { active_rejections: swarmSection.active_rejections } : {}),
    },
    ...(swarmSection ? {
      swarm: {
        title: swarmSection.swarm?.title || '',
        status: swarmSection.swarm?.status || 'UNKNOWN',
        head_seq: swarmSection.head_seq,
        concurrency_limit: swarmSection.swarm?.concurrency_limit ?? null,
        plan: swarmSection.plan,
        watchdog: swarmSection.watchdog,
        active_rejections: swarmSection.active_rejections,
        board_file: swarmSection.board_file,
        roster: swarmSection.roster,
      },
    } : {}),
    sessions: sessionManifestRows,
  }

  const orderedFiles = [
    { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'timeline.jsonl', content: timelineJsonl },
    ...files,
  ]

  return {
    ok: true,
    status: 200,
    bundle: {
      format: DIAGNOSTIC_EXPORT_FORMAT,
      mode,
      root_session_id: rootSessionId,
      manifest,
      timeline: cleanTimeline,
      timeline_jsonl: timelineJsonl,
      files: orderedFiles,
    },
  }
}

/** Build a bounded read-only Seance handover capsule (<= maxChars) of recent decisions and tool errors from a member's session events. */
export function extractMemberHandoverCapsule(sessionEvents = [], maxChars = 1500) {
  const list = Array.isArray(sessionEvents) ? sessionEvents : []
  const errors = []
  const notes = []

  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'tool/result') {
      const data = ev.data || {}
      const failed = data.isError === true || Boolean(data.error)
      if (failed) {
        const name = data.name || data.toolName || 'tool'
        const raw = typeof data.content === 'string'
          ? data.content
          : JSON.stringify(data.error ?? data.content ?? '')
        errors.push(`- [ERR ${name}] ${String(raw).replace(/\s+/g, ' ').slice(0, 180)}`)
      }
    } else if (ev.type === 'assistant/message') {
      const textParts = Array.isArray(ev.data?.content)
        ? ev.data.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text)
        : (typeof ev.data?.text === 'string' ? [ev.data.text] : [])
      const joined = textParts.join(' ').replace(/\s+/g, ' ').trim()
      if (joined) notes.push(`- ${joined.slice(0, 220)}`)
    }
  }

  const lines = []
  if (errors.length > 0) {
    lines.push('Recent Tool Errors / Dead Ends:')
    lines.push(...errors.slice(-5))
  }
  if (notes.length > 0) {
    lines.push('Recent Assistant Notes:')
    lines.push(...notes.slice(-3))
  }
  if (lines.length === 0) return '(no captured session events available)'
  const full = lines.join('\n')
  return full.length <= maxChars ? full : `${full.slice(0, Math.max(0, maxChars - 16))}\n...(truncated)`
}

// #FUNC Build a standards-compliant PKZIP archive (`Buffer`) from `{ path, content }` entries using only Node built-in `zlib.crc32` and `zlib.deflateRawSync`.
// #NOT  Requires zero external npm dependencies (`fflate`/`jszip` not needed) and never leaks unprefixed paths when `rootFolder` is supplied.
// #EDGE-IN Generated ZIP archive passes Python `zipfile.ZipFile.testzip()` integrity verification with UTF-8 filenames and multiple epoch JSONL files → test_log_export_normal_conversation_epochs_zip_and_timeline
// #WHY  Using `zlib.deflateRawSync` and `zlib.crc32` keeps `dsh-swarm` 100% zero-dependency so remote `dsh plugin add` installs work out-of-the-box without build steps.
export function buildZipArchive(entries, rootFolder = '') {
  const prefix = rootFolder ? `${String(rootFolder).replace(/[\\/]+$/g, '')}/` : ''
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries ?? []) {
    const relPath = String(entry.path ?? '').replace(/^\/+/, '').replace(/\\/g, '/')
    if (!relPath) continue
    const nameBuf = Buffer.from(`${prefix}${relPath}`, 'utf8')
    const rawBuf = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(String(entry.content ?? ''), 'utf8')
    const crc = zlib.crc32(rawBuf) >>> 0
    const deflated = rawBuf.length > 0 ? zlib.deflateRawSync(rawBuf, { level: 6 }) : rawBuf
    const useDeflate = rawBuf.length > 0 && deflated.length < rawBuf.length
    const method = useDeflate ? 8 : 0
    const payload = useDeflate ? deflated : rawBuf
    const flags = 0x0800 // UTF-8 filename encoding
    const modTime = 0
    const modDate = 0x5921 // 2024-09-01 valid DOS date

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(modTime, 10)
    localHeader.writeUInt16LE(modDate, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(rawBuf.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, nameBuf, payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(0x0314, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(modTime, 12)
    centralHeader.writeUInt16LE(modDate, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(rawBuf.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    centralParts.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + payload.length
  }

  const centralDirBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(centralParts.length / 2, 8)
  eocd.writeUInt16LE(centralParts.length / 2, 10)
  eocd.writeUInt32LE(centralDirBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirBuf, eocd])
}
