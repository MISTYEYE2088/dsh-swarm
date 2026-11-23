// dsh-swarm Host half (Node ESM entry).
//
// Coordinates:
//   1. Three-file plain-text blackboard (`swarm.json`, `board.jsonl`, `members.json`) + `plan.json`
//   2. Polite shared-cluster `ConcurrencyGate` on `llm/stream` (1..6 cap, P0..P3 priority, AIMD on 429)
//   3. Zero-idle-token `swarm_wait` (`concludeTurn`) + `agent/turn-stopping` Stop-Hook race lock
//   4. Anti-deadlock `@monitor` daemon timer (3-minute ticks, `last_post_seq` check, 5-tick auto-sleep)
//   5. Strict format & semantic validators + detailed SOP prompts for self-hosted `glm5.3` / `deepseek4.1f`
//   6. Live `swarm` SessionProjection for the deterministic Browser Hive UI (no token-burning narrator)
//
// Boot safety rule (host-plugin-reference.md §3 & §9):
//   - Deliberately exports NO `Config` (Cordis validates `Config` as a Standard Schema;
//     a plain object throws `Cannot read properties of undefined (reading 'validate')` and breaks boot).
//   - No top-level side effects.
//   - `apply(ctx, config)` wraps `applyWith(ctx, config)` in `try/catch` so an unexpected
//     runtime failure never costs the user their DSH profile.

import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { SwarmStore, defaultSwarmRoot } from './src/host/store.js'
import { ConcurrencyGate, PRIORITY, isConcurrencyFailure } from './src/host/concurrency-gate.js'
import { handleTurnStopping, statusOf, buildSwarmSystemMessage } from './src/host/stop-hook.js'
import { SwarmMonitorDaemon } from './src/host/monitor.js'
import { renderRolePrompt, COORDINATOR_SOP_PROMPT } from './src/host/prompts.js'
import { createSwarmTools, createSwarmCommand, buildSwarmProjectionSnapshot } from './src/host/tools.js'

export {
  SwarmStore,
  ConcurrencyGate,
  PRIORITY,
  handleTurnStopping,
  statusOf,
  SwarmMonitorDaemon,
  renderRolePrompt,
  createSwarmTools,
  buildSwarmProjectionSnapshot,
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-swarm'

const DEFAULTS = Object.freeze({
  enabled: true,
  defaultConcurrency: 4,
  minSpacingMs: 200,
  agingThresholdMs: 15_000,
  monitorIntervalMs: 180_000,
  defaultProvider: 'inherit',
  defaultModel: 'inherit',
  coordinatorModel: 'inherit',
  swarmDir: '',
  worktreesDir: '',
})

function mergeSettings(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (src[key] !== undefined) merged[key] = src[key]
  }
  merged.defaultConcurrency = Math.max(1, Math.floor(Number(merged.defaultConcurrency) || 4))
  return merged
}

