// Polite shared-cluster ConcurrencyGate for company internal models (glm5.3 / deepseek4.1f).
//
// Hooks into DSH's `llm/stream` waterfall event so that at most `effectiveLimit`
// (user-selected 1..6, default 2) model requests stream concurrently across the
// entire Swarm. Also enforces:
//   - 4-tier priority queue: P0 (Coordinator / main user session) > P1 (Verifier) >
//     P2 (Worker, fair least-recently-served) > P3 (Monitor)
//   - Aging promotion so P2/P3 requests never starve indefinitely
//   - Polite inter-request pacing (`minSpacingMs`) to avoid prefill burst spikes
//   - AIMD backoff on HTTP 429 / concurrency errors + `agent/request-error` retry

export const PRIORITY = Object.freeze({
  COORDINATOR: 0,
  VERIFIER: 1,
  WORKER: 2,
  MONITOR: 3,
})

/** Classify whether an LlmFailure or Error represents a concurrency / 429 limit. */
export function isConcurrencyFailure(failureOrError) {
  if (!failureOrError || typeof failureOrError !== 'object') return false
  const f = failureOrError.failure && typeof failureOrError.failure === 'object'
    ? failureOrError.failure
    : failureOrError
  if (f.status === 429 || f.status === 503) return true
  const code = typeof f.code === 'string' ? f.code.toUpperCase() : ''
  const msg = typeof f.message === 'string' ? f.message.toLowerCase() : ''
  return (
    code.includes('RATE_LIMIT')
    || code.includes('CONCURRENCY')
    || code.includes('OVERLOADED')
    || code.includes('TOO_MANY_REQUESTS')
    || msg.includes('concurrency')
    || msg.includes('too many requests')
    || msg.includes('rate limit')
  )
}

export class ConcurrencyGate {
  constructor(options = {}) {
    this.configuredLimit = Math.min(6, Math.max(1, Number(options.limit ?? 2)))
    this.effectiveLimit = this.configuredLimit
    this.minSpacingMs = Math.max(0, Number(options.minSpacingMs ?? 200))
    this.agingThresholdMs = Math.max(1_000, Number(options.agingThresholdMs ?? 15_000))
    this.increaseAfterSuccesses = Math.max(2, Number(options.increaseAfterSuccesses ?? 8))
    this.cooldownMs = Math.max(50, Number(options.cooldownMs ?? 1_500))

    this.activeCount = 0
    this.activeAgents = new Set() // agentId currently holding a permit
    this.queue = [] // { id, agentId, memberName, priority, enqueuedAt, signal, resolve, reject }
    this.lastServedAtByAgent = new Map() // agentId -> timestamp for fair round-robin
    this.lastDispatchTime = 0
    this.consecutiveSuccesses = 0
    this.rateLimitHits = 0
    this.cooldownUntil = 0
    this.nextTicketId = 1
    this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {}
  }

  setLimit(newLimit) {
    const clamped = Math.min(6, Math.max(1, Number(newLimit)))
    if (!Number.isInteger(clamped)) return this.configuredLimit
    this.configuredLimit = clamped
    this.effectiveLimit = clamped
    this._pump()
    this.onChange(this.snapshot())
    return this.configuredLimit
  }

  isQueued(agentId) {
    return this.queue.some(item => item.agentId === agentId)
  }

  queuePositionOf(agentId) {
    const idx = this.queue.findIndex(item => item.agentId === agentId)
    return idx === -1 ? 0 : idx + 1
  }

  isStreaming(agentId) {
    return this.activeAgents.has(agentId)
  }

  snapshot() {
    return {
      configuredLimit: this.configuredLimit,
      effectiveLimit: this.effectiveLimit,
      active: this.activeCount,
      queued: this.queue.length,
      queuedAgents: this.queue.map((q, i) => ({
        position: i + 1,
        agentId: q.agentId,
        memberName: q.memberName,
        priority: q.priority,
      })),
      rateLimitHits: this.rateLimitHits,
    }
  }

