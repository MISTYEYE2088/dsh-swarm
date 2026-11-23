// Model-facing Swarm tools, `/swarm` slash command, and `swarm` SessionProjection.
//
// All tool parameter and output schemas strictly conform to DSH's enforced
// JSON Schema subset (`packages/core/tools/src/json-schema.ts`: only `type`,
// `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`,
// `const`, `description`, `title`, `default`, `examples`).

import { replayChannelsAt, extractScreenshotsFromPosts } from './store.js'
import {
  validateSwarmInit,
  validateSwarmAdd,
  validatePostBoard,
  validateSwarmWait,
  validateSwarmPlan,
} from './validators.js'
import { statusOf, buildSwarmSystemMessage } from './stop-hook.js'
import { runGit, createIsolatedWorktree, landWorktree, removeIsolatedWorktree } from './worktree.js'

const TEXT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
  },
  required: ['ok', 'text'],
})

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
    execute,
  }
}

/** Build the deterministic Overview / Board / Roster / Graph snapshot for the Browser UI. */
export function buildSwarmProjectionSnapshot({ store, swarmId, runtime }) {
  if (!store.exists(swarmId)) return null
  const swarm = store.readSwarm(swarmId)
  const members = store.readMembers(swarmId)
  const records = store.readBoard(swarmId)
  const plan = store.readPlan(swarmId)
  const headSeq = records.length === 0 ? 0 : records[records.length - 1].seq
  const channelState = replayChannelsAt(records, headSeq)

  const memberRows = Object.entries(members).map(([name, m]) => {
    const liveness = runtime.getMemberLiveness(swarmId, name, m)
    const queuePos = runtime.concurrencyGate?.queuePositionOf?.(m.session_id) ?? 0
    return {
      name,
      session_id: m.session_id,
      role: m.role,
      system_builtin: m.system_builtin === true,
      group: m.group,
      parent: m.parent,
      phase: m.last_error ? 'ERROR' : m.phase,
      killed: m.killed === true,
      status: liveness.status,
      stepSummary: liveness.stepSummary,
      desired_provider: m.desired_provider,
      desired_model: m.desired_model,
      applied_provider: m.applied_provider,
      applied_model: m.applied_model,
      workspace_mode: m.workspace_mode,
      worktree_path: m.worktree_path,
      wake_mode: m.wake_mode,
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
      queue_position: queuePos,
    }
  })

  // Compute directed @mention graph edges for every post so the UI Replay slider
  // can filter edges up to any historical `seq <= replaySeq`.
  const edgeEvents = []
  for (const rec of records) {
    if (!rec || rec.type === 'control') continue
    const targets = store.resolveTargetsForPost(swarmId, rec)
    for (const target of targets) {
      edgeEvents.push({
        seq: rec.seq,
        from: rec.agent,
        to: target,
        kind: rec.kind,
      })
    }
  }

  return {
    runtime: typeof runtime.getRuntimeFingerprint === 'function' ? runtime.getRuntimeFingerprint() : null,
    swarm,
    plan,
    headSeq,
    channels: channelState.channels,
    archivedChannels: channelState.archived,
    concurrency: runtime.concurrencyGate.snapshot(),
    members: memberRows,
    posts: records.slice(-250),
    edgeEvents,
    screenshots: extractScreenshotsFromPosts(records),
  }
}

