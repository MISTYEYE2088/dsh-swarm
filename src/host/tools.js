// Model-facing Swarm tools, `/swarm` slash command, and `swarm` SessionProjection.
//
// Strictly English-only so consuming agents never get nudged into switching response
// languages. All tool return payloads pass through `toLosslessJson()` so DSH's
// lossless JSON validation can never fail after a write commits.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  replayChannelsAt,
  replaySwarmEvents,
  resolveVerdictTargets,
  extractScreenshotsFromPosts,
  computeSupersededMap,
  isMergeGateRejectPost,
  canSupersedeReject,
  computeBlindGroupState,
  deriveFallbackTitle,
  VALID_POST_KINDS,
  VALID_VERDICTS,
} from './store.js'
import {
  validateSwarmInit,
  validateSwarmAdd,
  validatePostBoard,
  validateSwarmWait,
  validateSwarmPlan,
} from './validators.js'
import { buildSwarmSystemMessage } from './stop-hook.js'
import { getRoleSpec, getSpawnableRoles } from './prompts.js'
import {
  runGit,
  createIsolatedWorktree,
  createReviewSnapshotWorktree,
  diffWorktree,
  snapshotWorktreeCommit,
  scanPatchHygiene,
  runHostGateCommands,
  findOwnershipOverlaps,
  auditChangedPaths,
  landWorktree,
  removeIsolatedWorktree,
} from './worktree.js'
import { formatCompactTokens, extractMemberHandoverCapsule } from './log-export.js'

const TEXT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
  },
  required: ['ok', 'text'],
})

// #FUNC Recursively normalize any JS value into strictly lossless plain JSON (no `undefined` properties, no extra props on arrays, no `NaN`/`Infinity`).
// #NOT  Never returns non-plain arrays or objects with `undefined` values that fail lossless JSON validation.
// #EDGE-IN An array with a non-enumerable property and an object with `undefined` fields are stripped cleanly → test_tool_outputs_are_strictly_lossless_json
// #WHY  `toLosslessJson` strips `undefined` fields, non-index array props, and non-finite numbers via `Number.isFinite` so DSH tool result validation never fails after disk writes commit.
export function toLosslessJson(value) {
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) {
    const out = []
    for (let i = 0; i < value.length; i += 1) {
      out.push(toLosslessJson(value[i]))
    }
    return out
  }
  if (t === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue
      out[k] = toLosslessJson(v)
    }
    return out
  }
  return String(value)
}

function makeTool({ name, description, parameters, isConcurrencySafe = false, execute }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      ...parameters,
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render(_args, value) {
        const text = value && typeof value.text === 'string'
          ? value.text
          : JSON.stringify(value, null, 2)
        return [{ type: 'text', text }]
      },
    },
    isConcurrencySafe() {
      return isConcurrencySafe === true
    },
    async execute(args, exec) {
      const raw = await execute(args, exec)
      return toLosslessJson(raw)
    },
  }
}

/** Discover immediate 1-level subdirectory git repositories when cwd itself is not a git repo. */
function discoverChildGitRepos(baseDir) {
  const found = []
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const candidate = path.join(baseDir, entry.name)
      if (fs.existsSync(path.join(candidate, '.git'))) {
        found.push(entry.name)
      }
      if (found.length >= 8) break
    }
  } catch {
    // Ignore unreadable directory
  }
  return found
}

/** Collect deduplicated host `gate_commands` configured on Swarm metadata and active plan. */
function collectEffectiveGateCommands(swarmMeta, planMeta) {
  return [...new Set([
    ...(Array.isArray(swarmMeta?.gate_commands) ? swarmMeta.gate_commands : []),
    ...(Array.isArray(planMeta?.gate_commands) ? planMeta.gate_commands : []),
  ].map(c => String(c ?? '').trim()).filter(Boolean))]
}

/** Deterministically shuffle posts within each unsealed `blind_group` across their occupied slots to break first-mover anchoring. */
export function orderUnsealedBlindGroupPosts(posts, swarmId, blindGroups) {
  if (!Array.isArray(posts) || posts.length < 2 || !blindGroups || blindGroups.size === 0) return posts
  const out = [...posts]
  const indicesByGroup = new Map()
  for (let i = 0; i < out.length; i += 1) {
    const p = out[i]
    if (!p || p.type === 'control' || !p.blind_group) continue
    const g = blindGroups.get(p.blind_group)
    if (!g || !g.unsealed) continue
    if (!indicesByGroup.has(p.blind_group)) indicesByGroup.set(p.blind_group, [])
    indicesByGroup.get(p.blind_group).push(i)
  }
  for (const [group, slotIndices] of indicesByGroup.entries()) {
    if (slotIndices.length < 2) continue
    const items = slotIndices.map(idx => ({
      post: out[idx],
      sortKey: createHash('sha256').update(`${swarmId}:${group}:${out[idx].seq}`, 'utf8').digest('hex'),
    }))
    items.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    for (let k = 0; k < slotIndices.length; k += 1) {
      out[slotIndices[k]] = items[k].post
    }
  }
  return out
}

/** Project a board post for `callerRole`, enforcing `blind_group` sealing until quorum and replacing worker prose with an objective commit/diff envelope when `blindToWorkerProse` is enabled. */
export function projectPostForCaller(post, callerRole, members = {}, options = {}) {
  if (!post || post.type === 'control') return post
  const callerName = options.callerName ?? null
  const blindGroups = options.blindGroups ?? null
  let basePost = post

  if (typeof post.blind_group === 'string' && post.blind_group.trim() && blindGroups instanceof Map) {
    const bg = blindGroups.get(post.blind_group.trim())
    if (bg) {
      if (!bg.unsealed && callerName !== 'coordinator' && callerName !== post.agent) {
        return {
          ...post,
          title: `[BLIND_SEALED] blind_group "${bg.group}" (${bg.submitted_count}/${bg.quorum} submitted)`,
          text: `[BLIND_SEALED] Submission #${post.seq} by @${post.agent} in blind_group "${bg.group}" (${bg.submitted_count}/${bg.quorum} submitted). Body stays sealed until quorum (${bg.quorum}) is reached.`,
          sealed_for_blind_group: true,
          blind_group_status: 'sealed',
        }
      }
      basePost = {
        ...post,
        blind_group_status: bg.unsealed ? 'unsealed' : 'sealed',
      }
    }
  }

  const callerSpec = getRoleSpec(callerRole)
  if (callerSpec.blindToWorkerProse !== true) return basePost
  const authorRole = members[basePost.agent]?.role ?? 'worker'
  if (authorRole !== 'worker') return basePost

  const art = basePost.artifact && typeof basePost.artifact === 'object' ? basePost.artifact : null
  const commitPart = art?.commit_sha ? ` (${art.commit_sha})` : ''
  const lines = [
    `[BLIND_REVIEW_ENVELOPE] Worker prose intentionally redacted for @${basePost.agent} (#${basePost.seq}). Audit strictly from raw commit/diff and @coordinator background/anchors.`,
  ]
  if (art) {
    if (art.worktree_path) lines.push(`Worktree: ${art.worktree_path}`)
    if (art.baseline_commit) lines.push(`Baseline Commit: ${art.baseline_commit}`)
    if (art.prev_commit && art.prev_commit !== art.commit_sha) lines.push(`Previous Commit: ${art.prev_commit}`)
    if (art.commit_sha) lines.push(`Commit SHA: ${art.commit_sha}`)
    if (art.diff_hash) lines.push(`Diff Hash: ${art.diff_hash}`)
    const files = Array.isArray(art.changed_files) ? art.changed_files : []
    lines.push(`Changed Files (${files.length}): ${files.join(', ') || 'none'}`)
    if (art.worktree_path && art.baseline_commit && art.commit_sha) {
      lines.push(`Inspect Cumulative Diff: git -C "${art.worktree_path}" diff ${art.baseline_commit}..${art.commit_sha}`)
      if (art.prev_commit && art.prev_commit !== art.commit_sha && art.prev_commit !== art.baseline_commit) {
        lines.push(`Inspect Round Delta: git -C "${art.worktree_path}" diff ${art.prev_commit}..${art.commit_sha}`)
      }
    }
    if (Array.isArray(art.diff_hygiene_flags) && art.diff_hygiene_flags.length > 0) {
      lines.push(`[DIFF_HYGIENE_FLAGS]: ${art.diff_hygiene_flags.join(', ')}`)
    }
  } else {
    lines.push('No worktree artifact attached; inspect repository git diff / git status directly.')
  }

  return {
    ...basePost,
    title: `[BLIND_REVIEW] @${basePost.agent} submission #${basePost.seq}${commitPart}`,
    text: lines.join('\n'),
    redacted_for_blind_review: true,
  }
}

/** Build the deterministic Overview / Board / Roster / Round-Table snapshot from the single `events.jsonl` projection. */
export function buildSwarmProjectionSnapshot({ store, swarmId, runtime }) {
  if (!store.exists(swarmId)) return null
  const { events, projection } = store.projectState(swarmId)
  const swarm = projection.swarm
  const plan = projection.plan
  const records = projection.board
  const headSeq = projection.headSeq
  const members = store.readMembers(swarmId)
  const supersededMap = computeSupersededMap(records)
  const supersededBy = {}
  for (const [oldSeq, newSeq] of supersededMap.entries()) {
    supersededBy[String(oldSeq)] = newSeq
  }
  const activeRejections = store.computeActiveRejections(swarmId)

  const memberSummary = {
    totalActive: 0,
    working: 0,
    queued: 0,
    waiting: 0,
    unparked_idle: 0,
    starting: 0,
    zombie: 0,
    error: 0,
    killed: 0,
  }

  const memberRows = []
  for (const [name, rawMember] of Object.entries(members)) {
    if (rawMember.system_builtin === true && rawMember.role === 'monitor') continue
    const liveOverlay = typeof runtime.getMemberTelemetry === 'function'
      ? runtime.getMemberTelemetry(rawMember.session_id)
      : null
    const m = liveOverlay ? { ...rawMember, ...liveOverlay } : rawMember
    const liveness = runtime.getMemberLiveness(swarmId, name, m)
    const queuePos = runtime.concurrencyGate?.queuePositionOf?.(m.session_id) ?? 0

    if (m.killed) {
      memberSummary.killed += 1
    } else {
      memberSummary.totalActive += 1
      if (liveness.status === 'working') memberSummary.working += 1
      else if (liveness.status === 'queued') memberSummary.queued += 1
      else if (liveness.status === 'waiting') memberSummary.waiting += 1
      else if (liveness.status === 'unparked_idle') memberSummary.unparked_idle += 1
      else if (liveness.status === 'starting') memberSummary.starting += 1
      else if (liveness.status === 'zombie') memberSummary.zombie += 1
      else if (liveness.status === 'error') memberSummary.error += 1
    }

    memberRows.push({
      name,
      session_id: m.session_id,
      role: m.role,
      can_block_merge: m.can_block_merge === true || getRoleSpec(m.role).canBlockMerge,
      blind_to_worker_prose: getRoleSpec(m.role).blindToWorkerProse === true,
      adopted_from: m.adopted_from ?? null,
      review_target: m.review_target ?? null,
      owned_paths: Array.isArray(m.owned_paths) ? m.owned_paths : [],
      forbidden_paths: Array.isArray(m.forbidden_paths) ? m.forbidden_paths : [],
      group: m.group ?? null,
      parent: m.parent ?? null,
      phase: m.last_error ? 'ERROR' : m.phase,
      killed: m.killed === true,
      born_seq: m.born_seq ?? m.brief_seq ?? 0,
      retired_seq: m.retired_seq ?? m.killed_at_seq ?? null,
      brief_seq: m.brief_seq ?? 0,
      killed_at_seq: m.killed_at_seq ?? null,
      handover_to: m.handover_to ?? null,
      status: liveness.status,
      stepSummary: liveness.stepSummary ?? null,
      desired_provider: m.desired_provider ?? 'inherit',
      desired_model: m.desired_model ?? 'inherit',
      applied_provider: m.applied_provider ?? 'inherit',
      applied_model: m.applied_model ?? 'inherit',
      workspace_mode: m.workspace_mode ?? 'inherit',
      worktree_path: m.worktree_path ?? null,
      wake_mode: m.wake_mode ?? 'mentions',
      wake_kinds: Array.isArray(m.wake_kinds) ? m.wake_kinds : null,
      channels: m.channels ?? ['main'],
      wait_since: m.wait_since ?? 0,
      last_read_seq: m.last_read_seq ?? 0,
      last_nudged_seq: m.last_nudged_seq ?? 0,
      last_park_blocked_seq: m.last_park_blocked_seq ?? 0,
      last_post_seq: m.last_post_seq ?? 0,
      turn_count: m.turn_count ?? 0,
      tool_call_count: m.tool_call_count ?? 0,
      last_turn_at: m.last_turn_at ?? null,
      last_tool_call_at: m.last_tool_call_at ?? null,
      last_tool_name: m.last_tool_name ?? null,
      last_error: m.last_error ?? null,
      last_input_tokens: m.last_input_tokens ?? 0,
      context_window: m.context_window ?? 0,
      consecutive_tool_errors: m.consecutive_tool_errors ?? 0,
      last_tool_error_name: m.last_tool_error_name ?? null,
      queue_position: queuePos,
    })
  }

  const blindGroupsMap = computeBlindGroupState(records)
  const blindGroups = {}
  for (const [gName, gVal] of blindGroupsMap.entries()) {
    blindGroups[gName] = gVal
  }
  const effectiveGateCommands = collectEffectiveGateCommands(swarm, plan)

  const annotatedPosts = records.slice(-250).map((rec) => {
    if (!rec || rec.type === 'control') return rec
    const withTitle = rec.title ? rec : { ...rec, title: deriveFallbackTitle(rec.text, rec.kind || 'post') }
    const bgInfo = withTitle.blind_group ? blindGroups[withTitle.blind_group] : null
    const withBg = bgInfo ? { ...withTitle, blind_group_status: bgInfo.unsealed ? 'unsealed' : 'sealed' } : withTitle
    return supersededMap.has(rec.seq)
      ? { ...withBg, superseded_by: supersededMap.get(rec.seq) }
      : withBg
  })

  return {
    runtime: typeof runtime.getRuntimeFingerprint === 'function' ? runtime.getRuntimeFingerprint() : null,
    swarm,
    plan,
    gate_commands: effectiveGateCommands,
    blindGroups,
    headSeq,
    headOffset: projection.offset,
    channels: projection.channels,
    archivedChannels: projection.archivedChannels,
    concurrency: runtime.concurrencyGate.snapshot(),
    memberSummary,
    watchdog: typeof runtime.getWatchdogStatus === 'function' ? runtime.getWatchdogStatus(swarmId) : null,
    activeRejections,
    supersededBy,
    members: memberRows,
    posts: annotatedPosts,
    events: events.filter(e => e && e.type !== 'state.checkpoint').slice(-600),
    edgeEvents: projection.edgeEvents,
    screenshots: extractScreenshotsFromPosts(records),
  }
}

