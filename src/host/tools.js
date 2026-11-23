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
import { createIsolatedWorktree, landWorktree, removeIsolatedWorktree } from './worktree.js'

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
    return {
      name,
      session_id: m.session_id,
      role: m.role,
      group: m.group,
      parent: m.parent,
      phase: m.phase,
      killed: m.killed === true,
      status: liveness.status,
      stepSummary: liveness.stepSummary,
      desired_model: m.desired_model,
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

      return await store.withLock(swarmId, async () => {
        const { swarm } = store.initSwarm(swarmId, {
          ...check.value,
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
        return {
          ok: true,
          swarm,
          text: `[swarm_init OK] Swarm "${swarm.title}" 已初始化（swarm_id=${swarmId}，并发上限=${swarm.concurrency_limit}，默认路由=${swarm.default_provider}/${swarm.default_model}）。接下来请调用 swarm_plan 写入波次计划，再调用 swarm_add 添加成员。`,
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

          await runtime.spawnMemberAgent({
            swarmId,
            memberName,
            member,
            briefPost,
            fullBrief,
            rootAgent,
          })

          createdRows.push({
            name: memberName,
            role: member.role,
            model: member.applied_model,
            workspace: member.workspace_mode,
            brief_seq: briefPost.seq,
            last_read_seq: member.last_read_seq,
          })
        }

        runtime.notifyProjectionChanged(swarmId)
        const summary = createdRows.map(r => `@${r.name} (role=${r.role}, model=${r.model}, workspace=${r.workspace}, brief=#${r.brief_seq})`).join(', ')
        return {
          ok: true,
          created: createdRows,
          text: `[swarm_add OK] 已创建并派发任务书：${summary}。`,
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

        if (postRecord.kind === 'done' || postRecord.text.includes('[done]')) {
          store.updateSwarm(swarmId, { status: 'DONE' })
        }

        const wokenTargets = await runtime.dispatchPostWakeups(swarmId, postRecord)
        runtime.notifyBoardActivity(swarmId, postRecord)
        runtime.notifyProjectionChanged(swarmId)

        return {
          ok: true,
          seq: postRecord.seq,
          woken: wokenTargets,
          text: `[post_board OK] 已发布到黑板 #${postRecord.seq} (channel=#${postRecord.channel}, 唤醒目标: ${wokenTargets.length > 0 ? wokenTargets.map(n => '@' + n).join(', ') : '无'})。你的 last_read_seq 已更新为 ${postRecord.seq}。若本轮工作已完成，请立即调用 swarm_wait({"since": ${postRecord.seq}, "mentions_only": true}) 进入休眠。`,
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

        return {
          ok: true,
          head_seq: headSeq,
          last_read_seq: newReadSeq,
          count: posts.length,
          posts,
          text: `[read_board OK] 已读至最新楼层 #${newReadSeq}（本次返回 ${posts.length} 条记录）：\n\n${formatted}`,
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
    description: 'Inspect the live Swarm roster, 5 floor cursors, real transcript liveness, and shared concurrency pool usage.',
    isConcurrencySafe: true,
    parameters: {
      properties: {},
    },
    async execute(_args, exec) {
      const { swarmId } = runtime.resolveCaller(exec.agent)
      if (!store.exists(swarmId)) {
        return { ok: false, text: '当前会话尚未启动 Swarm。' }
      }
      const snap = buildSwarmProjectionSnapshot({ store, swarmId, runtime })
      const lines = [
        `Swarm: "${snap.swarm.title}" (status=${snap.swarm.status}, head=#${snap.headSeq})`,
        `Concurrency Pool: ${snap.concurrency.active}/${snap.concurrency.effectiveLimit} active (configured=${snap.concurrency.configuredLimit}, queued=${snap.concurrency.queued}, 429_hits=${snap.concurrency.rateLimitHits})`,
        `Channels: ${snap.channels.map(c => '#' + c).join(', ')}`,
        'Roster:',
        ...snap.members.map(m => (
          `  - @${m.name} [${m.role}] status=${m.status} model=${m.applied_model}${m.desired_model !== m.applied_model ? '->' + m.desired_model : ''} workspace=${m.workspace_mode} cursors(read=#${m.last_read_seq}, wait=#${m.wait_since}, post=#${m.last_post_seq}, blocked=#${m.last_park_blocked_seq}) ${m.stepSummary ? '· ' + m.stepSummary : ''}`
        )),
      ]
      return {
        ok: true,
        snapshot: snap,
        text: lines.join('\n'),
      }
    },
  })

  const swarmModelTool = makeTool({
    name: 'swarm_model',
    description: 'Hot-swap a waiting member to a different model (e.g. between deepseek4.1f and glm5.3), keeping its full conversation history.',
    parameters: {
      properties: {
        name: { type: 'string', description: 'Target member name in members.json.' },
        provider: { type: 'string', description: 'Target provider route (default: internal).' },
        model: { type: 'string', description: 'Target model name (e.g. glm5.3 or deepseek4.1f).' },
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
          text: `[swarm_model OK] @${targetName} 模型已无损热切为 ${nextProvider}/${nextModel}（保留完整对话记忆）。`,
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
