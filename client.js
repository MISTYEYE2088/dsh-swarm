// dsh-swarm browser half, in the DSH classic-script combo artifact format.
//
// Served verbatim in `/plugins/??.../client.js`, so it MUST NOT contain any
// top-level ES module `import` or `export` statements or raw JSX.
//
// Mounts natively into DSH's Right Sidebar (`Crs0CG_rightbarCol` / `ui-sidebar-right`):
//   1. Registers `kind: 'swarm'` (`id: 'dsh-swarm'`) in `ctx.sidebarRightTabs`
//      with a Guide entry card ("Swarm 协作黑板").
//   2. Registers the interactive Swarm body into `sidebar.right.pane.tab` and
//      chip title into `sidebar.right.pane.tab.title`.
//   3. Registers a native DSH header trigger in `conversation.session.header.actions`
//      (matching `TeamAction.module.css` tokens) that toggles/opens the `'swarm'`
//      tab inside `Crs0CG_rightbarCol` via `ctx.sidebarRight.openTab('swarm')`.
//   4. Bridges live 4-file blackboard state via `/api/dsh-swarm/state` and
//      interactive actions via `/api/dsh-swarm/action`.

window.__ModuleLoader__.load({
  id: 'dsh-swarm',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var VERSION = '0.1.0'
    var LOG = '[dsh-swarm]'
    var SWARM_TAB_ID = 'dsh-swarm'
    var SWARM_TAB_KIND = 'swarm'

    var React = null
    var Primitives = null
    try { React = require('react') } catch (_e) {}
    try { Primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch (_e) {}

    var sidebarRightRef = null
    var uiWorkspaceRef = null

    function makeSource(initial) {
      var value = initial
      var listeners = new Set()
      return {
        getSnapshot: function () { return value },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        set: function (next) {
          value = next
          listeners.forEach(function (listener) {
            try { listener(value) } catch (_e) {}
          })
        },
      }
    }

    // dup-ok: browser classic-script board tokenizer distinct from smoke test harness
    // #FUNC Parse markdown board text into segments with clickable `#seq` floor pills and `@mention` badges.
    // #NOT  Does not execute untrusted HTML (`view.html` narrator was removed for zero-trust safety and 0 token cost).
    // #EDGE-IN Text containing `#5`, `@verifier`, and `@#render` produces typed `'ref'`, `'mention'`, and `'channel'` tokens → test_client_tokenize_board_text
    // #WHY  `#[1-9][0-9]*` tokens let the user click `#5` in `#21` to jump directly to the original evidence post.
    function tokenizeBoardText(text) {
      if (typeof text !== 'string' || text.length === 0) return []
      var tokens = []
      var regex = /(@#[a-z0-9][a-z0-9_-]*|@[a-z0-9][a-z0-9_-]*|#[1-9][0-9]*)/g
      var lastIndex = 0
      var match
      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          tokens.push({ kind: 'text', value: text.slice(lastIndex, match.index) })
        }
        var raw = match[1]
        if (raw.startsWith('@#')) {
          tokens.push({ kind: 'channel', value: raw, channel: raw.slice(2) })
        } else if (raw.startsWith('@')) {
          tokens.push({ kind: 'mention', value: raw, target: raw.slice(1) })
        } else {
          tokens.push({ kind: 'ref', value: raw, seq: Number(raw.slice(1)) })
        }
        lastIndex = regex.lastIndex
      }
      if (lastIndex < text.length) {
        tokens.push({ kind: 'text', value: text.slice(lastIndex) })
      }
      return tokens
    }

    // #FUNC Aggregate directed `@mention` edges up to `maxSeq` for the Graph tab's interactive timeline replay.
    // #NOT  Does not include posts with `seq > maxSeq` when the user scrubs the replay slider backward.
    // #EDGE-IN Scrubbing `maxSeq` to wave 1 excludes wave 2 edges and computes accurate per-direction weights → test_client_graph_replay_aggregation
    // #WHY  `maxSeq` filtering enables deterministic step-by-step replay of how workers and verifiers converged without any backend query.
    function computeGraphEdges(edgeEvents, maxSeq) {
      var limit = typeof maxSeq === 'number' && maxSeq > 0 ? maxSeq : Infinity
      var counts = new Map()
      var activeNodes = new Set()
      var list = Array.isArray(edgeEvents) ? edgeEvents : []

      for (var i = 0; i < list.length; i += 1) {
        var ev = list[i]
        if (!ev || typeof ev.seq !== 'number' || ev.seq > limit) continue
        activeNodes.add(ev.from)
        activeNodes.add(ev.to)
        var key = ev.from + '->' + ev.to
        var prev = counts.get(key)
        if (!prev) {
          counts.set(key, { from: ev.from, to: ev.to, count: 1, latestSeq: ev.seq })
        } else {
          prev.count += 1
          prev.latestSeq = ev.seq
        }
      }

      return {
        nodes: Array.from(activeNodes),
        edges: Array.from(counts.values()),
      }
    }

    var uiStore = makeSource({
      drawerOpen: false,
      activeTab: 'board', // 'board' | 'overview' | 'graph'
      filterMember: null,
      filterChannel: null,
      highlightedSeq: null,
      replaySeq: null, // null means LIVE (headSeq)
      composerText: '',
      composerChannel: 'main',
      posting: false,
      loading: false,
      selectedSwarmId: null,
      resolvedSwarmId: null,
      activeSessionId: null,
      swarmsList: [],
      globalConcurrency: null,
      snapshotsBySession: {},
      lastFetchedAt: 0,
    })

    function updateUi(patch) {
      var curr = uiStore.getSnapshot()
      var next = Object.assign({}, curr, typeof patch === 'function' ? patch(curr) : patch)
      uiStore.set(next)
      return next
    }

    /** Subscribe a React component to `uiStore` so clicks re-render immediately without waiting for a session switch. */
    function useUiState(props) {
      if (React && typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot, uiStore.getSnapshot)
      }
      if (props && typeof props.useSwarmUi === 'function') {
        try {
          return props.useSwarmUi(function (s) { return s })
        } catch (_e) {}
      }
      if (React && typeof React.useState === 'function' && typeof React.useEffect === 'function') {
        var pair = React.useState(uiStore.getSnapshot())
        var state = pair[0]
        var setState = pair[1]
        React.useEffect(function () {
          return uiStore.subscribe(function (next) {
            setState(next)
          })
        }, [])
        return state
      }
      return uiStore.getSnapshot()
    }

    /** Resolve the best snapshot for the current session or selected swarm. */
    function resolveSnapshot(ui, sessionId) {
      var map = ui.snapshotsBySession || {}
      if (ui.selectedSwarmId && map[ui.selectedSwarmId]) return map[ui.selectedSwarmId]
      if (sessionId && map[sessionId]) return map[sessionId]
      if (ui.resolvedSwarmId && map[ui.resolvedSwarmId]) return map[ui.resolvedSwarmId]
      if (ui.activeSessionId && map[ui.activeSessionId]) return map[ui.activeSessionId]
      var keys = Object.keys(map)
      return keys.length > 0 ? map[keys[keys.length - 1]] : null
    }

    /** Fetch live 4-file blackboard state from the Host `/api/dsh-swarm/state` route. */
    function fetchSwarmState(sessionId, explicitSwarmId) {
      if (typeof fetch !== 'function') return Promise.resolve(null)
      var curr = uiStore.getSnapshot()
      var sid = sessionId || curr.activeSessionId || ''
      var swId = explicitSwarmId || curr.selectedSwarmId || ''
      var query = '?sessionId=' + encodeURIComponent(sid) + (swId ? '&swarmId=' + encodeURIComponent(swId) : '')
      return fetch('/api/dsh-swarm/state' + query, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
        .then(function (res) {
          if (!res || !res.ok) return null
          return res.json()
        })
        .then(function (data) {
          if (!data || !data.ok) return null
          updateUi(function (prev) {
            var nextMap = Object.assign({}, prev.snapshotsBySession)
            if (data.snapshot) {
              if (data.resolvedSwarmId) nextMap[data.resolvedSwarmId] = data.snapshot
              if (sid) nextMap[sid] = data.snapshot
            }
            return {
              loading: false,
              activeSessionId: sid || prev.activeSessionId,
              resolvedSwarmId: data.resolvedSwarmId || prev.resolvedSwarmId,
              swarmsList: Array.isArray(data.swarms) ? data.swarms : prev.swarmsList,
              globalConcurrency: data.concurrency || prev.globalConcurrency,
              snapshotsBySession: nextMap,
              lastFetchedAt: Date.now(),
            }
          })
          return data
        })
        .catch(function () {
          return null
        })
    }

    /** Execute an interactive action (`post`, `concurrency`, `init`) on the Host `/api/dsh-swarm/action` route. */
    function postSwarmAction(payload) {
      if (typeof fetch !== 'function') return Promise.resolve({ ok: false })
      return fetch('/api/dsh-swarm/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) { return res.json() })
        .then(function (data) {
          if (data && data.ok && data.snapshot) {
            updateUi(function (prev) {
              var nextMap = Object.assign({}, prev.snapshotsBySession)
              var key = data.resolvedSwarmId || payload.swarmId || payload.sessionId || prev.resolvedSwarmId || 'default'
              nextMap[key] = data.snapshot
              if (prev.activeSessionId) nextMap[prev.activeSessionId] = data.snapshot
              return {
                resolvedSwarmId: data.resolvedSwarmId || prev.resolvedSwarmId,
                globalConcurrency: data.concurrency || data.snapshot.concurrency || prev.globalConcurrency,
                snapshotsBySession: nextMap,
                lastFetchedAt: Date.now(),
              }
            })
          }
          fetchSwarmState(payload.sessionId, payload.swarmId)
          return data
        })
        .catch(function (err) {
          return { ok: false, error: String(err) }
        })
    }

    /** Hook that auto-polls `/api/dsh-swarm/state` while a Swarm surface is mounted. */
    function useSwarmPolling(sessionId, selectedSwarmId, intervalMs) {
      if (!React || typeof React.useEffect !== 'function') return
      React.useEffect(function () {
        if (sessionId && uiStore.getSnapshot().activeSessionId !== sessionId) {
          updateUi({ activeSessionId: sessionId })
        }
        fetchSwarmState(sessionId, selectedSwarmId)
        var timer = setInterval(function () {
          fetchSwarmState(sessionId, uiStore.getSnapshot().selectedSwarmId)
        }, intervalMs || 2000)
        return function () { clearInterval(timer) }
      }, [sessionId, selectedSwarmId])
    }

    function renderDot(isRunning) {
      if (React && Primitives && Primitives.StateDot) {
        return React.createElement(Primitives.StateDot, {
          state: isRunning ? 'ongoing' : 'idle',
          size: 10,
        })
      }
      return React
        ? React.createElement('span', {
            style: {
              display: 'inline-block',
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: isRunning
                ? 'var(--dsw-alias-state-business-primary, #3b82f6)'
                : 'var(--dsw-alias-label-tertiary, #94a3b8)',
            },
          })
        : null
    }

    function renderUsersIcon(size) {
      var px = size || 14
      if (React && Primitives && Primitives.IconUsersOutlineRegular) {
        return React.createElement(Primitives.IconUsersOutlineRegular, {
          style: { width: px + 'px', height: px + 'px', flex: '0 0 auto' },
        })
      }
      return null
    }

    /** Open or toggle the `'swarm'` tab inside `Crs0CG_rightbarCol` (`ctx.sidebarRight`). */
    function toggleSwarmRightbar() {
      var ui = uiStore.getSnapshot()
      fetchSwarmState(ui.activeSessionId, ui.selectedSwarmId)
      if (sidebarRightRef && typeof sidebarRightRef.openTab === 'function') {
        try {
          var isExpanded = typeof sidebarRightRef.isExpanded === 'function' && sidebarRightRef.isExpanded()
          var activeTab = typeof sidebarRightRef.active === 'function' ? sidebarRightRef.active() : null
          if (isExpanded && activeTab && activeTab.kind === SWARM_TAB_KIND) {
            sidebarRightRef.toggleExpanded()
          } else {
            sidebarRightRef.openTab(SWARM_TAB_KIND)
          }
          return
        } catch (_err) {
          // Fall back to drawerOpen toggle if no session is mounted yet
        }
      }
      updateUi({ drawerOpen: !ui.drawerOpen })
    }

    /** Conversation header trigger button styled natively after `TeamAction.module.css`. */
    function SwarmHeaderAction(props) {
      if (!React) return null
      var ui = useUiState(props)
      var sessionId = (props && props.sessionId) || ui.activeSessionId || null
      useSwarmPolling(sessionId, ui.selectedSwarmId, 2500)

      var snap = resolveSnapshot(ui, sessionId)
      var conc = (snap && snap.concurrency) || ui.globalConcurrency || { active: 0, effectiveLimit: 4, queued: 0 }
      var headSeq = snap ? (snap.headSeq || 0) : 0
      var memberCount = snap && Array.isArray(snap.members)
        ? snap.members.filter(function (m) { return !m.killed }).length
        : 0
      var isWorking = conc.active > 0 || conc.queued > 0
      var isRightbarSwarmActive = false
      try {
        if (sidebarRightRef && typeof sidebarRightRef.isExpanded === 'function' && sidebarRightRef.isExpanded()) {
          var act = typeof sidebarRightRef.active === 'function' ? sidebarRightRef.active() : null
          isRightbarSwarmActive = Boolean(act && act.kind === SWARM_TAB_KIND)
        }
      } catch (_e) {}
      var isOpen = isRightbarSwarmActive || ui.drawerOpen

      return React.createElement(
        'button',
        {
          type: 'button',
          'aria-expanded': isOpen,
          onClick: toggleSwarmRightbar,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            minHeight: '28px',
            padding: '3px 8px',
            border: '0',
            borderRadius: '6px',
            background: isOpen ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            color: isWorking
              ? 'var(--dsw-alias-label-primary)'
              : isOpen
                ? 'var(--dsw-alias-label-secondary)'
                : 'var(--dsw-alias-label-tertiary)',
            font: 'inherit',
            fontSize: '12px',
            lineHeight: 1,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          },
          title: '在右侧栏打开 Swarm 协作黑板 (/swarm)',
        },
        renderUsersIcon(14),
        renderDot(isWorking),
        React.createElement('span', { style: { fontWeight: 500 } }, 'Swarm'),
        snap
          ? React.createElement(
              'span',
              {
                style: {
                  color: 'var(--dsw-alias-label-tertiary)',
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              memberCount + '人 · ' + conc.active + '/' + conc.effectiveLimit + '并发 · #' + headSeq,
            )
          : null,
      )
    }

    /** Rightbar tab chip title (`sidebar.right.pane.tab.title`). */
    function SwarmRightbarTitle(props) {
      if (!React) return null
      var ui = useUiState(props)
      var snap = resolveSnapshot(ui, props && props.sessionId)
      var headSeq = snap ? (snap.headSeq || 0) : 0
      return React.createElement(
        React.Fragment,
        null,
        renderUsersIcon(15),
        React.createElement(
          'span',
          { style: { marginLeft: '4px' } },
          'Swarm' + (headSeq > 0 ? ' (#' + headSeq + ')' : ''),
        ),
      )
    }

    function renderOverviewTab(snap, ui, targetSwarmId) {
      var conc = (snap && snap.concurrency) || ui.globalConcurrency || {
        active: 0,
        effectiveLimit: 4,
        configuredLimit: 4,
        queued: 0,
        rateLimitHits: 0,
      }
      var members = snap && Array.isArray(snap.members) ? snap.members : []
      var plan = snap && snap.plan ? snap.plan : null
      var screenshots = snap && Array.isArray(snap.screenshots) ? snap.screenshots : []

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        // Concurrency control card
        React.createElement(
          'div',
          {
            style: {
              padding: '10px 12px',
              borderRadius: '8px',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } },
            React.createElement(
              'span',
              { style: { fontWeight: 600, fontSize: '12px', color: 'var(--dsw-alias-label-primary)' } },
              '并发调度池 (Concurrency Gate)',
            ),
            React.createElement(
              'span',
              { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' } },
              '活跃 ' + conc.active + ' / 上限 ' + conc.effectiveLimit + ' · 排队 ' + conc.queued,
            ),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' } },
            React.createElement(
              'span',
              { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginRight: '4px' } },
              '动态调整并发度:',
            ),
            [2, 4, 6, 8, 12, 16].map(function (n) {
              var isCurrent = conc.configuredLimit === n
              return React.createElement(
                'button',
                {
                  key: n,
                  type: 'button',
                  onClick: function () {
                    postSwarmAction({ action: 'concurrency', swarmId: targetSwarmId, limit: n })
                  },
                  style: {
                    padding: '2px 8px',
                    borderRadius: '4px',
                    border: isCurrent
                      ? '1px solid var(--dsw-alias-state-business-primary)'
                      : '0.5px solid var(--dsw-alias-border-l2)',
                    background: isCurrent ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-3)',
                    color: isCurrent ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                    fontSize: '11px',
                    fontWeight: isCurrent ? 600 : 400,
                    cursor: 'pointer',
                  },
                },
                String(n),
              )
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  postSwarmAction({
                    action: 'concurrency',
                    swarmId: targetSwarmId,
                    limit: Math.max(1, (conc.configuredLimit || 4) + 2),
                  })
                },
                style: {
                  padding: '2px 7px',
                  borderRadius: '4px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-3)',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: '11px',
                  cursor: 'pointer',
                },
                title: '增加 2 个并发槽',
              },
              '+2',
            ),
          ),
        ),
        // Plan & Tracks card
        plan
          ? React.createElement(
              'div',
              {
                style: {
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                },
              },
              React.createElement(
                'div',
                { style: { fontWeight: 600, fontSize: '12px', marginBottom: '4px', color: 'var(--dsw-alias-label-primary)' } },
                '任务规划 (Wave ' + (plan.current_wave || 1) + ')',
              ),
              React.createElement(
                'div',
                { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '8px' } },
                plan.goal,
              ),
              Array.isArray(plan.tracks) && plan.tracks.length > 0
                ? plan.tracks.map(function (t, idx) {
                    return React.createElement(
                      'div',
                      {
                        key: idx,
                        style: {
                          fontSize: '12px',
                          padding: '5px 0',
                          borderTop: '0.5px solid var(--dsw-alias-border-l3)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '6px',
                        },
                      },
                      React.createElement(
                        'span',
                        { style: { color: 'var(--dsw-alias-label-primary)' } },
                        t.name + ' (@' + t.owner + ') · ' + t.status,
                      ),
                      React.createElement(
                        'span',
                        null,
                        Array.isArray(t.evidence_seqs)
                          ? t.evidence_seqs.map(function (seq) {
                              return React.createElement(
                                'button',
                                {
                                  key: seq,
                                  type: 'button',
                                  onClick: function () { updateUi({ activeTab: 'board', highlightedSeq: seq }) },
                                  style: {
                                    marginLeft: '4px',
                                    padding: '1px 6px',
                                    borderRadius: '4px',
                                    border: '0.5px solid var(--dsw-alias-border-l2)',
                                    background: 'var(--dsw-alias-bg-layer-3)',
                                    color: 'var(--dsw-alias-state-business-primary)',
                                    cursor: 'pointer',
                                    fontSize: '11px',
                                  },
                                },
                                '#' + seq,
                              )
                            })
                          : null,
                      ),
                    )
                  })
                : null,
            )
          : null,
        // Roster list
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          React.createElement(
            'div',
            { style: { fontWeight: 600, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
            '成员花名册 (' + members.length + ')',
          ),
          members.length === 0
            ? React.createElement(
                'div',
                { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' } },
                '尚未派生子成员。使用 /swarm <任务> 启动后，Coordinator 将在此处注册成员。',
              )
            : members.map(function (m) {
                var isRunning = m.status === 'working' || m.status === 'queued'
                return React.createElement(
                  'div',
                  {
                    key: m.name,
                    style: {
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: '0.5px solid var(--dsw-alias-border-l2)',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      opacity: m.killed ? 0.55 : 1,
                      fontSize: '12px',
                    },
                  },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' } },
                    React.createElement(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 } },
                      renderDot(isRunning),
                      React.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, '@' + m.name),
                      React.createElement(
                        'span',
                        {
                          style: {
                            fontSize: '11px',
                            fontWeight: 400,
                            padding: '0 6px',
                            borderRadius: '4px',
                            background: 'var(--dsw-alias-bg-layer-3)',
                            color: 'var(--dsw-alias-label-secondary)',
                          },
                        },
                        m.role,
                      ),
                    ),
                    React.createElement(
                      'span',
                      { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } },
                      m.status + (m.applied_model ? ' · ' + m.applied_model : ''),
                    ),
                  ),
                  React.createElement(
                    'div',
                    { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '4px', fontVariantNumeric: 'tabular-nums' } },
                    (m.stepSummary ? m.stepSummary + ' · ' : '')
                      + 'read:#' + m.last_read_seq
                      + ' wait:#' + m.wait_since
                      + ' post:#' + m.last_post_seq
                      + (m.last_park_blocked_seq ? ' blocked:#' + m.last_park_blocked_seq : ''),
                  ),
                  React.createElement(
                    'div',
                    { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        onClick: function () { updateUi({ activeTab: 'board', filterMember: m.name }) },
                        style: {
                          padding: '2px 8px',
                          borderRadius: '4px',
                          border: '0.5px solid var(--dsw-alias-border-l2)',
                          background: 'var(--dsw-alias-bg-layer-3)',
                          color: 'var(--dsw-alias-label-secondary)',
                          fontSize: '11px',
                          cursor: 'pointer',
                        },
                      },
                      '查看相关帖',
                    ),
                    m.session_id && uiWorkspaceRef && typeof uiWorkspaceRef.openSession === 'function'
                      ? React.createElement(
                          'button',
                          {
                            type: 'button',
                            onClick: function () {
                              try { uiWorkspaceRef.openSession(m.session_id) } catch (_e) {}
                            },
                            style: {
                              padding: '2px 8px',
                              borderRadius: '4px',
                              border: '0.5px solid var(--dsw-alias-border-l2)',
                              background: 'var(--dsw-alias-bg-layer-3)',
                              color: 'var(--dsw-alias-state-business-primary)',
                              fontSize: '11px',
                              cursor: 'pointer',
                            },
                          },
                          '跳转子会话',
                        )
                      : null,
                  ),
                )
              }),
        ),
        screenshots.length > 0
          ? React.createElement(
              'div',
              {
                style: {
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                },
              },
              React.createElement('div', { style: { fontWeight: 600, fontSize: '12px', marginBottom: '6px' } }, '截图时间线 (' + screenshots.length + ')'),
              screenshots.map(function (sc, idx) {
                return React.createElement(
                  'div',
                  { key: idx, style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '4px' } },
                  '#' + sc.seq + ' @' + sc.agent + ': ' + sc.caption + ' (' + sc.path + ')',
                )
              }),
            )
          : null,
      )
    }

    function renderBoardTab(snap, ui) {
      var posts = snap && Array.isArray(snap.posts) ? snap.posts : []
      var filtered = posts.filter(function (p) {
        if (!p || p.type === 'control') return false
        if (ui.filterChannel && (p.channel || 'main') !== ui.filterChannel) return false
        if (ui.filterMember) {
          var m = ui.filterMember
          var mentions = Array.isArray(p.mentions) ? p.mentions : []
          if (p.agent !== m && mentions.indexOf(m) === -1) return false
        }
        return true
      })

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        ui.filterMember || ui.filterChannel
          ? React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '12px',
                  padding: '5px 10px',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  borderRadius: '6px',
                },
              },
              React.createElement(
                'span',
                { style: { color: 'var(--dsw-alias-label-secondary)' } },
                '当前筛选: ' + (ui.filterMember ? '@' + ui.filterMember : '') + ' ' + (ui.filterChannel ? '#' + ui.filterChannel : ''),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: function () { updateUi({ filterMember: null, filterChannel: null }) },
                  style: {
                    padding: '2px 8px',
                    borderRadius: '4px',
                    border: '0.5px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-layer-3)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: '11px',
                    cursor: 'pointer',
                  },
                },
                '清除筛选',
              ),
            )
          : null,
        filtered.length === 0
          ? React.createElement(
              'div',
              {
                style: {
                  padding: '16px 12px',
                  borderRadius: '8px',
                  border: '0.5px dashed var(--dsw-alias-border-l2)',
                  color: 'var(--dsw-alias-label-tertiary)',
                  fontSize: '12px',
                  textAlign: 'center',
                },
              },
              '黑板暂无帖子。可在下方输入框直接发帖（如 @worker-1 或 @coordinator），或在主输入框执行 /swarm <任务>。',
            )
          : filtered.map(function (p) {
              var isHighlighted = ui.highlightedSeq === p.seq
              var tokens = tokenizeBoardText(p.text)
              return React.createElement(
                'div',
                {
                  key: p.seq,
                  style: {
                    padding: '9px 11px',
                    borderRadius: '8px',
                    border: isHighlighted
                      ? '1px solid var(--dsw-alias-state-business-primary)'
                      : '0.5px solid var(--dsw-alias-border-l2)',
                    background: isHighlighted ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-2)',
                    fontSize: '12px',
                  },
                },
                React.createElement(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '5px',
                      color: 'var(--dsw-alias-label-secondary)',
                      fontSize: '11px',
                    },
                  },
                  React.createElement(
                    'span',
                    { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                    '#' + p.seq + ' · @' + p.agent + (p.channel && p.channel !== 'main' ? ' [#' + p.channel + ']' : '') + (p.kind ? ' (' + p.kind + ')' : ''),
                  ),
                  React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, p.time || ''),
                ),
                React.createElement(
                  'div',
                  { style: { whiteSpace: 'pre-wrap', lineHeight: 1.55, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' } },
                  tokens.map(function (tok, idx) {
                    if (tok.kind === 'ref') {
                      return React.createElement(
                        'button',
                        {
                          key: idx,
                          type: 'button',
                          onClick: function () { updateUi({ highlightedSeq: tok.seq }) },
                          style: {
                            display: 'inline-block',
                            padding: '0 6px',
                            margin: '0 2px',
                            borderRadius: '4px',
                            background: 'var(--dsw-alias-bg-layer-3)',
                            color: 'var(--dsw-alias-state-business-primary)',
                            border: '0.5px solid var(--dsw-alias-border-l2)',
                            cursor: 'pointer',
                            fontSize: '11px',
                            fontWeight: 500,
                          },
                        },
                        tok.value,
                      )
                    }
                    if (tok.kind === 'mention') {
                      return React.createElement(
                        'button',
                        {
                          key: idx,
                          type: 'button',
                          onClick: function () { updateUi({ filterMember: tok.target }) },
                          style: {
                            display: 'inline-block',
                            padding: '0 6px',
                            margin: '0 2px',
                            borderRadius: '4px',
                            background: 'var(--dsw-alias-bg-layer-3)',
                            color: 'var(--dsw-alias-label-primary)',
                            border: '0.5px solid var(--dsw-alias-border-l2)',
                            cursor: 'pointer',
                            fontSize: '11px',
                            fontWeight: 600,
                          },
                        },
                        tok.value,
                      )
                    }
                    if (tok.kind === 'channel') {
                      return React.createElement(
                        'button',
                        {
                          key: idx,
                          type: 'button',
                          onClick: function () { updateUi({ filterChannel: tok.channel }) },
                          style: {
                            display: 'inline-block',
                            padding: '0 6px',
                            margin: '0 2px',
                            borderRadius: '4px',
                            background: 'var(--dsw-alias-bg-layer-3)',
                            color: 'var(--dsw-alias-label-secondary)',
                            border: '0.5px solid var(--dsw-alias-border-l2)',
                            cursor: 'pointer',
                            fontSize: '11px',
                          },
                        },
                        tok.value,
                      )
                    }
                    return React.createElement('span', { key: idx }, tok.value)
                  }),
                ),
              )
            }),
      )
    }

    function renderGraphTab(snap, ui) {
      var headSeq = (snap && snap.headSeq) || 1
      var maxSeq = ui.replaySeq !== null ? ui.replaySeq : headSeq
      var graph = computeGraphEdges((snap && snap.edgeEvents) || [], maxSeq)

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '12px',
              padding: '8px 10px',
              borderRadius: '8px',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
          React.createElement(
            'span',
            { style: { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } },
            '回放 #1..#' + maxSeq,
          ),
          React.createElement('input', {
            type: 'range',
            min: 1,
            max: Math.max(1, headSeq),
            value: maxSeq,
            onChange: function (e) { updateUi({ replaySeq: Number(e.target.value) }) },
            style: { flex: 1 },
          }),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: function () { updateUi({ replaySeq: null }) },
              style: {
                cursor: 'pointer',
                padding: '2px 8px',
                borderRadius: '4px',
                border: '0.5px solid var(--dsw-alias-border-l2)',
                background: ui.replaySeq === null ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-3)',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: '11px',
              },
            },
            ui.replaySeq === null ? '● 实时' : '回到最新',
          ),
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' } },
          graph.edges.length === 0
            ? React.createElement(
                'div',
                { style: { color: 'var(--dsw-alias-label-tertiary)', padding: '12px', textAlign: 'center' } },
                '当前楼层范围内暂无 @mention 协作边',
              )
            : graph.edges.map(function (edge, idx) {
                return React.createElement(
                  'div',
                  {
                    key: idx,
                    onClick: function () { updateUi({ activeTab: 'board', highlightedSeq: edge.latestSeq }) },
                    style: {
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      border: '0.5px solid var(--dsw-alias-border-l2)',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      cursor: 'pointer',
                    },
                  },
                  React.createElement(
                    'span',
                    { style: { fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
                    '@' + edge.from + ' ───► @' + edge.to,
                  ),
                  React.createElement(
                    'span',
                    { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } },
                    edge.count + ' 次点名 (最新 #' + edge.latestSeq + ')',
                  ),
                )
              }),
        ),
      )
    }

    /** Shared inner surface used both inside `Crs0CG_rightbarCol` (`SwarmRightbarTab`) and the fallback drawer. */
    function renderSwarmSurface(ui, sessionId, isFallbackDrawer) {
      var snap = resolveSnapshot(ui, sessionId)
      var targetSwarmId = (snap && snap.swarm && snap.swarm.swarm_id)
        || ui.selectedSwarmId
        || ui.resolvedSwarmId
        || sessionId
        || 'default-swarm'
      var swarmsList = Array.isArray(ui.swarmsList) ? ui.swarmsList : []

      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flex: '1 1 auto',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
            lineHeight: 1.5,
          },
        },
        // 38px sub-header aligned with DSH conversation header and FilesBody.module.css `.header`
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              flex: '0 0 auto',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '6px',
              boxSizing: 'border-box',
              height: '38px',
              padding: '0 8px 0 12px',
              borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
            [
              { id: 'board', label: '黑板' },
              { id: 'overview', label: '总览' },
              { id: 'graph', label: '拓扑' },
            ].map(function (tab) {
              var active = ui.activeTab === tab.id
              return React.createElement(
                'button',
                {
                  key: tab.id,
                  type: 'button',
                  'aria-pressed': active,
                  onClick: function () { updateUi({ activeTab: tab.id }) },
                  style: {
                    padding: '4px 9px',
                    borderRadius: 'var(--dsw-radius-sm, 4px)',
                    border: 'none',
                    background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                    color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
                    fontWeight: active ? 600 : 400,
                    fontSize: '12px',
                    cursor: 'pointer',
                  },
                },
                tab.label,
              )
            }),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
            swarmsList.length > 1
              ? React.createElement(
                  'select',
                  {
                    value: targetSwarmId,
                    onChange: function (e) {
                      var val = e.target.value
                      updateUi({ selectedSwarmId: val })
                      fetchSwarmState(sessionId, val)
                    },
                    style: {
                      maxWidth: '130px',
                      height: '24px',
                      fontSize: '11px',
                      borderRadius: '4px',
                      border: '0.5px solid var(--dsw-alias-border-l2)',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  swarmsList.map(function (item) {
                    return React.createElement(
                      'option',
                      { key: item.swarm_id, value: item.swarm_id },
                      (item.title || item.swarm_id).slice(0, 22),
                    )
                  }),
                )
              : null,
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  updateUi({ loading: true })
                  fetchSwarmState(sessionId, ui.selectedSwarmId)
                },
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '28px',
                  height: '28px',
                  padding: '6px',
                  color: 'var(--dsw-alias-label-secondary)',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 'var(--dsw-radius-sm, 4px)',
                  cursor: 'pointer',
                },
                title: '刷新黑板状态',
              },
              Primitives && Primitives.IconRefreshOutlineRegular
                ? React.createElement(Primitives.IconRefreshOutlineRegular, { style: { width: '15px', height: '15px' } })
                : '↻',
            ),
            isFallbackDrawer
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: function () { updateUi({ drawerOpen: false }) },
                    style: {
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '28px',
                      height: '28px',
                      color: 'var(--dsw-alias-label-secondary)',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                    },
                    title: '关闭',
                  },
                  '✕',
                )
              : null,
          ),
        ),
        // Scrollable body
        React.createElement(
          'div',
          {
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              overflow: 'auto',
              padding: '10px 12px',
              scrollbarGutter: 'stable',
            },
          },
          !snap
            ? React.createElement(
                'div',
                {
                  style: {
                    padding: '16px 14px',
                    borderRadius: '8px',
                    border: '0.5px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-layer-2)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  },
                },
                React.createElement(
                  'div',
                  { style: { fontWeight: 600, fontSize: '13px', color: 'var(--dsw-alias-label-primary)' } },
                  '当前会话尚未初始化 Swarm 黑板',
                ),
                React.createElement(
                  'div',
                  { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
                  '你可以在对话输入框中输入 /swarm <任务描述> 启动多智能体协作，或点击下方按钮立即为当前会话创建黑板：',
                ),
                React.createElement(
                  'div',
                  { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                  [4, 6, 8].map(function (limit) {
                    return React.createElement(
                      'button',
                      {
                        key: limit,
                        type: 'button',
                        onClick: function () {
                          postSwarmAction({
                            action: 'init',
                            sessionId: sessionId,
                            swarmId: targetSwarmId,
                            title: 'Swarm 协作任务',
                            concurrency_limit: limit,
                          })
                        },
                        style: {
                          padding: '5px 10px',
                          borderRadius: '6px',
                          border: '0.5px solid var(--dsw-alias-border-l2)',
                          background: 'var(--dsw-alias-bg-layer-3)',
                          color: 'var(--dsw-alias-label-primary)',
                          fontSize: '12px',
                          cursor: 'pointer',
                        },
                      },
                      '初始化 (' + limit + ' 并发)',
                    )
                  }),
                ),
              )
            : ui.activeTab === 'overview'
              ? renderOverviewTab(snap, ui, targetSwarmId)
              : ui.activeTab === 'graph'
                ? renderGraphTab(snap, ui)
                : renderBoardTab(snap, ui),
        ),
        // Interactive bottom board message composer
        ui.activeTab === 'board'
          ? React.createElement(
              'div',
              {
                style: {
                  flex: '0 0 auto',
                  display: 'flex',
                  gap: '6px',
                  padding: '8px 12px',
                  borderTop: '0.5px solid var(--dsw-alias-border-l3)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                },
              },
              React.createElement('input', {
                type: 'text',
                value: ui.composerText || '',
                placeholder: '发帖到黑板 (如: @verifier 请核查 #1)...',
                onChange: function (e) { updateUi({ composerText: e.target.value }) },
                onKeyDown: function (e) {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    var txt = String(uiStore.getSnapshot().composerText || '').trim()
                    if (!txt) return
                    updateUi({ composerText: '', posting: true })
                    postSwarmAction({
                      action: 'post',
                      sessionId: sessionId,
                      swarmId: targetSwarmId,
                      text: txt,
                      channel: ui.filterChannel || 'main',
                    }).then(function () { updateUi({ posting: false }) })
                  }
                },
                style: {
                  flex: 1,
                  minWidth: 0,
                  height: '30px',
                  padding: '0 10px',
                  borderRadius: '6px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontSize: '12px',
                },
              }),
              React.createElement(
                'button',
                {
                  type: 'button',
                  disabled: ui.posting,
                  onClick: function () {
                    var txt = String(uiStore.getSnapshot().composerText || '').trim()
                    if (!txt) return
                    updateUi({ composerText: '', posting: true })
                    postSwarmAction({
                      action: 'post',
                      sessionId: sessionId,
                      swarmId: targetSwarmId,
                      text: txt,
                      channel: ui.filterChannel || 'main',
                    }).then(function () { updateUi({ posting: false }) })
                  },
                  style: {
                    height: '30px',
                    padding: '0 12px',
                    borderRadius: '6px',
                    border: '0.5px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-layer-3)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: '12px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  },
                },
                '发送',
              ),
            )
          : null,
      )
    }

    /** Primary Rightbar Tab component mounted inside `Crs0CG_rightbarCol` (`sidebar.right.pane.tab`). */
    function SwarmRightbarTab(props) {
      if (!React) return null
      var ui = useUiState(props)
      var sessionId = (props && props.sessionId) || ui.activeSessionId || null
      useSwarmPolling(sessionId, ui.selectedSwarmId, 1800)

      // Bind native rightbar tab refresh command when `useTabInfo` is provided
      if (props && typeof props.useTabInfo === 'function' && typeof React.useEffect === 'function') {
        try {
          var tabInfo = props.useTabInfo()
          React.useEffect(function () {
            if (tabInfo && tabInfo.tab && tabInfo.tab.actions && typeof tabInfo.tab.actions.bindCommands === 'function') {
              return tabInfo.tab.actions.bindCommands({
                refresh: function () {
                  fetchSwarmState(sessionId, uiStore.getSnapshot().selectedSwarmId)
                },
              })
            }
            return undefined
          }, [sessionId])
        } catch (_e) {}
      }

      return renderSwarmSurface(ui, sessionId, false)
    }

    /** Fallback drawer shown only if `sidebarRight` is not mounted in a custom shell. */
    function SwarmOverlayDrawer(props) {
      if (!React) return null
      var ui = useUiState(props)
      if (!ui.drawerOpen) return null
      var sessionId = (props && props.sessionId) || ui.activeSessionId || null

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            top: '48px',
            right: '12px',
            bottom: '16px',
            width: '400px',
            zIndex: 9000,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '10px',
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: 'var(--dsw-elevation-panel)',
            overflow: 'hidden',
          },
        },
        renderSwarmSurface(ui, sessionId, true),
      )
    }

    // dup-ok: client-half Cordis entry point distinct from host-half index.js apply
    // #FUNC Cordis client entry point: mount the Swarm Board UI into the right sidebar (`Crs0CG_rightbarCol`) without risking page boot failure.
    // #NOT  Does not inject host-only services like `timer`, and never rethrows from `apply`.
    // #WHY  Wrapping `startClient` in a `catch` ensures a browser slot change cannot block the rest of the classic-script combo.
    function apply(ctx) {
      try {
        startClient(ctx)
      } catch (error) {
        console.error(LOG, 'could not start client half; page is unaffected:', error)
      }
    }

    function mountRightbarTab(sctx) {
      var tabsSvc = sctx.sidebarRightTabs || (typeof sctx.get === 'function' ? sctx.get('sidebarRightTabs') : null)
      var ctrlSvc = sctx.sidebarRight || (typeof sctx.get === 'function' ? sctx.get('sidebarRight') : null)
      var slotsSvc = sctx.slots || (typeof sctx.get === 'function' ? sctx.get('slots') : null)
      if (ctrlSvc) sidebarRightRef = ctrlSvc
      if (!tabsSvc || !slotsSvc) return

      sctx.effect(function () {
        return tabsSvc.register({
          id: SWARM_TAB_ID,
          kind: SWARM_TAB_KIND,
          keepMounted: true,
          title: function () { return 'Swarm' },
          guide: [
            {
              id: 'swarm-board',
              order: 35,
              title: function () { return 'Swarm 协作黑板' },
              description: function () { return '多智能体共享黑板 (board.jsonl)、花名册 (members.json) 与拓扑回放' },
              icon: Primitives && Primitives.IconUsersOutlineRegular ? Primitives.IconUsersOutlineRegular : undefined,
            },
          ],
        })
      }, 'dsh-swarm: rightbar tab type')

      sctx.effect(function () {
        return slotsSvc.inject('sidebar.right.pane.tab', function () {
          return slotsSvc.register(
            {
              name: 'sidebar.right.pane.tab',
              key: SWARM_TAB_ID,
              inject: function () { return { hooks: { swarmUi: uiStore } } },
            },
            SwarmRightbarTab,
          )
        })
      }, 'dsh-swarm: rightbar tab body')

      sctx.effect(function () {
        return slotsSvc.inject('sidebar.right.pane.tab.title', function () {
          return slotsSvc.register(
            {
              name: 'sidebar.right.pane.tab.title',
              key: SWARM_TAB_ID,
              inject: function () { return { hooks: { swarmUi: uiStore } } },
            },
            SwarmRightbarTitle,
          )
        })
      }, 'dsh-swarm: rightbar tab title')
    }

    function startClient(ctx) {
      var disposers = []

      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], function (sctx) {
          mountRightbarTab(sctx)
        })
        ctx.inject(['uiWorkspace'], function (wctx) {
          uiWorkspaceRef = wctx.uiWorkspace || (typeof wctx.get === 'function' ? wctx.get('uiWorkspace') : null)
        })
      } else if (typeof ctx.get === 'function' && ctx.get('sidebarRightTabs')) {
        mountRightbarTab(ctx)
      }

      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('conversation.session.header.actions', function () {
          var d = ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'dsh-swarm-header-pill',
              order: -15,
              inject: function () { return { hooks: { swarmUi: uiStore } } },
            },
            SwarmHeaderAction,
          )
          if (typeof d === 'function') disposers.push(d)
        })

        ctx.slots.inject('shell.overlay', function () {
          var d = ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-swarm-overlay-drawer',
              order: 10,
              inject: function () { return { hooks: { swarmUi: uiStore } } },
            },
            SwarmOverlayDrawer,
          )
          if (typeof d === 'function') disposers.push(d)
        })
      }

      if (typeof window !== 'undefined') {
        window.dshSwarm = {
          version: VERSION,
          tokenizeBoardText: tokenizeBoardText,
          computeGraphEdges: computeGraphEdges,
          getState: function () { return uiStore.getSnapshot() },
          refresh: function (sessionId) { return fetchSwarmState(sessionId) },
          pushSnapshot: function (sessionId, snapshot) {
            updateUi(function (curr) {
              var nextMap = Object.assign({}, curr.snapshotsBySession)
              nextMap[sessionId] = snapshot
              return {
                activeSessionId: curr.activeSessionId || sessionId,
                snapshotsBySession: nextMap,
              }
            })
          },
          openDrawer: function (tab) {
            if (tab) updateUi({ activeTab: tab })
            toggleSwarmRightbar()
          },
          closeDrawer: function () {
            if (sidebarRightRef && typeof sidebarRightRef.isExpanded === 'function' && sidebarRightRef.isExpanded()) {
              sidebarRightRef.toggleExpanded()
            }
            updateUi({ drawerOpen: false })
          },
        }
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            for (var i = 0; i < disposers.length; i += 1) {
              try { disposers[i]() } catch (_e) {}
            }
            sidebarRightRef = null
            uiWorkspaceRef = null
            if (typeof window !== 'undefined') delete window.dshSwarm
          }
        }, 'dsh-swarm: client cleanup')
      }

      console.info(LOG, 'client active', VERSION)
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.tokenizeBoardText = tokenizeBoardText
    exports.computeGraphEdges = computeGraphEdges
    return module.exports
  },
})