// #FUNC Construct all 9 Swarm model tools with strict format checking and self-healing error templates.
// #NOT  Never throws raw unhandled exceptions for malformed model inputs; returns structured `[FORMAT_ERROR]` payloads so `glm5.3`/`deepseek4.1f` self-corrects.
// #EDGE-IN Calling `swarm_wait` with valid `since` invokes `exec.concludeTurn()` to end the turn at 0 idle token cost → test_swarm_wait_concludes_turn
// #WHY  `concludeTurn` is the native DSH `ToolRunContext` hook that stops `agent-loop` from issuing another LLM request after `swarm_wait` returns `DONE`.
export function createSwarmTools(runtime) {
  const { store, concurrencyGate } = runtime

  const swarmInitTool = makeTool({
    name: 'swarm_init',
    description: 'Initialize or update the Swarm blackboard (swarm.json, board.jsonl, members.json) AFTER asking the user for concurrency_limit and model preference via ask_user_question.',
    parameters: {
      properties: {
        title: { type: 'string', description: 'Short descriptive title for this Swarm.' },
        concurrency_limit: { type: 'integer', description: 'User-confirmed positive integer concurrency limit (e.g. 2, 4, 6, 8, ...).' },
        default_provider: { type: 'string', description: 'Optional registered LLM provider id (default: "inherit" from current session).' },
        default_model: { type: 'string', description: 'Optional model id or "provider/model" (default: "inherit" from current session).' },
        coordinator_model: { type: 'string', description: 'Optional coordinator/monitor model id (default: "inherit" from current session).' },
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
      const gitProbe = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: mainCwd, timeoutMs: 4_000 })
      const gitSupported = gitProbe.ok && gitProbe.stdout.trim() === 'true'
      const isWslUnc = /^\\\\wsl(?:\.localhost|\$)\\/i.test(String(mainCwd))
      const fp = typeof runtime.getRuntimeFingerprint === 'function'
        ? runtime.getRuntimeFingerprint()
        : { version: '0.2.0', commit: 'HEAD', loaded_at: '' }

      return await store.withLock(swarmId, async () => {
        if (store.exists(swarmId) && store.readSwarm(swarmId)?.status === 'DONE') {
          store.archiveSwarm(swarmId, 'before-reinit')
        }
        const { swarm } = store.initSwarm(swarmId, {
          ...check.value,
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
        runtime.ensureMonitorDaemon(swarmId)
        runtime.notifyProjectionChanged(swarmId)

        const envNotes = [
          `[RUNTIME] dsh-swarm v${fp.version} (commit=${fp.commit}, loaded=${fp.loaded_at})`,
          `[WORKSPACE_PREFLIGHT] cwd="${mainCwd}" · git_worktree=${gitSupported ? 'AVAILABLE (可使用 workspace="share"|"branch"|"inherit")' : 'UNAVAILABLE (当前目录非 Git 仓库，所有成员必须使用 workspace="inherit")'}`,
        ]
        if (isWslUnc) {
          envNotes.push(`[WSL_UNC_HINT] 当前工作区为 Windows WSL UNC 路径 (${mainCwd})：DSH 内置的 workflow 工具在 UNC 路径下会因 Win32 GetNamedSecurityInfoW ACL 限制而报错 (worker-exit)。请统一使用 swarm_add 派生进程内 Swarm 成员，并在成员内使用 bash / read / write / edit 工具（bash 会在 WSL Linux 侧正常执行）。`)
        }

        return {
          ok: true,
          swarm,
          git_worktree_available: gitSupported,
          is_wsl_unc: isWslUnc,
          runtime: fp,
          text: `[swarm_init OK] Swarm "${swarm.title}" 已初始化（swarm_id=${swarmId}, gen=${swarm.generation ?? 1}, 并发上限=${swarm.concurrency_limit}, 默认路由=${swarm.default_provider}/${swarm.default_model}）。\n${envNotes.join('\n')}\n接下来请调用 swarm_plan 写入波次计划与拆活矩阵，再调用 swarm_add 添加成员。`,
        }
      })
    },
  })

  const swarmPlanTool = makeTool({
    name: 'swarm_plan',
    description: 'Write or update the static plan.json (goal, waves, tracks) for the deterministic Swarm Overview UI (replaces the token-burning narrator). Max 64 KB.',
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
          return { ok: false, text: '[FORMAT_ERROR: swarm_plan] 请先调用 swarm_init 初始化 Swarm，再调用 swarm_plan。' }
        }
        const plan = store.writePlan(swarmId, check.value)
        runtime.notifyProjectionChanged(swarmId)
        return {
          ok: true,
          plan,
          text: `[swarm_plan OK] plan.json 已更新（当前第 ${plan.current_wave} 波，共 ${plan.tracks.length} 条轨道）。`,
        }
      })
    },
  })

  const swarmAddTool = makeTool({
    name: 'swarm_add',
    description: 'Spawn one named Swarm member (or a numbered group <name>-1..n) with a public 3-part brief ([OWNERSHIP], [FORBIDDEN], [DONE_CRITERIA]) posted to board.jsonl.',
    parameters: {
      properties: {
        name: { type: 'string', description: 'Lowercase member name (a-z, 0-9, -), permanently unique across waves.' },
        role: { type: 'string', enum: ['worker', 'verifier', 'monitor'], description: 'Member role.' },
        workspace: { type: 'string', enum: ['inherit', 'share', 'branch'], description: 'inherit (shared cwd), share (isolated git worktree with dirty sync), or branch.' },
        brief: { type: 'string', description: 'Public brief MUST include [OWNERSHIP], [FORBIDDEN], and [DONE_CRITERIA].' },
        provider: { type: 'string', description: 'Optional provider override.' },
        model: { type: 'string', description: 'Optional model override (e.g. deepseek4.1f or glm5.3).' },
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
        const mainCwd = rootAgent?.session?.header?.cwd ?? process.cwd()

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
          if (spec.workspace === 'share' || spec.workspace === 'branch') {
            const wtRes = await createIsolatedWorktree({
              mainCwd,
              worktreesRoot: runtime.worktreesRoot,
              swarmId,
              memberName,
              mode: spec.workspace,
            })
            if (!wtRes.ok) {
              return { ok: false, text: `[WORKTREE_ERROR: swarm_add] 为 @${memberName} 创建隔离工作区失败: ${wtRes.error}` }
            }
            worktreeInfo = wtRes
          }

          const sessionId = `${swarmId}__${memberName}`
          const { member, briefPost } = store.registerMemberWithBrief(swarmId, {
            name: memberName,
            session_id: sessionId,
            role: spec.role,
            group: spec.group,
            parent: spec.parent,
            provider: spec.provider,
            model: spec.model,
            workspace_mode: worktreeInfo.workspace_mode,
            worktree_path: worktreeInfo.worktree_path,
            base_commit: worktreeInfo.base_commit,
            baseline_tree: worktreeInfo.baseline_commit,
            fork_from: spec.fork,
            brief: fullBrief,
          })

          const handle = await runtime.spawnMemberAgent({
            swarmId,
            memberName,
            member,
            briefPost,
            fullBrief,
            rootAgent,
          })

          // R2: Give the newly steered child turn a brief settle window (100ms) so fast
          // synchronous/adapter errors (like NO_ADAPTER which fails in ~14ms) are caught immediately!
          if (handle) {
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          const latestMember = store.readMembers(swarmId)[memberName] ?? member
          if (latestMember.last_error) {
            runtime.notifyProjectionChanged(swarmId)
            return {
              ok: false,
              error: latestMember.last_error,
              text: `[SPAWN_RUNTIME_ERROR: swarm_add] 成员 @${memberName} 已创建但首轮启动即发生错误 (${latestMember.last_error.code}: ${latestMember.last_error.message})！请检查模型路由 (${latestMember.applied_provider}/${latestMember.applied_model})，调用 swarm_model 切换为当前会话可用模型或降级回单 Agent 处理，切勿调用 swarm_wait 死等！`,
            }
          }

          createdRows.push({
            name: memberName,
            session_id: latestMember.session_id,
            role: latestMember.role,
            provider: latestMember.applied_provider,
            model: latestMember.applied_model,
            workspace: latestMember.workspace_mode,
            brief_seq: briefPost.seq,
            last_read_seq: latestMember.last_read_seq,
            spawned_live_agent: Boolean(handle),
            turn_count: latestMember.turn_count ?? 0,
          })
        }

        runtime.notifyProjectionChanged(swarmId)
        const summary = createdRows.map(r => `@${r.name} (role=${r.role}, route=${r.provider}/${r.model}, workspace=${r.workspace}, brief=#${r.brief_seq}, live=${r.spawned_live_agent})`).join(', ')
        return {
          ok: true,
          created: createdRows,
          text: `[swarm_add OK] 已创建并启动任务书：${summary}。`,
        }
      })
    },
  })

  const postBoardTool = makeTool({
    name: 'post_board',
    description: 'Post a message to the shared board.jsonl (or create/subscribe a #channel) and automatically wake @mentioned members. Always cite floor numbers like #5 instead of copy-pasting.',
    isConcurrencySafe: true,
    parameters: {
      properties: {
        text: { type: 'string', description: 'Markdown message body (6..4000 chars). Use #seq to cite earlier floors and @name to wake recipients.' },
        mentions: { type: 'array', items: { type: 'string' }, description: 'Target member names (e.g. ["verifier"] or ["coordinator"]).' },
        refs: { type: 'array', items: { type: 'integer' }, description: 'Referenced floor numbers (e.g. [5, 6]).' },
        channel: { type: 'string', description: 'Target channel (default: "main").' },
        kind: { type: 'string', enum: ['brief', 'report', 'question', 'review', 'decision', 'alert', 'done'], description: 'Semantic kind of post.' },
        control_action: { type: 'string', enum: ['channel.create', 'channel.subscribe', 'channel.unsubscribe', 'channel.archive'], description: 'Optional event-sourced channel control operation.' },
        control_target: { type: 'string', description: 'Optional member name for channel.subscribe / channel.unsubscribe.' },
      },
      required: ['text'],
    },
    async execute(args, exec) {
      const { swarmId, callerName } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        if (!store.exists(swarmId)) {
          return { ok: false, text: '[FORMAT_ERROR: post_board] Swarm 尚未初始化，请先调用 swarm_init。' }
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
            text: `[post_board CONTROL OK] 已写入频道控制帧 #${ctrlRec.seq} (${ctrlRec.action} #${ctrlRec.channel})。`,
          }
        }

        const check = validatePostBoard(args, existingMembers, callerName, channelState.channels)
        if (!check.ok) return { ok: false, text: check.error }

        const postRecord = store.appendBoardRecord(swarmId, {
          type: 'post',
          agent: callerName,
          ...check.value,
        })

        let archivePath = null
        if (postRecord.kind === 'done' || postRecord.text.includes('[done]')) {
          store.updateSwarm(swarmId, { status: 'DONE' })
          archivePath = store.archiveSwarm(swarmId, 'done')
        }

        const wokenTargets = await runtime.dispatchPostWakeups(swarmId, postRecord)
        const unreachableTargets = wokenTargets.unreachable ?? []
        runtime.notifyBoardActivity(swarmId, postRecord)
        runtime.notifyProjectionChanged(swarmId)

        const wakeNote = wokenTargets.length > 0
          ? `实际唤醒: ${wokenTargets.map(n => '@' + n).join(', ')}`
          : '无成员被唤醒（本帖未触发任何活跃实例唤醒）'
        const unreachableNote = unreachableTargets.length > 0
          ? `；未唤醒(无存活实例): ${unreachableTargets.map(n => '@' + n).join(', ')}`
          : ''
        const archiveNote = archivePath
          ? `\n[SWARM_ARCHIVED] 本场 Swarm 完整现场（board.jsonl / members.json / swarm.json / plan.json）已持久化归档至：${archivePath}`
          : ''
        const fp = typeof runtime.getRuntimeFingerprint === 'function' ? runtime.getRuntimeFingerprint() : null
        const fpNote = (archivePath && fp) ? `\n[RUNTIME] dsh-swarm v${fp.version} (commit=${fp.commit}, loaded=${fp.loaded_at})` : ''

        return {
          ok: true,
          seq: postRecord.seq,
          woken: wokenTargets,
          unreachable: unreachableTargets,
          ...(archivePath ? { archive_path: archivePath } : {}),
          text: `[post_board OK] 已发布到黑板 #${postRecord.seq} (channel=#${postRecord.channel}, ${wakeNote}${unreachableNote})。你的 last_read_seq 已更新为 ${postRecord.seq}。${archiveNote}${fpNote}${!archivePath ? ` 若本轮工作已完成，请立即调用 swarm_wait({"since": ${postRecord.seq}, "mentions_only": true}) 进入休眠。` : ''}`,
        }
      })
    },
  })

  const readBoardTool = makeTool({
    name: 'read_board',
    description: 'Read new messages from board.jsonl after `since` (defaults to your last_read_seq) and advance your last_read_seq cursor.',
    isConcurrencySafe: true,
    parameters: {
      properties: {
        since: { type: 'integer', description: 'Floor seq after which to read (0 reads from the start).' },
        channel: { type: 'string', description: 'Optional channel filter.' },
        mentions_only: { type: 'boolean', description: 'If true, only return posts that @mentioned you.' },
      },
    },
    async execute(args, exec) {
      const { swarmId, callerName } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        if (!store.exists(swarmId)) {
          return { ok: false, text: '[FORMAT_ERROR: read_board] Swarm 尚未初始化。' }
        }
        const members = store.readMembers(swarmId)
        const caller = members[callerName]
        const sinceSeq = args && Number.isInteger(Number(args.since)) && Number(args.since) >= 0
          ? Number(args.since)
          : (caller?.last_read_seq ?? 0)

        let posts = store.queryVisiblePosts(swarmId, callerName, sinceSeq, {
          mentionsOnly: args?.mentions_only === true,
        })
        if (args?.channel) {
          const ch = String(args.channel).replace(/^#/, '')
          posts = posts.filter(p => (p.channel || 'main') === ch)
        }

        const headSeq = store.headSeq(swarmId)
        const newReadSeq = Math.max(caller?.last_read_seq ?? 0, headSeq)
        if (caller) {
          store.updateMember(swarmId, callerName, m => ({
            ...m,
            last_read_seq: newReadSeq,
          }))
        }
        runtime.notifyProjectionChanged(swarmId)

        const formatted = posts.length === 0
          ? `(自 #${sinceSeq} 以来没有新帖子；当前黑板最新楼层为 #${headSeq})`
          : posts.map(p => (
              p.type === 'control'
                ? `#${p.seq} [CONTROL ${p.time}] @${p.agent}: ${p.action} #${p.channel} ${p.target ? '-> @' + p.target : ''}`
                : `#${p.seq} [${p.time}] [#${p.channel || 'main'}] @${p.agent} (${p.kind}):\n${p.text}`
            )).join('\n\n---\n\n')

        const swarmMeta = store.readSwarm(swarmId)
        return {
          ok: true,
          swarm_id: swarmId,
          generation: swarmMeta?.generation ?? 1,
          head_seq: headSeq,
          last_read_seq: newReadSeq,
          count: posts.length,
          posts,
          text: `[read_board OK] (swarm_id=${swarmId}, gen=${swarmMeta?.generation ?? 1}) 已读至最新楼层 #${newReadSeq}（本次返回 ${posts.length} 条记录）：\n\n${formatted}`,
        }
      })
    },
  })

  const swarmWaitTool = makeTool({
    name: 'swarm_wait',
    description: 'End your current turn and sleep on the board at 0 token cost until a new message mentions you. You MUST pass `since` <= your actual `last_read_seq`.',
    parameters: {
      properties: {
        since: { type: 'integer', description: 'The latest floor seq you have actually read via read_board.' },
        mentions_only: { type: 'boolean', description: 'True (default) wakes only on @name / @group / @#channel / @all; false wakes on any new post.' },
      },
      required: ['since'],
    },
    async execute(args, exec) {
      const { swarmId, callerName } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        if (!store.exists(swarmId)) {
          return { ok: false, text: '[FORMAT_ERROR: swarm_wait] Swarm 尚未初始化。' }
        }
        const members = store.readMembers(swarmId)
        const member = members[callerName]
        const headSeq = store.headSeq(swarmId)
        const check = validateSwarmWait(args, member, headSeq)
        if (!check.ok) return { ok: false, text: check.error }

        const { since, mentions_only } = check.value
        const pending = store.queryVisiblePosts(swarmId, callerName, since, {
          mentionsOnly: mentions_only,
        })

        // If matching posts already arrived after `since`, do NOT sleep — return them right now!
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
          const preview = pending.map(p => `#${p.seq} @${p.agent}: ${p.text}`).join('\n---\n')
          return {
            ok: true,
            status: 'NEW_MESSAGES_ARRIVED',
            posts: pending,
            text: `[swarm_wait BLOCKED] 在 #${since} 之后已有 ${pending.length} 条新消息到达（最新 #${newest}），已取消休眠并为你直接加载：\n\n${preview}\n\n请处理这些新消息后再调用 swarm_wait({"since": ${newest}})。`,
          }
        }

        // Otherwise, park the member at 0 token cost and conclude the turn immediately!
        if (member) {
          store.updateMember(swarmId, callerName, m => ({
            ...m,
            wait_since: since,
            wake_mode: mentions_only ? 'mentions' : 'anything',
          }))
        }
        runtime.markTurnParked(exec.agent?.id)
        if (typeof exec?.concludeTurn === 'function') {
          exec.concludeTurn()
        }
        runtime.notifyProjectionChanged(swarmId)

        return {
          ok: true,
          status: 'DONE',
          parked_at_seq: since,
          wake_mode: mentions_only ? 'mentions' : 'anything',
          text: `DONE (parked on board since #${since}, wake_mode=${mentions_only ? 'mentions' : 'anything'}, 0 token standby)`,
        }
      })
    },
  })

  const swarmStatusTool = makeTool({
    name: 'swarm_status',
    description: 'Inspect the live Swarm roster, runtime version fingerprint (R0), 5 floor cursors, turn_count / last_tool_call_at / last_error telemetry, and shared concurrency pool usage.',
    isConcurrencySafe: true,
    parameters: {
      properties: {},
    },
    async execute(_args, exec) {
      const { swarmId } = runtime.resolveCaller(exec.agent)
      const fp = typeof runtime.getRuntimeFingerprint === 'function'
        ? runtime.getRuntimeFingerprint()
        : { version: '0.2.0', commit: 'HEAD', loaded_at: '' }
      if (!store.exists(swarmId)) {
        return {
          ok: false,
          runtime: fp,
          text: `当前会话尚未启动 Swarm。[Runtime: dsh-swarm v${fp.version} @ ${fp.commit}, loaded=${fp.loaded_at}]`,
        }
      }
      const snap = buildSwarmProjectionSnapshot({ store, swarmId, runtime })
      const lines = [
        `Runtime: dsh-swarm v${fp.version} (commit=${fp.commit}, loaded=${fp.loaded_at})`,
        `Swarm: "${snap.swarm.title}" (id=${swarmId}, gen=${snap.swarm.generation ?? 1}, status=${snap.swarm.status}, head=#${snap.headSeq})`,
        `Concurrency Pool: ${snap.concurrency.active}/${snap.concurrency.effectiveLimit} active (configured=${snap.concurrency.configuredLimit}, queued=${snap.concurrency.queued}, 429_hits=${snap.concurrency.rateLimitHits})`,
        `Channels: ${snap.channels.map(c => '#' + c).join(', ')}`,
        'Roster:',
        ...snap.members.map(m => (
          `  - @${m.name} [${m.role}${m.system_builtin ? ':builtin' : ''}] status=${m.status} route=${m.applied_provider || 'inherit'}/${m.applied_model}${m.desired_model !== m.applied_model ? '->' + m.desired_model : ''} workspace=${m.workspace_mode} telemetry(turns=${m.turn_count}, tools=${m.tool_call_count}${m.last_tool_call_at ? ', last_tool=' + m.last_tool_name + '@' + m.last_tool_call_at : ''}${m.queue_position > 0 ? ', queue=#' + m.queue_position : ''}${m.last_error ? ', ERROR=' + m.last_error.code + ':' + m.last_error.message : ''}) cursors(read=#${m.last_read_seq}, wait=#${m.wait_since}, post=#${m.last_post_seq}, nudged=#${m.last_nudged_seq}, blocked=#${m.last_park_blocked_seq}) ${m.stepSummary ? '· ' + m.stepSummary : ''}`
        )),
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
        provider: { type: 'string', description: 'Target registered provider route (or "inherit" to use parent session provider).' },
        model: { type: 'string', description: 'Target model id or "<provider>/<model>" (or "inherit" to use parent session model).' },
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
          return { ok: false, text: `[FORMAT_ERROR: swarm_model] 成员 "@${targetName}" 不存在或已销毁。` }
        }
        if (callerName !== 'coordinator' && target.parent !== callerName && callerName !== targetName) {
          return { ok: false, text: `[PERMISSION_ERROR: swarm_model] @${callerName} 无权切换 @${targetName} 的模型。` }
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
          text: `[swarm_model OK] @${targetName} 模型已热切为 ${swapped.provider}/${swapped.model} (member_alive=${swapped.member_alive === true}, turn_count=${swapped.turn_count ?? 0}, last_turn_at=${swapped.last_turn_at ?? 'none'})。`,
        }
      })
    },
  })

  const swarmLandTool = makeTool({
    name: 'swarm_land',
    description: 'Inspect (`action: "diff"`) or merge (`action: "apply"`) a share/branch worktree member\'s incremental changes back into the main workspace.',
    parameters: {
      properties: {
        name: { type: 'string', description: 'Member name whose worktree to diff or land.' },
        action: { type: 'string', enum: ['diff', 'apply'], description: '"diff" to inspect incremental changes, "apply" to preflight-check and apply onto main workspace.' },
      },
      required: ['name', 'action'],
    },
    async execute(args, exec) {
      const { swarmId, rootAgent } = runtime.resolveCaller(exec.agent)
      const members = store.readMembers(swarmId)
      const targetName = String(args?.name ?? '').trim()
      const member = members[targetName]
      if (!member) {
        return { ok: false, text: `[FORMAT_ERROR: swarm_land] 成员 "@${targetName}" 不存在。` }
      }
      if (member.workspace_mode === 'inherit' || !member.worktree_path) {
        return { ok: true, text: `[swarm_land] @${targetName} 使用的是 inherit 共享工作区，修改已直接在主工作区中，无需合并。` }
      }
      const mainCwd = rootAgent?.session?.header?.cwd ?? process.cwd()
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
          text: `[swarm_land DIFF @${targetName}] 变更文件 (${res.files.length}): ${res.files.join(', ') || '无'}\n\n${res.patch.slice(0, 6000)}`,
        }
      }
      // Mark worktree as clean/landed after apply so swarm_kill is allowed
      store.updateMember(swarmId, targetName, m => ({ ...m, landed: true }))
      runtime.notifyProjectionChanged(swarmId)
      return {
        ok: true,
        files: res.files,
        text: `[swarm_land APPLY OK] @${targetName}: ${res.message}`,
      }
    },
  })

  const swarmKillTool = makeTool({
    name: 'swarm_kill',
    description: 'Permanently retire a Swarm member, lock its name in members.json, and delete its isolated worktree (refuses if unmerged changes remain unless force=true).',
    parameters: {
      properties: {
        name: { type: 'string', description: 'Member name to permanently retire.' },
        force: { type: 'boolean', description: 'Set true only to discard unmerged worktree edits intentionally.' },
      },
      required: ['name'],
    },
    async execute(args, exec) {
      const { swarmId, callerName, rootAgent } = runtime.resolveCaller(exec.agent)
      return await store.withLock(swarmId, async () => {
        const members = store.readMembers(swarmId)
        const targetName = String(args?.name ?? '').trim()
        const target = members[targetName]
        if (!target) {
          return { ok: false, text: `[FORMAT_ERROR: swarm_kill] 成员 "@${targetName}" 不存在。` }
        }
        if (targetName === 'coordinator') {
          return { ok: false, text: '[FORMAT_ERROR: swarm_kill] 不能销毁 coordinator 主会话。' }
        }
        if (target.killed) {
          return { ok: true, text: `[swarm_kill] @${targetName} 已经是 killed 状态。` }
        }
        if (callerName !== 'coordinator' && target.parent !== callerName) {
          return {
            ok: false,
            text: `[PERMISSION_ERROR: swarm_kill] 权限拒绝：@${callerName} 只能销毁自己招的帮手，无权销毁 @${targetName}（由 @${target.parent} 创建）。`,
          }
        }

        const mainCwd = rootAgent?.session?.header?.cwd ?? process.cwd()
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
              text: `[SAFETY_BLOCK: swarm_kill] 成员 @${targetName} 的独立工作区还有未合并的修改 (${(rmRes.files ?? []).join(', ')})！直接 kill 会永久删除其代码。\n请先调用 swarm_land({"name": "${targetName}", "action": "apply"}) 合并代码，或确认废弃后传 {"name": "${targetName}", "force": true}。`,
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
        store.updateMember(swarmId, targetName, m => ({
          ...m,
          desired_state: 'KILLED',
          phase: 'KILLED',
          killed: true,
        }))
        runtime.notifyProjectionChanged(swarmId)

        return {
          ok: true,
          text: `[swarm_kill OK] 成员 @${targetName} 已永久退役并清理工作区（名字 "${targetName}" 已永久锁死不可复用）。`,
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
    swarmLandTool,
    swarmKillTool,
  ]
}

/** Register the human `/swarm` slash command on `ctx.commands`. */
export function createSwarmCommand(runtime) {
  return {
    definitionId: 'dsh-swarm',
    name: 'swarm',
    description: 'Start or inspect a multi-agent blackboard Swarm (/swarm <task>, /swarm status, /swarm concurrency <N>)',
    input: {
      hint: '[<task> | status | board | concurrency <N>]',
      attachments: true,
    },
    async handler(invocation) {
      const raw = String(invocation.rawInput ?? '').trim()
      const agent = invocation.agent
      const swarmId = agent.id
      const { store, concurrencyGate } = runtime

      if (raw === 'status' || raw === 'board') {
        if (!store.exists(swarmId)) {
          return { kind: 'success', text: '当前会话尚未启动 Swarm。使用 `/swarm <任务描述>` 启动。' }
        }
        const snap = buildSwarmProjectionSnapshot({ store, swarmId, runtime })
        return {
          kind: 'success',
          text: `🐝 Swarm "${snap.swarm.title}" (${snap.swarm.status}) · 并发槽: ${snap.concurrency.active}/${snap.concurrency.effectiveLimit} (排队 ${snap.concurrency.queued}) · 黑板共 #${snap.headSeq} 帖`,
        }
      }

      const concMatch = /^concurrency\s+(\d+)$/i.exec(raw)
      if (concMatch) {
        const limit = Number(concMatch[1])
        if (!Number.isInteger(limit) || limit < 1) {
          return { kind: 'error', text: '并发上限必须是 >= 1 的正整数。' }
        }
        concurrencyGate.setLimit(limit)
        if (store.exists(swarmId)) {
          store.updateSwarm(swarmId, { concurrency_limit: limit, concurrency_confirmed: true })
          runtime.notifyProjectionChanged(swarmId)
        }
        return { kind: 'success', text: `[dsh-swarm] 已将并发上限热更新为 ${limit}。` }
      }

      // Default: `/swarm <task>` — initialize unconfirmed swarm entry and steer the Coordinator
      // to ask the user for concurrency_limit and model preference first!
      const discovered = typeof runtime.discoverAvailableModels === 'function'
        ? await runtime.discoverAvailableModels(agent)
        : { parentRoute: { provider: 'inherit', model: 'inherit' }, routes: [] }
      const currentRouteText = discovered.parentRoute?.provider && discovered.parentRoute?.model
        ? `${discovered.parentRoute.provider}/${discovered.parentRoute.model}`
        : 'inherit'
      const availableRoutesList = Array.isArray(discovered.routes) && discovered.routes.length > 0
        ? discovered.routes.slice(0, 12).map(r => `${r.provider}/${r.model}`).join(', ')
        : currentRouteText

      await store.withLock(swarmId, async () => {
        if (!store.exists(swarmId)) {
          store.initSwarm(swarmId, {
            title: raw.slice(0, 60) || 'Swarm Task',
            concurrency_confirmed: false,
            concurrency_limit: runtime.settings.defaultConcurrency,
            default_provider: discovered.parentRoute?.provider || 'inherit',
            default_model: discovered.parentRoute?.model || 'inherit',
            coordinator_model: discovered.parentRoute?.model || 'inherit',
          })
        }
      })
      runtime.activateCoordinatorMode(agent)
      runtime.notifyProjectionChanged(swarmId)

      const kickoffPrompt = [
        `[USER INVOKED /swarm]`,
        `任务目标：${raw || '请协助完成任务'}`,
        ``,
        `【当前 DSH 环境真实模型路由信息（严禁硬编码或捏造 provider="internal"！）】`,
        `- 当前主会话正在使用的模型：\`${currentRouteText}\``,
        `- 当前 DSH 已注册可用模型路由：\`${availableRoutesList}\``,
        ``,
        `【强制第一步】在调用 swarm_add 创建任何成员之前，你必须立即先调用 ask_user_question 询问用户：`,
        `1. 本次希望使用的并发槽位数（如 4 / 6 / 2 / 8 或自定义）；`,
        `2. 本次子成员希望使用的模型偏好（第一项推荐 "沿用当前会话模型 (${currentRouteText}) (Recommended)"，并将上述已注册可用模型列为选项，允许用户在 Other 中输入任意可用模型）。`,
        ``,
        `【拆解任务铁律】严禁为了凑并行人数把一个完整需求拆成多个毫无关联的小玩具（例如不要把“做一个游戏 Demo”拆成贪吃蛇+打砖块+翻牌三个无关游戏）！所有 Worker 必须围绕**同一个核心目标/系统**的正交子模块或不同排查线协同，并配备独立 @verifier 交叉实测打回返工！`,
      ].join('\n')
      agent.steer(buildSwarmSystemMessage(kickoffPrompt, 'Swarm kickoff'))
      return {
        kind: 'success',
        text: `🐝 已进入 Swarm 协调模式（当前会话模型: ${currentRouteText}），正在向您确认本次任务的并发数与模型偏好...`,
      }
    },
  }
}