  // #FUNC Acquire one concurrency permit in priority + fair-aging order, honoring `AbortSignal`.
  // #NOT  Never leaks a permit or leaves a cancelled request in the wait queue when `signal` aborts.
  // #EDGE-IN Aborting `signal` while queued removes the waiter and rejects with AbortError → test_concurrency_gate_abort_releases_waiter
  // #EDGE-IN P0 Coordinator request jumps ahead of queued P2 Workers → test_concurrency_gate_priority_and_bounds
  // #WHY  `effectiveLimit` bounds concurrent in-flight streams so the Swarm never overwhelms the shared 4..6 concurrency model server.
  acquire({ agentId = 'unknown', memberName = 'unknown', priority = PRIORITY.WORKER, signal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }

    return new Promise((resolve, reject) => {
      const ticket = {
        id: this.nextTicketId++,
        agentId,
        memberName,
        priority,
        enqueuedAt: Date.now(),
        signal,
        onAbort: null,
        resolve,
        reject,
      }

      if (signal) {
        ticket.onAbort = () => {
          const idx = this.queue.indexOf(ticket)
          if (idx !== -1) {
            this.queue.splice(idx, 1)
            this.onChange(this.snapshot())
          }
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        signal.addEventListener('abort', ticket.onAbort, { once: true })
      }

      this.queue.push(ticket)
      this._sortQueue()
      this.onChange(this.snapshot())
      this._pump()
    })
  }

  _sortQueue() {
    const now = Date.now()
    this.queue.sort((a, b) => {
      const ageA = now - a.enqueuedAt >= this.agingThresholdMs ? Math.max(0, a.priority - 1) : a.priority
      const ageB = now - b.enqueuedAt >= this.agingThresholdMs ? Math.max(0, b.priority - 1) : b.priority
      if (ageA !== ageB) return ageA - ageB
      // Fair round-robin within the same priority: whoever was served longest ago goes first
      const lastA = this.lastServedAtByAgent.get(a.agentId) ?? 0
      const lastB = this.lastServedAtByAgent.get(b.agentId) ?? 0
      if (lastA !== lastB) return lastA - lastB
      return a.id - b.id
    })
  }

  _pump() {
    if (this.activeCount >= this.effectiveLimit || this.queue.length === 0) return
    const now = Date.now()
    const waitCooldown = Math.max(0, this.cooldownUntil - now)
    const waitSpacing = this.minSpacingMs > 0 && this.lastDispatchTime > 0
      ? Math.max(0, this.lastDispatchTime + this.minSpacingMs - now)
      : 0
    const delay = Math.max(waitCooldown, waitSpacing)

    if (delay > 0) {
      if (!this._timer) {
        this._timer = setTimeout(() => {
          this._timer = null
          this._pump()
        }, delay)
      }
      return
    }

    while (this.activeCount < this.effectiveLimit && this.queue.length > 0) {
      this._sortQueue()
      const ticket = this.queue.shift()
      if (!ticket) break
      if (ticket.signal && ticket.onAbort) {
        ticket.signal.removeEventListener('abort', ticket.onAbort)
      }
      if (ticket.signal?.aborted) {
        ticket.reject(ticket.signal.reason ?? new DOMException('Aborted', 'AbortError'))
        continue
      }

      this.activeCount += 1
      this.activeAgents.add(ticket.agentId)
      this.lastDispatchTime = Date.now()
      this.lastServedAtByAgent.set(ticket.agentId, this.lastDispatchTime)

      let released = false
      const lease = {
        ticketId: ticket.id,
        release: () => {
          if (released) return
          released = true
          this.activeCount = Math.max(0, this.activeCount - 1)
          this.activeAgents.delete(ticket.agentId)
          this.onChange(this.snapshot())
          this._pump()
        },
      }
      this.onChange(this.snapshot())
      ticket.resolve(lease)
      // If minSpacingMs > 0 and more items remain, schedule the next dispatch after minSpacingMs
      if (this.minSpacingMs > 0 && this.queue.length > 0 && this.activeCount < this.effectiveLimit) {
        this._pump()
        break
      }
    }
  }

  // #FUNC Record a 429 / concurrency rejection and apply AIMD multiplicative decrease.
  // #NOT  Never drops `effectiveLimit` below 1, so the swarm always makes forward progress.
  // #EDGE-IN Encountering HTTP 429 reduces `effectiveLimit` and recovers after `increaseAfterSuccesses` clean calls → test_concurrency_gate_aimd_backoff_and_recovery
  // #WHY  `effectiveLimit` adapts dynamically when colleagues share the same internal `glm5.3` / `deepseek4.1f` endpoint.
  onRateLimited(retryAfterMs) {
    this.rateLimitHits += 1
    this.consecutiveSuccesses = 0
    this.effectiveLimit = Math.max(1, Math.floor(this.effectiveLimit * 0.6))
    const waitMs = typeof retryAfterMs === 'number' && retryAfterMs > 0 ? retryAfterMs : this.cooldownMs
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + waitMs)
    this.onChange(this.snapshot())
  }

  onSuccess() {
    this.consecutiveSuccesses += 1
    if (this.effectiveLimit < this.configuredLimit && this.consecutiveSuccesses >= this.increaseAfterSuccesses) {
      this.effectiveLimit = Math.min(this.configuredLimit, this.effectiveLimit + 1)
      this.consecutiveSuccesses = 0
      this.onChange(this.snapshot())
      this._pump()
    }
  }

  /** Wrap a DSH `llm/stream` waterfall invocation with this concurrency gate. */
  wrapStream(options, next, meta = {}) {
    const gate = this
    return (async function* () {
      const lease = await gate.acquire({
        agentId: meta.agentId ?? 'unknown',
        memberName: meta.memberName ?? 'unknown',
        priority: meta.priority ?? PRIORITY.WORKER,
        signal: options?.signal,
      })
      let hitRateLimit = false
      let retryAfterMs
      try {
        const stream = next()
        for await (const chunk of stream) {
          if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
            if (isConcurrencyFailure(chunk.reason.failure)) {
              hitRateLimit = true
              retryAfterMs = chunk.reason.failure?.providerRetryAfterMs
            }
          }
          yield chunk
        }
        if (!hitRateLimit) gate.onSuccess()
      } catch (error) {
        if (isConcurrencyFailure(error)) {
          hitRateLimit = true
          retryAfterMs = error?.failure?.providerRetryAfterMs
        }
        throw error
      } finally {
        if (hitRateLimit) gate.onRateLimited(retryAfterMs)
        lease.release()
      }
    })()
  }
}