// #FUNC Construct all 10 Swarm model tools with strict format checking, mandatory meaningful titles, atomic spawn/rollback, noise filtering, merge gate, and guaranteed lossless JSON output.
// #NOT  Never throws raw unhandled exceptions for malformed model inputs; never returns non-lossless JSON payloads or Chinese strings.
// #EDGE-IN Calling `swarm_wait` with valid `since` invokes `exec.concludeTurn()` to end the turn at 0 idle token cost → test_swarm_wait_concludes_turn
// #WHY  `concludeTurn` is the native DSH `ToolRunContext` hook that stops `agent-loop` from issuing another LLM request after `swarm_wait` returns `DONE`.
export const WORKER_SWARM_TOOL_NAMES = Object.freeze([
  'post_board',
  'read_board',
  'swarm_wait',
  'swarm_status',
  'swarm_model',
])

export function createSwarmTools(runtime) {
  const { store, concurrencyGate } = runtime

  const swarmInitTool = makeTool({
    name: 'swarm_init',
    description: 'Initialize or update the Swarm blackboard (`events.jsonl` + `offsets.json`) and dynamically unlock the remaining Swarm tools (`swarm_plan`, `swarm_add`, `swarm_concurrency`, `post_board`, `read_board`, `swarm_wait`, `swarm_status`, `swarm_model`, `swarm_land`, `swarm_kill`) for this session. Supports optional `project_root` pointing to a subdirectory Git repo for `workspace="share"|"branch"` worktree isolation.',
    parameters: {
      properties: {
        title: { type: 'string', description: 'Short descriptive title for this Swarm.' },
        concurrency_limit: { type: 'integer', description: 'Positive integer in-flight LLM request slot limit (NOT a cap on member count; e.g. 2, 4, 6, 8).' },
        project_root: { type: 'string', description: 'Optional project directory (absolute or relative to session cwd) containing `.git` for isolated worktrees.' },
        anchors: { type: 'array', items: { type: 'string' }, description: 'Optional immutable ground-truth anchors (verbatim user paths, verification commands, hard constraints) auto-injected into every spawned brief.' },
        gate_commands: { type: 'array', items: { type: 'string' }, description: 'Optional deterministic host verification commands run automatically on `swarm_land(apply)` and `post_board(kind="done")` (requiring rc=0 and zero fail/error/skip keywords).' },
        default_provider: { type: 'string', description: 'Optional registered LLM provider id (default: "inherit" from current session).' },
        default_model: { type: 'string', description: 'Optional model id or "provider/model" (default: "inherit" from current session).' },
        coordinator_model: { type: 'string', description: 'Optional coordinator model id (default: "inherit" from current session).' },
      },
      required: ['title', 'concurrency_limit'],
    },
    async execute(args, exec) {
      const check = validateSwarmInit(args)
      if (!check.ok) return { ok: false, text: check.error }
      const { swarmId, rootAgent } = runtime.resolveCaller(exec.agent)
      const resolvedDefault = typeof runtime.resolveModelRoute === 'function'
        ? await runtime.resolveModelRoute({
            requestedProvider: check.value.default_provider,
            requestedModel: check.value.default_model,
            rootAgent,
          })
        : { provider: check.value.default_provider, model: check.value.default_model }
      const resolvedCoord = typeof runtime.resolveModelRoute === 'function'
        ? await runtime.resolveModelRoute({
            requestedProvider: check.value.default_provider,
            requestedModel: check.value.coordinator_model,
            rootAgent,
          })
        : { provider: check.value.default_provider, model: check.value.coordinator_model }

      const mainCwd = rootAgent?.session?.header?.cwd ?? process.cwd()
      let effectiveRoot = mainCwd
      if (check.value.project_root) {
        const candidate = path.isAbsolute(check.value.project_root)
          ? check.value.project_root
          : path.resolve(mainCwd, check.value.project_root)
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
          return {
            ok: false,
            text: `[FORMAT_ERROR: swarm_init] project_root "${check.value.project_root}" (resolved to "${candidate}") does not exist or is not a directory.`,
          }
        }
        effectiveRoot = candidate
      }

      const gitProbe = await runGit(['rev-parse', '--show-toplevel'], { cwd: effectiveRoot, timeoutMs: 4_000 })
      const gitSupported = gitProbe.ok && gitProbe.stdout.trim().length > 0
      const childGitRepos = gitSupported ? [] : discoverChildGitRepos(effectiveRoot)
      const isWslUnc = /^\\\\wsl(?:\.localhost|\$)\\/i.test(String(effectiveRoot))
      const fp = typeof runtime.getRuntimeFingerprint === 'function'
        ? runtime.getRuntimeFingerprint()
        : { version: '0.7.0', commit: 'HEAD', loaded_at: '' }

      return await store.withLock(swarmId, async () => {
        if (store.exists(swarmId) && store.readSwarm(swarmId)?.status === 'DONE') {
          store.archiveSwarm(swarmId, 'before-reinit')
        }
        const { swarm } = store.initSwarm(swarmId, {
          ...check.value,
          project_root: effectiveRoot,
          status: 'ACTIVE',
          default_provider: resolvedDefault.provider || check.value.default_provider,
          default_model: resolvedDefault.model || check.value.default_model,
          coordinator_model: resolvedCoord.model || resolvedDefault.model || check.value.coordinator_model,
          concurrency_confirmed: true,
        })
        if (resolvedCoord.provider || resolvedCoord.model) {
          try {
            store.updateMember(swarmId, 'coordinator', curr => ({
              ...curr,
              desired_provider: resolvedCoord.provider || curr.desired_provider,
              desired_model: resolvedCoord.model || curr.desired_model,
              applied_provider: resolvedCoord.provider || curr.applied_provider,
              applied_model: resolvedCoord.model || curr.applied_model,
            }))
          } catch {}
        }
        concurrencyGate.setLimit(swarm.concurrency_limit)
        runtime.activateCoordinatorMode?.(exec.agent)
        runtime.enableSwarmToolsOnAgent?.(exec.agent, 'coordinator')
        runtime.ensureMonitorDaemon(swarmId)
        runtime.notifyProjectionChanged(swarmId)

        const gitNote = gitSupported
          ? `AVAILABLE (git_root="${gitProbe.stdout.trim()}"; workspace="share"|"branch"|"inherit" supported)`
          : (childGitRepos.length > 0
              ? `UNAVAILABLE at "${effectiveRoot}", but discovered child git repo(s): [${childGitRepos.join(', ')}]. Call swarm_init with project_root="<subdir>" to unlock isolated worktrees (workspace="share").`
              : `UNAVAILABLE (not a git repository; members must use workspace="inherit")`)

        const envNotes = [
          `[RUNTIME] dsh-swarm v${fp.version} (commit=${fp.commit}, loaded=${fp.loaded_at})`,
          `[WORKSPACE_PREFLIGHT] project_root="${effectiveRoot}" | git_worktree=${gitNote}`,
          `[SLOTS_SEMANTICS] concurrency_limit=${swarm.concurrency_limit} caps in-flight LLM requests (NOT max member count); ConcurrencyGate queues excess streams automatically.`,
        ]
        if (isWslUnc) {
          envNotes.push(`[WSL_UNC_HINT] Workspace is a Windows WSL UNC path (${effectiveRoot}): built-in DSH workflow fails on Win32 ACL checks; use swarm_add for in-process Swarm members.`)
        }

        return {
          ok: true,
          swarm,
          project_root: effectiveRoot,
          git_worktree_available: gitSupported,
          discovered_child_git_repos: childGitRepos,
          is_wsl_unc: isWslUnc,
          runtime: fp,
          text: `[swarm_init OK] Initialized Swarm "${swarm.title}" (swarm_id=${swarmId}, gen=${swarm.generation ?? 1}, llm_slots=${swarm.concurrency_limit}, route=${swarm.default_provider}/${swarm.default_model}).\n${envNotes.join('\n')}\nNext: call swarm_plan to publish wave/track plan, then spawn members with swarm_add (Watchdog runs automatically; do not spawn monitor).`,
        }
      })
    },
  })

  const swarmPlanTool = makeTool({
    name: 'swarm_plan',
    description: 'Write or update the structured Swarm plan (goal, waves, tracks) stored in `events.jsonl` and shown in the Control tab. Max 64 KB.',
    parameters: {
      properties: {
        goal: { type: 'string', description: 'Overarching goal of the swarm.' },
        current_wave: { type: 'integer', description: 'Current wave number (1, 2, ...).' },
        anchors: { type: 'array', items: { type: 'string' }, description: 'Optional ground-truth anchors (verbatim paths, commands, constraints) auto-injected into spawned briefs.' },
        gate_commands: { type: 'array', items: { type: 'string' }, description: 'Optional deterministic host verification commands enforced on `swarm_land(apply)` and `post_board(kind="done")`.' },
        waves: {
          type: 'array',
          description: 'List of wave descriptors.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              wave: { type: 'integer' },
              title: { type: 'string' },
              status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED'] },
              members: { type: 'array', items: { type: 'string' } },
              summary_seq: { type: 'integer' },
            },
            required: ['wave', 'title', 'status'],
          },
        },
        tracks: {
          type: 'array',
          description: 'Parallel work tracks shown in the Overview.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string' },
              owner: { type: 'string' },
              status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'VERIFYING', 'DONE', 'BLOCKED'] },
              evidence_seqs: { type: 'array', items: { type: 'integer' } },
            },
            required: ['name', 'owner', 'status'],
          },
        },
      },
      required: ['goal'],
    },
    async execute(args, exec) {
      const check = validateSwarmPlan(args)
      if (!check.ok) return { ok: false, text: check.error }
      const { swarmId } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        if (!store.exists(swarmId)) {
          return { ok: false, text: '[FORMAT_ERROR: swarm_plan] Swarm is not initialized. Call swarm_init first.' }
        }
        const plan = store.writePlan(swarmId, check.value)
        runtime.notifyProjectionChanged(swarmId)
        return {
          ok: true,
          plan,
          text: `[swarm_plan OK] Updated plan.json (wave ${plan.current_wave}, ${plan.tracks.length} track(s)).`,
        }
      })
    },
  })

  const swarmAddTool = makeTool({
    name: 'swarm_add',
    description: 'Atomically spawn one named Swarm member (or a numbered group <name>-1..n) with role preset ("worker" | "architect" | "verifier" | "lore_master") and a 3-part brief ([OWNERSHIP], [FORBIDDEN], [DONE_CRITERIA]). Defaults code-writing workers to isolated `workspace="share"` when Git is available. Rolls back cleanly on spawn failure so zero zombies remain.',
    parameters: {
      properties: {
        name: { type: 'string', description: 'Lowercase member name (a-z, 0-9, -), e.g. "arch-lead", "impl-engine", "qa-gate", "spec-lore".' },
        role: { type: 'string', enum: getSpawnableRoles(), description: `Role preset (${getSpawnableRoles().join(' | ')}).` },
        can_block_merge: { type: 'boolean', description: 'Whether this member\'s `verdict:"reject"` blocks `swarm_land` and `[done]` (default: true for architect/verifier, false for worker/lore_master).' },
        workspace: { type: 'string', enum: ['inherit', 'share', 'branch'], description: 'Workspace mode: defaults to "share" for role="worker" when Git is available (isolated worktree with dirty sync), or "inherit" for read-only roles / non-Git dirs.' },
        brief: { type: 'string', description: 'Public brief MUST include literal [OWNERSHIP], [FORBIDDEN], and [DONE_CRITERIA] sections.' },
        owned_paths: { type: 'array', items: { type: 'string' }, description: 'Optional explicit owned path/glob list enforced on `swarm_land`.' },
        forbidden_paths: { type: 'array', items: { type: 'string' }, description: 'Optional explicit forbidden path/glob list enforced on `swarm_land` (defaults to path tokens parsed from `[FORBIDDEN]`).' },
        adopt_worktree_from: { type: 'string', description: 'Optional member name whose isolated worktree is losslessly adopted by this replacement session (retiring the predecessor without deleting its edits).' },
        review_target: { type: 'string', description: 'Optional target worker name for spawning a reviewer (`verifier`/`red_team`) in an isolated review snapshot worktree overlaid with that worker\'s diff.' },
        provider: { type: 'string', description: 'Optional provider override.' },
        model: { type: 'string', description: 'Optional model override (or "inherit").' },
        fork: { type: 'string', description: 'Optional existing member name (or "coordinator") to fork conversation history from.' },
        n: { type: 'integer', description: 'Optional homogeneous copy count (positive integer >= 1).' },
        tasks: { type: 'array', items: { type: 'string' }, description: 'Optional per-shard task slices (<name>-1..k).' },
      },
      required: ['name', 'brief'],
    },
    async execute(args, exec) {
      const { swarmId, callerName, rootAgent } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        const swarmMeta = store.readSwarm(swarmId)
        const existingMembers = store.readMembers(swarmId)
        const check = validateSwarmAdd(args, swarmMeta, existingMembers, callerName)
        if (!check.ok) return { ok: false, text: check.error }

        const spec = check.value
        const createdRows = []
        const mainCwd = swarmMeta.project_root || rootAgent?.session?.header?.cwd || process.cwd()

        const resolvedRoute = typeof runtime.resolveModelRoute === 'function'
          ? await runtime.resolveModelRoute({
              requestedProvider: spec.providerExplicit ? spec.provider : 'inherit',
              requestedModel: spec.modelExplicit ? spec.model : 'inherit',
              role: spec.role,
              rootAgent,
              swarmMeta,
            })
          : { provider: spec.provider, model: spec.model }
        const effectiveProvider = resolvedRoute.provider || spec.provider || 'inherit'
        const effectiveModel = resolvedRoute.model || spec.model || 'inherit'

        // Tier-B guardrail: default roles with `autoShareInGit` (e.g. code-writing workers) to isolated `workspace="share"` when Git worktree is available.
        let effectiveWorkspace = spec.workspace
        if (getRoleSpec(spec.role).autoShareInGit && !spec.workspaceExplicit) {
          const gitProbe = await runGit(['rev-parse', '--show-toplevel'], { cwd: mainCwd, timeoutMs: 3_000 })
          if (gitProbe.ok && gitProbe.stdout.trim().length > 0) {
            effectiveWorkspace = 'share'
          }
        }

        const planMeta = store.readPlan(swarmId)
        const combinedAnchors = [...new Set([
          ...(Array.isArray(swarmMeta?.anchors) ? swarmMeta.anchors : []),
          ...(Array.isArray(planMeta?.anchors) ? planMeta.anchors : []),
        ])]
        const anchorsPrefix = combinedAnchors.length > 0
          ? `[GROUND_TRUTH_ANCHORS]\n${combinedAnchors.map(a => `- ${a}`).join('\n')}\n\n`
          : ''

        for (let i = 0; i < spec.targetNames.length; i += 1) {
          const memberName = spec.targetNames[i]
          const sliceTask = spec.tasks && spec.tasks[i] ? `\n[SHARD_TASK]\n${spec.tasks[i]}` : ''
          let fullBrief = anchorsPrefix + spec.brief + sliceTask
          let effectiveOwnedPaths = spec.owned_paths
          let effectiveForbiddenPaths = spec.forbidden_paths

          let worktreeInfo = {
            workspace_mode: 'inherit',
            worktree_path: mainCwd,
            base_commit: null,
            baseline_commit: null,
          }
          let adoptedFromMember = null
          if (spec.adopt_worktree_from) {
            const srcMember = existingMembers[spec.adopt_worktree_from]
            if (!srcMember?.worktree_path || !fs.existsSync(srcMember.worktree_path)) {
              return {
                ok: false,
                text: `[WORKTREE_ERROR: swarm_add] Cannot adopt worktree from @${spec.adopt_worktree_from}: directory "${srcMember?.worktree_path ?? 'none'}" does not exist.`,
              }
            }
            adoptedFromMember = spec.adopt_worktree_from
            worktreeInfo = {
              workspace_mode: srcMember.workspace_mode,
              worktree_path: srcMember.worktree_path,
              base_commit: srcMember.base_commit ?? null,
              baseline_commit: srcMember.baseline_tree ?? srcMember.base_commit ?? null,
            }
            if (effectiveOwnedPaths.length === 0 && Array.isArray(srcMember.owned_paths)) {
              effectiveOwnedPaths = srcMember.owned_paths
            }
            if (effectiveForbiddenPaths.length === 0 && Array.isArray(srcMember.forbidden_paths)) {
              effectiveForbiddenPaths = srcMember.forbidden_paths
            }
            const adoptedDiff = await diffWorktree({
              worktreePath: worktreeInfo.worktree_path,
              baselineCommit: worktreeInfo.baseline_commit,
            })
            const priorEvents = typeof runtime.getMemberSessionEvents === 'function'
              ? runtime.getMemberSessionEvents(srcMember.session_id)
              : []
            const capsule = extractMemberHandoverCapsule(priorEvents, 900)
            fullBrief += `\n\n[ADOPTED_WORKTREE from @${adoptedFromMember}]\nWorktree: ${worktreeInfo.worktree_path}\nDiff Hash: ${adoptedDiff.diffHash || 'none'}\nChanged Files (${adoptedDiff.files?.length ?? 0}): ${(adoptedDiff.files ?? []).join(', ') || 'none'}\nPredecessor Capsule:\n${capsule}`
          } else if (spec.review_target) {
            const rtMember = existingMembers[spec.review_target]
            const gitProbe = await runGit(['rev-parse', '--show-toplevel'], { cwd: mainCwd, timeoutMs: 3_000 })
            if (gitProbe.ok && gitProbe.stdout.trim().length > 0) {
              const revWt = await createReviewSnapshotWorktree({
                mainCwd,
                worktreesRoot: runtime.worktreesRoot,
                swarmId,
                memberName,
                targetWorktreePath: rtMember?.worktree_path ?? null,
                targetBaselineCommit: rtMember?.baseline_tree ?? rtMember?.base_commit ?? null,
              })
              if (!revWt.ok) {
                return { ok: false, text: `[WORKTREE_ERROR: swarm_add] Failed to provision isolated review snapshot worktree for @${memberName}: ${revWt.error}` }
              }
              worktreeInfo = revWt
            }
          } else if (effectiveWorkspace === 'share' || effectiveWorkspace === 'branch') {
            const wtRes = await createIsolatedWorktree({
              mainCwd,
              worktreesRoot: runtime.worktreesRoot,
              swarmId,
              memberName,
              mode: effectiveWorkspace,
            })
            if (!wtRes.ok) {
              return { ok: false, text: `[WORKTREE_ERROR: swarm_add] Failed to provision isolated worktree for @${memberName}: ${wtRes.error}` }
            }
            worktreeInfo = wtRes
          }

          const sessionId = `${swarmId}__${memberName}`
          const plannedBriefSeq = store.headSeq(swarmId) + 1
          const candidateMember = {
            session_id: sessionId,
            role: spec.role,
            can_block_merge: spec.can_block_merge,
            group: spec.group,
            parent: spec.parent,
            applied_provider: effectiveProvider,
            applied_model: effectiveModel,
            workspace_mode: worktreeInfo.workspace_mode,
            worktree_path: worktreeInfo.worktree_path,
            fork_from: spec.fork,
            last_read_seq: plannedBriefSeq,
          }

          // 1. Atomic spawn: create the live DSH child session FIRST before committing to disk
          let handle = null
          try {
            if (typeof runtime.createMemberAgent === 'function') {
              handle = await runtime.createMemberAgent({
                swarmId,
                memberName,
                member: candidateMember,
                briefSeq: plannedBriefSeq,
                fullBrief,
                resolvedRoute,
                rootAgent,
              })
            }
          } catch (spawnErr) {
            if (!adoptedFromMember && worktreeInfo.workspace_mode !== 'inherit' && worktreeInfo.worktree_path) {
              await removeIsolatedWorktree({
                mainCwd,
                worktreePath: worktreeInfo.worktree_path,
                baselineCommit: worktreeInfo.baseline_commit || worktreeInfo.base_commit,
                force: true,
              }).catch(() => {})
            }
            return {
              ok: false,
              error: { code: spawnErr?.code || 'SPAWN_FAILED', message: String(spawnErr?.message ?? spawnErr) },
              text: `[SPAWN_ERROR: swarm_add] Failed to spawn child session for @${memberName}; rolled back cleanly (no board post written, name "${memberName}" not locked): ${String(spawnErr?.message ?? spawnErr)}`,
            }
          }

          // 2. Commit brief & member record (rollback if steering fails)
          let committed = null
          try {
            if (adoptedFromMember) {
              const srcMember = existingMembers[adoptedFromMember]
              if (srcMember && !srcMember.killed) {
                await runtime.disposeMemberAgent(swarmId, adoptedFromMember)
                const killedAtSeq = store.headSeq(swarmId)
                store.appendEvent(swarmId, {
                  type: 'member.kill',
                  actor: callerName,
                  seq: killedAtSeq,
                  payload: {
                    name: adoptedFromMember,
                    released: false,
                    killed_at_seq: killedAtSeq,
                    handover_to: memberName,
                    reason: `Lossless worktree adoption by @${memberName}`,
                  },
                })
              }
              store.updateMember(swarmId, adoptedFromMember, m => ({
                ...m,
                worktree_handed_over: true,
                handover_to: memberName,
              }))
            }

            committed = store.registerMemberWithBrief(swarmId, {
              name: memberName,
              session_id: sessionId,
              role: spec.role,
              can_block_merge: spec.can_block_merge,
              group: spec.group,
              parent: spec.parent,
              provider: effectiveProvider,
              model: effectiveModel,
              workspace_mode: worktreeInfo.workspace_mode,
              worktree_path: worktreeInfo.worktree_path,
              base_commit: worktreeInfo.base_commit,
              baseline_tree: worktreeInfo.baseline_commit,
              owned_paths: effectiveOwnedPaths,
              brief_owned_paths: spec.brief_owned_paths,
              forbidden_paths: effectiveForbiddenPaths,
              adopted_from: adoptedFromMember,
              review_target: spec.review_target,
              fork_from: spec.fork,
              spawned_live_agent: Boolean(handle),
              brief: fullBrief,
            })

            if (handle && typeof runtime.activateSpawnedMember === 'function') {
              runtime.activateSpawnedMember({
                swarmId,
                memberName,
                member: committed.member,
                briefPost: committed.briefPost,
                fullBrief,
                handle,
                rootAgent,
              })
            } else if (!handle && typeof runtime.spawnMemberAgent === 'function') {
              handle = await runtime.spawnMemberAgent({
                swarmId,
                memberName,
                member: committed.member,
                briefPost: committed.briefPost,
                fullBrief,
                rootAgent,
              })
            }
          } catch (commitErr) {
            if (handle && typeof handle.dispose === 'function') {
              await handle.dispose().catch(() => {})
            }
            if (committed) {
              try { store.removeMemberRecord(swarmId, memberName) } catch {}
            }
            if (!adoptedFromMember && worktreeInfo.workspace_mode !== 'inherit' && worktreeInfo.worktree_path) {
              await removeIsolatedWorktree({
                mainCwd,
                worktreePath: worktreeInfo.worktree_path,
                baselineCommit: worktreeInfo.baseline_commit || worktreeInfo.base_commit,
                force: true,
              }).catch(() => {})
            }
            return {
              ok: false,
              error: { code: commitErr?.code || 'COMMIT_FAILED', message: String(commitErr?.message ?? commitErr) },
              text: `[SPAWN_ERROR: swarm_add] Failed while activating @${memberName}; rolled back and released name "${memberName}": ${String(commitErr?.message ?? commitErr)}`,
            }
          }

          if (handle) {
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          const latestOverlay = typeof runtime.getMemberTelemetry === 'function'
            ? runtime.getMemberTelemetry(sessionId)
            : null
          const latestMember = {
            ...(store.readMembers(swarmId)[memberName] ?? committed.member),
            ...(latestOverlay || {}),
          }
          if (latestMember.last_error) {
            runtime.notifyProjectionChanged(swarmId)
            return {
              ok: false,
              error: latestMember.last_error,
              text: `[SPAWN_RUNTIME_ERROR: swarm_add] Member @${memberName} failed immediately on Turn 1 (${latestMember.last_error.code}: ${latestMember.last_error.message}). Check route (${latestMember.applied_provider}/${latestMember.applied_model}), call swarm_model to switch, or swarm_kill to retire. Do NOT park in swarm_wait!`,
            }
          }

          createdRows.push({
            name: memberName,
            session_id: latestMember.session_id,
            role: latestMember.role,
            can_block_merge: latestMember.can_block_merge === true,
            provider: latestMember.applied_provider,
            model: latestMember.applied_model,
            workspace: latestMember.workspace_mode,
            brief_seq: committed.briefPost.seq,
            last_read_seq: latestMember.last_read_seq,
            spawned_live_agent: Boolean(handle),
            turn_count: latestMember.turn_count ?? 0,
          })
        }

        const allMembersAfter = store.readMembers(swarmId)
        const activeCount = Object.values(allMembersAfter).filter(m => !m.killed && !m.system_builtin).length
        const llmSlots = swarmMeta.concurrency_limit ?? 4

        const checkOwnedPatterns = spec.owned_paths.length > 0 ? spec.owned_paths : spec.brief_owned_paths
        const ownershipOverlaps = spec.role === 'worker' && checkOwnedPatterns.length > 0
          ? findOwnershipOverlaps(
              checkOwnedPatterns,
              existingMembers,
              [...(spec.adopt_worktree_from ? [spec.adopt_worktree_from] : []), ...spec.targetNames],
            )
          : []
        const overlapNote = ownershipOverlaps.length > 0
          ? `\n[OWNERSHIP_OVERLAP_WARN] Static [OWNERSHIP] overlap detected with active worker(s): ${ownershipOverlaps.map(o => `${o.pattern} <-> @${o.member}:${o.other_pattern} (${o.workspace_mode})`).join('; ')}. Split write scopes or serialize waves to avoid merge conflicts.`
          : ''

        runtime.notifyProjectionChanged(swarmId)
        const summary = createdRows.map(r => `@${r.name} (role=${r.role}, gate=${r.can_block_merge}, route=${r.provider}/${r.model}, workspace=${r.workspace}, brief=#${r.brief_seq}, live=${r.spawned_live_agent})`).join(', ')
        return {
          ok: true,
          active_members: activeCount,
          llm_slots: llmSlots,
          created: createdRows,
          ...(ownershipOverlaps.length > 0 ? { ownership_overlaps: ownershipOverlaps } : {}),
          text: `[swarm_add OK] Spawned and briefed: ${summary}. (active_members=${activeCount} / llm_slots=${llmSlots})${overlapNote}`,
        }
      })
    },
  })

  const postBoardTool = makeTool({
    name: 'post_board',
    description: 'Post to the Swarm board (requires meaningful `title` 4..100 chars + `text`). Supports `mentions`, `kind`, `verdict`, `supersedes`, `escalate`, `silent`, and channel control.',
    isConcurrencySafe: true,
    parameters: {
      properties: {
        title: { type: 'string', description: 'Meaningful 1-line summary (4..100 chars; no generic words like "update").' },
        text: { type: 'string', description: 'Message body (6..4000 chars). Cite floors with #seq.' },
        mentions: { type: 'array', items: { type: 'string' }, description: 'Recipient member names (e.g. ["qa-gate"]).' },
        refs: { type: 'array', items: { type: 'integer' }, description: 'Referenced floor numbers.' },
        channel: { type: 'string', description: 'Channel name (default: "main").' },
        kind: { type: 'string', enum: [...VALID_POST_KINDS], description: 'brief|report|question|review|decision|alert|done.' },
        verdict: { type: 'string', enum: [...VALID_VERDICTS], description: 'reject (blocks merge/done), approve, or override.' },
        target_member: { type: 'string', description: 'Optional target member name for scoped review verdicts (e.g. "worker-a", or "*" for swarm-wide).' },
        supersedes: { type: 'array', items: { type: 'integer' }, description: 'Earlier floor numbers obsoleted by this post.' },
        blind_group: { type: 'string', description: 'Optional sealed proposal group id (e.g. "arch-r1"). Peers cannot read each other\'s submissions until `blind_quorum` distinct authors submit.' },
        blind_quorum: { type: 'integer', description: 'Optional unique-author quorum (2..20, default: 2) required to unseal `blind_group` in shuffled order.' },
        escalate: { type: 'boolean', description: 'Bypass recipients\' wake_kinds filter.' },
        silent: { type: 'boolean', description: 'Log without waking anyone.' },
        idempotency_key: { type: 'string', description: 'Optional dedup key.' },
        override_reason: { type: 'string', description: 'PM reason to override active reject gates on done.' },
        control_action: { type: 'string', enum: ['channel.create', 'channel.subscribe', 'channel.unsubscribe', 'channel.archive'], description: 'Channel control action.' },
        control_target: { type: 'string', description: 'Member name for subscribe/unsubscribe.' },
      },
      required: ['title', 'text'],
    },
    async execute(args, exec) {
      const { swarmId, callerName } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        if (!store.exists(swarmId)) {
          return { ok: false, text: '[FORMAT_ERROR: post_board] Swarm is not initialized. Call swarm_init first.' }
        }
        const existingMembers = store.readMembers(swarmId)
        const records = store.readBoard(swarmId)
        const headSeq = records.length === 0 ? 0 : records[records.length - 1].seq
        const channelState = replayChannelsAt(records, headSeq)

        if (args.control_action) {
          const ctrlRec = store.appendBoardRecord(swarmId, {
            type: 'control',
            action: args.control_action,
            agent: callerName,
            channel: args.channel ?? 'main',
            target: args.control_target ?? callerName,
          })
          runtime.notifyProjectionChanged(swarmId)
          return {
            ok: true,
            seq: ctrlRec.seq,
            text: `[post_board CONTROL OK] Wrote control frame #${ctrlRec.seq} (${ctrlRec.action} #${ctrlRec.channel}).`,
          }
        }

        const check = validatePostBoard(args, existingMembers, callerName, channelState.channels)
        if (!check.ok) return { ok: false, text: check.error }

        const val = check.value
        const isDonePost = val.kind === 'done' || val.text.includes('[done]')

        // Supersedes authorization: prevent workers or unauthorized peers from erasing a reviewer's [REJECT] gate
        if (val.supersedes.length > 0) {
          const recBySeq = new Map()
          for (const r of records) {
            if (r && r.type !== 'control') recBySeq.set(r.seq, r)
          }
          for (const oldSeq of val.supersedes) {
            const oldRec = recBySeq.get(oldSeq)
            if (oldRec && isMergeGateRejectPost(oldRec, existingMembers) && !canSupersedeReject(oldRec, callerName, val.verdict, existingMembers)) {
              return {
                ok: false,
                blocked_supersedes: oldSeq,
                text: `[PERMISSION_ERROR: post_board] @${callerName} cannot supersede [REJECT] floor #${oldSeq} authored by @${oldRec.agent}. Only the original reviewer, its explicit handover_to successor, or @coordinator with verdict="override" may supersede a rejection. Address @${oldRec.agent} on the board and wait for their CONCEDE or approve.`,
              }
            }
          }
        }

        if (isDonePost) {
          const activeRejections = store.computeActiveRejections(swarmId)
          if (activeRejections.length > 0 && !val.override_reason) {
            const list = activeRejections.map(r => `#${r.seq} by @${r.reviewer} (${r.role}): ${r.title}`).join('; ')
            return {
              ok: false,
              blocked_by_rejections: activeRejections,
              text: `[GATE_BLOCKED: post_board] Closing blocked by ${activeRejections.length} unresolved rejection(s): [${list}]. Have the reviewer re-verify and post verdict="approve" (or supersede the rejection), or pass override_reason to explicitly override.`,
            }
          }
          const swarmMetaForDone = store.readSwarm(swarmId)
          const planMetaForDone = store.readPlan(swarmId)
          const effectiveGates = collectEffectiveGateCommands(swarmMetaForDone, planMetaForDone)
          if (effectiveGates.length > 0) {
            const gateCwd = swarmMetaForDone?.project_root || process.cwd()
            const gateRes = await runHostGateCommands(gateCwd, effectiveGates)
            store.updateSwarm(swarmId, {
              last_host_gate: {
                ok: gateRes.ok,
                target: 'main',
                ran: gateRes.ran,
                failed_count: gateRes.failed_count,
                at: new Date().toISOString(),
                results: gateRes.results.map(r => ({
                  command: r.command,
                  exit_code: r.exit_code,
                  output_flags: r.output_flags,
                  passed: r.passed,
                })),
              },
            })
            if (!gateRes.ok && !val.override_reason) {
              const failedLines = gateRes.results
                .filter(r => !r.passed)
                .map(r => `\`${r.command}\` (rc=${r.exit_code}${r.output_flags.length > 0 ? ', flags=' + r.output_flags.join('|') : ''}): ${r.excerpt}`)
                .join('\n')
              return {
                ok: false,
                host_gate: gateRes,
                text: `[HOST_GATE_BLOCKED: post_board] Host gate_commands failed (${gateRes.failed_count}/${gateRes.ran}) before closing:\n${failedLines}\nFix the failing checks or pass override_reason with explicit user approval.`,
              }
            }
          }
        }

        const dup = store.findDuplicatePost(swarmId, {
          agent: callerName,
          channel: val.channel,
          kind: val.kind,
          text: val.text,
          idempotency_key: val.idempotency_key,
        })
        if (dup) {
          return {
            ok: true,
            deduplicated: true,
            seq: dup.seq,
            title: dup.title,
            woken: [],
            unreachable: [],
            silent_mentions: [],
            text: `[post_board DEDUPLICATED] Duplicate submission matched existing floor #${dup.seq} ("${dup.title}"); skipped duplicate write and wakeup.`,
          }
        }

        const finalText = (isDonePost && val.override_reason)
          ? `${val.text}\n\n[GATE_OVERRIDE by @${callerName}]: ${val.override_reason}`
          : val.text

        let reviewedDiffHash = null
        let reviewedDiffHashes = null
        let postArtifact = null
        let postWitness = null
        const callerRecord = existingMembers[callerName]
        const callerCanBlock = Boolean(callerRecord && (callerRecord.can_block_merge === true || getRoleSpec(callerRecord.role).canBlockMerge))

        // Objective reviewer transcript witness: attach real exec/tool/error/flag counts and block live rubber-stamp approvals with 0 exec calls
        if (callerCanBlock && (val.verdict === 'approve' || val.kind === 'review')) {
          const w = typeof runtime.getMemberWitness === 'function'
            ? runtime.getMemberWitness(callerRecord.session_id)
            : null
          if (w) {
            postWitness = {
              exec_calls: w.cycle_exec_calls,
              tool_calls: w.cycle_tool_calls,
              tool_errors: w.cycle_tool_errors,
              output_flags: w.cycle_output_flags,
              turn_count: w.turn_count,
            }
            const needsExec = getRoleSpec(callerRecord.role).requireExecWitness === true
            if (val.verdict === 'approve' && needsExec && w.turn_count > 0 && w.cycle_exec_calls === 0 && !val.override_reason) {
              return {
                ok: false,
                witness: postWitness,
                text: `[WITNESS_BLOCKED: post_board] Reviewer @${callerName} (${callerRecord.role}) attempted verdict="approve" after ${w.turn_count} turn(s) with 0 shell/command executions in this cycle. Run real verification commands first, or pass override_reason only for non-executable audits.`,
              }
            }
          }
        }

        // Zero-dirty-write gate: a reviewer running in an isolated review worktree must not mutate repo files (even via bash redirection)
        if (val.verdict === 'approve' && callerCanBlock && callerRecord.workspace_mode !== 'inherit' && callerRecord.worktree_path) {
          const ownDiff = await diffWorktree({
            worktreePath: callerRecord.worktree_path,
            baselineCommit: callerRecord.baseline_tree || callerRecord.base_commit,
          })
          if (ownDiff.ok && ownDiff.hasChanges) {
            return {
              ok: false,
              dirty_files: ownDiff.files,
              text: `[ROGUE_WRITE_BLOCKED: post_board] Reviewer @${callerName} modified repo file(s) inside its isolated review worktree (${ownDiff.files.join(', ')}). Reviewers must not mutate repo files (even via shell); clean up or use /tmp and re-verify cleanly.`,
            }
          }
        }

        // Objective worker submission snapshot: capture immutable commit SHA + diff metadata on events.jsonl for blind review projection
        if (callerRecord?.role === 'worker' && val.kind === 'report') {
          if (callerRecord.workspace_mode !== 'inherit' && callerRecord.worktree_path) {
            const snap = await snapshotWorktreeCommit({
              worktreePath: callerRecord.worktree_path,
              baselineCommit: callerRecord.baseline_tree || callerRecord.base_commit,
              label: `@${callerName}`,
            })
            if (snap.ok) {
              postArtifact = {
                worktree_path: callerRecord.worktree_path,
                baseline_commit: snap.baselineCommit,
                prev_commit: callerRecord.last_snapshot_commit || snap.prevCommitSha,
                commit_sha: snap.commitSha,
                diff_hash: snap.diffHash,
                changed_files: snap.files,
                ...(snap.hygieneFlags.length > 0 ? { diff_hygiene_flags: snap.hygieneFlags } : {}),
              }
              if (snap.commitSha && snap.commitSha !== callerRecord.last_snapshot_commit) {
                store.updateMember(swarmId, callerName, m => ({ ...m, last_snapshot_commit: snap.commitSha }))
              }
            }
          } else {
            const swarmMetaForArt = store.readSwarm(swarmId)
            const repoCwd = swarmMetaForArt?.project_root
            if (repoCwd && fs.existsSync(repoCwd)) {
              const headRes = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: repoCwd, timeoutMs: 3_000 })
              if (headRes.ok) {
                const diffRes = await diffWorktree({ worktreePath: repoCwd, baselineCommit: 'HEAD' })
                const hygieneFlags = diffRes.ok ? scanPatchHygiene(diffRes.patch) : []
                postArtifact = {
                  worktree_path: repoCwd,
                  baseline_commit: headRes.stdout.trim(),
                  commit_sha: headRes.stdout.trim(),
                  diff_hash: diffRes.ok ? diffRes.diffHash : null,
                  changed_files: diffRes.ok ? diffRes.files : [],
                  ...(hygieneFlags.length > 0 ? { diff_hygiene_flags: hygieneFlags } : {}),
                }
              }
            }
          }
        }

        if (val.verdict === 'approve' && callerCanBlock) {
          const verdictTargets = resolveVerdictTargets(
            { agent: callerName, target_member: val.target_member, mentions: val.mentions },
            existingMembers,
          )
          if (verdictTargets.length === 1 && verdictTargets[0] !== '*') {
            const tm = existingMembers[verdictTargets[0]]
            if (tm && tm.workspace_mode !== 'inherit' && tm.worktree_path) {
              const d = await diffWorktree({
                worktreePath: tm.worktree_path,
                baselineCommit: tm.baseline_tree || tm.base_commit,
              })
              if (d.ok && d.diffHash) reviewedDiffHash = d.diffHash
            }
          } else {
            const candidates = verdictTargets.includes('*')
              ? Object.entries(existingMembers)
                  .filter(([, m]) => !m.killed && !m.landed && m.workspace_mode !== 'inherit' && m.worktree_path)
                  .map(([n]) => n)
              : verdictTargets
            const hashMap = {}
            for (const targetName of candidates) {
              const tm = existingMembers[targetName]
              if (!tm || tm.workspace_mode === 'inherit' || !tm.worktree_path) continue
              const d = await diffWorktree({
                worktreePath: tm.worktree_path,
                baselineCommit: tm.baseline_tree || tm.base_commit,
              })
              if (d.ok && d.diffHash) hashMap[targetName] = d.diffHash
            }
            if (Object.keys(hashMap).length > 0) reviewedDiffHashes = hashMap
          }
        }

        const postRecord = store.appendBoardRecord(swarmId, {
          type: 'post',
          agent: callerName,
          title: val.title,
          channel: val.channel,
          mentions: val.mentions,
          channel_mentions: val.channel_mentions,
          skip_prose_mention_extraction: true,
          refs: val.refs,
          kind: val.kind,
          verdict: val.verdict,
          target_member: val.target_member,
          reviewed_diff_hash: reviewedDiffHash,
          reviewed_diff_hashes: reviewedDiffHashes,
          artifact: postArtifact,
          witness: postWitness,
          blind_group: val.blind_group,
          blind_quorum: val.blind_quorum,
          supersedes: val.supersedes,
          escalate: val.escalate,
          silent: val.silent,
          idempotency_key: val.idempotency_key,
          text: finalText,
        })

        if (callerCanBlock && postWitness && typeof runtime.resetMemberWitness === 'function') {
          runtime.resetMemberWitness(callerRecord.session_id)
        }

        let blindGroupSummary = null
        if (postRecord.blind_group) {
          const bgAfter = computeBlindGroupState(store.readBoard(swarmId))
          blindGroupSummary = bgAfter.get(postRecord.blind_group) ?? null
        }

        let archivePath = null
        let releaseHygiene = null
        if (isDonePost) {
          const swarmMeta = store.readSwarm(swarmId)
          if (swarmMeta?.project_root) {
            const st = await runGit(['status', '--porcelain'], { cwd: swarmMeta.project_root, timeoutMs: 3_000 })
            if (st.ok && st.stdout.trim().length > 0) {
              const dirtyLines = st.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
              const hasScratch = dirtyLines.some(l => /(?:^|\s|\/)(?:scratch|mutants|tmp)(?:\/|$)/i.test(l))
              releaseHygiene = {
                dirty_count: dirtyLines.length,
                has_scratch_artifacts: hasScratch,
                sample: dirtyLines.slice(0, 8),
              }
            }
          }
          store.appendEvent(swarmId, {
            type: 'swarm.done',
            actor: callerName,
            seq: postRecord.seq,
            payload: { seq: postRecord.seq, title: postRecord.title },
          })
          archivePath = store.archiveSwarm(swarmId, 'done')
        }

        const wakeRes = await runtime.dispatchPostWakeups(swarmId, postRecord)
        const wokenTargets = Array.isArray(wakeRes?.woken) ? [...wakeRes.woken] : []
        const unreachableTargets = Array.isArray(wakeRes?.unreachable) ? [...wakeRes.unreachable] : []
        const silentMentions = Array.isArray(wakeRes?.silentMentions) ? [...wakeRes.silentMentions] : []

        runtime.notifyBoardActivity(swarmId, postRecord)
        runtime.notifyProjectionChanged(swarmId)

        const notes = []
        if (val.silent) {
          notes.push('silent')
        } else if (wokenTargets.length > 0) {
          notes.push(`woke:${wokenTargets.map(n => '@' + n).join(',')}`)
        }
        if (silentMentions.length > 0) {
          notes.push(`filtered:${silentMentions.map(n => '@' + n).join(',')}`)
        }
        if (unreachableTargets.length > 0) {
          notes.push(`offline:${unreachableTargets.map(n => '@' + n).join(',')}`)
        }
        if (val.ignored_prose_mentions.length > 0) {
          notes.push(`ignored:${val.ignored_prose_mentions.map(n => '@' + n).join(',')}`)
        }
        if (postRecord.supersedes && postRecord.supersedes.length > 0) {
          notes.push(`supersedes:${postRecord.supersedes.map(s => '#' + s).join(',')}`)
        }
        if (postRecord.verdict) {
          notes.push(`verdict=${postRecord.verdict}`)
        }
        if (postWitness) {
          const flagSuffix = postWitness.output_flags.length > 0 ? `,flags=${postWitness.output_flags.join('|')}` : ''
          notes.push(`witness:exec=${postWitness.exec_calls},err=${postWitness.tool_errors}${flagSuffix}`)
        }
        if (blindGroupSummary) {
          notes.push(blindGroupSummary.unsealed
            ? `blind_group:${blindGroupSummary.group}=UNSEALED(${blindGroupSummary.submitted_count}/${blindGroupSummary.quorum})`
            : `blind_group:${blindGroupSummary.group}=SEALED(${blindGroupSummary.submitted_count}/${blindGroupSummary.quorum})`)
        }

        let consecutiveRejects = 0
        if (postRecord.verdict === 'reject') {
          const matchingRejs = store.computeActiveRejections(swarmId).filter(r => r.seq === postRecord.seq)
          consecutiveRejects = matchingRejs.length > 0
            ? Math.max(...matchingRejs.map(r => r.consecutive_rejects ?? 1))
            : 1
        }
        const escalateHumanNote = consecutiveRejects >= 2
          ? `\n[ESCALATE_TO_HUMAN] @${callerName} reached ${consecutiveRejects} consecutive rejects—stop local patching and ask the user to arbitrate architecture/scope.`
          : ''
        const archiveNote = archivePath
          ? `\n[SWARM_ARCHIVED] ${archivePath}`
          : ''
        const hygieneNote = releaseHygiene
          ? `\n[RELEASE_HYGIENE_WARN] ${releaseHygiene.dirty_count} dirty path(s)${releaseHygiene.has_scratch_artifacts ? ' (includes scratch/mutants/tmp!)' : ''}: ${releaseHygiene.sample.join(', ')}`
          : ''
        const fp = typeof runtime.getRuntimeFingerprint === 'function' ? runtime.getRuntimeFingerprint() : null
        const fpNote = (archivePath && fp) ? `\n[RUNTIME] dsh-swarm v${fp.version} (${fp.commit})` : ''
        const notesSuffix = notes.length > 0 ? `, ${notes.join(', ')}` : ''

        return {
          ok: true,
          deduplicated: false,
          seq: postRecord.seq,
          title: postRecord.title,
          woken: wokenTargets,
          silent_mentions: silentMentions,
          unreachable: unreachableTargets,
          ignored_prose_mentions: val.ignored_prose_mentions,
          ...(consecutiveRejects > 0 ? { consecutive_rejects: consecutiveRejects } : {}),
          ...(postWitness ? { witness: postWitness } : {}),
          ...(blindGroupSummary ? { blind_group: blindGroupSummary } : {}),
          ...(archivePath ? { archive_path: archivePath } : {}),
          ...(releaseHygiene ? { release_hygiene: releaseHygiene } : {}),
          text: `OK #${postRecord.seq} (read=#${postRecord.seq}${notesSuffix})${escalateHumanNote}${hygieneNote}${archiveNote}${fpNote}`,
        }
      })
    },
  })

  const readBoardTool = makeTool({
    name: 'read_board',
    description: 'Read board posts after `since` (default: your last_read_seq). Supports `kinds`, `agent`, `channel`, `limit`, `hide_superseded`, and read-only `seance_member` handover capsule inspection.',
    isConcurrencySafe: true,
    parameters: {
      properties: {
        since: { type: 'integer', description: 'Read after this floor seq (0 = all).' },
        channel: { type: 'string', description: 'Channel filter.' },
        mentions_only: { type: 'boolean', description: 'Only posts mentioning you.' },
        kinds: { type: 'array', items: { type: 'string', enum: [...VALID_POST_KINDS] }, description: 'Kind filter.' },
        agent: { type: 'string', description: 'Author filter.' },
        limit: { type: 'integer', description: 'Max recent posts.' },
        hide_superseded: { type: 'boolean', description: 'Omit superseded posts.' },
        seance_member: { type: 'string', description: 'Optional retired/existing member name to read a bounded (<=1500 char) capsule of its recent decisions and tool errors.' },
      },
    },
    async execute(args, exec) {
      const { swarmId, callerName } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        if (!store.exists(swarmId)) {
          return { ok: false, text: '[FORMAT_ERROR: read_board] Swarm is not initialized.' }
        }
        const members = store.readMembers(swarmId)
        const caller = members[callerName]
        const callerRole = caller?.role ?? 'worker'

        if (typeof args?.seance_member === 'string' && args.seance_member.trim()) {
          const targetName = args.seance_member.replace(/^@/, '').trim()
          const targetRec = members[targetName]
          if (!targetRec) {
            return { ok: false, text: `[FORMAT_ERROR: read_board] seance_member "@${targetName}" does not exist.` }
          }
          const evs = typeof runtime.getMemberSessionEvents === 'function'
            ? runtime.getMemberSessionEvents(targetRec.session_id)
            : []
          const capsule = extractMemberHandoverCapsule(evs, 1500)
          return {
            ok: true,
            seance_member: targetName,
            killed: targetRec.killed === true,
            capsule,
            text: `[SEANCE @${targetName} (${targetRec.role}, ${targetRec.killed ? 'retired' : 'active'})]\n${capsule}`,
          }
        }

        const sinceSeq = args && args.since !== undefined && Number.isInteger(Number(args.since)) && Number(args.since) >= 0
          ? Number(args.since)
          : (caller?.last_read_seq ?? 0)

        const allRecords = store.readBoard(swarmId)
        const supersededMap = computeSupersededMap(allRecords)
        const blindGroups = computeBlindGroupState(allRecords)

        let posts = store.queryVisiblePosts(swarmId, callerName, sinceSeq, {
          mentionsOnly: args?.mentions_only === true,
        })

        const hasKindFilter = Array.isArray(args?.kinds) && args.kinds.length > 0
        const hasAgentFilter = typeof args?.agent === 'string' && args.agent.trim().length > 0
        const hasChannelFilter = typeof args?.channel === 'string' && args.channel.trim().length > 0
        const limitNum = args?.limit !== undefined ? Math.floor(Number(args.limit)) : 0
        const hasLimit = Number.isInteger(limitNum) && limitNum > 0
        const hideSuperseded = args?.hide_superseded === true

        if (hasChannelFilter) {
          const ch = String(args.channel).replace(/^#/, '')
          posts = posts.filter(p => (p.channel || 'main') === ch)
        }
        if (hasKindFilter) {
          const allowed = new Set(args.kinds.map(k => String(k).trim()))
          posts = posts.filter(p => p.type !== 'control' && allowed.has(p.kind || 'report'))
        }
        if (hasAgentFilter) {
          const targetAgent = String(args.agent).replace(/^@/, '').trim()
          posts = posts.filter(p => p.agent === targetAgent)
        }
        if (hideSuperseded) {
          posts = posts.filter(p => !supersededMap.has(p.seq))
        }
        let truncatedCount = 0
        if (hasLimit && posts.length > limitNum) {
          truncatedCount = posts.length - limitNum
          posts = posts.slice(-limitNum)
        }

        const orderedPosts = orderUnsealedBlindGroupPosts(posts, swarmId, blindGroups)
        const annotatedPosts = orderedPosts.map((p) => {
          if (!p || p.type === 'control') return p
          const projected = projectPostForCaller(p, callerRole, members, { callerName, blindGroups })
          const withTitle = projected.title ? projected : { ...projected, title: deriveFallbackTitle(projected.text, projected.kind || 'post') }
          return supersededMap.has(p.seq)
            ? { ...withTitle, superseded_by: supersededMap.get(p.seq) }
            : withTitle
        })

        const headSeq = store.headSeq(swarmId)
        const isFilteredView = hasKindFilter || hasAgentFilter || hasLimit
        const newReadSeq = isFilteredView
          ? (caller?.last_read_seq ?? 0)
          : Math.max(caller?.last_read_seq ?? 0, headSeq)
        if (caller && newReadSeq > (caller.last_read_seq ?? 0)) {
          store.updateMember(swarmId, callerName, m => ({
            ...m,
            last_read_seq: newReadSeq,
          }))
        }
        runtime.notifyProjectionChanged(swarmId)

        const formatted = annotatedPosts.length === 0
          ? ''
          : annotatedPosts.map((p) => {
              const shortTime = p.time ? String(p.time).slice(11, 19) || String(p.time) : ''
              if (p.type === 'control') {
                return `#${p.seq} ${shortTime} CTRL @${p.agent} ${p.action} #${p.channel}${p.target ? ' -> @' + p.target : ''}`
              }
              const badges = []
              if (p.verdict) badges.push(`verdict=${p.verdict}`)
              if (p.witness) {
                const wf = Array.isArray(p.witness.output_flags) && p.witness.output_flags.length > 0
                  ? `,flags=${p.witness.output_flags.join('|')}`
                  : ''
                badges.push(`WITNESS:exec=${p.witness.exec_calls},err=${p.witness.tool_errors}${wf}`)
              }
              if (p.artifact && Array.isArray(p.artifact.diff_hygiene_flags) && p.artifact.diff_hygiene_flags.length > 0) {
                badges.push(`HYGIENE:${p.artifact.diff_hygiene_flags.join('|')}`)
              }
              if (p.blind_group) {
                const bgInfo = blindGroups.get(p.blind_group)
                badges.push(bgInfo?.unsealed
                  ? `BLIND_UNSEALED:${p.blind_group}`
                  : `BLIND_SEALED:${p.blind_group}(${bgInfo?.submitted_count ?? 1}/${bgInfo?.quorum ?? 2})`)
              }
              if (p.escalate) badges.push('ESCALATE')
              if (p.silent) badges.push('SILENT')
              if (p.superseded_by) badges.push(`SUPERSEDED by #${p.superseded_by}`)
              const badgeText = badges.length > 0 ? ` [${badges.join('|')}]` : ''
              const chPart = p.channel && p.channel !== 'main' ? ` #${p.channel}` : ''
              return `#${p.seq} ${shortTime}${chPart} @${p.agent} (${p.kind}) ${p.title}${badgeText}\n${p.text}`
            }).join('\n---\n')

        const swarmMeta = store.readSwarm(swarmId)
        const gen = swarmMeta?.generation ?? 1
        const metaParts = [`head=#${headSeq}`, `read=#${newReadSeq}`]
        if (gen > 1) metaParts.push(`gen=${gen}`)
        if (isFilteredView) metaParts.push(truncatedCount > 0 ? `filtered,-${truncatedCount}` : 'filtered')
        const header = `board ${annotatedPosts.length} (${metaParts.join(', ')})`
        return {
          ok: true,
          swarm_id: swarmId,
          generation: gen,
          head_seq: headSeq,
          last_read_seq: newReadSeq,
          count: annotatedPosts.length,
          posts: annotatedPosts,
          text: formatted ? `${header}\n${formatted}` : header,
        }
      })
    },
  })

  const swarmWaitTool = makeTool({
    name: 'swarm_wait',
    description: 'Park at 0 token cost until matching board posts arrive. Optional `wake_kinds` filters noise (bypassed by `escalate: true`).',
    parameters: {
      properties: {
        since: { type: 'integer', description: 'Latest floor seq read via read_board.' },
        mentions_only: { type: 'boolean', description: 'True (default) = wake on mentions only; false = wake on any post.' },
        wake_kinds: { type: 'array', items: { type: 'string', enum: [...VALID_POST_KINDS] }, description: 'Only wake for these post kinds.' },
      },
      required: ['since'],
    },
    async execute(args, exec) {
      const { swarmId, callerName } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        if (!store.exists(swarmId)) {
          return { ok: false, text: '[FORMAT_ERROR: swarm_wait] Swarm is not initialized.' }
        }
        const members = store.readMembers(swarmId)
        const member = members[callerName]
        const headSeq = store.headSeq(swarmId)
        const check = validateSwarmWait(args, member, headSeq)
        if (!check.ok) return { ok: false, text: check.error }

        const { since, mentions_only, wake_kinds } = check.value
        const pending = store.queryVisiblePosts(swarmId, callerName, since, {
          mentionsOnly: mentions_only,
          wakeKinds: wake_kinds,
        })

        if (pending.length > 0) {
          const newest = pending[pending.length - 1].seq
          if (member) {
            store.updateMember(swarmId, callerName, m => ({
              ...m,
              last_read_seq: Math.max(m.last_read_seq ?? 0, newest),
              last_park_blocked_seq: newest,
              wake_mode: 'working',
            }))
          }
          runtime.notifyProjectionChanged(swarmId)
          const blindGroupsForWait = computeBlindGroupState(store.readBoard(swarmId))
          const projectedPending = pending.map(p => projectPostForCaller(p, member?.role ?? 'worker', members, { callerName, blindGroups: blindGroupsForWait }))
          const preview = projectedPending.map(p => `#${p.seq} @${p.agent} (${p.kind}) ${p.title || deriveFallbackTitle(p.text)}\n${p.text}`).join('\n---\n')
          return {
            ok: true,
            status: 'NEW_MESSAGES_ARRIVED',
            posts: projectedPending,
            text: `[swarm_wait BLOCKED] +${projectedPending.length} (#${projectedPending[0].seq}..#${newest}):\n${preview}`,
          }
        }

        if (member) {
          store.updateMember(swarmId, callerName, m => ({
            ...m,
            wait_since: since,
            wake_mode: mentions_only ? 'mentions' : 'anything',
            wake_kinds: wake_kinds ?? null,
          }))
        }
        runtime.markTurnParked(exec.agent?.id)
        if (typeof exec?.concludeTurn === 'function') {
          exec.concludeTurn()
        }
        runtime.notifyProjectionChanged(swarmId)

        const kindsDesc = wake_kinds ? ` kinds=${wake_kinds.join(',')}` : ''
        return {
          ok: true,
          status: 'DONE',
          parked_at_seq: since,
          wake_mode: mentions_only ? 'mentions' : 'anything',
          wake_kinds: wake_kinds ?? null,
          text: `PARKED #${since} (${mentions_only ? 'mentions' : 'all'}${kindsDesc})`,
        }
      })
    },
  })

  const swarmStatusTool = makeTool({
    name: 'swarm_status',
    description: 'Inspect the live Swarm roster (distinguishing working/waiting/starting/zombie/error), LLM in-flight slot usage vs active member counts, Watchdog health status, and active `[REJECT]` merge-gate blocks.',
    isConcurrencySafe: true,
    parameters: {
      properties: {},
    },
    async execute(_args, exec) {
      const { swarmId } = runtime.resolveCaller(exec.agent)
      const fp = typeof runtime.getRuntimeFingerprint === 'function'
        ? runtime.getRuntimeFingerprint()
        : { version: '0.7.0', commit: 'HEAD', loaded_at: '' }
      if (!store.exists(swarmId)) {
        return {
          ok: false,
          runtime: fp,
          text: `No active Swarm in this session. [Runtime: dsh-swarm v${fp.version} @ ${fp.commit}, loaded=${fp.loaded_at}]`,
        }
      }
      const snap = buildSwarmProjectionSnapshot({ store, swarmId, runtime })
      const ms = snap.memberSummary
      const wd = snap.watchdog
      const wdLine = wd
        ? `Watchdog: ${wd.active ? 'ACTIVE' : 'SLEEPING'} (health=${wd.healthIntervalSec}s, stall=${wd.stallIntervalSec}s, alerts=${wd.alertsPosted}${wd.lastCheckAt ? ', last_check=' + wd.lastCheckAt : ''})`
        : 'Watchdog: standby'
      const rejLine = snap.activeRejections.length > 0
        ? `Active Merge-Gate Rejections (${snap.activeRejections.length}): ${snap.activeRejections.map(r => `#${r.seq} @${r.reviewer}${r.target_member && r.target_member !== '*' ? '->@' + r.target_member : ''}(${r.role}${r.consecutive_rejects >= 2 ? ', x' + r.consecutive_rejects + ' ESCALATE_TO_HUMAN' : ''}): ${r.title}`).join(', ')}`
        : 'Active Merge-Gate Rejections: none'

      const HIGH_TOOL_CALL_THRESHOLD = 80
      const lines = [
        `Runtime: dsh-swarm v${fp.version} (${fp.commit}) | "${snap.swarm.title}" ${snap.swarm.status} head=#${snap.headSeq}${snap.swarm.project_root ? ' root=' + snap.swarm.project_root : ''}`,
        `LLM In-Flight Slots: ${snap.concurrency.active}/${snap.concurrency.effectiveLimit} (cfg=${snap.concurrency.configuredLimit}, q=${snap.concurrency.queued}, 429=${snap.concurrency.rateLimitHits}) | Members: ${ms.totalActive} active (${ms.working}w/${ms.waiting}idle/${ms.starting}start${ms.unparked_idle ? '/' + ms.unparked_idle + 'unparked' : ''}${ms.zombie ? '/' + ms.zombie + 'zmb' : ''}${ms.error ? '/' + ms.error + 'err' : ''}, ${ms.killed} killed)`,
        wdLine,
        ...(Array.isArray(snap.gate_commands) && snap.gate_commands.length > 0
          ? [`Host Gate Commands (${snap.gate_commands.length}): ${snap.gate_commands.join(' ; ')}${snap.swarm?.last_host_gate ? ` [last=${snap.swarm.last_host_gate.ok ? 'PASS' : 'FAIL'}@${snap.swarm.last_host_gate.target}]` : ''}`]
          : []),
        ...(snap.activeRejections.length > 0 ? [rejLine] : []),
        ...snap.members.map(m => {
          const shortLastAt = m.last_tool_call_at ? String(m.last_tool_call_at).slice(11, 19) || m.last_tool_call_at : ''
          const route = `${m.applied_provider || 'inherit'}/${m.applied_model}${m.desired_model !== m.applied_model ? '->' + m.desired_model : ''}`
          const lastTool = shortLastAt ? ` (${m.last_tool_name}@${shortLastAt})` : ''
          const qPart = m.queue_position > 0 ? ` q=#${m.queue_position}` : ''
          const errPart = m.last_error ? ` ERR=${m.last_error.code}:${m.last_error.message}` : ''
          const blkPart = m.last_park_blocked_seq > 0 ? ` blk=#${m.last_park_blocked_seq}` : ''
          const ctxPct = m.context_window > 0 && m.last_input_tokens > 0
            ? Math.round((m.last_input_tokens / m.context_window) * 100)
            : 0
          const ctxPart = m.context_window > 0 && m.last_input_tokens > 0
            ? ` ctx=${formatCompactTokens(m.last_input_tokens)}/${formatCompactTokens(m.context_window)}(${ctxPct}%)`
            : (m.last_input_tokens > 0 ? ` ctx=${formatCompactTokens(m.last_input_tokens)}` : '')
          const stepPart = m.stepSummary && m.status !== 'waiting' && m.status !== 'killed' ? ` | ${m.stepSummary}` : ''
          const budgetWarn = !m.killed && m.tool_call_count >= HIGH_TOOL_CALL_THRESHOLD
            ? ` [BUDGET_WARN: ${m.tool_call_count} tool calls]`
            : ''
          const ctxWarn = !m.killed && ctxPct >= 80
            ? ` [CTX_PRESSURE: ${ctxPct}%]`
            : ''
          const toolLoopWarn = !m.killed && (m.consecutive_tool_errors ?? 0) >= 3
            ? ` [TOOL_LOOP_WARN: ${m.consecutive_tool_errors}x ${m.last_tool_error_name || 'tool'} errors]`
            : ''
          return `  - @${m.name} [${m.role}${m.can_block_merge ? ':gate' : ''}] status=${m.status} ${route} ${m.workspace_mode} t=${m.turn_count} tc=${m.tool_call_count}${ctxPart}${lastTool}${qPart}${errPart} r=#${m.last_read_seq} w=#${m.wait_since} p=#${m.last_post_seq}${blkPart}${stepPart}${budgetWarn}${ctxWarn}${toolLoopWarn}`
        }),
      ]
      return {
        ok: true,
        runtime: fp,
        snapshot: snap,
        text: lines.join('\n'),
      }
    },
  })

  const swarmModelTool = makeTool({
    name: 'swarm_model',
    description: 'Hot-swap a member to a different model route (e.g. "inherit" or "<provider>/<model>"), keeping its full conversation history and returning liveness telemetry.',
    parameters: {
      properties: {
        name: { type: 'string', description: 'Target member name in members.json.' },
        provider: { type: 'string', description: 'Target registered provider route (or "inherit").' },
        model: { type: 'string', description: 'Target model id or "<provider>/<model>" (or "inherit").' },
        reason: { type: 'string', description: 'Why the model is being switched.' },
      },
      required: ['name', 'model'],
    },
    async execute(args, exec) {
      const { swarmId, callerName } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        const members = store.readMembers(swarmId)
        const targetName = String(args?.name ?? '').trim()
        const target = members[targetName]
        if (!target || target.killed) {
          return { ok: false, text: `[FORMAT_ERROR: swarm_model] Member "@${targetName}" does not exist or is retired.` }
        }
        if (callerName !== 'coordinator' && target.parent !== callerName && callerName !== targetName) {
          return { ok: false, text: `[PERMISSION_ERROR: swarm_model] @${callerName} is not authorized to hot-swap @${targetName}.` }
        }
        const nextProvider = typeof args.provider === 'string' && args.provider.trim() ? args.provider.trim() : target.applied_provider
        const nextModel = String(args.model).trim()

        const swapped = await runtime.hotSwapMemberModel({
          swarmId,
          memberName: targetName,
          provider: nextProvider,
          model: nextModel,
          reason: args.reason ?? 'Model switched by coordinator',
        })
        if (!swapped.ok) return { ok: false, text: swapped.error }
        runtime.notifyProjectionChanged(swarmId)
        return {
          ok: true,
          applied_provider: swapped.provider,
          applied_model: swapped.model,
          member_alive: swapped.member_alive === true,
          turn_count: swapped.turn_count ?? 0,
          last_turn_at: swapped.last_turn_at ?? null,
          text: `[swarm_model OK] Hot-swapped @${targetName} to ${swapped.provider}/${swapped.model} (member_alive=${swapped.member_alive === true}, turn_count=${swapped.turn_count ?? 0}, last_turn_at=${swapped.last_turn_at ?? 'none'}).`,
        }
      })
    },
  })

  const swarmLandTool = makeTool({
    name: 'swarm_land',
    description: 'Inspect (`action: "diff"`), run host `gate_commands` (`action: "gate"`), batch-preflight (`action: "preflight_all"`), or merge (`action: "apply"`) isolated worktree changes into `project_root` / main workspace. Enforces merge gates, host `gate_commands`, diff-hash approval freshness, `[OWNERSHIP]`/`[FORBIDDEN]` scope, and sensitive-file blacklists unless `override_reason` is provided.',
    parameters: {
      properties: {
        name: { type: 'string', description: 'Member name whose worktree to diff, gate-check, or land (omit for action="preflight_all" or action="gate" on main workspace).' },
        action: { type: 'string', enum: ['diff', 'apply', 'preflight_all', 'gate'], description: '"diff" to inspect changes, "gate" to run host gate_commands objectively, "preflight_all" to check all unlanded worktrees for main & cross-member conflicts, "apply" to verify and apply onto main workspace.' },
        override_reason: { type: 'string', description: 'Optional PM reason to override an active merge gate, host gate failure, or scope/sensitive block.' },
      },
      required: ['action'],
    },
    async execute(args, exec) {
      const { swarmId, callerName, rootAgent } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        const swarmMeta = store.readSwarm(swarmId)
        const planMeta = store.readPlan(swarmId)
        const members = store.readMembers(swarmId)
        const mainCwd = swarmMeta?.project_root || rootAgent?.session?.header?.cwd || process.cwd()
        const effectiveGates = collectEffectiveGateCommands(swarmMeta, planMeta)

        if (args.action === 'gate') {
          const targetName = typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : null
          const targetMember = targetName ? members[targetName] : null
          if (targetName && !targetMember) {
            return { ok: false, text: `[FORMAT_ERROR: swarm_land] Member "@${targetName}" does not exist.` }
          }
          if (effectiveGates.length === 0) {
            return { ok: true, ran: 0, results: [], text: '[swarm_land GATE] No host gate_commands configured on swarm_init or swarm_plan.' }
          }
          const runCwd = (targetMember && targetMember.workspace_mode !== 'inherit' && targetMember.worktree_path)
            ? targetMember.worktree_path
            : mainCwd
          const gateRes = await runHostGateCommands(runCwd, effectiveGates)
          store.updateSwarm(swarmId, {
            last_host_gate: {
              ok: gateRes.ok,
              target: targetName || 'main',
              ran: gateRes.ran,
              failed_count: gateRes.failed_count,
              at: new Date().toISOString(),
              results: gateRes.results.map(r => ({
                command: r.command,
                exit_code: r.exit_code,
                output_flags: r.output_flags,
                passed: r.passed,
              })),
            },
          })
          runtime.notifyProjectionChanged(swarmId)
          const lines = [
            `[swarm_land GATE ${gateRes.ok ? 'PASS' : 'FAIL'}] target=${targetName ? '@' + targetName : 'main'} (${gateRes.ran - gateRes.failed_count}/${gateRes.ran} passed)`,
            ...gateRes.results.map(r => `  - [${r.passed ? 'PASS' : 'FAIL'}] \`${r.command}\` rc=${r.exit_code} (${r.duration_ms}ms${r.output_flags.length > 0 ? ', flags=' + r.output_flags.join('|') : ''})${!r.passed && r.excerpt ? '\n    ' + r.excerpt : ''}`),
          ]
          return {
            ok: gateRes.ok,
            host_gate: gateRes,
            text: lines.join('\n'),
          }
        }

        if (args.action === 'preflight_all') {
          const candidates = Object.entries(members)
            .filter(([, m]) => (
              m && !m.killed && !m.landed && !m.worktree_handed_over
              && m.workspace_mode !== 'inherit' && m.worktree_path
              && !(m.can_block_merge === true || getRoleSpec(m.role).canBlockMerge)
            ))
          const reports = []
          const fileOwners = new Map()
          for (const [mName, m] of candidates) {
            const d = await diffWorktree({
              worktreePath: m.worktree_path,
              baselineCommit: m.baseline_tree || m.base_commit,
            })
            const scopeAudit = d.ok
              ? auditChangedPaths({ files: d.files, ownedPaths: m.owned_paths, forbiddenPaths: m.forbidden_paths })
              : { ok: false, paths: [], sensitive: [], forbidden: [], outOfScope: [] }
            let applyClean = true
            let conflictDetail = null
            if (d.ok && d.hasChanges) {
              const chk = await runGit(['-c', 'core.autocrlf=false', 'apply', '--check', '--whitespace=nowarn', '-'], {
                cwd: mainCwd,
                input: d.patch,
              })
              if (!chk.ok) {
                applyClean = false
                conflictDetail = chk.stderr.trim()
              }
            }
            for (const p of scopeAudit.paths) {
              if (!fileOwners.has(p)) fileOwners.set(p, [])
              fileOwners.get(p).push(mName)
            }
            const activeRejs = store.computeActiveRejections(swarmId, { targetMember: mName })
            const staleApps = d.ok && d.diffHash ? store.computeStaleApprovals(swarmId, mName, d.diffHash) : []
            reports.push({
              member: mName,
              has_changes: d.hasChanges === true,
              diff_hash: d.diffHash ?? null,
              files: scopeAudit.paths,
              apply_clean: applyClean,
              ...(conflictDetail ? { conflict_detail: conflictDetail } : {}),
              scope_ok: scopeAudit.ok,
              scope_audit: scopeAudit,
              hygiene_flags: d.ok ? scanPatchHygiene(d.patch) : [],
              active_rejections: activeRejs.length,
              stale_approvals: staleApps.length,
            })
          }
          const overlaps = []
          for (const [filePath, owners] of fileOwners.entries()) {
            if (owners.length > 1) overlaps.push({ path: filePath, members: owners })
          }
          const allReady = overlaps.length === 0 && reports.every(r => r.apply_clean && r.scope_ok && r.active_rejections === 0 && r.stale_approvals === 0)
          const summaryLines = [
            `[swarm_land PREFLIGHT_ALL] ${reports.length} worktree(s) checked, all_ready=${allReady}, cross_overlaps=${overlaps.length}`,
            ...reports.map(r => `  - @${r.member}: files=${r.files.length}, apply_clean=${r.apply_clean}, scope_ok=${r.scope_ok}, rej=${r.active_rejections}, stale=${r.stale_approvals}${r.hygiene_flags.length > 0 ? ', flags=' + r.hygiene_flags.join('|') : ''}`),
            ...overlaps.map(o => `  ! OVERLAP: ${o.path} touched by ${o.members.map(n => '@' + n).join(', ')}`),
          ]
          return {
            ok: true,
            all_ready: allReady,
            members: reports,
            overlaps,
            text: summaryLines.join('\n'),
          }
        }

        const targetName = String(args?.name ?? '').trim()
        const member = members[targetName]
        if (!member) {
          return { ok: false, text: `[FORMAT_ERROR: swarm_land] Member "@${targetName}" does not exist.` }
        }
        if (member.workspace_mode === 'inherit' || !member.worktree_path) {
          return { ok: true, text: `[swarm_land] @${targetName} uses workspace="inherit"; edits are already in the main workspace.` }
        }

        if (args.action === 'apply') {
          const activeRejections = store.computeActiveRejections(swarmId, { targetMember: targetName })
          const preDiff = await diffWorktree({
            worktreePath: member.worktree_path,
            baselineCommit: member.baseline_tree || member.base_commit,
          })
          const staleApprovals = preDiff.ok && preDiff.diffHash
            ? store.computeStaleApprovals(swarmId, targetName, preDiff.diffHash)
            : []
          const scopeAudit = preDiff.ok
            ? auditChangedPaths({
                files: preDiff.files,
                ownedPaths: member.owned_paths,
                forbiddenPaths: member.forbidden_paths,
              })
            : { ok: true, paths: [], sensitive: [], forbidden: [], outOfScope: [] }
          const overrideReason = typeof args.override_reason === 'string' && args.override_reason.trim()
            ? args.override_reason.trim()
            : null
          let hostGateRes = null
          if (effectiveGates.length > 0) {
            hostGateRes = await runHostGateCommands(member.worktree_path, effectiveGates)
            store.updateSwarm(swarmId, {
              last_host_gate: {
                ok: hostGateRes.ok,
                target: targetName,
                ran: hostGateRes.ran,
                failed_count: hostGateRes.failed_count,
                at: new Date().toISOString(),
                results: hostGateRes.results.map(r => ({
                  command: r.command,
                  exit_code: r.exit_code,
                  output_flags: r.output_flags,
                  passed: r.passed,
                })),
              },
            })
          }
          const hostGateFailed = Boolean(hostGateRes && !hostGateRes.ok)
          if ((activeRejections.length > 0 || staleApprovals.length > 0 || !scopeAudit.ok || hostGateFailed) && !overrideReason) {
            const parts = []
            if (activeRejections.length > 0) {
              const list = activeRejections.map(r => `#${r.seq} by @${r.reviewer} (${r.role}): ${r.title}`).join('; ')
              parts.push(`unresolved rejection(s): [${list}]`)
            }
            if (staleApprovals.length > 0) {
              const staleList = staleApprovals.map(a => `#${a.seq} by @${a.reviewer} (approved=${a.approved_diff_hash}, current=${a.current_diff_hash})`).join('; ')
              parts.push(`stale approval(s) after post-review edits: [${staleList}]`)
            }
            if (!scopeAudit.ok) {
              const scopeParts = []
              if (scopeAudit.sensitive.length > 0) scopeParts.push(`sensitive/scratch=[${scopeAudit.sensitive.join(', ')}]`)
              if (scopeAudit.forbidden.length > 0) scopeParts.push(`forbidden=[${scopeAudit.forbidden.join(', ')}]`)
              if (scopeAudit.outOfScope.length > 0) scopeParts.push(`out_of_ownership=[${scopeAudit.outOfScope.join(', ')}]`)
              parts.push(`scope violation(s): ${scopeParts.join('; ')}`)
            }
            if (hostGateFailed) {
              const failStr = hostGateRes.results
                .filter(r => !r.passed)
                .map(r => `\`${r.command}\` (rc=${r.exit_code}${r.output_flags.length > 0 ? ', flags=' + r.output_flags.join('|') : ''})`)
                .join('; ')
              parts.push(`host gate_commands failed: [${failStr}]`)
            }
            return {
              ok: false,
              ...(activeRejections.length > 0 ? { blocked_by_rejections: activeRejections } : {}),
              ...(staleApprovals.length > 0 ? { stale_approvals: staleApprovals } : {}),
              ...(!scopeAudit.ok ? { scope_violations: scopeAudit } : {}),
              ...(hostGateFailed ? { host_gate: hostGateRes } : {}),
              text: `[${hostGateFailed ? 'HOST_GATE_BLOCKED' : 'GATE_BLOCKED'}: swarm_land] Landing @${targetName} blocked by ${parts.join(' and ')}. Resolve or pass override_reason to override.`,
            }
          }
          if ((activeRejections.length > 0 || staleApprovals.length > 0 || !scopeAudit.ok || hostGateFailed) && overrideReason) {
            const refsList = [
              ...activeRejections.map(r => '#' + r.seq),
              ...staleApprovals.map(a => '#' + a.seq + '(stale)'),
              ...(!scopeAudit.ok ? ['scope_audit'] : []),
              ...(hostGateFailed ? ['host_gate'] : []),
            ].join(', ')
            store.appendBoardRecord(swarmId, {
              type: 'post',
              agent: callerName,
              kind: 'decision',
              verdict: 'override',
              target_member: targetName,
              silent: true,
              title: `Gate override: land @${targetName}`,
              text: `[GATE_OVERRIDE] @${callerName} landed @${targetName} overriding gate block(s) ${refsList}: ${overrideReason}`,
            })
          }
        }

        const res = await landWorktree({
          mainCwd,
          worktreePath: member.worktree_path,
          baselineCommit: member.baseline_tree || member.base_commit,
          action: args.action,
        })
        if (!res.ok) {
          return { ok: false, text: `[LAND_ERROR: swarm_land] ${res.error}` }
        }
        if (args.action === 'diff') {
          const hygieneFlags = scanPatchHygiene(res.patch)
          const scopeAudit = auditChangedPaths({
            files: res.files,
            ownedPaths: member.owned_paths,
            forbiddenPaths: member.forbidden_paths,
          })
          const flagsNote = hygieneFlags.length > 0 ? `\n[DIFF_HYGIENE_FLAGS]: ${hygieneFlags.join(', ')}` : ''
          const scopeNote = !scopeAudit.ok
            ? `\n[SCOPE_WARN]: sensitive=[${scopeAudit.sensitive.join(', ')}], forbidden=[${scopeAudit.forbidden.join(', ')}], out_of_ownership=[${scopeAudit.outOfScope.join(', ')}]`
            : ''
          return {
            ok: true,
            files: res.files,
            diff_hash: res.diffHash ?? null,
            hygiene_flags: hygieneFlags,
            scope_audit: scopeAudit,
            text: `[swarm_land DIFF @${targetName}] Changed files (${res.files.length}): ${res.files.join(', ') || 'none'}${flagsNote}${scopeNote}\n\n${res.patch.slice(0, 6000)}`,
          }
        }
        store.updateMember(swarmId, targetName, m => ({ ...m, landed: true }))
        runtime.notifyProjectionChanged(swarmId)
        return {
          ok: true,
          files: res.files,
          text: `[swarm_land APPLY OK] @${targetName}: ${res.message}`,
        }
      })
    },
  })

  const swarmKillTool = makeTool({
    name: 'swarm_kill',
    description: 'Retire a Swarm member and delete its isolated worktree (unless `keep_worktree: true` is passed for later `adopt_worktree_from` takeover). Use promptly to terminate low-efficiency, slacking, hallucinating, or context-polluted sessions and respawn clean replacements. Blocks retiring a currently `working` or `queued` member unless `force: true` is passed. If the member never started (`turn_count === 0 && last_post_seq === 0`), its name is released for reuse; otherwise it stays tombstoned for audit history.',
    parameters: {
      properties: {
        name: { type: 'string', description: 'Member name to retire.' },
        force: { type: 'boolean', description: 'Set true to force-kill a running/queued member or discard unmerged worktree edits intentionally.' },
        keep_worktree: { type: 'boolean', description: 'Set true to preserve the member\'s isolated worktree on disk for a replacement session to adopt via `swarm_add(adopt_worktree_from)`.' },
        handover_to: { type: 'string', description: 'Optional member name taking over responsibility.' },
        reason: { type: 'string', description: 'Optional retirement/handover reason.' },
      },
      required: ['name'],
    },
    async execute(args, exec) {
      const { swarmId, callerName, rootAgent } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        const swarmMeta = store.readSwarm(swarmId)
        const members = store.readMembers(swarmId)
        const targetName = String(args?.name ?? '').trim()
        const rawTarget = members[targetName]
        if (!rawTarget) {
          return { ok: false, text: `[FORMAT_ERROR: swarm_kill] Member "@${targetName}" does not exist.` }
        }
        if (targetName === 'coordinator') {
          return { ok: false, text: '[FORMAT_ERROR: swarm_kill] Cannot retire the coordinator root session.' }
        }
        if (rawTarget.killed) {
          return { ok: true, text: `[swarm_kill] @${targetName} is already retired (killed).` }
        }
        if (callerName !== 'coordinator' && rawTarget.parent !== callerName) {
          return {
            ok: false,
            text: `[PERMISSION_ERROR: swarm_kill] @${callerName} may only retire members it spawned; @${targetName} was spawned by @${rawTarget.parent}.`,
          }
        }

        const liveness = typeof runtime.getMemberLiveness === 'function'
          ? runtime.getMemberLiveness(swarmId, targetName, rawTarget)
          : { status: 'unknown', stepSummary: null }
        if ((liveness.status === 'working' || liveness.status === 'queued') && args.force !== true) {
          const stepNote = liveness.stepSummary ? ` (${liveness.stepSummary})` : ''
          return {
            ok: false,
            blocked_running: true,
            status: liveness.status,
            text: `[KILL_BLOCKED: swarm_kill] @${targetName} is currently ${liveness.status}${stepNote}. If its in-progress findings or context ("last words") are meaningful, message @${targetName} via post_board to post a brief handover summary before killing; otherwise re-call swarm_kill({"name": "${targetName}", "force": true}) to terminate immediately.`,
          }
        }

        const liveOverlay = typeof runtime.getMemberTelemetry === 'function'
          ? runtime.getMemberTelemetry(rawTarget.session_id)
          : null
        const target = liveOverlay ? { ...rawTarget, ...liveOverlay } : rawTarget

        const mainCwd = swarmMeta?.project_root || rootAgent?.session?.header?.cwd || process.cwd()
        const keepWorktree = args.keep_worktree === true || target.worktree_handed_over === true
        if (!keepWorktree) {
          if ((target.workspace_mode === 'share' || target.workspace_mode === 'branch') && target.worktree_path && !target.landed) {
            const rmRes = await removeIsolatedWorktree({
              mainCwd,
              worktreePath: target.worktree_path,
              baselineCommit: target.baseline_tree || target.base_commit,
              force: args.force === true,
            })
            if (!rmRes.ok) {
              return {
                ok: false,
                text: `[SAFETY_BLOCK: swarm_kill] @${targetName} still has unmerged worktree changes (${(rmRes.files ?? []).join(', ')}). Run swarm_land({"name": "${targetName}", "action": "apply"}), pass keep_worktree=true (or adopt_worktree_from in swarm_add) to hand over edits, or pass force=true to discard intentionally.`,
              }
            }
          } else if (target.worktree_path && target.worktree_path !== mainCwd) {
            await removeIsolatedWorktree({
              mainCwd,
              worktreePath: target.worktree_path,
              baselineCommit: target.baseline_tree || target.base_commit,
              force: true,
            })
          }
        }

        await runtime.disposeMemberAgent(swarmId, targetName)

        const neverWorked = (target.turn_count ?? 0) === 0 && (target.last_post_seq ?? 0) === 0
        const handoverTo = typeof args.handover_to === 'string' && args.handover_to.trim()
          ? args.handover_to.replace(/^@/, '').trim()
          : null
        const killReason = typeof args.reason === 'string' && args.reason.trim()
          ? args.reason.trim()
          : null

        if (neverWorked) {
          store.removeMemberRecord(swarmId, targetName, {
            actor: callerName,
            seq: store.headSeq(swarmId),
            reason: killReason,
          })
          runtime.notifyProjectionChanged(swarmId)
          return {
            ok: true,
            name_released: true,
            text: `[swarm_kill OK] Cleaned up never-started member @${targetName} (turns=0, post=#0); name "${targetName}" has been released for reuse.`,
          }
        }

        const killedAtSeq = store.headSeq(swarmId)
        store.appendEvent(swarmId, {
          type: 'member.kill',
          actor: callerName,
          seq: killedAtSeq,
          payload: {
            name: targetName,
            released: false,
            killed_at_seq: killedAtSeq,
            handover_to: handoverTo,
            reason: killReason,
          },
        })
        runtime.notifyProjectionChanged(swarmId)

        const handoverNote = handoverTo ? ` (handed over to @${handoverTo}${killReason ? ': ' + killReason : ''})` : ''
        return {
          ok: true,
          name_released: false,
          handover_to: handoverTo,
          text: `[swarm_kill OK] Retired @${targetName} and cleaned up its worktree${handoverNote} (name tombstoned to preserve board history).`,
        }
      })
    },
  })

  const swarmConcurrencyTool = makeTool({
    name: 'swarm_concurrency',
    description: 'Adjust the Swarm in-flight LLM concurrency slot limit (`limit >= 1`, coordinator-only). Caps simultaneous in-flight LLM streams (NOT max member count) and records the change in `events.jsonl`.',
    parameters: {
      properties: {
        limit: { type: 'integer', minimum: 1, description: 'New maximum concurrent in-flight LLM streams (positive integer >= 1).' },
        reason: { type: 'string', description: 'Optional concise reason for adjusting concurrency slots (e.g. Wave 2 scale-up or rate-limit tuning).' },
      },
      required: ['limit'],
    },
    async execute(args, exec) {
      const { swarmId, callerName } = runtime.resolveCaller(exec.agent)
      if (callerName !== 'coordinator') {
        return {
          ok: false,
          text: `[PERMISSION_ERROR: swarm_concurrency] Only @coordinator may adjust LLM concurrency slots (caller: @${callerName}).`,
        }
      }
      if (!store.exists(swarmId)) {
        return {
          ok: false,
          text: '[STATE_ERROR: swarm_concurrency] Swarm is not initialized yet. Call `swarm_init` first.',
        }
      }
      const limit = Number(args?.limit)
      if (!Number.isInteger(limit) || limit < 1) {
        return {
          ok: false,
          text: '[FORMAT_ERROR: swarm_concurrency] `limit` must be a positive integer >= 1.',
        }
      }
      const reason = typeof args?.reason === 'string' && args.reason.trim() ? args.reason.trim() : null
      return await store.withLock(swarmId, async () => {
        const previousLimit = store.readSwarm(swarmId)?.concurrency_limit ?? concurrencyGate.snapshot().configuredLimit
        concurrencyGate.setLimit(limit)
        store.updateSwarm(swarmId, {
          concurrency_limit: limit,
          concurrency_confirmed: true,
        })
        runtime.notifyProjectionChanged(swarmId)
        const snap = concurrencyGate.snapshot()
        const reasonText = reason ? ` (reason: ${reason})` : ''
        return {
          ok: true,
          previous_limit: previousLimit,
          limit,
          concurrency: snap,
          text: `[swarm_concurrency OK] Updated in-flight LLM concurrency slots from ${previousLimit} to ${limit}${reasonText}. Live slots: ${snap.active}/${snap.effectiveLimit} active, ${snap.queued} queued.`,
        }
      })
    },
  })

  return [
    swarmInitTool,
    swarmPlanTool,
    swarmAddTool,
    postBoardTool,
    readBoardTool,
    swarmWaitTool,
    swarmStatusTool,
    swarmModelTool,
    swarmConcurrencyTool,
    swarmLandTool,
    swarmKillTool,
  ]
}

