// dsh-swarm Host half (Node ESM entry).
//
// Strictly English-only runtime messages so consuming agents always reply in the
// user's own language.
//
// Boot safety rule (host-plugin-reference.md §3 & §9):
//   - Deliberately exports NO `Config` (Cordis validates `Config` as a Standard Schema).
//   - No top-level side effects.
//   - `apply(ctx, config)` wraps `applyWith(ctx, config)` in `try/catch`.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { SwarmStore, defaultSwarmRoot, formatTime } from './src/host/store.js'
import { ConcurrencyGate, PRIORITY, isConcurrencyFailure } from './src/host/concurrency-gate.js'
import { handleTurnStopping, statusOf, buildSwarmSystemMessage } from './src/host/stop-hook.js'
import { SwarmMonitorDaemon } from './src/host/monitor.js'
import {
  renderRolePrompt,
  COORDINATOR_SOP_PROMPT,
  ARCHITECT_REVIEW_RULES,
  VERIFIER_REVIEW_RULES,
  registerRole,
  unregisterRole,
  getRoleSpec,
  getSpawnableRoles,
  formatReviewRules,
  hasLeadingAuditBias,
} from './src/host/prompts.js'
import { createSwarmTools, createSwarmCommand, buildSwarmProjectionSnapshot, WORKER_SWARM_TOOL_NAMES } from './src/host/tools.js'
import {
  collectDiagnosticExport,
  buildZipArchive,
  extractSessionTranscript,
  safeExportFilename,
} from './src/host/log-export.js'

export const PLUGIN_VERSION = '0.5.1'
export const PLUGIN_LOADED_AT = new Date().toISOString()

function detectGitCommit() {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const headFile = path.join(dir, '.git', 'HEAD')
    if (!fs.existsSync(headFile)) return 'release-0.5.1'
    const head = fs.readFileSync(headFile, 'utf8').trim()
    if (head.startsWith('ref: ')) {
      const refPath = path.join(dir, '.git', head.slice(5).trim())
      if (fs.existsSync(refPath)) return fs.readFileSync(refPath, 'utf8').trim().slice(0, 8)
    }
    return head.slice(0, 8)
  } catch {
    return 'release-0.5.1'
  }
}

export const PLUGIN_COMMIT = detectGitCommit()