/** Read and parse a JSON HTTP request body (up to 128 KB). */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > 131_072) {
        reject(new Error('Payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** Write a JSON HTTP response with status code. */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** Build the `/api/dsh-swarm/state` and `/api/dsh-swarm/action` route definitions for `webServer`. */
export function createSwarmWebRoutes(runtime) {
  const { store, concurrencyGate } = runtime
  return [
    {
      kind: 'exact',
      path: '/api/dsh-swarm/state',
      async handler(req, res) {
        try {
          const url = new URL(req.url ?? '/api/dsh-swarm/state', 'http://127.0.0.1')
          const requestedSessionId = url.searchParams.get('sessionId') || ''
          const explicitSwarmId = url.searchParams.get('swarmId') || ''
          const resolvedSwarmId = (explicitSwarmId && store.exists(explicitSwarmId))
            ? explicitSwarmId
            : store.resolveSwarmId(requestedSessionId)
          const snapshot = resolvedSwarmId
            ? buildSwarmProjectionSnapshot({ store, swarmId: resolvedSwarmId, runtime })
            : null
          sendJson(res, 200, {
            ok: true,
            requestedSessionId,
            resolvedSwarmId,
            swarms: store.listSwarms(),
            concurrency: concurrencyGate.snapshot(),
            snapshot,
          })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-swarm/action',
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method Not Allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const action = String(body.action ?? '').trim()
          const targetSwarmId = (body.swarmId && store.exists(body.swarmId))
            ? String(body.swarmId)
            : (store.resolveSwarmId(body.sessionId || body.swarmId) || String(body.swarmId || body.sessionId || 'default-swarm'))

          if (action === 'init') {
            const limit = Math.max(1, Math.floor(Number(body.concurrency_limit) || runtime.settings.defaultConcurrency))
            const title = String(body.title || 'Swarm Task').trim().slice(0, 120) || 'Swarm Task'
            await store.withLock(targetSwarmId, async () => {
              store.initSwarm(targetSwarmId, {
                title,
                concurrency_limit: limit,
                concurrency_confirmed: true,
              })
            })
            concurrencyGate.setLimit(limit)
            runtime.ensureMonitorDaemon(targetSwarmId)
            runtime.notifyProjectionChanged(targetSwarmId)
            sendJson(res, 200, {
              ok: true,
              resolvedSwarmId: targetSwarmId,
              snapshot: buildSwarmProjectionSnapshot({ store, swarmId: targetSwarmId, runtime }),
            })
            return
          }

          if (action === 'concurrency') {
            const limit = Math.floor(Number(body.limit))
            if (!Number.isInteger(limit) || limit < 1) {
              sendJson(res, 400, { ok: false, error: '并发数必须是 >= 1 的正整数' })
              return
            }
            concurrencyGate.setLimit(limit)
            if (store.exists(targetSwarmId)) {
              await store.withLock(targetSwarmId, async () => {
                store.updateSwarm(targetSwarmId, {
                  concurrency_limit: limit,
                  concurrency_confirmed: true,
                })
              })
              runtime.notifyProjectionChanged(targetSwarmId)
            }
            sendJson(res, 200, {
              ok: true,
              concurrency: concurrencyGate.snapshot(),
              snapshot: store.exists(targetSwarmId)
                ? buildSwarmProjectionSnapshot({ store, swarmId: targetSwarmId, runtime })
                : null,
            })
            return
          }

          if (action === 'post') {
            const text = String(body.text ?? '').trim()
            if (!text) {
              sendJson(res, 400, { ok: false, error: '消息内容不能为空' })
              return
            }
            const result = await store.withLock(targetSwarmId, async () => {
              if (!store.exists(targetSwarmId)) {
                store.initSwarm(targetSwarmId, {
                  title: 'Swarm Task',
                  concurrency_limit: runtime.settings.defaultConcurrency,
                  concurrency_confirmed: true,
                })
              }
              const postRecord = store.appendBoardRecord(targetSwarmId, {
                type: 'post',
                agent: String(body.agent || 'coordinator'),
                actor_kind: 'HUMAN',
                channel: String(body.channel || 'main'),
                kind: String(body.kind || 'decision'),
                mentions: Array.isArray(body.mentions) ? body.mentions : undefined,
                text,
              })
              const woken = await runtime.dispatchPostWakeups(targetSwarmId, postRecord)
              runtime.notifyBoardActivity(targetSwarmId, postRecord)
              runtime.notifyProjectionChanged(targetSwarmId)
              return { postRecord, woken }
            })
            sendJson(res, 200, {
              ok: true,
              post: result.postRecord,
              woken: result.woken,
              snapshot: buildSwarmProjectionSnapshot({ store, swarmId: targetSwarmId, runtime }),
            })
            return
          }

          sendJson(res, 400, { ok: false, error: `Unknown action "${action}"` })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    },
  ]
}

// dup-ok: strict inner host mount implementation paired with boot-safe outer apply()
// #FUNC Wire the Swarm blackboard, concurrency gate, stop hook, tools, commands, and projection into a Cordis Context.
// #NOT  Does not export a plain-object `Config`, and does not poll sleeping agents.
// #EDGE-IN Sibling `session/event` dispatch records transcript events for `statusOf()` liveness → test_host_sibling_event_liveness
// #WHY  `turnStates` tracks whether an active agent turn invoked `swarm_wait` so `handleTurnStopping` can intercept `glm5.3`/`deepseek4.1f` turns that forget to park.
export function applyWith(ctx, config, deps = {}) {
  const settings = mergeSettings(config)
  const log = deps.log ?? ((...args) => console.info('[dsh-swarm]', ...args))
  const warn = deps.warn ?? ((message) => console.warn('[dsh-swarm] ' + message))

  if (settings.enabled !== true) {
    log('disabled by config')
    return null
  }

  const swarmRoot = settings.swarmDir || deps.swarmDir || defaultSwarmRoot()
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const worktreesRoot = settings.worktreesDir || deps.worktreesDir || path.join(dshHome, 'swarm-worktrees')

  const store = deps.store ?? new SwarmStore(swarmRoot)
  const disposers = []
  const sessionEventsByAgent = new Map() // sessionId -> recent SessionEvent[]
  const memberHandles = new Map() // `${swarmId}:${memberName}` -> AgentHandle
  const agentMembership = new Map() // agentSessionId -> { swarmId, memberName, role }
  const turnStates = new Map() // agentSessionId -> { calledSwarmWait: boolean, unparkedBlockCount: number }
  const monitorDaemons = new Map() // swarmId -> SwarmMonitorDaemon

  const concurrencyGate = deps.concurrencyGate ?? new ConcurrencyGate({
    limit: settings.defaultConcurrency,
    minSpacingMs: settings.minSpacingMs,
    agingThresholdMs: settings.agingThresholdMs,
    onChange: () => {
      for (const swarmId of monitorDaemons.keys()) {
        runtime.notifyProjectionChanged(swarmId)
      }
    },
  })

  const runtime = {
    settings,
    store,
    worktreesRoot,
    concurrencyGate,
    sessionEventsByAgent,
    memberHandles,
    agentMembership,
    turnStates,
    monitorDaemons,

    resolveCaller(agent) {
      const id = agent?.id ?? 'default-swarm'
      const mapped = agentMembership.get(id)
      if (mapped) {
        const rootAgent = ctx.get?.('agents')?.get?.(mapped.swarmId) ?? agent
        return {
          swarmId: mapped.swarmId,
          callerName: mapped.memberName,
          role: mapped.role,
          rootAgent,
        }
      }
      const parentId = agent?.session?.header?.parentSession
      if (parentId && store.exists(parentId)) {
        const members = store.readMembers(parentId)
        for (const [mName, m] of Object.entries(members)) {
          if (m.session_id === id) {
            const rootAgent = ctx.get?.('agents')?.get?.(parentId) ?? agent
            return { swarmId: parentId, callerName: mName, role: m.role, rootAgent }
          }
        }
      }
      return {
        swarmId: id,
        callerName: 'coordinator',
        role: 'coordinator',
        rootAgent: agent,
      }
    },

    getMemberLiveness(swarmId, memberName, memberRecord) {
      const m = memberRecord ?? store.readMembers(swarmId)[memberName]
      if (!m) return { status: 'unknown', stepSummary: null }
      const liveAgent = ctx.get?.('agents')?.get?.(m.session_id)
        ?? memberHandles.get(`${swarmId}:${memberName}`)?.agent
      const events = sessionEventsByAgent.get(m.session_id) ?? []
      return statusOf(m, {
        liveAgent,
        concurrencyGate,
        sessionEvents: events,
      })
    },

    markTurnParked(agentId) {
      if (!agentId) return
      const state = turnStates.get(agentId) ?? { calledSwarmWait: false, unparkedBlockCount: 0 }
      state.calledSwarmWait = true
      turnStates.set(agentId, state)
    },

    getParentModelRoute(rootAgent) {
      const reqCfg = rootAgent?.session?.requestHeader?.()?.config
      const agentOpts = rootAgent?.options
      const defSel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      const provider = reqCfg?.provider ?? agentOpts?.provider ?? defSel?.provider ?? ''
      const model = reqCfg?.model ?? agentOpts?.model ?? defSel?.model ?? ''
      const maxTokens = reqCfg?.maxTokens ?? agentOpts?.maxTokens
      const reasoningEffort = reqCfg?.reasoningEffort ?? agentOpts?.reasoningEffort ?? defSel?.reasoningEffort
      return {
        provider: String(provider || ''),
        model: String(model || ''),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      }
    },

    async discoverAvailableModels(rootAgent) {
      const parentRoute = runtime.getParentModelRoute(rootAgent)
      const routes = []
      const seen = new Set()
      function addRoute(provider, model, name = '') {
        if (!provider || !model) return
        const key = `${provider}/${model}`
        if (seen.has(key)) return
        seen.add(key)
        routes.push({
          provider,
          model,
          name: name || model,
          label: `${provider}/${model}`,
        })
      }

      if (parentRoute.provider && parentRoute.model) {
        addRoute(parentRoute.provider, parentRoute.model, `${parentRoute.model} (当前会话模型)`)
      }

      // Check DSH subagentModelSelection settings if configured
      try {
        const subSel = ctx.get?.('subagentModelSelection')?.current?.()
        if (subSel && Array.isArray(subSel.allowedModels)) {
          for (const r of subSel.allowedModels) {
            addRoute(r.provider, r.model)
          }
        }
      } catch {
        // Ignore if subagentModelSelection is not configured
      }

      // Query registered providers and advertised models from ctx.llm
      try {
        const llm = ctx.get?.('llm')
        if (llm && typeof llm.listProviders === 'function') {
          const providers = llm.listProviders() ?? []
          for (const p of providers) {
            if (!p?.id) continue
            try {
              const models = (await llm.listModels?.(p.id)) ?? []
              for (const m of models) {
                if (m?.id) addRoute(p.id, m.id, m.name || m.id)
              }
            } catch {
              // Ignore provider listing failure
            }
          }
        }
      } catch {
        // Ignore if llm service is absent in unit test mocks
      }

      return { parentRoute, routes }
    },

    async resolveModelRoute({ requestedProvider, requestedModel, rootAgent, swarmMeta } = {}) {
      const { parentRoute, routes } = await runtime.discoverAvailableModels(rootAgent)
      let rawProvider = typeof requestedProvider === 'string' ? requestedProvider.trim() : ''
      let rawModel = typeof requestedModel === 'string' ? requestedModel.trim() : ''

      // Support combined "provider/model" string in requestedModel
      if (rawModel.includes('/')) {
        const slashIdx = rawModel.indexOf('/')
        const prefix = rawModel.slice(0, slashIdx).trim()
        const suffix = rawModel.slice(slashIdx + 1).trim()
        if (prefix && suffix) {
          rawProvider = prefix
          rawModel = suffix
        }
      }

      const isInherit = (val) => !val || val === 'inherit' || val === 'default' || val === 'current' || val === 'internal'
      if (isInherit(rawModel)) {
        const fallbackModel = !isInherit(swarmMeta?.default_model)
          ? swarmMeta.default_model
          : parentRoute.model
        rawModel = fallbackModel || rawModel
      }
      if (isInherit(rawProvider)) {
        const fallbackProv = !isInherit(swarmMeta?.default_provider)
          ? swarmMeta.default_provider
          : parentRoute.provider
        rawProvider = fallbackProv || rawProvider
      }

      const llm = ctx.get?.('llm')
      const registeredProviders = (llm && typeof llm.listProviders === 'function')
        ? (llm.listProviders() ?? []).map(p => p.id)
        : []

      if (registeredProviders.length > 0) {
        const providerValid = registeredProviders.includes(rawProvider)
        // Find matching route in discovered catalog
        const exactMatch = routes.find(r => (
          (!providerValid || r.provider === rawProvider)
          && (r.model === rawModel || r.label === `${rawProvider}/${rawModel}`)
        )) ?? routes.find(r => r.model.toLowerCase() === rawModel.toLowerCase())
          ?? routes.find(r => (
            rawModel
            && !isInherit(rawModel)
            && (r.model.toLowerCase().includes(rawModel.toLowerCase())
              || rawModel.toLowerCase().includes(r.model.toLowerCase()))
          ))

        if (exactMatch) {
          rawProvider = exactMatch.provider
          rawModel = exactMatch.model
        } else if (!providerValid) {
          // Never allow an unregistered provider (like "internal") to reach DSH agent-loop!
          rawProvider = parentRoute.provider || registeredProviders[0] || rawProvider
          if (isInherit(rawModel) && parentRoute.model) {
            rawModel = parentRoute.model
          }
        }
      }

      const finalProvider = rawProvider || parentRoute.provider || ''
      const finalModel = rawModel || parentRoute.model || ''
      const routeChanged = finalProvider !== parentRoute.provider || finalModel !== parentRoute.model
      return {
        provider: finalProvider,
        model: finalModel,
        ...(parentRoute.maxTokens !== undefined ? { maxTokens: parentRoute.maxTokens } : {}),
        ...(!routeChanged && parentRoute.reasoningEffort !== undefined
          ? { reasoningEffort: parentRoute.reasoningEffort }
          : {}),
      }
    },

    activateCoordinatorMode(agent) {
      if (!agent) return
      agentMembership.set(agent.id, {
        swarmId: agent.id,
        memberName: 'coordinator',
        role: 'coordinator',
      })
      const sp = agent.ctx?.get?.('systemPrompt') ?? ctx.get?.('systemPrompt')
      if (sp && typeof sp.section === 'function') {
        try {
          sp.section({
            name: `dsh-swarm:coordinator:${agent.id}`,
            order: 85,
            text: COORDINATOR_SOP_PROMPT,
            interpolate: false,
          })
        } catch {
          // Section already registered
        }
      }
    },

    buildChildSetup({ swarmId, memberName, member, rolePrompt, resolvedRoute, rootAgent, isCreate }) {
      const permPreset = rootAgent?.ctx?.get?.('permissionPresets')?.current?.(rootAgent?.session)
      const sandboxMode = rootAgent?.ctx?.get?.('sandboxPolicy')?.overrideOf?.(rootAgent?.session)
      const hasApprovalSvc = rootAgent?.ctx?.get?.('approval') !== undefined

      return function setup(agentCtx, childAgent) {
        // 1. Join parent's Agent Preset so preset tools (bash, read, write, edit, glob, grep) are mounted!
        try {
          if (rootAgent?.ctx) {
            agentCtx?.get?.('agentPresets')?.composeFrom?.(agentCtx, rootAgent.ctx)
          }
        } catch (err) {
          warn(`composeFrom parent preset failed for @${memberName}: ${String(err)}`)
        }

        // 2. On fresh creation, append the durable v3 subagent/descriptor and delegated policy events
        if (isCreate && childAgent?.session && typeof childAgent.session.append === 'function') {
          try {
            childAgent.session.append('subagent/descriptor', {
              version: 3,
              mode: 'continuable',
              provider: 'spawn',
              label: `@${memberName} (${member.role})`,
              ...(resolvedRoute.provider ? { agentProvider: resolvedRoute.provider } : {}),
              ...(resolvedRoute.model ? { agentModel: resolvedRoute.model } : {}),
              ...(resolvedRoute.reasoningEffort ? { agentReasoningEffort: resolvedRoute.reasoningEffort } : {}),
            })
          } catch (err) {
            warn(`append subagent/descriptor failed for @${memberName}: ${String(err)}`)
          }

          try {
            if (sandboxMode !== undefined) {
              childAgent.session.append('sandbox/mode', { mode: sandboxMode, source: 'delegation' })
            }
            if (hasApprovalSvc) {
              childAgent.session.append('approval/policy', { policy: 'never', source: 'delegation' })
            }
            if (permPreset === 'auto' || permPreset === 'danger-full-access') {
              childAgent.session.append('permission/preset', { preset: permPreset })
            }
          } catch {
            // Ignore if session event schemas are not mounted in minimal test harness
          }
        }

        // 3. Restrict recursive subagent tools on workers so they communicate via board.jsonl
        try {
          const toolsOnChild = agentCtx?.tools ?? agentCtx?.get?.('tools')
          if (toolsOnChild && typeof toolsOnChild.restrict === 'function') {
            toolsOnChild.restrict({
              deny: ['subagent', 'subagent_fork', 'workflow', 'swarm_init', 'swarm_add', 'swarm_kill'],
            })
          }
        } catch {
          // Ignore if tool restriction is unavailable
        }

        // 4. Mount the role-specific SOP prompt section
        const sp = agentCtx?.systemPrompt ?? agentCtx?.get?.('systemPrompt')
        if (sp && typeof sp.section === 'function') {
          sp.section({
            name: 'dsh-swarm:role-sop',
            order: 85,
            text: rolePrompt,
            interpolate: false,
          })
        }
      }
    },

    async spawnMemberAgent({ swarmId, memberName, member, briefPost, fullBrief, rootAgent }) {
      agentMembership.set(member.session_id, {
        swarmId,
        memberName,
        role: member.role,
      })

      const swarmMeta = store.readSwarm(swarmId)
      const resolvedRoute = await runtime.resolveModelRoute({
        requestedProvider: member.applied_provider,
        requestedModel: member.applied_model,
        rootAgent,
        swarmMeta,
      })

      // Persist the resolved real provider/model back to members.json
      if (resolvedRoute.provider || resolvedRoute.model) {
        member = store.updateMember(swarmId, memberName, curr => ({
          ...curr,
          desired_provider: resolvedRoute.provider || curr.desired_provider,
          desired_model: resolvedRoute.model || curr.desired_model,
          applied_provider: resolvedRoute.provider || curr.applied_provider,
          applied_model: resolvedRoute.model || curr.applied_model,
        }))
      }

      const members = store.readMembers(swarmId)
      const verifierName = Object.keys(members).find(n => !members[n].killed && members[n].role === 'verifier') ?? 'verifier'
      const rolePrompt = renderRolePrompt(member.role, {
        memberName,
        groupName: member.group ?? 'none',
        workspaceMode: member.workspace_mode,
        cwd: member.worktree_path ?? rootAgent?.session?.header?.cwd ?? process.cwd(),
        briefSeq: briefPost.seq,
        brief: fullBrief,
        lastReadSeq: member.last_read_seq,
        verifierName,
      })

      const agentsSvc = ctx.get?.('agents')
      if (agentsSvc && typeof agentsSvc.create === 'function') {
        let seedEvents
        let inheritedEventCount
        if (member.fork_from) {
          const forkTargetId = member.fork_from === 'coordinator'
            ? swarmId
            : members[member.fork_from]?.session_id
          const forkAgent = forkTargetId ? agentsSvc.get?.(forkTargetId) : undefined
          const logEvents = forkAgent?.session?.events?.()
          if (Array.isArray(logEvents) && logEvents.length > 0) {
            seedEvents = logEvents
            inheritedEventCount = logEvents.length
          }
        }

        const agentPreset = rootAgent?.ctx?.get?.('agentPresets')?.composedPreset?.(rootAgent.ctx)
          ?? rootAgent?.session?.header?.agentPreset
        const childDepth = (rootAgent?.session?.header?.delegationDepth ?? 0) + 1
        const agentOptions = {
          ...(resolvedRoute.provider ? { provider: resolvedRoute.provider } : {}),
          ...(resolvedRoute.model ? { model: resolvedRoute.model } : {}),
          ...(resolvedRoute.maxTokens !== undefined ? { maxTokens: resolvedRoute.maxTokens } : {}),
          ...(resolvedRoute.reasoningEffort !== undefined ? { reasoningEffort: resolvedRoute.reasoningEffort } : {}),
          subagentDepth: childDepth,
        }

        const handle = await agentsSvc.create({
          sessionId: member.session_id,
          ...(rootAgent ? { parentAgent: rootAgent } : {}),
          meta: {
            cwd: member.worktree_path ?? rootAgent?.session?.header?.cwd ?? process.cwd(),
            ...(agentPreset ? { agentPreset } : {}),
            parentSession: swarmId,
            isSeeded: Boolean(seedEvents),
            origin: 'subagent',
            delegationDepth: childDepth,
          },
          ...(seedEvents ? { seed: seedEvents, inheritedEventCount } : {}),
          agentOptions,
          setup: runtime.buildChildSetup({
            swarmId,
            memberName,
            member,
            rolePrompt,
            resolvedRoute,
            rootAgent,
            isCreate: true,
          }),
        })

        // Register the child in the parent session's durable subagent/catalog projection
        // so DSH's SessionHistoryController & ClientSessions resolve its durable parent address!
        if (rootAgent?.session && typeof rootAgent.session.append === 'function') {
          try {
            const childHeader = handle?.agent?.session?.header
            rootAgent.session.append('subagent/catalog', {
              version: 0,
              childId: childHeader?.id ?? member.session_id,
              childCreatedAt: childHeader?.createdAt ?? Date.now(),
              mode: 'continuable',
              label: `@${memberName} (${member.role})`,
            })
          } catch (err) {
            warn(`append subagent/catalog failed for @${memberName}: ${String(err)}`)
          }
        }

        memberHandles.set(`${swarmId}:${memberName}`, handle)
        if (member.role !== 'monitor') {
          handle.agent.steer(
            buildSwarmSystemMessage(
              `[Swarm Brief #${briefPost.seq}] 你已被任命为 @${memberName} (${member.role})。\n\n${fullBrief}\n\n你的游标已初始化至 last_read_seq=${member.last_read_seq}（已自动跳过开局其他成员的任务书噪音）。请开始执行任务，完成后调用 post_board 点名汇报并调用 swarm_wait({"since": <最新seq>}) 休眠。`,
              `Brief #${briefPost.seq} for @${memberName}`,
            ),
          )
        }
        return handle
      }
      return null
    },

    async dispatchPostWakeups(swarmId, postRecord) {
      const targets = store.resolveTargetsForPost(swarmId, postRecord)
      const members = store.readMembers(swarmId)
      const woken = []

      for (const targetName of targets) {
        const m = members[targetName]
        if (!m || m.killed) continue
        const handle = memberHandles.get(`${swarmId}:${targetName}`)
        const liveAgent = handle?.agent ?? ctx.get?.('agents')?.get?.(m.session_id)

        store.updateMember(swarmId, targetName, curr => ({
          ...curr,
          last_nudged_seq: Math.max(curr.last_nudged_seq ?? 0, postRecord.seq),
        }))

        if (liveAgent && typeof liveAgent.steer === 'function') {
          const wakeText = `[board] the latest message is #${postRecord.seq} from @${postRecord.agent} (channel #${postRecord.channel || 'main'}). Call read_board({"since": ${m.last_read_seq ?? 0}}) to read and respond.`
          if (liveAgent.status === 'running' && typeof liveAgent.inject === 'function') {
            liveAgent.inject(buildSwarmSystemMessage(wakeText, `Board nudge #${postRecord.seq}`))
          } else {
            store.updateMember(swarmId, targetName, curr => ({
              ...curr,
              wake_mode: 'working',
            }))
            liveAgent.steer(buildSwarmSystemMessage(wakeText, `Board wakeup #${postRecord.seq}`))
          }
        }
        woken.push(targetName)
      }
      return woken
    },

    async hotSwapMemberModel({ swarmId, memberName, provider, model, reason }) {
      const members = store.readMembers(swarmId)
      const m = members[memberName]
      if (!m || m.killed) return { ok: false, error: `Member @${memberName} not found or killed.` }

      const agentsSvc = ctx.get?.('agents')
      const rootAgent = agentsSvc?.get?.(swarmId)
      const swarmMeta = store.readSwarm(swarmId)
      const resolvedRoute = await runtime.resolveModelRoute({
        requestedProvider: provider,
        requestedModel: model,
        rootAgent,
        swarmMeta,
      })
      const nextProvider = resolvedRoute.provider || provider
      const nextModel = resolvedRoute.model || model

      // Record desired_model first, then apply
      store.updateMember(swarmId, memberName, curr => ({
        ...curr,
        desired_provider: nextProvider,
        desired_model: nextModel,
      }))

      const key = `${swarmId}:${memberName}`
      const existingHandle = memberHandles.get(key)
      if (existingHandle && typeof existingHandle.dispose === 'function') {
        await existingHandle.dispose()
        memberHandles.delete(key)
      }

      if (agentsSvc && typeof agentsSvc.resume === 'function') {
        const verifierName = Object.keys(members).find(n => !members[n].killed && members[n].role === 'verifier') ?? 'verifier'
        const rolePrompt = renderRolePrompt(m.role, {
          memberName,
          groupName: m.group ?? 'none',
          workspaceMode: m.workspace_mode,
          cwd: m.worktree_path ?? rootAgent?.session?.header?.cwd ?? process.cwd(),
          briefSeq: m.brief_seq ?? 1,
          brief: '',
          lastReadSeq: m.last_read_seq ?? 0,
          verifierName,
        })
        const resumed = await agentsSvc.resume({
          resumeSessionId: m.session_id,
          ...(rootAgent ? { parentAgent: rootAgent } : {}),
          agentOptions: {
            ...(nextProvider ? { provider: nextProvider } : {}),
            ...(nextModel ? { model: nextModel } : {}),
            ...(resolvedRoute.maxTokens !== undefined ? { maxTokens: resolvedRoute.maxTokens } : {}),
          },
          setup: runtime.buildChildSetup({
            swarmId,
            memberName,
            member: m,
            rolePrompt,
            resolvedRoute,
            rootAgent,
            isCreate: false,
          }),
        })
        memberHandles.set(key, resumed)
        resumed.agent.steer(
          buildSwarmSystemMessage(
            `[Swarm Model Switch] 你的运行模型已热切换为 ${nextProvider}/${nextModel}（原因：${reason}）。请调用 read_board({"since": ${m.last_read_seq ?? 0}}) 继续未完成的工作。`,
            `Swarm model switched to ${nextModel}`,
          ),
        )
      }

      store.updateMember(swarmId, memberName, curr => ({
        ...curr,
        applied_provider: nextProvider,
        applied_model: nextModel,
      }))

      return { ok: true, provider: nextProvider, model: nextModel }
    },

    async disposeMemberAgent(swarmId, memberName) {
      const key = `${swarmId}:${memberName}`
      const handle = memberHandles.get(key)
      if (handle && typeof handle.dispose === 'function') {
        try {
          await handle.dispose()
        } catch (err) {
          warn(`dispose member @${memberName} failed: ${String(err)}`)
        }
      }
      memberHandles.delete(key)
    },

    ensureMonitorDaemon(swarmId) {
      if (monitorDaemons.has(swarmId)) return monitorDaemons.get(swarmId)
      const daemon = new SwarmMonitorDaemon({
        store,
        swarmId,
        intervalMs: settings.monitorIntervalMs,
        getMemberLiveness: (name, member) => runtime.getMemberLiveness(swarmId, name, member),
        onPostStall: async ({ target, text, kind, refs }) => {
          const postRecord = store.appendBoardRecord(swarmId, {
            type: 'post',
            agent: 'monitor',
            channel: 'main',
            mentions: [target],
            refs,
            kind,
            text,
          })
          await runtime.dispatchPostWakeups(swarmId, postRecord)
          runtime.notifyProjectionChanged(swarmId)
        },
      })
      daemon.start()
      monitorDaemons.set(swarmId, daemon)
      return daemon
    },

    notifyBoardActivity(swarmId, postRecord) {
      const daemon = monitorDaemons.get(swarmId)
      if (daemon) daemon.notifyBoardActivity(postRecord)
    },

    notifyProjectionChanged(swarmId) {
      if (typeof deps.onProjectionChanged === 'function') {
        deps.onProjectionChanged(swarmId)
      }
    },
  }

  // 1. Subscribe to `session/event` for transcript liveness (`statusOf`) and turn bookkeeping
  const disposeSessionEvent = ctx.on('session/event', (session, event) => {
    const sid = session?.id
    if (!sid || !event) return
    let list = sessionEventsByAgent.get(sid)
    if (!list) {
      list = []
      sessionEventsByAgent.set(sid, list)
    }
    list.push(event)
    if (list.length > 60) list.splice(0, list.length - 60)

    if (event.type === 'turn/start') {
      turnStates.set(sid, { calledSwarmWait: false, unparkedBlockCount: 0 })
    } else if (event.type === 'turn/end') {
      turnStates.delete(sid)
    }
  })
  if (typeof disposeSessionEvent === 'function') disposers.push(disposeSessionEvent)

  // 2. Hook `llm/stream` waterfall for polite 1..6 concurrency gating
  const disposeLlmStream = ctx.on('llm/stream', function (options, next) {
    if ( typeof next !== 'function') return undefined
    const initiator = ctx.get?.('agents')?.initiator?.()
    const agentId = initiator?.id ?? options?.agentId ?? 'main'
    const mapped = agentMembership.get(agentId)
    const role = mapped?.role ?? 'coordinator'
    const priority = role === 'coordinator'
      ? PRIORITY.COORDINATOR
      : role === 'verifier'
        ? PRIORITY.VERIFIER
        : role === 'monitor'
          ? PRIORITY.MONITOR
          : PRIORITY.WORKER
    return concurrencyGate.wrapStream(options, next, {
      agentId,
      memberName: mapped?.memberName ?? 'coordinator',
      priority,
    })
  })
  if (typeof disposeLlmStream === 'function') disposers.push(disposeLlmStream)

  // 3. Hook `agent/request-error` for AIMD backoff + transparent retry on 429 / concurrency errors
  const disposeReqError = ctx.on('agent/request-error', async (payload) => {
    const failure = payload?.failure ?? payload?.error?.failure ?? payload?.error
    if (!isConcurrencyFailure(failure)) return undefined
    const retryCount = Array.isArray(payload?.priorFailures) ? payload.priorFailures.length : 0
    if (retryCount >= 5) return undefined
    concurrencyGate.onRateLimited(failure?.providerRetryAfterMs)
    const waitMs = Math.min(10_000, (failure?.providerRetryAfterMs ?? 800) * (retryCount + 1))
    await new Promise(resolve => setTimeout(resolve, waitMs))
    return { kind: 'retry' }
  })
  if (typeof disposeReqError === 'function') disposers.push(disposeReqError)

  // 4. Hook `agent/turn-stopping` for the Stop-Hook race lock
  const disposeTurnStopping = ctx.on('agent/turn-stopping', async (payload) => {
    const initiator = payload?.agent ?? ctx.get?.('agents')?.initiator?.()
    if (!initiator) return
    const { swarmId, callerName } = runtime.resolveCaller(initiator)
    if (!store.exists(swarmId)) return
    const turnState = turnStates.get(initiator.id) ?? { calledSwarmWait: false, unparkedBlockCount: 0 }
    turnStates.set(initiator.id, turnState)
    await store.withLock(swarmId, async () => {
      handleTurnStopping({
        store,
        swarmId,
        memberName: callerName,
        agent: initiator,
        turnState,
      })
    })
  })
  if (typeof disposeTurnStopping === 'function') disposers.push(disposeTurnStopping)

  // 5. Register model tools via `ctx.inject(['tools'], ...)` (with fallback to `ctx.get('tools')` for mock test contexts)
  let toolsRegistered = false
  function mountToolsOn(svc) {
    if (toolsRegistered || !svc || typeof svc.register !== 'function') return []
    toolsRegistered = true
    const list = []
    for (const tool of createSwarmTools(runtime)) {
      const disp = svc.register(tool)
      if (typeof disp === 'function') {
        disposers.push(disp)
        list.push(disp)
      }
    }
    return list
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => {
      const svc = toolsCtx.tools ?? toolsCtx.get?.('tools')
      const list = mountToolsOn(svc)
      toolsCtx.effect?.(() => () => {
        for (const d of list) {
          try { d() } catch {}
        }
      }, 'dsh-swarm: tools')
    })
  }
  if (!toolsRegistered && typeof ctx.get === 'function') {
    mountToolsOn(ctx.get('tools'))
  }

  // 6. Register `/swarm` human command via `ctx.inject(['commands'], ...)` so it mounts into the `/` slash menu
  let commandRegistered = false
  function mountCommandOn(svc) {
    if (commandRegistered || !svc || typeof svc.register !== 'function') return null
    commandRegistered = true
    const disp = svc.register(createSwarmCommand(runtime))
    if (typeof disp === 'function') disposers.push(disp)
    return disp
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (cmdCtx) => {
      const svc = cmdCtx.commands ?? cmdCtx.get?.('commands')
      const disp = mountCommandOn(svc)
      cmdCtx.effect?.(() => () => {
        try { if (typeof disp === 'function') disp() } catch {}
      }, 'dsh-swarm: command')
    })
  }
  if (!commandRegistered && typeof ctx.get === 'function') {
    mountCommandOn(ctx.get('commands'))
  }

  // 7. Register HTTP routes `/api/dsh-swarm/state` & `/api/dsh-swarm/action` on `webServer` for the Rightbar UI
  let webRoutesRegistered = false
  function mountWebRoutesOn(svc) {
    if (webRoutesRegistered || !svc || typeof svc.register !== 'function') return []
    webRoutesRegistered = true
    const list = []
    for (const route of createSwarmWebRoutes(runtime)) {
      try {
        const disp = svc.register(route)
        if (typeof disp === 'function') {
          disposers.push(disp)
          list.push(disp)
        }
      } catch (err) {
        warn('webServer route registration skipped: ' + String(err))
      }
    }
    return list
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const svc = webCtx.webServer ?? webCtx.get?.('webServer')
      const list = mountWebRoutesOn(svc)
      webCtx.effect?.(() => () => {
        for (const d of list) {
          try { d() } catch {}
        }
      }, 'dsh-swarm: webServer routes')
    })
  }
  if (!webRoutesRegistered && typeof ctx.get === 'function') {
    mountWebRoutesOn(ctx.get('webServer'))
  }

  // 8. Register `swarm` SessionProjection via `ctx.get('sessionProjections')` (optional fallback)
  const projectionsSvc = (ctx.root && typeof ctx.root.get === 'function' ? ctx.root.get('sessionProjections') : undefined)
    ?? (typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined)
  if (projectionsSvc && typeof projectionsSvc.register === 'function') {
    try {
      const disp = projectionsSvc.register({
        name: 'swarm',
        initial(sessionId) {
          return buildSwarmProjectionSnapshot({ store, swarmId: sessionId, runtime })
        },
        apply(state, session) {
          const sid = session?.id
          return sid ? buildSwarmProjectionSnapshot({ store, swarmId: sid, runtime }) : state
        },
        project(state) {
          return state
        },
      })
      if (typeof disp === 'function') disposers.push(disp)
    } catch (err) {
      warn('sessionProjections registration skipped: ' + String(err))
    }
  }

  ctx.effect(() => () => {
    for (const daemon of monitorDaemons.values()) daemon.stop()
    monitorDaemons.clear()
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  }, 'dsh-swarm: cleanup')

  log('active', {
    defaultConcurrency: settings.defaultConcurrency,
    defaultModel: settings.defaultModel,
    coordinatorModel: settings.coordinatorModel,
    swarmRoot,
  })

  return runtime
}

// dup-ok: boot-safe outer host Cordis entry point wrapping strict applyWith()
// #FUNC Cordis entry point: mount the Swarm plugin safely without ever breaking DSH profile boot.
// #NOT  Does not rethrow unexpected startup exceptions; `applyWith` remains strict for `boot-check.mjs` and `smoke.mjs`.
// #WHY  Wrapping `applyWith` in a `catch` prevents an out-of-tree plugin hiccup from taking down the entire DSH web server at startup.
export function apply(ctx, config) {
  try {
    return applyWith(ctx, config, {})
  } catch (error) {
    console.error('[dsh-swarm] could not start; the rest of the profile is unaffected:', error)
    return null
  }
}