/** Detect if the user already specified a concurrency limit in `/swarm <task>`. */
function extractInlineConcurrency(rawText) {
  if (!rawText) return null
  const m = /(?:(\d+)\s*(?:slots?|concurrency)|(?:concurrency|slots?)\s*[:=]?\s*(\d+))/i.exec(rawText)
  if (!m) return null
  const num = Number(m[1] || m[2])
  return Number.isInteger(num) && num >= 1 ? num : null
}

/** Register the human `/swarm` slash command on `ctx.commands`. */
export function createSwarmCommand(runtime) {
  return {
    definitionId: 'dsh-swarm',
    name: 'swarm',
    description: 'Start or inspect a multi-agent blackboard Swarm (/swarm <task>, /swarm status)',
    input: {
      hint: '[<task> | status | board]',
      attachments: true,
    },
    async handler(invocation) {
      const raw = String(invocation.rawInput ?? '').trim()
      const agent = invocation.agent
      const swarmId = agent.id
      const { store, concurrencyGate } = runtime

      if (raw === 'status' || raw === 'board') {
        if (!store.exists(swarmId)) {
          return { kind: 'success', text: 'No active Swarm in this session. Start one with `/swarm <task>`.' }
        }
        const snap = buildSwarmProjectionSnapshot({ store, swarmId, runtime })
        const ms = snap.memberSummary
        return {
          kind: 'success',
          text: `Swarm "${snap.swarm.title}" (${snap.swarm.status}) | Members: ${ms.totalActive} (${ms.working} working / ${ms.waiting} waiting / ${ms.zombie} zombie) | LLM Slots: ${snap.concurrency.active}/${snap.concurrency.effectiveLimit} | Board: #${snap.headSeq}`,
        }
      }

      const discovered = typeof runtime.discoverAvailableModels === 'function'
        ? await runtime.discoverAvailableModels(agent)
        : { parentRoute: { provider: 'inherit', model: 'inherit' }, routes: [] }
      const currentRouteText = discovered.parentRoute?.provider && discovered.parentRoute?.model
        ? `${discovered.parentRoute.provider}/${discovered.parentRoute.model}`
        : 'inherit'
      const availableRoutesList = Array.isArray(discovered.routes) && discovered.routes.length > 0
        ? discovered.routes.slice(0, 12).map(r => `${r.provider}/${r.model}`).join(', ')
        : currentRouteText
      const inlineConc = extractInlineConcurrency(raw)

      await store.withLock(swarmId, async () => {
        if (!store.exists(swarmId)) {
          store.initSwarm(swarmId, {
            title: raw.slice(0, 60) || 'Swarm Task',
            concurrency_confirmed: inlineConc !== null,
            concurrency_limit: inlineConc ?? runtime.settings.defaultConcurrency,
            default_provider: discovered.parentRoute?.provider || 'inherit',
            default_model: discovered.parentRoute?.model || 'inherit',
            coordinator_model: discovered.parentRoute?.model || 'inherit',
          })
          if (inlineConc !== null) concurrencyGate.setLimit(inlineConc)
        }
      })
      runtime.activateCoordinatorMode(agent)
      runtime.enableSwarmToolsOnAgent?.(agent, 'coordinator')
      runtime.notifyProjectionChanged(swarmId)

      const kickoffPrompt = [
        `[USER INVOKED /swarm]`,
        `Task request: ${raw || 'Assist with the user task'}`,
        ``,
        `[DISCOVERED DSH MODEL ROUTES — never invent provider="internal"]`,
        `- Active session model: \`${currentRouteText}\``,
        `- Registered available routes: \`${availableRoutesList}\``,
        ...(inlineConc !== null ? [`- Parsed inline concurrency slots from user input: \`${inlineConc}\` (do not re-ask concurrency)`] : []),
        ``,
        `[PM PHASE-0 ALIGNMENT — ask once, only missing items, reply in the user's language]`,
        `You are in Product Manager mode (the user is the boss). Use a single ask_user_question call to clarify only what is still unspecified:`,
        `1. True Goal: What exact deliverable matters most? (code / architecture / benchmark / hypothesis test)`,
        `2. Acceptance Bar: What counts as done?`,
        `3. Scope & Non-Goals: What should explicitly be excluded?`,
        `4. In-Flight LLM Slots (NOT max member count) & Model Preference: only ask if the user did not already specify; recommend inheriting the active session model (${currentRouteText}).`,
        ``,
        `[ORG CONTRACT REMINDER] Do NOT write architecture docs, production code, or test harness scripts yourself. Spawn peer-accountable roles (architect / worker / verifier), require meaningful titles on every post_board call, and park with swarm_wait({ wake_kinds: ["alert","question","decision","review"] }) for low noise.`,
      ].join('\n')
      agent.steer(buildSwarmSystemMessage(kickoffPrompt, 'Swarm kickoff'))
      return {
        kind: 'success',
        text: `Swarm Coordinator mode activated (session model: ${currentRouteText}${inlineConc ? `, inline slots=${inlineConc}` : ''}). Aligning goals and launch parameters...`,
      }
    },
  }
}
