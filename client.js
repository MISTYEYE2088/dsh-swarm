// dsh-swarm browser half, in the DSH classic-script combo artifact format.
//
// Served verbatim in `/plugins/??.../client.js`, so it MUST NOT contain any
// top-level ES module `import` or `export` statements or raw JSX.
//
// Replaces the legacy token-burning `narrator` with deterministic frontend
// synthesis (`hive.js` pattern):
//   - Header pill in `conversation.session.header.actions` showing active
//     concurrency slots, total board posts, and a live `StateDot`.
//   - Collapsible right-hand Hive Drawer in `shell.overlay` with 3 tabs:
//       1. Overview & Roster: Concurrency pool meter, static `plan.json` waves &
//          tracks, queen/worker bee badges, 5 floor cursors, and Progress Reel
//          for `Screenshot: <path> | <caption>` posts.
//       2. Board: Live message feed with clickable `#seq` floor jump pills,
//          `@mention` pills, `#channel` filter, member filter, and unread `New`
//          divider line.
//       3. Graph: Deterministic SVG `@mention` directed graph weighted by post
//          count, with a `#1 ──●── #N [Live]` timeline replay slider.

window.__ModuleLoader__.load({
  id: 'dsh-swarm',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var VERSION = '0.1.0'
    var LOG = '[dsh-swarm]'

    var React = null
    var Primitives = null
    try { React = require('react') } catch (_e) {}
    try { Primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch (_e) {}

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
    // #WHY  `#([1-9][0-9]*)` tokens let the user click `#5` in `#21` to jump directly to the original evidence post.
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
      activeTab: 'board', // 'overview' | 'board' | 'graph'
      filterMember: null,
      filterChannel: null,
      highlightedSeq: null,
      replaySeq: null, // null means LIVE (headSeq)
      follow: true,
      snapshotsBySession: {},
      activeSessionId: null,
    })

    function updateUi(patch) {
      var curr = uiStore.getSnapshot()
      var next = Object.assign({}, curr, typeof patch === 'function' ? patch(curr) : patch)
      uiStore.set(next)
      return next
    }

    function currentSwarmSnapshot() {
      var state = uiStore.getSnapshot()
      var sid = state.activeSessionId
      if (sid && state.snapshotsBySession[sid]) return state.snapshotsBySession[sid]
      var keys = Object.keys(state.snapshotsBySession)
      return keys.length > 0 ? state.snapshotsBySession[keys[keys.length - 1]] : null
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
              backgroundColor: isRunning ? '#22c55e' : '#94a3b8',
              marginRight: '6px',
            },
          })
        : null
    }

    function SwarmHeaderAction() {
      if (!React) return null
      var snap = currentSwarmSnapshot()
      var ui = uiStore.getSnapshot()
      var conc = snap && snap.concurrency ? snap.concurrency : { active: 0, effectiveLimit: 2, queued: 0 }
      var headSeq = snap ? (snap.headSeq || 0) : 0
      var title = snap && snap.swarm ? snap.swarm.title : 'Swarm'
      var isWorking = conc.active > 0 || conc.queued > 0

      return React.createElement(
        'button',
        {
          type: 'button',
          onClick: function () { updateUi({ drawerOpen: !ui.drawerOpen }) },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            borderRadius: '999px',
            border: '1px solid rgba(148, 163, 184, 0.35)',
            background: ui.drawerOpen ? 'rgba(245, 158, 11, 0.16)' : 'rgba(15, 23, 42, 0.6)',
            color: '#f8fafc',
            fontSize: '12px',
            cursor: 'pointer',
          },
          title: 'Open Swarm Mission Control Board',
        },
        renderDot(isWorking),
        React.createElement('span', null, '🐝 ' + title),
        React.createElement(
          'span',
          { style: { opacity: 0.8 } },
          '· 槽位 ' + conc.active + '/' + conc.effectiveLimit + (conc.queued > 0 ? ' (排队 ' + conc.queued + ')' : '') + ' · #' + headSeq,
        ),
      )
    }

    function renderOverviewTab(snap) {
      var conc = snap.concurrency || { active: 0, effectiveLimit: 2, configuredLimit: 2, queued: 0, rateLimitHits: 0 }
      var members = Array.isArray(snap.members) ? snap.members : []
      var plan = snap.plan || null
      var screenshots = Array.isArray(snap.screenshots) ? snap.screenshots : []

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        React.createElement(
          'div',
          { style: { padding: '10px', borderRadius: '8px', background: 'rgba(30, 41, 59, 0.7)' } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '共享集群并发池水位 (Concurrency Gate)'),
          React.createElement(
            'div',
            { style: { fontSize: '12px', opacity: 0.9 } },
            'Active: ' + conc.active + ' / ' + conc.effectiveLimit + ' (上限 ' + conc.configuredLimit + ') · 排队中: ' + conc.queued + ' · 429 自动降速次数: ' + conc.rateLimitHits,
          ),
        ),
        plan
          ? React.createElement(
              'div',
              { style: { padding: '10px', borderRadius: '8px', background: 'rgba(30, 41, 59, 0.7)' } },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: '4px' } }, 'Goal (Wave ' + (plan.current_wave || 1) + ')'),
              React.createElement('div', { style: { fontSize: '12px', marginBottom: '8px' } }, plan.goal),
              Array.isArray(plan.tracks)
                ? plan.tracks.map(function (t, idx) {
                    return React.createElement(
                      'div',
                      { key: idx, style: { fontSize: '12px', padding: '4px 0', borderTop: '1px solid rgba(148,163,184,0.15)' } },
                      '• ' + t.name + ' (@' + t.owner + ') [' + t.status + '] ',
                      Array.isArray(t.evidence_seqs)
                        ? t.evidence_seqs.map(function (seq) {
                            return React.createElement(
                              'button',
                              {
                                key: seq,
                                type: 'button',
                                onClick: function () { updateUi({ activeTab: 'board', highlightedSeq: seq }) },
                                style: { marginLeft: '4px', padding: '1px 6px', borderRadius: '6px', cursor: 'pointer', fontSize: '11px' },
                              },
                              '#' + seq,
                            )
                          })
                        : null,
                    )
                  })
                : null,
            )
          : null,
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          React.createElement('div', { style: { fontWeight: 600 } }, 'Members Roster (' + members.length + ')'),
          members.map(function (m) {
            var badge = m.role === 'coordinator' ? '👑🐝' : '🐝'
            return React.createElement(
              'div',
              {
                key: m.name,
                onClick: function () { updateUi({ activeTab: 'board', filterMember: m.name }) },
                style: {
                  padding: '8px 10px',
                  borderRadius: '6px',
                  background: 'rgba(30, 41, 59, 0.55)',
                  opacity: m.killed ? 0.5 : 1,
                  cursor: 'pointer',
                  fontSize: '12px',
                },
              },
              React.createElement(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', fontWeight: 600 } },
                React.createElement('span', null, badge + ' @' + m.name + ' [' + m.role + ']'),
                React.createElement('span', null, m.status + ' · ' + (m.applied_model || '')),
              ),
              React.createElement(
                'div',
                { style: { fontSize: '11px', opacity: 0.8, marginTop: '3px' } },
                (m.stepSummary || '') + ' | read:#' + m.last_read_seq + ' wait:#' + m.wait_since + ' post:#' + m.last_post_seq + (m.last_park_blocked_seq ? ' blocked:#' + m.last_park_blocked_seq : ''),
              ),
            )
          }),
        ),
        screenshots.length > 0
          ? React.createElement(
              'div',
              { style: { padding: '10px', borderRadius: '8px', background: 'rgba(30, 41, 59, 0.7)' } },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, 'Progress Reel (' + screenshots.length + ')'),
              screenshots.map(function (sc, idx) {
                return React.createElement(
                  'div',
                  { key: idx, style: { fontSize: '12px', marginBottom: '4px' } },
                  '#' + sc.seq + ' @' + sc.agent + ': ' + sc.caption + ' (' + sc.path + ')',
                )
              }),
            )
          : null,
      )
    }

    function renderBoardTab(snap, ui) {
      var posts = Array.isArray(snap.posts) ? snap.posts : []
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
              { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '4px 8px', background: 'rgba(245, 158, 11, 0.15)', borderRadius: '6px' } },
              React.createElement('span', null, '过滤中: ' + (ui.filterMember ? '@' + ui.filterMember : '') + ' ' + (ui.filterChannel ? '#' + ui.filterChannel : '')),
              React.createElement(
                'button',
                { type: 'button', onClick: function () { updateUi({ filterMember: null, filterChannel: null }) }, style: { cursor: 'pointer' } },
                '清除过滤 (Esc)',
              ),
            )
          : null,
        filtered.map(function (p) {
          var isHighlighted = ui.highlightedSeq === p.seq
          var tokens = tokenizeBoardText(p.text)
          return React.createElement(
            'div',
            {
              key: p.seq,
              style: {
                padding: '8px 10px',
                borderRadius: '8px',
                border: isHighlighted ? '1px solid #f59e0b' : '1px solid rgba(148,163,184,0.2)',
                background: isHighlighted ? 'rgba(245, 158, 11, 0.12)' : 'rgba(15, 23, 42, 0.65)',
                fontSize: '12px',
              },
            },
            React.createElement(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', opacity: 0.85, marginBottom: '4px', fontWeight: 600 } },
              React.createElement('span', null, '#' + p.seq + ' · @' + p.agent + ' [#' + (p.channel || 'main') + ']'),
              React.createElement('span', null, p.time || ''),
            ),
            React.createElement(
              'div',
              { style: { whiteSpace: 'pre-wrap', lineHeight: 1.5 } },
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
                        borderRadius: '999px',
                        background: 'rgba(56, 189, 248, 0.2)',
                        color: '#38bdf8',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '11px',
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
                        borderRadius: '999px',
                        background: 'rgba(245, 158, 11, 0.2)',
                        color: '#fbbf24',
                        border: 'none',
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
      var headSeq = snap.headSeq || 1
      var maxSeq = ui.replaySeq !== null ? ui.replaySeq : headSeq
      var graph = computeGraphEdges(snap.edgeEvents || [], maxSeq)

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' } },
          React.createElement('span', null, 'Replay Timeline: #1 .. #' + maxSeq),
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
              style: { cursor: 'pointer', padding: '2px 8px', borderRadius: '4px' },
            },
            ui.replaySeq === null ? '● LIVE' : 'Back to Live',
          ),
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' } },
          graph.edges.length === 0
            ? React.createElement('div', { style: { opacity: 0.7 } }, '暂无 @mention 交互边')
            : graph.edges.map(function (edge, idx) {
                return React.createElement(
                  'div',
                  {
                    key: idx,
                    style: {
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      background: 'rgba(30, 41, 59, 0.6)',
                    },
                  },
                  React.createElement('span', null, '@' + edge.from + ' ───► @' + edge.to),
                  React.createElement('span', null, edge.count + ' 次点名 (最新 #' + edge.latestSeq + ')'),
                )
              }),
        ),
      )
    }

    function SwarmOverlayDrawer() {
      if (!React) return null
      var ui = uiStore.getSnapshot()
      if (!ui.drawerOpen) return null
      var snap = currentSwarmSnapshot() || {
        swarm: { title: 'No Active Swarm', status: 'IDLE' },
        headSeq: 0,
        concurrency: { active: 0, effectiveLimit: 2, configuredLimit: 2, queued: 0, rateLimitHits: 0 },
        members: [],
        posts: [],
        edgeEvents: [],
      }

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            top: '48px',
            right: '12px',
            bottom: '16px',
            width: '420px',
            zIndex: 9000,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '12px',
            border: '1px solid rgba(148, 163, 184, 0.3)',
            background: 'rgba(15, 23, 42, 0.96)',
            color: '#f8fafc',
            boxShadow: '0 20px 40px rgba(0,0,0,0.45)',
            overflow: 'hidden',
          },
        },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 14px',
              borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
            },
          },
          React.createElement('div', { style: { fontWeight: 700, fontSize: '13px' } }, '🐝 ' + (snap.swarm?.title || 'Swarm Board')),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: '6px' } },
            ['board', 'overview', 'graph'].map(function (tab) {
              return React.createElement(
                'button',
                {
                  key: tab,
                  type: 'button',
                  onClick: function () { updateUi({ activeTab: tab }) },
                  style: {
                    padding: '3px 8px',
                    borderRadius: '6px',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '11px',
                    background: ui.activeTab === tab ? '#f59e0b' : 'rgba(51, 65, 85, 0.7)',
                    color: ui.activeTab === tab ? '#0f172a' : '#f8fafc',
                    fontWeight: 600,
                  },
                },
                tab.toUpperCase(),
              )
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () { updateUi({ drawerOpen: false }) },
                style: { padding: '3px 8px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '11px' },
              },
              '✕',
            ),
          ),
        ),
        React.createElement(
          'div',
          { style: { flex: 1, overflowY: 'auto', padding: '12px' } },
          ui.activeTab === 'overview'
            ? renderOverviewTab(snap)
            : ui.activeTab === 'graph'
              ? renderGraphTab(snap, ui)
              : renderBoardTab(snap, ui),
        ),
      )
    }

    // dup-ok: client-half Cordis entry point distinct from host-half index.js apply
    // #FUNC Cordis client entry point: mount the Swarm Board UI slots without risking page boot failure.
    // #NOT  Does not inject host-only services like `timer`, and never rethrows from `apply`.
    // #WHY  Wrapping `startClient` in a `catch` ensures a browser slot change cannot block the rest of the classic-script combo.
    function apply(ctx) {
      try {
        startClient(ctx)
      } catch (error) {
        console.error(LOG, 'could not start client half; page is unaffected:', error)
      }
    }

    function startClient(ctx) {
      var disposers = []

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
            updateUi({ drawerOpen: true, activeTab: tab || 'board' })
          },
          closeDrawer: function () {
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