export {
  SwarmStore,
  ConcurrencyGate,
  PRIORITY,
  handleTurnStopping,
  statusOf,
  SwarmMonitorDaemon,
  renderRolePrompt,
  ARCHITECT_REVIEW_RULES,
  VERIFIER_REVIEW_RULES,
  registerRole,
  unregisterRole,
  getRoleSpec,
  getSpawnableRoles,
  formatReviewRules,
  createSwarmTools,
  buildSwarmProjectionSnapshot,
  collectDiagnosticExport,
  buildZipArchive,
  extractSessionTranscript,
  safeExportFilename,
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-swarm'

const DEFAULTS = Object.freeze({
  enabled: true,
  defaultConcurrency: 4,
  minSpacingMs: 200,
  agingThresholdMs: 15_000,
  monitorIntervalMs: 120_000,
  healthIntervalMs: 30_000,
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

/** Write a JSON HTTP response with status code. */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** Build the read-only `/api/dsh-swarm/state` and `/api/dsh-swarm/export` routes for `webServer`. */
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
          const exactSwarmId = requestedSessionId
            ? store.resolveSwarmId(requestedSessionId, { fallbackLatest: false })
            : null
          const resolvedSwarmId = (explicitSwarmId && store.exists(explicitSwarmId))
            ? explicitSwarmId
            : store.resolveSwarmId(requestedSessionId)
          const snapshot = resolvedSwarmId
            ? buildSwarmProjectionSnapshot({ store, swarmId: resolvedSwarmId, runtime })
            : null
          sendJson(res, 200, {
            ok: true,
            requestedSessionId,
            exactSwarmId,
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
      path: '/api/dsh-swarm/export',
      async handler(req, res) {
        try {
          const url = new URL(req.url ?? '/api/dsh-swarm/export', 'http://127.0.0.1')
          const sessionId = url.searchParams.get('sessionId') || ''
          const swarmId = url.searchParams.get('swarmId') || ''
          const formatRaw = (url.searchParams.get('format') || 'zip').toLowerCase()
          const format = ['zip', 'timeline', 'manifest', 'json'].includes(formatRaw) ? formatRaw : 'zip'
          const detailParam = (url.searchParams.get('detail') || 'compact').toLowerCase()
          const detail = detailParam === 'full' ? 'full' : 'compact'
          const includeSubagents = url.searchParams.get('includeSubagents') !== 'false'
          const includeReasoning = url.searchParams.get('includeReasoning') === 'true'
          const includeInjections = url.searchParams.get('includeInjections') === 'true'
          const downloadParam = url.searchParams.get('download')
          const isDownload = downloadParam === '1' || downloadParam === 'true'
          const maxCharsRaw = url.searchParams.get('maxToolResultChars')
          const maxToolResultChars = maxCharsRaw !== null && maxCharsRaw !== '' && Number.isFinite(Number(maxCharsRaw))
            ? Number(maxCharsRaw)
            : undefined

          const result = await collectDiagnosticExport({
            ctx: runtime.ctx,
            store,
            runtime,
            sessionId,
            swarmId,
            detail,
            includeSubagents,
            includeReasoning,
            includeInjections,
            ...(maxToolResultChars !== undefined ? { maxToolResultChars } : {}),
          })
          if (!result.ok) {
            sendJson(res, result.status || 400, { ok: false, error: result.error })
            return
          }

          const prefix = result.bundle.mode === 'swarm' ? 'dsh-swarm-log' : 'dsh-session-log'
          const ext = format === 'timeline' ? 'jsonl' : (format === 'zip' ? 'zip' : 'json')
          const filename = safeExportFilename(
            format === 'timeline' ? `${prefix}-timeline` : (format === 'manifest' ? `${prefix}-manifest` : prefix),
            result.bundle.root_session_id,
            ext,
          )
          const contentType = format === 'zip'
            ? 'application/zip'
            : (format === 'timeline' ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8')

          res.statusCode = 200
          res.setHeader('content-type', contentType)
          res.setHeader('cache-control', 'no-store')
          res.setHeader('x-dsh-export-mode', result.bundle.mode)
          res.setHeader('x-dsh-export-filename', filename)
          if (isDownload) {
            res.setHeader('content-disposition', `attachment; filename="${filename}"`)
          }
          if (String(req.method || 'GET').toUpperCase() === 'HEAD') {
            res.end('')
            return
          }
          if (format === 'zip') {
            const rootDirName = filename.replace(/\.zip$/i, '')
            res.end(buildZipArchive(result.bundle.files, rootDirName))
            return
          }
          if (format === 'timeline') {
            res.end(result.bundle.timeline_jsonl)
            return
          }
          if (format === 'manifest') {
            res.end(`${JSON.stringify(result.bundle.manifest, null, 2)}\n`)
            return
          }
          res.end(`${JSON.stringify({
            manifest: result.bundle.manifest,
            timeline: result.bundle.timeline,
            files: result.bundle.files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content, 'utf8') })),
          }, null, 2)}\n`)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    },
  ]
}

// dup-ok: strict inner host mount implementation paired with boot-safe outer apply()
// #FUNC Wire the Swarm blackboard, concurrency gate, stop hook, tools, commands, lock-safe telemetry, and projection into a Cordis Context.
// #NOT  Does not export a plain-object `Config`, does not poll sleeping agents, and never mutates `members.json` outside `store.withLock`.
// #EDGE-IN Sibling `session/event` dispatch records transcript events for `statusOf()` liveness without lock-bypassing disk races → test_host_sibling_event_liveness
// #WHY  Keeping high-frequency `session/event` telemetry in memory and flushing coalesced patches inside `store.withLock` eliminates Windows NTFS `EPERM` rename collisions.
export function applyWith(ctx, config, deps = {}) {
  const settings = mergeSettings(config)
  const log = deps.log ?? ((...args) => console.info('[dsh-swarm]', ...args))
  const warn = deps.warn ?? ((message) => console.warn('[dsh-swarm] ' + message))

  if (settings.enabled !== true) {
    log('disabled by config')
    return null
  }

  if (config?.roles && typeof config.roles === 'object') {
    for (const [roleName, roleSpec] of Object.entries(config.roles)) {
      if (roleSpec && typeof roleSpec === 'object') {
        registerRole(roleName, roleSpec)
      }
    }
  }

  const swarmRoot = settings.swarmDir || deps.swarmDir || defaultSwarmRoot()
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const worktreesRoot = settings.worktreesDir || deps.worktreesDir || path.join(dshHome, 'swarm-worktrees')

  const store = deps.store ?? new SwarmStore(swarmRoot)
  const disposers = []
  const sessionEventsByAgent = new Map()
  const memberTelemetry = new Map()
  const pendingTelemetryFlushes = new Map()
  const memberHandles = new Map()
  const agentMembership = new Map()
  const turnStates = new Map()
  const monitorDaemons = new Map()

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

  function flushTelemetryForSwarm(swarmId) {
    const existingTimer = pendingTelemetryFlushes.get(swarmId)
    if (existingTimer) {
      clearTimeout(existingTimer)
      pendingTelemetryFlushes.delete(swarmId)
    }
    return store.withLock(swarmId, async () => {
      if (!store.exists(swarmId)) return
      const existingOffsets = store.readOffsets(swarmId)
      const updates = {}
      let changed = false
      for (const [, t] of memberTelemetry.entries()) {
        if (t.swarmId !== swarmId) continue
        const cur = existingOffsets[t.memberName] || {}
        updates[t.memberName] = {
          turn_count: Math.max(cur.turn_count ?? 0, t.turn_count ?? 0),
          tool_call_count: Math.max(cur.tool_call_count ?? 0, t.tool_call_count ?? 0),
          ...(t.last_turn_at ? { last_turn_at: t.last_turn_at } : {}),
          ...(t.last_tool_call_at ? { last_tool_call_at: t.last_tool_call_at } : {}),
          ...(t.last_tool_name ? { last_tool_name: t.last_tool_name } : {}),
          ...(t.last_error !== undefined ? { last_error: t.last_error } : {}),
          ...(t.phase ? { phase: t.phase } : {}),
        }
        changed = true
      }
      if (changed) {
        store.flushOffsets(swarmId, updates)
      }
    }).catch((err) => {
      warn(`telemetry flush skipped for ${swarmId}: ${String(err?.message ?? err)}`)
    })
  }

  function scheduleTelemetryFlush(swarmId, immediate = false) {
    if (immediate) {
      void flushTelemetryForSwarm(swarmId)
      return
    }
    if (pendingTelemetryFlushes.has(swarmId)) return
    const timer = setTimeout(() => {
      pendingTelemetryFlushes.delete(swarmId)
      void flushTelemetryForSwarm(swarmId)
    }, 250)
    if (typeof timer.unref === 'function') timer.unref()
    pendingTelemetryFlushes.set(swarmId, timer)
  }

  const runtime = {
    ctx,
    settings,
    store,
    worktreesRoot,
    concurrencyGate,
    sessionEventsByAgent,
    memberTelemetry,
    memberHandles,
    agentMembership,
    turnStates,
    monitorDaemons,

    getMemberTelemetry(sessionId) {
      if (!sessionId) return null
      const t = memberTelemetry.get(sessionId)
      if (!t) return null
      return {
        turn_count: t.turn_count,
        tool_call_count: t.tool_call_count,
        ...(t.last_turn_at ? { last_turn_at: t.last_turn_at } : {}),
        ...(t.last_tool_call_at ? { last_tool_call_at: t.last_tool_call_at } : {}),
        ...(t.last_tool_name ? { last_tool_name: t.last_tool_name } : {}),
        ...(t.last_error !== undefined ? { last_error: t.last_error } : {}),
        ...(t.phase ? { phase: t.phase } : {}),
        ...(t.last_input_tokens > 0 ? { last_input_tokens: t.last_input_tokens } : {}),
        ...(t.total_output_tokens > 0 ? { total_output_tokens: t.total_output_tokens } : {}),
        ...(t.context_window > 0 ? { context_window: t.context_window } : {}),
      }
    },

    getWatchdogStatus(swarmId) {
      const daemon = monitorDaemons.get(swarmId)
      return daemon ? daemon.status() : null
    },

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
      const raw = memberRecord ?? store.readMembers(swarmId)[memberName]
      if (!raw) return { status: 'unknown', stepSummary: null }
      const overlay = runtime.getMemberTelemetry(raw.session_id)
      const m = overlay ? { ...raw, ...overlay } : raw
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

    getRuntimeFingerprint() {
      return {
        version: PLUGIN_VERSION,
        commit: PLUGIN_COMMIT,
        loaded_at: PLUGIN_LOADED_AT,
        swarm_root: swarmRoot,
      }
    },

    getService(serviceName, rootAgent) {
      return rootAgent?.ctx?.get?.(serviceName) ?? ctx.get?.(serviceName)
    },

    getParentModelRoute(rootAgent) {
      const reqCfg = rootAgent?.session?.requestHeader?.()?.config
      const agentOpts = rootAgent?.options
      const defSel = runtime.getService('agentDefaultModel', rootAgent)?.currentSelection?.()
      let evProvider = ''
      let evModel = ''
      if (rootAgent?.id) {
        const recent = sessionEventsByAgent.get(rootAgent.id) ?? []
        for (let i = recent.length - 1; i >= 0; i -= 1) {
          const ev = recent[i]
          if (ev?.type === 'request/context' && ev.data?.provider) {
            evProvider = ev.data.provider
            evModel = ev.data.model ?? ''
            break
          }
          if (ev?.type === 'request/header' && ev.data?.header?.config?.provider) {
            evProvider = ev.data.header.config.provider
            evModel = ev.data.header.config.model ?? ''
            break
          }
        }
      }
      const provider = reqCfg?.provider ?? agentOpts?.provider ?? (evProvider || undefined) ?? defSel?.provider ?? ''
      const model = reqCfg?.model ?? agentOpts?.model ?? (evModel || undefined) ?? defSel?.model ?? ''
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
      function addRoute(provider, model, displayName = '') {
        if (!provider || !model) return
        const key = `${provider}/${model}`
        if (seen.has(key)) return
        seen.add(key)
        routes.push({
          provider,
          model,
          name: displayName || model,
          label: `${provider}/${model}`,
        })
      }

      if (parentRoute.provider && parentRoute.model) {
        addRoute(parentRoute.provider, parentRoute.model, `${parentRoute.model} (current session model)`)
      }

      try {
        const subSel = runtime.getService('subagentModelSelection', rootAgent)?.current?.()
        if (subSel && Array.isArray(subSel.allowedModels)) {
          for (const r of subSel.allowedModels) {
            addRoute(r.provider, r.model)
          }
        }
      } catch {}

      try {
        const llm = runtime.getService('llm', rootAgent)
        if (llm && typeof llm.listProviders === 'function') {
          const providers = llm.listProviders() ?? []
          for (const p of providers) {
            if (!p?.id) continue
            try {
              const models = (await llm.listModels?.(p.id)) ?? []
              for (const m of models) {
                if (m?.id) addRoute(p.id, m.id, m.name || m.id)
              }
            } catch {}
          }
        }
      } catch {}

      return { parentRoute, routes }
    },

    // #FUNC Resolve the real DSH provider/model route for a Swarm member, honoring explicit overrides first and role-level `defaultModel`/`preferredModelKeywords` (case-insensitive) before inheriting `swarmMeta` or `parentRoute`.
    // #NOT  Never overrides an explicit caller `requestedModel` with role defaults, and never invents an unregistered provider/model when no keyword-matching route exists.
    // #EDGE-IN When DSH exposes a route named `Auto` alongside a DeepSeek parent, `verifier`/`architect` auto-select `Auto` via `preferredModelKeywords` (`['glm', 'auto']`) while `worker` inherits DeepSeek → test_verifier_review_rules_heterogeneous_model_keywords_and_kill_brake
    // #WHY  Checking `preferredModelKeywords` against discovered `routes` (preferring routes distinct from `parentRoute`) enables zero-config heterogeneous model auditing while degrading cleanly to `inherit` on single-model setups.
    async resolveModelRoute({ requestedProvider, requestedModel, role, rootAgent, swarmMeta } = {}) {
      const { parentRoute, routes } = await runtime.discoverAvailableModels(rootAgent)
      let rawProvider = typeof requestedProvider === 'string' ? requestedProvider.trim() : ''
      let rawModel = typeof requestedModel === 'string' ? requestedModel.trim() : ''

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
      const roleSpec = role ? getRoleSpec(role) : null
      if (isInherit(rawModel) && roleSpec) {
        if (roleSpec.defaultModel && !isInherit(roleSpec.defaultModel)) {
          const dm = roleSpec.defaultModel.trim()
          if (dm.includes('/')) {
            const slashIdx = dm.indexOf('/')
            rawProvider = dm.slice(0, slashIdx).trim()
            rawModel = dm.slice(slashIdx + 1).trim()
          } else {
            rawModel = dm
            if (isInherit(rawProvider) && roleSpec.defaultProvider && !isInherit(roleSpec.defaultProvider)) {
              rawProvider = roleSpec.defaultProvider.trim()
            }
          }
        } else if (Array.isArray(roleSpec.preferredModelKeywords) && roleSpec.preferredModelKeywords.length > 0 && routes.length > 0) {
          const keywords = roleSpec.preferredModelKeywords
          const findByKeywords = (candidates) => {
            for (const kw of keywords) {
              const hit = candidates.find(r => `${r.provider}/${r.model} ${r.name || ''}`.toLowerCase().includes(kw))
              if (hit) return hit
            }
            return null
          }
          const distinctRoutes = routes.filter(r => r.provider !== parentRoute.provider || r.model !== parentRoute.model)
          const matchedRoute = findByKeywords(distinctRoutes) ?? findByKeywords(routes)
          if (matchedRoute) {
            rawProvider = matchedRoute.provider
            rawModel = matchedRoute.model
          }
        }
      }

      if (isInherit(rawModel)) {
        const fallbackModel = !isInherit(swarmMeta?.default_model)
          ? swarmMeta.default_model
          : parentRoute.model
        rawModel = isInherit(fallbackModel) ? '' : (fallbackModel || '')
      }
      if (isInherit(rawProvider)) {
        const fallbackProv = !isInherit(swarmMeta?.default_provider)
          ? swarmMeta.default_provider
          : parentRoute.provider
        rawProvider = isInherit(fallbackProv) ? '' : (fallbackProv || '')
      }

      const llm = runtime.getService('llm', rootAgent)
      const registeredProviders = (llm && typeof llm.listProviders === 'function')
        ? (llm.listProviders() ?? []).map(p => p.id).filter(Boolean)
        : []

      if (registeredProviders.length > 0) {
        const providerValid = Boolean(rawProvider) && registeredProviders.includes(rawProvider)
        const exactMatch = routes.find(r => (
          (!providerValid || r.provider === rawProvider)
          && (r.model === rawModel || r.label === `${rawProvider}/${rawModel}`)
        )) ?? routes.find(r => rawModel && r.model.toLowerCase() === rawModel.toLowerCase())
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
          rawProvider = (parentRoute.provider && registeredProviders.includes(parentRoute.provider))
            ? parentRoute.provider
            : (registeredProviders[0] || '')
          if (!rawModel && parentRoute.model) {
            rawModel = parentRoute.model
          }
        }
      } else {
        if (!rawProvider && parentRoute.provider && !isInherit(parentRoute.provider)) {
          rawProvider = parentRoute.provider
        }
        if (!rawModel && parentRoute.model && !isInherit(parentRoute.model)) {
          rawModel = parentRoute.model
        }
      }

      const finalProvider = isInherit(rawProvider) ? '' : (rawProvider || '')
      const finalModel = isInherit(rawModel) ? '' : (rawModel || '')
      const routeChanged = finalProvider !== parentRoute.provider || finalModel !== parentRoute.model
      return {
        provider: finalProvider,
        model: finalModel,
        registeredProviders,
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
        } catch {}
      }
    },

    // #FUNC Dynamically register scoped Swarm tools on an individual agent's `agent.ctx.tools` after `swarm_init` or worker spawn.
    // #NOT  Never registers non-entry tools onto the global tool layer when a scoped `agent.ctx` is available, and never double-registers on the same scope.
    // #EDGE-IN Calling `swarm_init` unlocks all 10 Swarm tools on that agent's scope while unrelated sessions keep seeing only `swarm_init` → test_scoped_lazy_tool_unlock_on_swarm_init
    // #WHY  Keeping only `swarm_init` in the global layer saves 10 tool schemas on non-Swarm sessions while `agent.ctx.tools` emits `tools/change` for instant activation.
    enableSwarmToolsOnAgent(agent, role = 'coordinator', explicitCtx = null) {
      const targetCtx = explicitCtx ?? agent?.ctx ?? null
      const svc = targetCtx
        ? (targetCtx.tools ?? targetCtx.get?.('tools'))
        : (typeof ctx.get === 'function' ? ctx.get('tools') : null)
      if (!svc || typeof svc.register !== 'function') return []
      if (enabledToolServices.has(svc)) return []
      enabledToolServices.add(svc)

      const workerSet = new Set(WORKER_SWARM_TOOL_NAMES)
      const toolsToMount = role === 'coordinator'
        ? allSwarmTools.filter(t => t.name !== 'swarm_init')
        : allSwarmTools.filter(t => workerSet.has(t.name))

      const registeredDisposers = []
      for (const tool of toolsToMount) {
        try {
          const disp = svc.register(tool)
          if (typeof disp === 'function') {
            disposers.push(disp)
            registeredDisposers.push(disp)
          }
        } catch (err) {
          warn(`scoped tool register(${tool.name}) skipped: ${String(err)}`)
        }
      }
      return registeredDisposers
    },

    buildChildSetup({ memberName, member, rolePrompt, resolvedRoute, rootAgent, isCreate }) {
      const permPreset = rootAgent?.ctx?.get?.('permissionPresets')?.current?.(rootAgent?.session)
      const sandboxMode = rootAgent?.ctx?.get?.('sandboxPolicy')?.overrideOf?.(rootAgent?.session)
      const hasApprovalSvc = rootAgent?.ctx?.get?.('approval') !== undefined

      return function setup(agentCtx, childAgent) {
        try {
          if (rootAgent?.ctx) {
            agentCtx?.get?.('agentPresets')?.composeFrom?.(agentCtx, rootAgent.ctx)
          }
        } catch (err) {
          warn(`composeFrom parent preset failed for @${memberName}: ${String(err)}`)
        }

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
          } catch {}
        }

        try {
          const toolsOnChild = agentCtx?.tools ?? agentCtx?.get?.('tools')
          if (toolsOnChild && typeof toolsOnChild.restrict === 'function') {
            const denyCandidates = ['subagent', 'subagent_fork', 'workflow', 'swarm_init']
            const denyList = typeof toolsOnChild.get === 'function'
              ? denyCandidates.filter(name => toolsOnChild.get(name, childAgent) !== undefined)
              : denyCandidates
            if (denyList.length > 0) {
              toolsOnChild.restrict({ deny: denyList })
            }
          }
          runtime.enableSwarmToolsOnAgent(childAgent, 'worker', agentCtx)
        } catch {}

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

    /** Step 1 of atomic spawn: create the live DSH agent session BEFORE touching members.json/board.jsonl. */
    async createMemberAgent({ swarmId, memberName, member, briefSeq, fullBrief, resolvedRoute, rootAgent }) {
      const agentsSvc = runtime.getService('agents', rootAgent)
      if (!agentsSvc || typeof agentsSvc.create !== 'function') return null

      const members = store.readMembers(swarmId)
      const verifierName = Object.keys(members).find(n => !members[n].killed && members[n].role === 'verifier') ?? 'verifier'
      const rolePrompt = renderRolePrompt(member.role, {
        memberName,
        groupName: member.group ?? 'none',
        workspaceMode: member.workspace_mode,
        cwd: member.worktree_path ?? rootAgent?.session?.header?.cwd ?? process.cwd(),
        briefSeq,
        brief: fullBrief,
        lastReadSeq: member.last_read_seq,
        verifierName,
      })

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

      return await agentsSvc.create({
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
    },

    /** Step 2 of atomic spawn: bind handle, append parent `subagent/catalog`, and steer the opening brief. */
    activateSpawnedMember({ swarmId, memberName, member, briefPost, fullBrief, handle, rootAgent }) {
      agentMembership.set(member.session_id, {
        swarmId,
        memberName,
        role: member.role,
      })
      if (!handle) return
      memberHandles.set(`${swarmId}:${memberName}`, handle)

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

      handle.agent.steer(
        buildSwarmSystemMessage(
          `[Swarm Brief #${briefPost.seq}] You have been assigned as @${memberName} (${member.role}).\n\n${fullBrief}\n\nYour cursor is initialized to last_read_seq=${member.last_read_seq} (opening sibling brief noise skipped). Execute your assignment, post your handoff via post_board (with a meaningful title), and park via swarm_wait({"since": <latestSeq>, "mentions_only": true}).`,
          `Brief #${briefPost.seq} for @${memberName}`,
        ),
      )
    },

    /** Combined helper preserved for direct callers and smoke tests. */
    async spawnMemberAgent({ swarmId, memberName, member, briefPost, fullBrief, rootAgent }) {
      const swarmMeta = store.readSwarm(swarmId)
      const resolvedRoute = await runtime.resolveModelRoute({
        requestedProvider: member.applied_provider,
        requestedModel: member.applied_model,
        role: member.role,
        rootAgent,
        swarmMeta,
      })
      if (resolvedRoute.provider || resolvedRoute.model) {
        member = store.updateMember(swarmId, memberName, curr => ({
          ...curr,
          desired_provider: resolvedRoute.provider || curr.desired_provider,
          desired_model: resolvedRoute.model || curr.desired_model,
          applied_provider: resolvedRoute.provider || curr.applied_provider,
          applied_model: resolvedRoute.model || curr.applied_model,
        }))
      }
      const handle = await runtime.createMemberAgent({
        swarmId,
        memberName,
        member,
        briefSeq: briefPost.seq,
        fullBrief,
        resolvedRoute,
        rootAgent,
      })
      runtime.activateSpawnedMember({
        swarmId,
        memberName,
        member,
        briefPost,
        fullBrief,
        handle,
        rootAgent,
      })
      return handle
    },

    async dispatchPostWakeups(swarmId, postRecord) {
      const { wakeTargets, silentTargets } = store.resolveWakeRoutingForPost(swarmId, postRecord)
      const members = store.readMembers(swarmId)
      const woken = []
      const unreachable = []
      const silentMentions = [...silentTargets]

      if ((postRecord.mentions ?? []).includes('monitor')) {
        const daemon = monitorDaemons.get(swarmId)
        if (daemon) {
          daemon.notifyBoardActivity(postRecord)
          void daemon.healthTick()
        }
        woken.push('monitor')
      }

      for (const targetName of wakeTargets) {
        if (targetName === 'monitor') continue
        const m = members[targetName]
        if (!m || m.killed) {
          unreachable.push(targetName)
          continue
        }
        const handle = memberHandles.get(`${swarmId}:${targetName}`)
        const liveAgent = handle?.agent ?? ctx.get?.('agents')?.get?.(m.session_id)

        if (liveAgent && typeof liveAgent.steer === 'function') {
          store.updateMember(swarmId, targetName, curr => ({
            ...curr,
            last_nudged_seq: Math.max(curr.last_nudged_seq ?? 0, postRecord.seq),
          }))
          const chPart = postRecord.channel && postRecord.channel !== 'main' ? ` #${postRecord.channel}` : ''
          const titlePart = postRecord.title ? `: ${postRecord.title}` : ''
          const targetRoleSpec = getRoleSpec(m.role)
          const rulesAnchor = formatReviewRules(targetRoleSpec.reviewRules, 'anchor')
          const anchorPart = rulesAnchor && postRecord.kind !== 'done' ? `\n${rulesAnchor}` : ''
          const blindAuditPart = (
            targetRoleSpec.canBlockMerge
            && postRecord.agent !== targetName
            && postRecord.kind !== 'done'
            && hasLeadingAuditBias(`${postRecord.title || ''}\n${postRecord.text || ''}`)
          )
            ? `\n[BLIND_AUDIT_ALERT] Leading framing detected in #${postRecord.seq}. Discard sender conclusions, expected counts, and summaries; audit raw code/git diff/outputs from scratch. NEVER mention this alert or its trigger to the sender; if severe gaming/contamination occurred, reject and demand a clean redo.`
            : ''
          let escalatePart = ''
          if (targetName === 'coordinator' && postRecord.verdict === 'reject') {
            const rej = store.computeActiveRejections(swarmId).find(r => r.reviewer === postRecord.agent)
            if (rej && rej.consecutive_rejects >= 2) {
              escalatePart = `\n[ESCALATE_TO_HUMAN] @${postRecord.agent} rejected ${rej.consecutive_rejects} consecutive rounds—stop local patching and ask the user to arbitrate architecture/scope.`
            }
          }
          const wakeText = `[board] #${postRecord.seq} @${postRecord.agent} (${postRecord.kind}${chPart})${titlePart} -> read_board(since=${m.last_read_seq ?? 0})${anchorPart}${blindAuditPart}${escalatePart}`
          if (liveAgent.status === 'running' && typeof liveAgent.inject === 'function') {
            liveAgent.inject(buildSwarmSystemMessage(wakeText, `Board nudge #${postRecord.seq}`))
          } else {
            store.updateMember(swarmId, targetName, curr => ({
              ...curr,
              wake_mode: 'working',
            }))
            liveAgent.steer(buildSwarmSystemMessage(wakeText, `Board wakeup #${postRecord.seq}`))
          }
          woken.push(targetName)
        } else {
          unreachable.push(targetName)
        }
      }

      return { woken, unreachable, silentMentions }
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

      let memberAlive = false
      if (agentsSvc && typeof agentsSvc.resume === 'function') {
        const verifierName = Object.keys(members).find(n => !members[n].killed && members[n].role === 'verifier') ?? 'verifier'
        const rolePrompt = renderRolePrompt(m.role, {
          memberName,
          groupName: m.group ?? 'none',
          workspaceMode: m.workspace_mode,
          cwd: m.worktree_path ?? swarmMeta?.project_root ?? rootAgent?.session?.header?.cwd ?? process.cwd(),
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
        memberAlive = Boolean(resumed?.agent)
        resumed.agent.steer(
          buildSwarmSystemMessage(
            `[Swarm Model Switch] Your active model has been hot-swapped to ${nextProvider}/${nextModel} (reason: ${reason}). Call read_board({"since": ${m.last_read_seq ?? 0}}) and resume your unfinished work.`,
            `Swarm model switched to ${nextModel}`,
          ),
        )
      }

      const t = memberTelemetry.get(m.session_id)
      if (t) {
        t.last_error = null
        t.phase = 'RUNNING'
      }

      store.appendEvent(swarmId, {
        type: 'member.model_switch',
        actor: 'coordinator',
        seq: store.headSeq(swarmId),
        payload: {
          name: memberName,
          desired_provider: nextProvider,
          desired_model: nextModel,
          applied_provider: nextProvider,
          applied_model: nextModel,
          reason: reason ?? 'Model switched by coordinator',
        },
      })
      store.flushOffsets(swarmId, {
        [memberName]: { last_error: null, phase: 'RUNNING' },
      })
      const updatedMember = store.readMembers(swarmId)[memberName] ?? m

      return {
        ok: true,
        provider: nextProvider,
        model: nextModel,
        member_alive: memberAlive,
        turn_count: Math.max(updatedMember.turn_count ?? 0, t?.turn_count ?? 0),
        last_turn_at: t?.last_turn_at ?? updatedMember.last_turn_at ?? null,
      }
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
        healthIntervalMs: settings.healthIntervalMs,
        getMemberLiveness: (memberName, member) => runtime.getMemberLiveness(swarmId, memberName, member),
        onAutoNudge: async (memberName, customPrompt = null) => {
          const m = store.readMembers(swarmId)[memberName]
          if (!m || m.killed) return false
          const handle = memberHandles.get(`${swarmId}:${memberName}`)
          const liveAgent = handle?.agent ?? ctx.get?.('agents')?.get?.(m.session_id)
          if (!liveAgent || typeof liveAgent.steer !== 'function') return false
          const msgText = customPrompt
            || `[Watchdog Auto-Nudge] You were assigned as @${memberName} (Brief #${m.brief_seq ?? 1}), but showed no activity after 60s. Call read_board({"since": 0}) and begin immediately.`
          liveAgent.steer(
            buildSwarmSystemMessage(
              msgText,
              `Watchdog auto-nudge for @${memberName}`,
            ),
          )
          return true
        },
        onPostStall: async ({ target, targets, title, text, kind, refs, escalate }) => {
          await store.withLock(swarmId, async () => {
            if (!store.exists(swarmId)) return
            const mentionList = Array.isArray(targets) && targets.length > 0 ? targets : [target]
            const postRecord = store.appendBoardRecord(swarmId, {
              type: 'post',
              agent: 'monitor',
              channel: 'main',
              title: title || `Watchdog alert for @${target}`,
              mentions: mentionList,
              skip_prose_mention_extraction: true,
              refs,
              kind,
              escalate: escalate === true,
              text,
            })
            await runtime.dispatchPostWakeups(swarmId, postRecord)
            runtime.notifyProjectionChanged(swarmId)
          })
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

  // 1. Subscribe to `session/event` for transcript liveness, lock-safe telemetry, and error alerting
  const reportedErrorSignatures = new Set()
  function resolveMemberForSessionId(sid) {
    if (!sid) return null
    const direct = agentMembership.get(sid)
    if (direct) return direct
    if (typeof sid === 'string' && sid.includes('__')) {
      const [swId, mName] = sid.split('__')
      if (swId && mName && store.exists(swId)) {
        return { swarmId: swId, memberName: mName, role: store.readMembers(swId)[mName]?.role ?? 'worker' }
      }
    }
    return null
  }

  function extractEventFailure(event) {
    if (!event || typeof event !== 'object') return null
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      const err = event.data.reason.error ?? event.data.reason.failure ?? event.data.reason
      return {
        code: err?.code ?? 'TURN_ERROR',
        message: err?.message ?? String(err),
        turn: event.data?.turn ?? 1,
      }
    }
    if (event.type === 'assistant/attempt' && Array.isArray(event.data?.stream)) {
      for (const item of event.data.stream) {
        const chunk = item?.chunk
        if (chunk?.type === 'finish' && chunk?.reason?.kind === 'error') {
          const failure = chunk.reason.failure ?? chunk.reason.error ?? chunk.reason
          return {
            code: failure?.code ?? 'LLM_ERROR',
            message: failure?.message ?? String(failure),
            turn: event.data?.turn ?? 1,
          }
        }
      }
    }
    return null
  }

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

    const mapped = resolveMemberForSessionId(sid)
    if (mapped && store.exists(mapped.swarmId)) {
      const { swarmId, memberName } = mapped
      let t = memberTelemetry.get(sid)
      if (!t) {
        const existing = store.readMembers(swarmId)[memberName]
        t = {
          swarmId,
          memberName,
          turn_count: existing?.turn_count ?? 0,
          tool_call_count: existing?.tool_call_count ?? 0,
          last_turn_at: existing?.last_turn_at ?? null,
          last_tool_call_at: existing?.last_tool_call_at ?? null,
          last_tool_name: existing?.last_tool_name ?? null,
          last_error: existing?.last_error ?? null,
          phase: existing?.phase ?? 'RUNNING',
          last_input_tokens: 0,
          total_output_tokens: 0,
          context_window: 0,
        }
        memberTelemetry.set(sid, t)
      }

      if (event.type === 'turn/start') {
        t.turn_count += 1
        t.last_turn_at = formatTime()
        scheduleTelemetryFlush(swarmId, false)
      } else if (event.type === 'tool/call') {
        t.tool_call_count += 1
        t.last_tool_call_at = formatTime()
        t.last_tool_name = event.data?.name ?? 'tool'
        t.last_error = null
        t.phase = 'RUNNING'
        scheduleTelemetryFlush(swarmId, false)
      } else if (event.type === 'request/context') {
        if (typeof event.data?.contextWindow === 'number' && event.data.contextWindow > 0) {
          t.context_window = event.data.contextWindow
        }
      } else if (event.type === 'assistant/message') {
        const usage = event.data?.usage
        if (usage && typeof usage === 'object') {
          if (Number(usage.inputTokens) > 0) t.last_input_tokens = Number(usage.inputTokens)
          if (Number(usage.outputTokens) > 0) t.total_output_tokens += Number(usage.outputTokens)
        }
      } else {
        const failure = extractEventFailure(event)
        if (failure && memberName !== 'coordinator') {
          const errRecord = {
            code: failure.code,
            message: failure.message,
            turn: failure.turn,
            time: formatTime(),
          }
          t.last_error = errRecord
          t.phase = 'ERROR'
          scheduleTelemetryFlush(swarmId, true)

          const sig = `${sid}:${failure.turn}:${failure.code}:${failure.message}`
          if (!reportedErrorSignatures.has(sig)) {
            reportedErrorSignatures.add(sig)
            void store.withLock(swarmId, async () => {
              if (!store.exists(swarmId)) return
              const alertPost = store.appendBoardRecord(swarmId, {
                type: 'post',
                agent: 'monitor',
                channel: 'main',
                title: `Runtime error: @${memberName} (${failure.code})`,
                mentions: ['coordinator'],
                skip_prose_mention_extraction: true,
                kind: 'alert',
                escalate: true,
                text: `@coordinator [RUNTIME_ERROR] Member @${memberName} aborted on turn ${failure.turn}: ${failure.message} (code=${failure.code}). Inspect via swarm_status and run swarm_model or swarm_kill.`,
              })
              await runtime.dispatchPostWakeups(swarmId, alertPost)
              runtime.notifyProjectionChanged(swarmId)
            }).catch(() => {})
          }
        }
      }
    }
  })
  if (typeof disposeSessionEvent === 'function') disposers.push(disposeSessionEvent)

  // 2. Hook `llm/stream` waterfall for polite concurrency gating
  const PRIORITY_BY_TIER = {
    coordinator: PRIORITY.COORDINATOR,
    high: PRIORITY.VERIFIER,
    worker: PRIORITY.WORKER,
    low: PRIORITY.MONITOR,
  }
  const disposeLlmStream = ctx.on('llm/stream', function (options, next) {
    if (typeof next !== 'function') return undefined
    const initiator = ctx.get?.('agents')?.initiator?.()
    const agentId = initiator?.id ?? options?.agentId ?? 'main'
    const mapped = agentMembership.get(agentId)
    const role = mapped?.role ?? 'coordinator'
    const priority = PRIORITY_BY_TIER[getRoleSpec(role).priorityTier] ?? PRIORITY.WORKER
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

  // 5. Register ONLY `swarm_init` globally via `ctx.inject(['tools'], ...)`.
  //    The remaining 10 Swarm tools are registered dynamically onto `agent.ctx.tools`
  //    when `swarm_init` runs (or when an existing Swarm session is resumed via `agent/created`).
  const allSwarmTools = createSwarmTools(runtime)
  const entryTools = allSwarmTools.filter(t => t.name === 'swarm_init')
  const enabledToolServices = new WeakSet()

  let toolsRegistered = false
  function mountToolsOn(svc) {
    if (toolsRegistered || !svc || typeof svc.register !== 'function') return []
    toolsRegistered = true
    const list = []
    for (const tool of entryTools) {
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

  // Re-expose scoped Swarm tools automatically when an existing Swarm session is resumed
  const disposeAgentCreated = ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (!agent || typeof agent.id !== 'string') return
    if (store.exists(agent.id)) {
      runtime.activateCoordinatorMode(agent)
      runtime.enableSwarmToolsOnAgent(agent, 'coordinator')
      return
    }
    if (agent.id.includes('__')) {
      const prefix = agent.id.split('__')[0]
      if (prefix && store.exists(prefix)) {
        runtime.enableSwarmToolsOnAgent(agent, 'worker')
      }
    }
  })
  if (typeof disposeAgentCreated === 'function') disposers.push(disposeAgentCreated)

  // 6. Register `/swarm` human command via `ctx.inject(['commands'], ...)`
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

  // 7. Register HTTP routes `/api/dsh-swarm/state` & `/api/dsh-swarm/action` on `webServer`
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

  // 8. Register `swarm` SessionProjection via `ctx.get('sessionProjections')`
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
    for (const timer of pendingTelemetryFlushes.values()) clearTimeout(timer)
    pendingTelemetryFlushes.clear()
    for (const daemon of monitorDaemons.values()) daemon.stop()
    monitorDaemons.clear()
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  }, 'dsh-swarm: cleanup')

  log('active', {
    version: PLUGIN_VERSION,
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
