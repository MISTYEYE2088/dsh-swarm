// Model-facing Swarm tools, `/swarm` slash command, and `swarm` SessionProjection.
//
// Strictly English-only so consuming agents never get nudged into switching response
// languages. All tool return payloads pass through `toLosslessJson()` so DSH's
// lossless JSON validation can never fail after a write commits.

import fs from 'node:fs'
import path from 'node:path'

import {
  replayChannelsAt,
  replaySwarmEvents,
  extractScreenshotsFromPosts,
  computeSupersededMap,
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
import { runGit, createIsolatedWorktree, landWorktree, removeIsolatedWorktree } from './worktree.js'
import { formatCompactTokens } from './log-export.js'

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
      queue_position: queuePos,
    })
  }

  const annotatedPosts = records.slice(-250).map((rec) => {
    if (!rec || rec.type === 'control') return rec
    const withTitle = rec.title ? rec : { ...rec, title: deriveFallbackTitle(rec.text, rec.kind || 'post') }
    return supersededMap.has(rec.seq)
      ? { ...withTitle, superseded_by: supersededMap.get(rec.seq) }
      : withTitle
  })

  return {
    runtime: typeof runtime.getRuntimeFingerprint === 'function' ? runtime.getRuntimeFingerprint() : null,
    swarm,
    plan,
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
        : { version: '0.4.1', commit: 'HEAD', loaded_at: '' }

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

        for (let i = 0; i < spec.targetNames.length; i += 1) {
          const memberName = spec.targetNames[i]
          const sliceTask = spec.tasks && spec.tasks[i] ? `\n[SHARD_TASK]\n${spec.tasks[i]}` : ''
          const fullBrief = spec.brief + sliceTask

          let worktreeInfo = {
            workspace_mode: 'inherit',
            worktree_path: mainCwd,
            base_commit: null,
            baseline_commit: null,
          }
          if (effectiveWorkspace === 'share' || effectiveWorkspace === 'branch') {
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
            if (worktreeInfo.workspace_mode !== 'inherit' && worktreeInfo.worktree_path) {
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
            if (worktreeInfo.workspace_mode !== 'inherit' && worktreeInfo.worktree_path) {
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

        runtime.notifyProjectionChanged(swarmId)
        const summary = createdRows.map(r => `@${r.name} (role=${r.role}, gate=${r.can_block_merge}, route=${r.provider}/${r.model}, workspace=${r.workspace}, brief=#${r.brief_seq}, live=${r.spawned_live_agent})`).join(', ')
        return {
          ok: true,
          active_members: activeCount,
          llm_slots: llmSlots,
          created: createdRows,
          text: `[swarm_add OK] Spawned and briefed: ${summary}. (active_members=${activeCount} / llm_slots=${llmSlots})`,
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
        supersedes: { type: 'array', items: { type: 'integer' }, description: 'Earlier floor numbers obsoleted by this post.' },
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
          supersedes: val.supersedes,
          escalate: val.escalate,
          silent: val.silent,
          idempotency_key: val.idempotency_key,
          text: finalText,
        })

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

        let consecutiveRejects = 0
        if (postRecord.verdict === 'reject') {
          const activeRej = store.computeActiveRejections(swarmId).find(r => r.reviewer === callerName)
          consecutiveRejects = activeRej?.consecutive_rejects ?? 1
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
          ...(archivePath ? { archive_path: archivePath } : {}),
          ...(releaseHygiene ? { release_hygiene: releaseHygiene } : {}),
          text: `OK #${postRecord.seq} (read=#${postRecord.seq}${notesSuffix})${escalateHumanNote}${hygieneNote}${archiveNote}${fpNote}`,
        }
      })
    },
  })

  const readBoardTool = makeTool({
    name: 'read_board',
    description: 'Read board posts after `since` (default: your last_read_seq). Supports `kinds`, `agent`, `channel`, `limit`, `hide_superseded`.',
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
        const sinceSeq = args && args.since !== undefined && Number.isInteger(Number(args.since)) && Number(args.since) >= 0
          ? Number(args.since)
          : (caller?.last_read_seq ?? 0)

        const allRecords = store.readBoard(swarmId)
        const supersededMap = computeSupersededMap(allRecords)

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

        const annotatedPosts = posts.map((p) => {
          if (!p || p.type === 'control') return p
          const withTitle = p.title ? p : { ...p, title: deriveFallbackTitle(p.text, p.kind || 'post') }
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
          const preview = pending.map(p => `#${p.seq} @${p.agent} (${p.kind}) ${p.title || deriveFallbackTitle(p.text)}\n${p.text}`).join('\n---\n')
          return {
            ok: true,
            status: 'NEW_MESSAGES_ARRIVED',
            posts: pending,
            text: `[swarm_wait BLOCKED] +${pending.length} (#${pending[0].seq}..#${newest}):\n${preview}`,
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
        : { version: '0.4.1', commit: 'HEAD', loaded_at: '' }
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
        ? `Active Merge-Gate Rejections (${snap.activeRejections.length}): ${snap.activeRejections.map(r => `#${r.seq} @${r.reviewer}(${r.role}${r.consecutive_rejects >= 2 ? ', x' + r.consecutive_rejects + ' ESCALATE_TO_HUMAN' : ''}): ${r.title}`).join(', ')}`
        : 'Active Merge-Gate Rejections: none'

      const HIGH_TOOL_CALL_THRESHOLD = 80
      const lines = [
        `Runtime: dsh-swarm v${fp.version} (${fp.commit}) | "${snap.swarm.title}" ${snap.swarm.status} head=#${snap.headSeq}${snap.swarm.project_root ? ' root=' + snap.swarm.project_root : ''}`,
        `LLM In-Flight Slots: ${snap.concurrency.active}/${snap.concurrency.effectiveLimit} (cfg=${snap.concurrency.configuredLimit}, q=${snap.concurrency.queued}, 429=${snap.concurrency.rateLimitHits}) | Members: ${ms.totalActive} active (${ms.working}w/${ms.waiting}idle/${ms.starting}start${ms.unparked_idle ? '/' + ms.unparked_idle + 'unparked' : ''}${ms.zombie ? '/' + ms.zombie + 'zmb' : ''}${ms.error ? '/' + ms.error + 'err' : ''}, ${ms.killed} killed)`,
        wdLine,
        ...(snap.activeRejections.length > 0 ? [rejLine] : []),
        ...snap.members.map(m => {
          const shortLastAt = m.last_tool_call_at ? String(m.last_tool_call_at).slice(11, 19) || m.last_tool_call_at : ''
          const route = `${m.applied_provider || 'inherit'}/${m.applied_model}${m.desired_model !== m.applied_model ? '->' + m.desired_model : ''}`
          const lastTool = shortLastAt ? ` (${m.last_tool_name}@${shortLastAt})` : ''
          const qPart = m.queue_position > 0 ? ` q=#${m.queue_position}` : ''
          const errPart = m.last_error ? ` ERR=${m.last_error.code}:${m.last_error.message}` : ''
          const blkPart = m.last_park_blocked_seq > 0 ? ` blk=#${m.last_park_blocked_seq}` : ''
          const ctxPart = m.context_window > 0 && m.last_input_tokens > 0
            ? ` ctx=${formatCompactTokens(m.last_input_tokens)}/${formatCompactTokens(m.context_window)}(${Math.round((m.last_input_tokens / m.context_window) * 100)}%)`
            : (m.last_input_tokens > 0 ? ` ctx=${formatCompactTokens(m.last_input_tokens)}` : '')
          const stepPart = m.stepSummary && m.status !== 'waiting' && m.status !== 'killed' ? ` | ${m.stepSummary}` : ''
          const budgetWarn = !m.killed && m.tool_call_count >= HIGH_TOOL_CALL_THRESHOLD
            ? ` [BUDGET_WARN: ${m.tool_call_count} tool calls]`
            : ''
          return `  - @${m.name} [${m.role}${m.can_block_merge ? ':gate' : ''}] status=${m.status} ${route} ${m.workspace_mode} t=${m.turn_count} tc=${m.tool_call_count}${ctxPart}${lastTool}${qPart}${errPart} r=#${m.last_read_seq} w=#${m.wait_since} p=#${m.last_post_seq}${blkPart}${stepPart}${budgetWarn}`
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
    description: 'Inspect (`action: "diff"`) or merge (`action: "apply"`) a share/branch worktree member\'s incremental changes back into `project_root` / main workspace. Respects unresolved `[REJECT]` merge gates unless `override_reason` is provided.',
    parameters: {
      properties: {
        name: { type: 'string', description: 'Member name whose worktree to diff or land.' },
        action: { type: 'string', enum: ['diff', 'apply'], description: '"diff" to inspect incremental changes, "apply" to preflight-check and apply onto main workspace.' },
        override_reason: { type: 'string', description: 'Optional PM reason to override an active `[REJECT]` merge gate.' },
      },
      required: ['name', 'action'],
    },
    async execute(args, exec) {
      const { swarmId, callerName, rootAgent } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        const swarmMeta = store.readSwarm(swarmId)
        const members = store.readMembers(swarmId)
        const targetName = String(args?.name ?? '').trim()
        const member = members[targetName]
        if (!member) {
          return { ok: false, text: `[FORMAT_ERROR: swarm_land] Member "@${targetName}" does not exist.` }
        }
        if (member.workspace_mode === 'inherit' || !member.worktree_path) {
          return { ok: true, text: `[swarm_land] @${targetName} uses workspace="inherit"; edits are already in the main workspace.` }
        }

        if (args.action === 'apply') {
          const activeRejections = store.computeActiveRejections(swarmId)
          const overrideReason = typeof args.override_reason === 'string' && args.override_reason.trim()
            ? args.override_reason.trim()
            : null
          if (activeRejections.length > 0 && !overrideReason) {
            const list = activeRejections.map(r => `#${r.seq} by @${r.reviewer} (${r.role}): ${r.title}`).join('; ')
            return {
              ok: false,
              blocked_by_rejections: activeRejections,
              text: `[GATE_BLOCKED: swarm_land] Landing @${targetName} blocked by unresolved rejection(s): [${list}]. Resolve and get verdict="approve", or pass override_reason to override.`,
            }
          }
          if (activeRejections.length > 0 && overrideReason) {
            store.appendBoardRecord(swarmId, {
              type: 'post',
              agent: callerName,
              kind: 'decision',
              verdict: 'override',
              silent: true,
              title: `Gate override: land @${targetName}`,
              text: `[GATE_OVERRIDE] @${callerName} landed @${targetName} overriding rejection(s) ${activeRejections.map(r => '#' + r.seq).join(', ')}: ${overrideReason}`,
            })
          }
        }

        const mainCwd = swarmMeta?.project_root || rootAgent?.session?.header?.cwd || process.cwd()
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
          return {
            ok: true,
            files: res.files,
            text: `[swarm_land DIFF @${targetName}] Changed files (${res.files.length}): ${res.files.join(', ') || 'none'}\n\n${res.patch.slice(0, 6000)}`,
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
    description: 'Retire a Swarm member and delete its isolated worktree. Blocks retiring a currently `working` or `queued` member unless `force: true` is passed (prompting to ask for handover notes / last words if valuable). If the member never started (`turn_count === 0 && last_post_seq === 0`), its name is cleanly released for reuse; otherwise the name stays tombstoned for audit history. Optional `handover_to` records responsibility handover.',
    parameters: {
      properties: {
        name: { type: 'string', description: 'Member name to retire.' },
        force: { type: 'boolean', description: 'Set true to force-kill a running/queued member or discard unmerged worktree edits intentionally.' },
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
              text: `[SAFETY_BLOCK: swarm_kill] @${targetName} still has unmerged worktree changes (${(rmRes.files ?? []).join(', ')}). Run swarm_land({"name": "${targetName}", "action": "apply"}) first, or pass force=true to discard intentionally.`,
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
