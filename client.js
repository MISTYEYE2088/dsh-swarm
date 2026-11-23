// dsh-swarm browser half, in the DSH classic-script combo artifact format.
//
// Served verbatim in `/plugins/??.../client.js`, so it MUST NOT contain any
// top-level ES module `import` or `export` statements or raw JSX.
// Strictly English-only UI labels so no CJK strings leak into the plugin.
//
// Mounts natively into DSH's Right Sidebar (`Crs0CG_rightbarCol` / `ui-sidebar-right`):
//   1. Registers `kind: 'swarm'` (`id: 'dsh-swarm'`) in `ctx.sidebarRightTabs`.
//   2. Renders collapsible title-only board cards (expanded on demand via a
//      toggle button placed immediately to the right of each timestamp).
//   3. Renders an interactive Round-Table SVG Topology where the latest round's
//      arrows are bright yellow and older steps progressively darken and fade out.

window.__ModuleLoader__.load({
  id: 'dsh-swarm',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var VERSION = '0.3.1'
    var LOG = '[dsh-swarm]'
    var SWARM_TAB_ID = 'dsh-swarm'
    var SWARM_TAB_KIND = 'swarm'
    var MAX_VISIBLE_EDGE_STEPS = 8

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

    function derivePostTitle(post) {
      if (post && typeof post.title === 'string' && post.title.trim().length > 0) {
        return post.title.trim()
      }
      var raw = post && typeof post.text === 'string' ? post.text : ''
      var lines = raw.split('\n')
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i].trim()
        if (line.length > 0) {
          var cleaned = line.replace(/^(?:@#?[a-z0-9][a-z0-9_-]*\s*)+/i, '').replace(/^#+\s*/, '').trim()
          return (cleaned.length >= 4 ? cleaned : line).slice(0, 96)
        }
      }
      return (post && post.kind ? post.kind + ' update' : 'Board message')
    }

    // dup-ok: browser classic-script board tokenizer distinct from smoke test harness
    // #FUNC Parse markdown board text into segments with clickable `#seq` floor pills and `@mention` badges.
    // #NOT  Does not execute untrusted HTML (`view.html` narrator was removed for zero-trust safety and 0 token cost).
    // #EDGE-IN Text containing `#5`, `@verifier`, and `@#render` produces typed `'ref'`, `'mention'`, and `'channel'` tokens → test_client_tokenize_board_text
    // #WHY  `#[1-9][0-9]*` tokens let the user click `#5` in `#21` to jump directly to and expand the original evidence post.
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
          counts.set(key, { from: ev.from, to: ev.to, count: 1, latestSeq: ev.seq, title: ev.title || '' })
        } else {
          prev.count += 1
          prev.latestSeq = ev.seq
          if (ev.title) prev.title = ev.title
        }
      }

      return {
        nodes: Array.from(activeNodes),
        edges: Array.from(counts.values()),
      }
    }

    // #FUNC Map an edge's recency (`stepsAgo`) to its Round-Table visual color, opacity, and stroke width.
    // #NOT  Never leaves stale historical arrows bright; edges at or past `maxSteps` become completely invisible (`visible: false`).
    // #EDGE-IN `stepsAgo === 0` returns bright yellow `#facc15` at opacity `1`, older steps monotonically darken and lower opacity, and `stepsAgo >= 8` disappears → test_client_round_table_edge_aging_and_layout
    // #WHY  `MAX_VISIBLE_EDGE_STEPS` fades older arrows step-by-step while keeping the newest round bright yellow (`#facc15`) so the round table stays uncluttered.
    function computeEdgeVisualStyle(stepsAgo, maxSteps) {
      var cap = typeof maxSteps === 'number' && maxSteps > 0 ? maxSteps : MAX_VISIBLE_EDGE_STEPS
      var age = typeof stepsAgo === 'number' && stepsAgo >= 0 ? Math.floor(stepsAgo) : cap
      if (age >= cap) {
        return {
          visible: false,
          color: '#1f1c1a',
          opacity: 0,
          strokeWidth: 0.8,
          isLatest: false,
          ageBucket: cap,
        }
      }
      var palette = [
        { color: '#facc15', opacity: 1.0, strokeWidth: 2.6 },
        { color: '#d97706', opacity: 0.78, strokeWidth: 2.1 },
        { color: '#b45309', opacity: 0.58, strokeWidth: 1.8 },
        { color: '#92400e', opacity: 0.42, strokeWidth: 1.55 },
        { color: '#78350f', opacity: 0.29, strokeWidth: 1.35 },
        { color: '#573018', opacity: 0.19, strokeWidth: 1.15 },
        { color: '#402a1d', opacity: 0.11, strokeWidth: 1.0 },
        { color: '#2e241f', opacity: 0.05, strokeWidth: 0.9 },
      ]
      var idx = Math.min(age, palette.length - 1)
      var entry = palette[idx]
      return {
        visible: true,
        color: entry.color,
        opacity: entry.opacity,
        strokeWidth: entry.strokeWidth,
        isLatest: age === 0,
        ageBucket: idx,
      }
    }

    /** Compute Round-Table seat coordinates and aged directed arrows up to `maxSeq`. */
    function computeRoundTableLayout(members, edgeEvents, maxSeq, options) {
      var opts = options || {}
      var cx = opts.cx || 170
      var cy = opts.cy || 152
      var seatR = opts.seatR || 102
      var maxSteps = opts.maxSteps || MAX_VISIBLE_EDGE_STEPS
      var limit = typeof maxSeq === 'number' && maxSeq > 0 ? maxSeq : Infinity

      var memberMap = new Map()
      var listMembers = Array.isArray(members) ? members : []
      for (var i = 0; i < listMembers.length; i += 1) {
        var m = listMembers[i]
        if (!m || !m.name) continue
        memberMap.set(m.name, m)
      }

      var rawEvents = Array.isArray(edgeEvents) ? edgeEvents : []
      var visibleEvents = []
      var seqSet = new Set()
      for (var j = 0; j < rawEvents.length; j += 1) {
        var ev = rawEvents[j]
        if (!ev || typeof ev.seq !== 'number' || ev.seq > limit) continue
        visibleEvents.push(ev)
        seqSet.add(ev.seq)
        if (ev.from && !memberMap.has(ev.from)) {
          memberMap.set(ev.from, { name: ev.from, role: ev.from === 'monitor' ? 'daemon' : 'worker', status: 'waiting', killed: false })
        }
        if (ev.to && !memberMap.has(ev.to)) {
          memberMap.set(ev.to, { name: ev.to, role: ev.to === 'monitor' ? 'daemon' : 'worker', status: 'waiting', killed: false })
        }
      }

      var roleOrder = { coordinator: 0, architect: 1, verifier: 2, worker: 3, daemon: 4 }
      var seatNames = Array.from(memberMap.keys()).sort(function (a, b) {
        if (a === 'coordinator') return -1
        if (b === 'coordinator') return 1
        var ra = roleOrder[memberMap.get(a).role] !== undefined ? roleOrder[memberMap.get(a).role] : 5
        var rb = roleOrder[memberMap.get(b).role] !== undefined ? roleOrder[memberMap.get(b).role] : 5
        if (ra !== rb) return ra - rb
        return a.localeCompare(b)
      })

      var seats = []
      var seatByName = {}
      var total = seatNames.length
      for (var s = 0; s < total; s += 1) {
        var sName = seatNames[s]
        var angle = total === 1 ? -Math.PI / 2 : (-Math.PI / 2 + (2 * Math.PI * s) / total)
        var sx = Math.round((cx + seatR * Math.cos(angle)) * 10) / 10
        var sy = Math.round((cy + seatR * Math.sin(angle)) * 10) / 10
        var meta = memberMap.get(sName)
        var seatObj = {
          name: sName,
          role: meta.role || 'worker',
          status: meta.status || 'waiting',
          killed: meta.killed === true,
          x: sx,
          y: sy,
          angle: angle,
        }
        seats.push(seatObj)
        seatByName[sName] = seatObj
      }

      var distinctSeqs = Array.from(seqSet).sort(function (a, b) { return a - b })
      var seqToAge = {}
      for (var q = 0; q < distinctSeqs.length; q += 1) {
        seqToAge[distinctSeqs[q]] = (distinctSeqs.length - 1) - q
      }

      // Keep the latest event per directed pair within each step; drop edges faded past maxSteps
      var agedEdges = []
      for (var e = 0; e < visibleEvents.length; e += 1) {
        var item = visibleEvents[e]
        var age = seqToAge[item.seq]
        var style = computeEdgeVisualStyle(age, maxSteps)
        if (!style.visible) continue
        if (!seatByName[item.from] || !seatByName[item.to]) continue
        agedEdges.push({
          seq: item.seq,
          from: item.from,
          to: item.to,
          kind: item.kind || 'report',
          title: item.title || '',
          time: item.time || '',
          stepsAgo: age,
          style: style,
        })
      }

      // Sort oldest first so newest yellow arrow renders on top in SVG z-order
      agedEdges.sort(function (a, b) {
        if (a.stepsAgo !== b.stepsAgo) return b.stepsAgo - a.stepsAgo
        return a.seq - b.seq
      })

      var latestSeq = distinctSeqs.length > 0 ? distinctSeqs[distinctSeqs.length - 1] : 0
      var latestEdges = agedEdges.filter(function (ed) { return ed.stepsAgo === 0 })

      return {
        cx: cx,
        cy: cy,
        seatR: seatR,
        seats: seats,
        seatByName: seatByName,
        edges: agedEdges,
        latestSeq: latestSeq,
        latestEdges: latestEdges,
        totalRounds: distinctSeqs.length,
      }
    }

    var uiStore = makeSource({
      drawerOpen: false,
      activeTab: 'board', // 'board' | 'overview' | 'graph'
      filterMember: null,
      filterChannel: null,
      highlightedSeq: null,
      expandedSeqs: {}, // seq -> true (all posts collapsed by default)
      replaySeq: null, // null means LIVE (headSeq)
      composerTitle: '',
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

    function togglePostExpanded(seq) {
      updateUi(function (prev) {
        var nextMap = Object.assign({}, prev.expandedSeqs)
        if (nextMap[seq]) {
          delete nextMap[seq]
        } else {
          nextMap[seq] = true
        }
        return { expandedSeqs: nextMap }
      })
    }

    function jumpToPost(seq) {
      updateUi(function (prev) {
        var nextMap = Object.assign({}, prev.expandedSeqs)
        nextMap[seq] = true
        return {
          activeTab: 'board',
          highlightedSeq: seq,
          expandedSeqs: nextMap,
        }
      })
    }

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

    function resolveSnapshot(ui, sessionId) {
      var map = ui.snapshotsBySession || {}
      if (ui.selectedSwarmId && map[ui.selectedSwarmId]) return map[ui.selectedSwarmId]
      if (sessionId && map[sessionId]) return map[sessionId]
      if (ui.resolvedSwarmId && map[ui.resolvedSwarmId]) return map[ui.resolvedSwarmId]
      if (ui.activeSessionId && map[ui.activeSessionId]) return map[ui.activeSessionId]
      var keys = Object.keys(map)
      return keys.length > 0 ? map[keys[keys.length - 1]] : null
    }

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
        } catch (_err) {}
      }
      updateUi({ drawerOpen: !ui.drawerOpen })
    }

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
          title: 'Open Swarm Blackboard in Right Sidebar (/swarm)',
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
              memberCount + 'm · ' + conc.active + '/' + conc.effectiveLimit + ' slots · #' + headSeq,
            )
          : null,
      )
    }

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
      var activeRejections = snap && Array.isArray(snap.activeRejections) ? snap.activeRejections : []
      var watchdog = snap && snap.watchdog ? snap.watchdog : null
      var memberSummary = snap && snap.memberSummary ? snap.memberSummary : null

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        activeRejections.length > 0
          ? React.createElement(
              'div',
              {
                style: {
                  padding: '8px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--dsw-alias-state-danger-primary, #ef4444)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  fontSize: '12px',
                  color: 'var(--dsw-alias-state-danger-primary, #ef4444)',
                },
              },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'Merge/Done Gate Blocked (' + activeRejections.length + ' open [REJECT])'),
              activeRejections.map(function (rej, idx) {
                return React.createElement(
                  'div',
                  {
                    key: idx,
                    onClick: function () { jumpToPost(rej.seq) },
                    style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px', cursor: 'pointer' },
                  },
                  '#' + rej.seq + ' @' + rej.reviewer + ' (' + rej.role + '): ' + (rej.title || ''),
                )
              }),
            )
          : null,
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
              'LLM In-Flight Slots (NOT max members)',
            ),
            React.createElement(
              'span',
              { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' } },
              conc.active + '/' + conc.effectiveLimit + ' active · ' + conc.queued + ' queued',
            ),
          ),
          watchdog
            ? React.createElement(
                'div',
                { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginBottom: '6px' } },
                'Watchdog: ' + (watchdog.active ? 'ACTIVE' : 'SLEEPING') + ' (health ' + watchdog.healthIntervalSec + 's · alerts ' + watchdog.alertsPosted + ')',
              )
            : null,
          memberSummary
            ? React.createElement(
                'div',
                { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px', fontVariantNumeric: 'tabular-nums' } },
                'Members: ' + memberSummary.working + ' working · ' + memberSummary.waiting + ' waiting · ' + memberSummary.starting + ' starting' + (memberSummary.zombie > 0 ? ' · ' + memberSummary.zombie + ' zombie' : '') + (memberSummary.error > 0 ? ' · ' + memberSummary.error + ' error' : ''),
              )
            : null,
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' } },
            React.createElement(
              'span',
              { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginRight: '4px' } },
              'Adjust slots:',
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
                title: 'Increase slot limit by 2',
              },
              '+2',
            ),
          ),
        ),
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
                'Plan (Wave ' + (plan.current_wave || 1) + ')',
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
                                  onClick: function () { jumpToPost(seq) },
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
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          React.createElement(
            'div',
            { style: { fontWeight: 600, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
            'Roster (' + members.length + ')',
          ),
          members.length === 0
            ? React.createElement(
                'div',
                { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' } },
                'No members spawned yet. Start with /swarm <task> in the main composer.',
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
                        m.role + (m.can_block_merge ? ':gate' : ''),
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
                      'Filter Posts',
                    ),
                    m.session_id && uiWorkspaceRef && typeof uiWorkspaceRef.openSession === 'function'
                      ? React.createElement(
                          'button',
                          {
                            type: 'button',
                            onClick: function () {
                              try {
                                if (m.role === 'coordinator' || m.session_id === targetSwarmId) {
                                  uiWorkspaceRef.openSession(targetSwarmId)
                                } else {
                                  uiWorkspaceRef.openSession({
                                    parentSessionId: targetSwarmId,
                                    childSessionId: m.session_id,
                                    mode: 'continuable',
                                  })
                                }
                              } catch (_e) {}
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
                          'Open Session',
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
              React.createElement('div', { style: { fontWeight: 600, fontSize: '12px', marginBottom: '6px' } }, 'Progress Reel (' + screenshots.length + ')'),
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
      var expandedMap = ui.expandedSeqs || {}
      var expandedCount = filtered.filter(function (p) { return Boolean(expandedMap[p.seq]) }).length

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        // Top bar: filter chip + Expand All / Collapse All
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '6px',
              fontSize: '11px',
              color: 'var(--dsw-alias-label-tertiary)',
              padding: '2px 0',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
            React.createElement('span', null, filtered.length + ' post(s) · collapsed by default'),
            ui.filterMember || ui.filterChannel
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    onClick: function () { updateUi({ filterMember: null, filterChannel: null }) },
                    style: {
                      padding: '1px 6px',
                      borderRadius: '4px',
                      border: '0.5px solid var(--dsw-alias-border-l2)',
                      background: 'var(--dsw-alias-bg-layer-3)',
                      color: 'var(--dsw-alias-label-primary)',
                      fontSize: '11px',
                      cursor: 'pointer',
                    },
                  },
                  'Clear: ' + (ui.filterMember ? '@' + ui.filterMember : '') + (ui.filterChannel ? ' #' + ui.filterChannel : '') + ' x',
                )
              : null,
          ),
          filtered.length > 0
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    if (expandedCount > 0) {
                      updateUi({ expandedSeqs: {} })
                    } else {
                      var allOpen = {}
                      for (var i = 0; i < filtered.length; i += 1) allOpen[filtered[i].seq] = true
                      updateUi({ expandedSeqs: allOpen })
                    }
                  },
                  style: {
                    padding: '2px 7px',
                    borderRadius: '4px',
                    border: '0.5px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-layer-3)',
                    color: 'var(--dsw-alias-label-secondary)',
                    fontSize: '11px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  },
                },
                expandedCount > 0 ? 'Collapse All' : 'Expand All',
              )
            : null,
        ),
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
              'No board posts yet. Post from the bar below or run /swarm <task> in the main composer.',
            )
          : filtered.map(function (p) {
              var isHighlighted = ui.highlightedSeq === p.seq
              var isExpanded = Boolean(expandedMap[p.seq])
              var isSuperseded = Boolean(p.superseded_by)
              var postTitle = derivePostTitle(p)
              var tokens = isExpanded ? tokenizeBoardText(p.text) : []
              var badges = []
              if (p.kind) badges.push(p.kind)
              if (p.verdict) badges.push('verdict:' + p.verdict)
              if (p.escalate) badges.push('ESCALATE')
              if (p.silent) badges.push('SILENT')
              if (isSuperseded) badges.push('superseded->#' + p.superseded_by)
              var shortTime = p.time ? String(p.time).slice(11, 19) || String(p.time) : ''

              return React.createElement(
                'div',
                {
                  key: p.seq,
                  style: {
                    padding: '7px 10px',
                    borderRadius: '8px',
                    border: isHighlighted
                      ? '1px solid var(--dsw-alias-state-business-primary)'
                      : '0.5px solid var(--dsw-alias-border-l2)',
                    background: isHighlighted ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-2)',
                    opacity: isSuperseded ? 0.65 : 1,
                    fontSize: '12px',
                  },
                },
                // Collapsed header row: #seq + @agent + title on left; timestamp + Expand/Collapse button on right
                React.createElement(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: '8px',
                    },
                  },
                  React.createElement(
                    'div',
                    {
                      onClick: function () { togglePostExpanded(p.seq) },
                      style: {
                        flex: '1 1 auto',
                        minWidth: 0,
                        cursor: 'pointer',
                      },
                    },
                    React.createElement(
                      'div',
                      {
                        style: {
                          fontWeight: 600,
                          color: 'var(--dsw-alias-label-primary)',
                          lineHeight: 1.35,
                          wordBreak: 'break-word',
                        },
                      },
                      '#' + p.seq + ' · ' + postTitle,
                    ),
                    React.createElement(
                      'div',
                      {
                        style: {
                          fontSize: '11px',
                          color: 'var(--dsw-alias-label-tertiary)',
                          marginTop: '2px',
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '5px',
                        },
                      },
                      React.createElement('span', { style: { fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' } }, '@' + p.agent),
                      p.channel && p.channel !== 'main'
                        ? React.createElement('span', null, '#' + p.channel)
                        : null,
                      badges.length > 0
                        ? React.createElement('span', null, '[' + badges.join(' | ') + ']')
                        : null,
                    ),
                  ),
                  // Timestamp + Expand/Collapse button immediately to its right
                  React.createElement(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        flex: '0 0 auto',
                        whiteSpace: 'nowrap',
                      },
                    },
                    React.createElement(
                      'span',
                      {
                        title: p.time || '',
                        style: {
                          fontSize: '11px',
                          color: 'var(--dsw-alias-label-tertiary)',
                          fontVariantNumeric: 'tabular-nums',
                        },
                      },
                      shortTime,
                    ),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        'aria-expanded': isExpanded,
                        onClick: function (e) {
                          e.stopPropagation()
                          togglePostExpanded(p.seq)
                        },
                        style: {
                          padding: '1px 6px',
                          borderRadius: '4px',
                          border: '0.5px solid var(--dsw-alias-border-l2)',
                          background: 'var(--dsw-alias-bg-layer-3)',
                          color: 'var(--dsw-alias-label-secondary)',
                          fontSize: '11px',
                          lineHeight: 1.4,
                          cursor: 'pointer',
                        },
                        title: isExpanded ? 'Collapse message body' : 'Expand message body',
                      },
                      isExpanded ? '▾ Hide' : '▸ Open',
                    ),
                  ),
                ),
                // Expanded message body
                isExpanded
                  ? React.createElement(
                      'div',
                      {
                        style: {
                          marginTop: '7px',
                          paddingTop: '7px',
                          borderTop: '0.5px solid var(--dsw-alias-border-l3)',
                          whiteSpace: 'pre-wrap',
                          lineHeight: 1.55,
                          color: 'var(--dsw-alias-label-primary)',
                          wordBreak: 'break-word',
                        },
                      },
                      tokens.map(function (tok, idx) {
                        if (tok.kind === 'ref') {
                          return React.createElement(
                            'button',
                            {
                              key: idx,
                              type: 'button',
                              onClick: function () { jumpToPost(tok.seq) },
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
                    )
                  : null,
              )
            }),
      )
    }

    function roleStrokeColor(role, status) {
      if (status === 'error' || status === 'zombie') return '#ef4444'
      if (role === 'coordinator') return '#3b82f6'
      if (role === 'architect') return '#a855f7'
      if (role === 'verifier') return '#10b981'
      return '#64748b'
    }

    function renderGraphTab(snap, ui) {
      var headSeq = (snap && snap.headSeq) || 1
      var maxSeq = ui.replaySeq !== null ? Math.min(ui.replaySeq, headSeq) : headSeq
      var layout = computeRoundTableLayout(
        (snap && snap.members) || [],
        (snap && snap.edgeEvents) || [],
        maxSeq,
        { cx: 170, cy: 152, seatR: 102, maxSteps: MAX_VISIBLE_EDGE_STEPS },
      )
      var nodeR = 16
      var markerColors = [
        '#facc15',
        '#d97706',
        '#b45309',
        '#92400e',
        '#78350f',
        '#573018',
        '#402a1d',
        '#2e241f',
      ]

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        // Interactive Timeline Scrubber
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '11px',
              padding: '7px 9px',
              borderRadius: '8px',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: function () { updateUi({ replaySeq: Math.max(1, maxSeq - 1) }) },
              style: {
                cursor: 'pointer',
                padding: '2px 6px',
                borderRadius: '4px',
                border: '0.5px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-3)',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: '11px',
              },
              title: 'Step backward one floor',
            },
            '◀',
          ),
          React.createElement(
            'span',
            { style: { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
            '#' + maxSeq + '/' + headSeq,
          ),
          React.createElement('input', {
            type: 'range',
            min: 1,
            max: Math.max(1, headSeq),
            value: maxSeq,
            onChange: function (e) { updateUi({ replaySeq: Number(e.target.value) }) },
            style: { flex: 1, minWidth: '60px' },
          }),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: function () {
                var next = maxSeq + 1
                updateUi({ replaySeq: next >= headSeq ? null : next })
              },
              style: {
                cursor: 'pointer',
                padding: '2px 6px',
                borderRadius: '4px',
                border: '0.5px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-3)',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: '11px',
              },
              title: 'Step forward one floor',
            },
            '▶',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: function () { updateUi({ replaySeq: null }) },
              style: {
                cursor: 'pointer',
                padding: '2px 7px',
                borderRadius: '4px',
                border: '0.5px solid var(--dsw-alias-border-l2)',
                background: ui.replaySeq === null ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-3)',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: '11px',
                whiteSpace: 'nowrap',
              },
            },
            ui.replaySeq === null ? '● Live' : 'Latest',
          ),
        ),
        // Round-Table SVG Canvas
        React.createElement(
          'div',
          {
            style: {
              borderRadius: '10px',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
              padding: '6px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            },
          },
          React.createElement(
            'svg',
            {
              viewBox: '0 0 340 304',
              style: { width: '100%', maxWidth: '360px', height: 'auto', display: 'block', overflow: 'visible' },
            },
            // Arrowhead marker definitions for each aging bucket
            React.createElement(
              'defs',
              null,
              markerColors.map(function (hex, idx) {
                return React.createElement(
                  'marker',
                  {
                    key: idx,
                    id: 'dsh-swarm-arrow-' + idx,
                    viewBox: '0 0 10 10',
                    refX: '8',
                    refY: '5',
                    markerWidth: idx === 0 ? '6.5' : '5.5',
                    markerHeight: idx === 0 ? '6.5' : '5.5',
                    orient: 'auto-start-reverse',
                  },
                  React.createElement('path', {
                    d: 'M 0 1.5 L 9 5 L 0 8.5 z',
                    fill: hex,
                  }),
                )
              }),
            ),
            // Center round table ring
            React.createElement('circle', {
              cx: layout.cx,
              cy: layout.cy,
              r: 58,
              fill: 'var(--dsw-alias-bg-layer-3)',
              fillOpacity: 0.45,
              stroke: 'var(--dsw-alias-border-l2)',
              strokeWidth: 1,
              strokeDasharray: '4 3',
            }),
            React.createElement('circle', {
              cx: layout.cx,
              cy: layout.cy,
              r: layout.seatR,
              fill: 'none',
              stroke: 'var(--dsw-alias-border-l3)',
              strokeWidth: 0.75,
            }),
            React.createElement(
              'text',
              {
                x: layout.cx,
                y: layout.cy - 4,
                textAnchor: 'middle',
                fill: 'var(--dsw-alias-label-secondary)',
                fontSize: '11',
                fontWeight: '600',
              },
              layout.latestSeq > 0 ? 'Floor #' + layout.latestSeq : 'Round Table',
            ),
            React.createElement(
              'text',
              {
                x: layout.cx,
                y: layout.cy + 12,
                textAnchor: 'middle',
                fill: 'var(--dsw-alias-label-tertiary)',
                fontSize: '9.5',
              },
              layout.totalRounds + ' round(s)',
            ),
            // Directed curved arrows (oldest dark faint first -> latest bright yellow on top!)
            layout.edges.map(function (ed, idx) {
              var fromSeat = layout.seatByName[ed.from]
              var toSeat = layout.seatByName[ed.to]
              if (!fromSeat || !toSeat || ed.from === ed.to) return null
              var dx = toSeat.x - fromSeat.x
              var dy = toSeat.y - fromSeat.y
              var dist = Math.sqrt(dx * dx + dy * dy) || 1
              var ux = dx / dist
              var uy = dy / dist
              var nx = -uy
              var ny = ux

              var sx = fromSeat.x + ux * (nodeR + 3)
              var sy = fromSeat.y + uy * (nodeR + 3)
              var ex = toSeat.x - ux * (nodeR + 8)
              var ey = toSeat.y - uy * (nodeR + 8)
              var curveOffset = Math.min(28, Math.max(12, dist * 0.16))
              var qcx = (sx + ex) / 2 + nx * curveOffset
              var qcy = (sy + ey) / 2 + ny * curveOffset
              var pathD = 'M ' + sx.toFixed(1) + ' ' + sy.toFixed(1) + ' Q ' + qcx.toFixed(1) + ' ' + qcy.toFixed(1) + ' ' + ex.toFixed(1) + ' ' + ey.toFixed(1)
              var midX = 0.25 * sx + 0.5 * qcx + 0.25 * ex
              var midY = 0.25 * sy + 0.5 * qcy + 0.25 * ey

              return React.createElement(
                'g',
                {
                  key: ed.seq + '-' + ed.from + '-' + ed.to + '-' + idx,
                  style: { cursor: 'pointer' },
                  onClick: function () { jumpToPost(ed.seq) },
                },
                React.createElement('path', {
                  d: pathD,
                  fill: 'none',
                  stroke: ed.style.color,
                  strokeOpacity: ed.style.opacity,
                  strokeWidth: ed.style.strokeWidth,
                  strokeLinecap: 'round',
                  markerEnd: 'url(#dsh-swarm-arrow-' + ed.style.ageBucket + ')',
                }),
                ed.style.isLatest
                  ? React.createElement(
                      'g',
                      null,
                      React.createElement('rect', {
                        x: midX - 14,
                        y: midY - 8,
                        width: 28,
                        height: 15,
                        rx: 4,
                        fill: '#422006',
                        stroke: '#facc15',
                        strokeWidth: 0.9,
                      }),
                      React.createElement(
                        'text',
                        {
                          x: midX,
                          y: midY + 3,
                          textAnchor: 'middle',
                          fill: '#fef08a',
                          fontSize: '9',
                          fontWeight: '700',
                        },
                        '#' + ed.seq,
                      ),
                    )
                  : null,
              )
            }),
            // Round-table seat nodes
            layout.seats.map(function (seat) {
              var stroke = roleStrokeColor(seat.role, seat.status)
              var isWorking = seat.status === 'working' || seat.status === 'queued'
              var labelOffsetR = nodeR + 13
              var lx = seat.x + Math.cos(seat.angle) * labelOffsetR
              var ly = seat.y + Math.sin(seat.angle) * labelOffsetR + 3
              var anchor = Math.cos(seat.angle) > 0.25 ? 'start' : (Math.cos(seat.angle) < -0.25 ? 'end' : 'middle')
              var shortName = seat.name.length > 13 ? seat.name.slice(0, 12) + '..' : seat.name
              var initials = seat.name.slice(0, 2).toUpperCase()

              return React.createElement(
                'g',
                {
                  key: seat.name,
                  style: { cursor: 'pointer', opacity: seat.killed ? 0.45 : 1 },
                  onClick: function () { updateUi({ activeTab: 'board', filterMember: seat.name }) },
                },
                isWorking
                  ? React.createElement('circle', {
                      cx: seat.x,
                      cy: seat.y,
                      r: nodeR + 4,
                      fill: 'none',
                      stroke: '#facc15',
                      strokeWidth: 1.2,
                      strokeOpacity: 0.7,
                    })
                  : null,
                React.createElement('circle', {
                  cx: seat.x,
                  cy: seat.y,
                  r: nodeR,
                  fill: 'var(--dsw-alias-bg-layer-1)',
                  stroke: stroke,
                  strokeWidth: seat.role === 'coordinator' ? 2.2 : 1.7,
                }),
                React.createElement(
                  'text',
                  {
                    x: seat.x,
                    y: seat.y + 3.5,
                    textAnchor: 'middle',
                    fill: 'var(--dsw-alias-label-primary)',
                    fontSize: '9.5',
                    fontWeight: '700',
                  },
                  initials,
                ),
                React.createElement(
                  'text',
                  {
                    x: lx,
                    y: ly,
                    textAnchor: anchor,
                    fill: 'var(--dsw-alias-label-primary)',
                    fontSize: '10',
                    fontWeight: seat.role === 'coordinator' ? '600' : '500',
                  },
                  '@' + shortName,
                ),
              )
            }),
          ),
          React.createElement(
            'div',
            { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '2px', textAlign: 'center' } },
            'Yellow arrow = latest round · Older steps darken & fade out · Click arrow or seat to inspect',
          ),
        ),
        // Latest Round Callout
        layout.latestEdges.length > 0
          ? React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '5px',
                },
              },
              React.createElement(
                'div',
                { style: { fontSize: '11px', fontWeight: 600, color: '#eab308' } },
                'Latest Round (#' + layout.latestSeq + ')',
              ),
              layout.latestEdges.map(function (ed, idx) {
                return React.createElement(
                  'div',
                  {
                    key: idx,
                    onClick: function () { jumpToPost(ed.seq) },
                    style: {
                      padding: '7px 9px',
                      borderRadius: '6px',
                      border: '0.5px solid #ca8a04',
                      background: 'var(--dsw-alias-bg-layer-2)',
                      fontSize: '11.5px',
                      cursor: 'pointer',
                    },
                  },
                  React.createElement(
                    'div',
                    { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                    '@' + ed.from + ' -> @' + ed.to + ' (' + ed.kind + ')',
                  ),
                  ed.title
                    ? React.createElement(
                        'div',
                        { style: { color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } },
                        ed.title,
                      )
                    : null,
                )
              }),
            )
          : React.createElement(
              'div',
              { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '8px', textAlign: 'center' } },
              'No directed @mention arrows up to floor #' + maxSeq + '.',
            ),
      )
    }

    function renderSwarmSurface(ui, sessionId, isFallbackDrawer) {
      var snap = resolveSnapshot(ui, sessionId)
      var targetSwarmId = (snap && snap.swarm && snap.swarm.swarm_id)
        || ui.selectedSwarmId
        || ui.resolvedSwarmId
        || sessionId
        || 'default-swarm'
      var swarmsList = Array.isArray(ui.swarmsList) ? ui.swarmsList : []

      function submitComposerPost() {
        var curr = uiStore.getSnapshot()
        var txt = String(curr.composerText || '').trim()
        var ttl = String(curr.composerTitle || '').trim()
        if (!txt) return
        updateUi({ composerTitle: '', composerText: '', posting: true })
        postSwarmAction({
          action: 'post',
          sessionId: sessionId,
          swarmId: targetSwarmId,
          title: ttl || undefined,
          text: txt,
          channel: curr.filterChannel || 'main',
        }).then(function () { updateUi({ posting: false }) })
      }

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
              { id: 'board', label: 'Board' },
              { id: 'overview', label: 'Overview' },
              { id: 'graph', label: 'Round Table' },
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
                title: 'Refresh Swarm state',
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
                    title: 'Close',
                  },
                  'x',
                )
              : null,
          ),
        ),
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
                  'No Swarm Blackboard Initialized',
                ),
                React.createElement(
                  'div',
                  { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
                  'Type /swarm <task> in the main composer to start, or initialize a blackboard directly below:',
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
                            title: 'Swarm Task',
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
                      'Init (' + limit + ' slots)',
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
        ui.activeTab === 'board'
          ? React.createElement(
              'div',
              {
                style: {
                  flex: '0 0 auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  padding: '8px 12px',
                  borderTop: '0.5px solid var(--dsw-alias-border-l3)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                },
              },
              React.createElement('input', {
                type: 'text',
                value: ui.composerTitle || '',
                placeholder: 'Title (meaningful summary, optional for human post)...',
                onChange: function (e) { updateUi({ composerTitle: e.target.value }) },
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  height: '26px',
                  padding: '0 9px',
                  borderRadius: '6px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontSize: '11.5px',
                },
              }),
              React.createElement(
                'div',
                { style: { display: 'flex', gap: '6px' } },
                React.createElement('input', {
                  type: 'text',
                  value: ui.composerText || '',
                  placeholder: 'Post to board (e.g. @verifier check #1)...',
                  onChange: function (e) { updateUi({ composerText: e.target.value }) },
                  onKeyDown: function (e) {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      submitComposerPost()
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
                    onClick: submitComposerPost,
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
                  'Send',
                ),
              ),
            )
          : null,
      )
    }

    function SwarmRightbarTab(props) {
      if (!React) return null
      var ui = useUiState(props)
      var sessionId = (props && props.sessionId) || ui.activeSessionId || null
      useSwarmPolling(sessionId, ui.selectedSwarmId, 1800)

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
              title: function () { return 'Swarm Blackboard' },
              description: function () { return 'Multi-agent shared blackboard, roster status, and round-table topology replay' },
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
          computeEdgeVisualStyle: computeEdgeVisualStyle,
          computeRoundTableLayout: computeRoundTableLayout,
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
    exports.computeEdgeVisualStyle = computeEdgeVisualStyle
    exports.computeRoundTableLayout = computeRoundTableLayout
    return module.exports
  },
})
