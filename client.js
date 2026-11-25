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

    var VERSION = '0.4.1'
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

    // dup-ok: legacy floor-based Round-Table layout counterpart to Kafka event-log computeRoundTableFromEvents
    /** Compute Round-Table seat coordinates and aged directed arrows for the EXACT active seats at `maxSeq`. */
    function computeRoundTableLayout(members, edgeEvents, maxSeq, options) {
      var opts = options || {}
      var cx = opts.cx || 170
      var cy = opts.cy || 152
      var seatR = opts.seatR || 102
      var maxSteps = opts.maxSteps || MAX_VISIBLE_EDGE_STEPS
      var limit = typeof maxSeq === 'number' && maxSeq > 0 ? maxSeq : Infinity

      var allMembersByName = new Map()
      var listMembers = Array.isArray(members) ? members : []
      for (var i = 0; i < listMembers.length; i += 1) {
        var m = listMembers[i]
        if (!m || !m.name) continue
        allMembersByName.set(m.name, m)
      }

      var rawEvents = Array.isArray(edgeEvents) ? edgeEvents : []
      var visibleEvents = []
      var seqSet = new Set()
      for (var j = 0; j < rawEvents.length; j += 1) {
        var ev = rawEvents[j]
        if (!ev || typeof ev.seq !== 'number' || ev.seq > limit) continue
        visibleEvents.push(ev)
        seqSet.add(ev.seq)
      }

      var distinctSeqs = Array.from(seqSet).sort(function (a, b) { return a - b })
      var seqToAge = {}
      for (var q = 0; q < distinctSeqs.length; q += 1) {
        seqToAge[distinctSeqs[q]] = (distinctSeqs.length - 1) - q
      }

      // Restore exact historically active seats at `limit`:
      //   bornSeq <= limit AND (retiredSeq === null || limit <= retiredSeq)
      var memberMap = new Map()
      allMembersByName.forEach(function (meta, name) {
        var isCoord = name === 'coordinator' || meta.role === 'coordinator'
        var bornSeq = isCoord
          ? 0
          : (typeof meta.born_seq === 'number'
              ? meta.born_seq
              : (typeof meta.brief_seq === 'number' ? meta.brief_seq : 0))
        var retiredSeq = isCoord
          ? null
          : (typeof meta.retired_seq === 'number'
              ? meta.retired_seq
              : (typeof meta.killed_at_seq === 'number' ? meta.killed_at_seq : null))
        var activeAtLimit = bornSeq <= limit && (retiredSeq === null || limit <= retiredSeq)
        if (!activeAtLimit) return
        memberMap.set(name, {
          name: name,
          role: meta.role || 'worker',
          status: (limit < Infinity && retiredSeq !== null && limit <= retiredSeq && meta.status === 'killed')
            ? 'waiting'
            : (meta.status || 'waiting'),
          killed: false,
          born_seq: bornSeq,
          retired_seq: retiredSeq,
        })
      })

      // Include any external speaker (e.g. watchdog `monitor`) referenced by still-visible non-faded arrows
      for (var k = 0; k < visibleEvents.length; k += 1) {
        var vev = visibleEvents[k]
        var vAge = seqToAge[vev.seq]
        if (vAge >= maxSteps) continue
        if (vev.from && vev.from !== '__table__' && !allMembersByName.has(vev.from) && !memberMap.has(vev.from)) {
          memberMap.set(vev.from, { name: vev.from, role: vev.from === 'monitor' ? 'daemon' : 'worker', status: 'waiting', killed: false })
        }
        if (vev.to && vev.to !== '__table__' && !allMembersByName.has(vev.to) && !memberMap.has(vev.to)) {
          memberMap.set(vev.to, { name: vev.to, role: vev.to === 'monitor' ? 'daemon' : 'worker', status: 'waiting', killed: false })
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

      var agedEdges = []
      for (var e = 0; e < visibleEvents.length; e += 1) {
        var item = visibleEvents[e]
        var age = seqToAge[item.seq]
        var style = computeEdgeVisualStyle(age, maxSteps)
        if (!style.visible) continue
        var isBroadcast = item.broadcast === true || item.to === '__table__'
        if (!seatByName[item.from]) continue
        if (!isBroadcast && !seatByName[item.to]) continue
        agedEdges.push({
          seq: item.seq,
          from: item.from,
          to: isBroadcast ? '__table__' : item.to,
          broadcast: isBroadcast,
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

    // dup-ok: Kafka event-stream replay counterpart to legacy snapshot computeRoundTableLayout
    /** Replay Kafka-style `events.jsonl` stream up to `atOffset` to build exact Round-Table seats & aging arrows. */
    function computeRoundTableFromEvents(events, liveMembers, atOffset, options) {
      var opts = options || {}
      var cx = opts.cx || 170
      var cy = opts.cy || 152
      var seatR = opts.seatR || 102
      var maxSteps = opts.maxSteps || MAX_VISIBLE_EDGE_STEPS
      var list = Array.isArray(events) ? events : []
      var totalOffsets = list.length > 0 ? (list[list.length - 1].offset || list.length) : 0
      var limitOffset = typeof atOffset === 'number' && atOffset > 0 ? Math.min(atOffset, totalOffsets || atOffset) : Infinity
      var isLive = limitOffset >= totalOffsets

      var liveByName = new Map()
      if (Array.isArray(liveMembers)) {
        for (var lm = 0; lm < liveMembers.length; lm += 1) {
          if (liveMembers[lm] && liveMembers[lm].name) liveByName.set(liveMembers[lm].name, liveMembers[lm])
        }
      }

      var activeMembers = new Map()
      var allSeenMembers = new Map()
      var subscriptions = new Map()
      var rawEdges = []
      var seqSet = new Set()
      var lastEvent = null

      function ensureSub(name) {
        if (!subscriptions.has(name)) subscriptions.set(name, new Set(['main']))
        return subscriptions.get(name)
      }

      for (var i = 0; i < list.length; i += 1) {
        var ev = list[i]
        if (!ev || typeof ev !== 'object') continue
        var evOffset = typeof ev.offset === 'number' ? ev.offset : (i + 1)
        if (evOffset > limitOffset) break
        lastEvent = ev
        var p = ev.payload || {}

        if (ev.type === 'swarm.init') {
          if (!activeMembers.has('coordinator')) {
            var coord = { name: 'coordinator', role: 'coordinator', group: null, status: 'waiting', killed: false }
            activeMembers.set('coordinator', coord)
            allSeenMembers.set('coordinator', coord)
            ensureSub('coordinator')
          }
        } else if (ev.type === 'member.spawn' && p.name) {
          var seatObj = { name: p.name, role: p.role || 'worker', group: p.group || null, status: 'waiting', killed: false }
          activeMembers.set(p.name, seatObj)
          allSeenMembers.set(p.name, seatObj)
          ensureSub(p.name)
        } else if (ev.type === 'member.kill' && p.name) {
          activeMembers.delete(p.name)
        } else if (ev.type === 'board.control') {
          var ch = typeof p.channel === 'string' ? p.channel.replace(/^#/, '') : ''
          if (ch && ch !== 'main') {
            if (p.action === 'channel.create' && p.agent) ensureSub(p.agent).add(ch)
            else if (p.action === 'channel.subscribe') ensureSub(p.target || p.agent).add(ch)
            else if (p.action === 'channel.unsubscribe') ensureSub(p.target || p.agent).delete(ch)
          }
        } else if (ev.type === 'board.post') {
          var from = p.agent || ev.actor || 'coordinator'
          var seq = p.seq || ev.seq || 0
          var title = p.title || ''
          var rawMentions = Array.isArray(p.mentions) ? p.mentions : []
          var rawChannels = Array.isArray(p.channel_mentions) ? p.channel_mentions : []
          if (seq > 0) seqSet.add(seq)

          if (p.silent === true || rawMentions.indexOf('all') !== -1) {
            rawEdges.push({
              offset: evOffset,
              ts_ms: ev.ts_ms || 0,
              time: ev.time || p.time || '',
              seq: seq,
              from: from,
              to: '__table__',
              broadcast: true,
              kind: p.kind || 'report',
              title: title,
            })
          } else {
            var targets = new Set()
            for (var m = 0; m < rawMentions.length; m += 1) {
              var tok = rawMentions[m]
              if (!tok || tok === from || tok === 'monitor') continue
              if (activeMembers.has(tok) || allSeenMembers.has(tok)) {
                targets.add(tok)
                continue
              }
              activeMembers.forEach(function (mObj, mName) {
                if (mName !== from && mObj.group === tok) targets.add(mName)
              })
            }
            if (rawChannels.length > 0) {
              activeMembers.forEach(function (_mObj, mName) {
                if (mName === from) return
                var subs = ensureSub(mName)
                for (var c = 0; c < rawChannels.length; c += 1) {
                  if (rawChannels[c] !== 'main' && subs.has(rawChannels[c])) {
                    targets.add(mName)
                    break
                  }
                }
              })
            }
            if (targets.size === 0) {
              rawEdges.push({
                offset: evOffset,
                ts_ms: ev.ts_ms || 0,
                time: ev.time || p.time || '',
                seq: seq,
                from: from,
                to: '__table__',
                broadcast: true,
                kind: p.kind || 'report',
                title: title,
              })
            } else {
              targets.forEach(function (tName) {
                rawEdges.push({
                  offset: evOffset,
                  ts_ms: ev.ts_ms || 0,
                  time: ev.time || p.time || '',
                  seq: seq,
                  from: from,
                  to: tName,
                  broadcast: false,
                  kind: p.kind || 'report',
                  title: title,
                })
              })
            }
          }
        }
      }

      if (!activeMembers.has('coordinator') && list.length > 0) {
        activeMembers.set('coordinator', { name: 'coordinator', role: 'coordinator', group: null, status: 'waiting', killed: false })
      }

      // Overlay real-time live status only when viewing Live (latest offset)
      if (isLive) {
        activeMembers.forEach(function (seat, sName) {
          var live = liveByName.get(sName)
          if (live) seat.status = live.status || seat.status
        })
      }

      var roleOrder = { coordinator: 0, architect: 1, verifier: 2, worker: 3, daemon: 4 }
      var seatNames = Array.from(activeMembers.keys()).sort(function (a, b) {
        if (a === 'coordinator') return -1
        if (b === 'coordinator') return 1
        var ra = roleOrder[activeMembers.get(a).role] !== undefined ? roleOrder[activeMembers.get(a).role] : 5
        var rb = roleOrder[activeMembers.get(b).role] !== undefined ? roleOrder[activeMembers.get(b).role] : 5
        if (ra !== rb) return ra - rb
        return a.localeCompare(b)
      })

      var justSpawnedName = lastEvent && lastEvent.type === 'member.spawn' ? (lastEvent.payload && lastEvent.payload.name) : null
      var justKilledName = lastEvent && lastEvent.type === 'member.kill' ? (lastEvent.payload && lastEvent.payload.name) : null

      var seats = []
      var seatByName = {}
      var total = seatNames.length
      for (var s = 0; s < total; s += 1) {
        var sName = seatNames[s]
        var angle = total === 1 ? -Math.PI / 2 : (-Math.PI / 2 + (2 * Math.PI * s) / total)
        var sx = Math.round((cx + seatR * Math.cos(angle)) * 10) / 10
        var sy = Math.round((cy + seatR * Math.sin(angle)) * 10) / 10
        var meta = activeMembers.get(sName)
        var seatEntry = {
          name: sName,
          role: meta.role || 'worker',
          status: meta.status || 'waiting',
          killed: false,
          justSpawned: sName === justSpawnedName,
          x: sx,
          y: sy,
          angle: angle,
        }
        seats.push(seatEntry)
        seatByName[sName] = seatEntry
      }

      var distinctSeqs = Array.from(seqSet).sort(function (a, b) { return a - b })
      var seqToAge = {}
      for (var q = 0; q < distinctSeqs.length; q += 1) {
        seqToAge[distinctSeqs[q]] = (distinctSeqs.length - 1) - q
      }

      var agedEdges = []
      for (var e = 0; e < rawEdges.length; e += 1) {
        var item = rawEdges[e]
        var age = seqToAge[item.seq]
        var style = computeEdgeVisualStyle(age, maxSteps)
        if (!style.visible) continue
        var isBroadcast = item.broadcast === true || item.to === '__table__'
        if (!seatByName[item.from]) continue
        if (!isBroadcast && !seatByName[item.to]) continue
        agedEdges.push({
          offset: item.offset,
          seq: item.seq,
          from: item.from,
          to: isBroadcast ? '__table__' : item.to,
          broadcast: isBroadcast,
          kind: item.kind,
          title: item.title,
          time: item.time,
          stepsAgo: age,
          style: style,
        })
      }

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
        currentOffset: lastEvent ? (lastEvent.offset || 0) : 0,
        totalOffsets: totalOffsets,
        currentTime: lastEvent ? (lastEvent.time || '') : '',
        currentEvent: lastEvent,
        justSpawnedName: justSpawnedName,
        justKilledName: justKilledName,
      }
    }

    var uiStore = makeSource({
      drawerOpen: false,
      activeTab: 'board', // 'board' | 'overview' | 'graph'
      filterMember: null,
      filterChannel: null,
      highlightedSeq: null,
      expandedSeqs: {}, // seq -> true (all posts collapsed by default)
      freshPostSeqs: {}, // seq -> true while yellow arrival animation plays (3.5s)
      replaySeq: null, // fallback for legacy snapshots
      replayOffset: null, // null means LIVE (latest Kafka event offset)
      loading: false,
      selectedSwarmId: null,
      resolvedSwarmId: null,
      activeSessionId: null,
      swarmsList: [],
      globalConcurrency: null,
      snapshotsBySession: {},
    })

    var lastStateFingerprint = ''
    var inFlightFetchPromise = null
    var knownMaxSeqBySwarm = {}
    var freshClearTimers = {}
    var pollRefCount = 0
    var sharedPollTimer = null

    function ensureAnimationStyles() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.getElementById('dsh-swarm-anim-css')) return
      try {
        var style = document.createElement('style')
        style.id = 'dsh-swarm-anim-css'
        style.textContent = [
          '@keyframes dshSwarmNewPostFlash {',
          '  0% { background-color: rgba(250, 204, 21, 0.28); border-color: #facc15; box-shadow: 0 0 0 1px rgba(250, 204, 21, 0.45); transform: translateY(-4px); opacity: 0.72; }',
          '  18% { background-color: rgba(250, 204, 21, 0.22); border-color: #eab308; box-shadow: 0 0 0 1px rgba(234, 179, 8, 0.35); transform: translateY(0); opacity: 1; }',
          '  65% { background-color: rgba(250, 204, 21, 0.11); border-color: rgba(234, 179, 8, 0.55); }',
          '  100% { background-color: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); box-shadow: none; transform: translateY(0); opacity: 1; }',
          '}',
          '.dsh-swarm-post-fresh {',
          '  animation: dshSwarmNewPostFlash 3.2s cubic-bezier(0.22, 1, 0.36, 1) forwards;',
          '}',
        ].join('\n')
        document.head.appendChild(style)
      } catch (_e) {}
    }

    function markPostsFresh(swarmKey, snapshot) {
      if (!snapshot || !Array.isArray(snapshot.posts) || !swarmKey) return []
      var maxSeq = 0
      for (var i = 0; i < snapshot.posts.length; i += 1) {
        var p = snapshot.posts[i]
        if (p && p.type !== 'control' && typeof p.seq === 'number' && p.seq > maxSeq) {
          maxSeq = p.seq
        }
      }
      var prevMax = knownMaxSeqBySwarm[swarmKey]
      knownMaxSeqBySwarm[swarmKey] = Math.max(prevMax || 0, maxSeq)
      // Do not flash historical posts on the very first load of a swarm
      if (prevMax === undefined || maxSeq <= prevMax) return []
      var newlyArrived = []
      for (var j = 0; j < snapshot.posts.length; j += 1) {
        var post = snapshot.posts[j]
        if (post && post.type !== 'control' && typeof post.seq === 'number' && post.seq > prevMax) {
          newlyArrived.push(post.seq)
        }
      }
      return newlyArrived
    }

    function scheduleClearFreshSeqs(seqs) {
      if (!Array.isArray(seqs) || seqs.length === 0) return
      for (var i = 0; i < seqs.length; i += 1) {
        (function (seq) {
          if (freshClearTimers[seq]) clearTimeout(freshClearTimers[seq])
          freshClearTimers[seq] = setTimeout(function () {
            delete freshClearTimers[seq]
            var curr = uiStore.getSnapshot()
            if (!curr.freshPostSeqs || !curr.freshPostSeqs[seq]) return
            var nextFresh = Object.assign({}, curr.freshPostSeqs)
            delete nextFresh[seq]
            updateUi({ freshPostSeqs: nextFresh })
          }, 3500)
        })(seqs[i])
      }
    }

    function computeStateFingerprint(data) {
      try {
        var snap = data && data.snapshot ? data.snapshot : null
        return JSON.stringify({
          exactSwarmId: data && data.exactSwarmId ? data.exactSwarmId : null,
          resolvedSwarmId: data && data.resolvedSwarmId ? data.resolvedSwarmId : null,
          swarms: data && data.swarms ? data.swarms : null,
          concurrency: data && data.concurrency ? data.concurrency : null,
          headSeq: snap ? snap.headSeq : 0,
          headOffset: snap ? snap.headOffset : 0,
          postCount: snap && Array.isArray(snap.posts) ? snap.posts.length : 0,
          memberSummary: snap ? snap.memberSummary : null,
          activeRejections: snap ? snap.activeRejections : null,
          planUpdated: snap && snap.plan ? snap.plan.updated_at : null,
          members: snap && Array.isArray(snap.members)
            ? snap.members.map(function (m) {
                return [m.name, m.status, m.killed, m.last_read_seq, m.wait_since, m.last_post_seq, m.turn_count, m.tool_call_count, m.stepSummary]
              })
            : null,
        })
      } catch (_e) {
        return String(Date.now())
      }
    }

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

    function fetchSwarmState(sessionId, explicitSwarmId, forceUpdate) {
      if (typeof fetch !== 'function') return Promise.resolve(null)
      if (inFlightFetchPromise && !forceUpdate) return inFlightFetchPromise
      var curr = uiStore.getSnapshot()
      var sid = sessionId || curr.activeSessionId || ''
      var swId = explicitSwarmId || curr.selectedSwarmId || ''
      var query = '?sessionId=' + encodeURIComponent(sid) + (swId ? '&swarmId=' + encodeURIComponent(swId) : '')
      inFlightFetchPromise = fetch('/api/dsh-swarm/state' + query, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
        .then(function (res) {
          if (!res || !res.ok) return null
          return res.json()
        })
        .then(function (data) {
          if (!data || !data.ok) return null
          var fp = computeStateFingerprint(data)
          var latestUi = uiStore.getSnapshot()
          // Skip uiStore.set() when nothing changed -> zero redundant re-renders -> zero flicker!
          if (!forceUpdate && fp === lastStateFingerprint && latestUi.loading === false) {
            return data
          }
          lastStateFingerprint = fp
          var swarmKey = data.resolvedSwarmId || swId || sid || 'default'
          var newlyArrived = markPostsFresh(swarmKey, data.snapshot)
          updateUi(function (prev) {
            var nextMap = Object.assign({}, prev.snapshotsBySession)
            if (data.snapshot) {
              if (data.resolvedSwarmId) nextMap[data.resolvedSwarmId] = data.snapshot
              if (sid) nextMap[sid] = data.snapshot
            }
            var nextFresh = prev.freshPostSeqs || {}
            if (newlyArrived.length > 0) {
              nextFresh = Object.assign({}, nextFresh)
              for (var i = 0; i < newlyArrived.length; i += 1) {
                nextFresh[newlyArrived[i]] = true
              }
            }
            return {
              loading: false,
              activeSessionId: sid || prev.activeSessionId,
              exactSwarmId: data.exactSwarmId || null,
              resolvedSwarmId: data.resolvedSwarmId || prev.resolvedSwarmId,
              swarmsList: Array.isArray(data.swarms) ? data.swarms : prev.swarmsList,
              globalConcurrency: data.concurrency || prev.globalConcurrency,
              snapshotsBySession: nextMap,
              freshPostSeqs: nextFresh,
            }
          })
          if (newlyArrived.length > 0) scheduleClearFreshSeqs(newlyArrived)
          return data
        })
        .catch(function () {
          return null
        })
        .finally(function () {
          inFlightFetchPromise = null
        })
      return inFlightFetchPromise
    }

    function useSwarmPolling(sessionId, selectedSwarmId) {
      if (!React || typeof React.useEffect !== 'function') return
      React.useEffect(function () {
        ensureAnimationStyles()
        if (sessionId && uiStore.getSnapshot().activeSessionId !== sessionId) {
          updateUi({ activeSessionId: sessionId })
        }
        fetchSwarmState(sessionId, selectedSwarmId)
        pollRefCount += 1
        if (!sharedPollTimer) {
          sharedPollTimer = setInterval(function () {
            var cur = uiStore.getSnapshot()
            fetchSwarmState(cur.activeSessionId, cur.selectedSwarmId)
          }, 2000)
        }
        return function () {
          pollRefCount = Math.max(0, pollRefCount - 1)
          if (pollRefCount === 0 && sharedPollTimer) {
            clearInterval(sharedPollTimer)
            sharedPollTimer = null
          }
        }
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

    function renderDownloadIcon(size) {
      var px = size || 14
      if (React && Primitives && Primitives.IconDownloadOutlineRegular) {
        return React.createElement(Primitives.IconDownloadOutlineRegular, {
          style: { width: px + 'px', height: px + 'px', flex: '0 0 auto' },
        })
      }
      if (!React) return null
      return React.createElement(
        'svg',
        {
          width: px,
          height: px,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { flex: '0 0 auto' },
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
        React.createElement('polyline', { points: '7 10 12 15 17 10' }),
        React.createElement('line', { x1: 12, y1: 15, x2: 12, y2: 3 }),
      )
    }

    /** Build the `/api/dsh-swarm/export` URL for either a Swarm or regular DSH conversation. */
    function buildExportUrl(opts) {
      var o = opts || {}
      var params = []
      if (o.sessionId) params.push('sessionId=' + encodeURIComponent(String(o.sessionId)))
      if (o.swarmId) params.push('swarmId=' + encodeURIComponent(String(o.swarmId)))
      params.push('format=' + encodeURIComponent(o.format === 'json' ? 'json' : 'md'))
      params.push('detail=' + encodeURIComponent(o.detail === 'full' ? 'full' : 'compact'))
      params.push('includeSubagents=' + (o.includeSubagents === false ? 'false' : 'true'))
      params.push('includeReasoning=' + (o.includeReasoning === false ? 'false' : 'true'))
      if (o.download) params.push('download=1')
      return '/api/dsh-swarm/export?' + params.join('&')
    }

    function copyTextToClipboard(text) {
      var value = String(text || '')
      if (!value) return Promise.resolve(false)
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(value).then(
          function () { return true },
          function () { return copyTextFallback(value) },
        )
      }
      return Promise.resolve(copyTextFallback(value))
    }

    function copyTextFallback(value) {
      try {
        if (typeof document === 'undefined' || !document.body) return false
        var ta = document.createElement('textarea')
        ta.value = value
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        var ok = document.execCommand && document.execCommand('copy')
        document.body.removeChild(ta)
        return Boolean(ok)
      } catch (_e) {
        return false
      }
    }

    function triggerExportDownload(opts) {
      if (typeof fetch !== 'function') return Promise.resolve({ ok: false, error: 'Fetch unavailable' })
      var url = buildExportUrl(Object.assign({}, opts, { download: true }))
      return fetch(url, { method: 'GET' })
        .then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return null }).then(function (j) {
              return { ok: false, error: (j && j.error) || ('HTTP ' + res.status) }
            })
          }
          var filename = res.headers.get('x-dsh-export-filename')
            || ('dsh-log.' + (opts && opts.format === 'json' ? 'json' : 'md'))
          return res.blob().then(function (blob) {
            if (typeof URL !== 'undefined' && typeof document !== 'undefined' && document.body) {
              var objUrl = URL.createObjectURL(blob)
              var a = document.createElement('a')
              a.href = objUrl
              a.download = filename
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              setTimeout(function () { try { URL.revokeObjectURL(objUrl) } catch (_e) {} }, 2000)
            }
            return { ok: true, filename: filename }
          })
        })
        .catch(function (err) {
          return { ok: false, error: String((err && err.message) || err || 'Export failed') }
        })
    }

    function copyExportMarkdown(opts) {
      if (typeof fetch !== 'function') return Promise.resolve({ ok: false, error: 'Fetch unavailable' })
      var url = buildExportUrl(Object.assign({}, opts, { format: 'md', download: false }))
      return fetch(url, { method: 'GET' })
        .then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return null }).then(function (j) {
              return { ok: false, error: (j && j.error) || ('HTTP ' + res.status) }
            })
          }
          return res.text().then(function (txt) {
            return copyTextToClipboard(txt).then(function (copied) {
              return copied ? { ok: true, chars: txt.length } : { ok: false, error: 'Clipboard write failed' }
            })
          })
        })
        .catch(function (err) {
          return { ok: false, error: String((err && err.message) || err || 'Copy failed') }
        })
    }

    function detectSwarmForHeader(ui, sessionId, explicitSwarmId) {
      var list = Array.isArray(ui && ui.swarmsList) ? ui.swarmsList : []
      if (explicitSwarmId) {
        var foundExp = list.find(function (item) { return item && item.swarm_id === explicitSwarmId })
        return { isSwarm: true, swarmId: explicitSwarmId, title: foundExp ? foundExp.title : explicitSwarmId }
      }
      if (!sessionId) return { isSwarm: false, swarmId: '', title: '' }
      if (ui && ui.activeSessionId === sessionId && ui.exactSwarmId) {
        var foundExact = list.find(function (item) { return item && item.swarm_id === ui.exactSwarmId })
        return { isSwarm: true, swarmId: ui.exactSwarmId, title: foundExact ? foundExact.title : ui.exactSwarmId }
      }
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i]
        if (!item || !item.swarm_id) continue
        if (item.swarm_id === sessionId || sessionId.indexOf(item.swarm_id + '__') === 0) {
          return { isSwarm: true, swarmId: item.swarm_id, title: item.title || item.swarm_id }
        }
      }
      return { isSwarm: false, swarmId: '', title: '' }
    }

    function SwarmExportMenuButton(props) {
      if (!React) return null
      var ui = useUiState(props)
      var compact = Boolean(props && props.compact)
      var explicitSwarmId = (props && props.explicitSwarmId) || ''
      var sessionId = (props && props.sessionId) || ui.activeSessionId || ''
      if (!sessionId && !explicitSwarmId) return null

      var openPair = React.useState(false)
      var menuOpen = openPair[0]
      var setMenuOpen = openPair[1]
      var subPair = React.useState(true)
      var includeSubagents = subPair[0]
      var setIncludeSubagents = subPair[1]
      var reasPair = React.useState(true)
      var includeReasoning = reasPair[0]
      var setIncludeReasoning = reasPair[1]
      var fullPair = React.useState(false)
      var fullToolOutputs = fullPair[0]
      var setFullToolOutputs = fullPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var msgPair = React.useState(null)
      var statusMsg = msgPair[0]
      var setStatusMsg = msgPair[1]

      var rootRef = React.useRef ? React.useRef(null) : { current: null }
      var clearTimerRef = React.useRef ? React.useRef(null) : { current: null }

      if (typeof React.useEffect === 'function') {
        React.useEffect(function () {
          return function () {
            if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
          }
        }, [])

        React.useEffect(function () {
          if (!menuOpen || typeof document === 'undefined') return undefined
          function onDocMouseDown(ev) {
            if (rootRef.current && typeof rootRef.current.contains === 'function' && !rootRef.current.contains(ev.target)) {
              setMenuOpen(false)
            }
          }
          function onDocKeyDown(ev) {
            if (ev && ev.key === 'Escape') setMenuOpen(false)
          }
          document.addEventListener('mousedown', onDocMouseDown)
          document.addEventListener('keydown', onDocKeyDown)
          return function () {
            document.removeEventListener('mousedown', onDocMouseDown)
            document.removeEventListener('keydown', onDocKeyDown)
          }
        }, [menuOpen])
      }

      var scope = detectSwarmForHeader(ui, sessionId, explicitSwarmId)
      var shortSession = sessionId.length > 16 ? (sessionId.slice(0, 8) + '...' + sessionId.slice(-4)) : sessionId

      function flashStatus(kind, text) {
        setStatusMsg({ kind: kind, text: text })
        if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
        clearTimerRef.current = setTimeout(function () {
          setStatusMsg(null)
        }, 2800)
      }

      function buildPayload(format) {
        return {
          sessionId: explicitSwarmId ? '' : sessionId,
          swarmId: explicitSwarmId || '',
          format: format,
          detail: fullToolOutputs ? 'full' : 'compact',
          includeSubagents: includeSubagents,
          includeReasoning: includeReasoning,
        }
      }

      function handleDownload(format) {
        if (busy) return
        setBusy(true)
        setStatusMsg({ kind: 'info', text: 'Exporting...' })
        triggerExportDownload(buildPayload(format)).then(function (res) {
          setBusy(false)
          if (res && res.ok) {
            flashStatus('ok', 'Downloaded ' + (format === 'json' ? '.json' : '.md'))
          } else {
            flashStatus('err', (res && res.error) || 'Export failed')
          }
        })
      }

      function handleCopyMarkdown() {
        if (busy) return
        setBusy(true)
        setStatusMsg({ kind: 'info', text: 'Copying...' })
        copyExportMarkdown(buildPayload('md')).then(function (res) {
          setBusy(false)
          if (res && res.ok) {
            flashStatus('ok', 'Copied Markdown (' + Math.round((res.chars || 0) / 1024) + ' KB)')
          } else {
            flashStatus('err', (res && res.error) || 'Copy failed')
          }
        })
      }

      var menuBtnStyle = {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '1px',
        width: '100%',
        padding: '6px 8px',
        border: 'none',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        textAlign: 'left',
        cursor: busy ? 'wait' : 'pointer',
        fontSize: '12px',
      }

      return React.createElement(
        'div',
        {
          ref: rootRef,
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            marginRight: compact ? '0' : '4px',
          },
        },
        React.createElement(
          'button',
          {
            type: 'button',
            'aria-haspopup': 'menu',
            'aria-expanded': menuOpen,
            title: scope.isSwarm
              ? 'Export Swarm diagnostic log (Blackboard + all member sessions)'
              : 'Export conversation diagnostic log (+ subagents)',
            onClick: function () { setMenuOpen(function (v) { return !v }) },
            style: compact
              ? {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '28px',
                  height: '28px',
                  padding: '6px',
                  color: menuOpen ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                  background: menuOpen ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                  border: 'none',
                  borderRadius: 'var(--dsw-radius-sm, 4px)',
                  cursor: 'pointer',
                }
              : {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  padding: '2px 8px',
                  borderRadius: '999px',
                  cursor: 'pointer',
                  fontSize: '11.5px',
                  lineHeight: '18px',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: menuOpen ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-2)',
                  color: statusMsg && statusMsg.kind === 'ok'
                    ? 'var(--dsw-alias-state-success-primary, #10b981)'
                    : 'var(--dsw-alias-label-secondary)',
                  whiteSpace: 'nowrap',
                },
          },
          renderDownloadIcon(compact ? 15 : 13),
          compact ? null : React.createElement('span', null, statusMsg && statusMsg.kind === 'ok' ? 'Exported' : 'Export Log'),
        ),
        menuOpen
          ? React.createElement(
              'div',
              {
                role: 'menu',
                style: {
                  position: 'absolute',
                  top: 'calc(100% + 5px)',
                  right: 0,
                  zIndex: 9500,
                  minWidth: '240px',
                  padding: '8px',
                  borderRadius: '8px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: 'var(--dsw-alias-label-primary)',
                  boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,0.22))',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                },
              },
              React.createElement(
                'div',
                {
                  style: {
                    padding: '2px 6px 6px',
                    borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
                    marginBottom: '2px',
                  },
                },
                React.createElement(
                  'div',
                  { style: { fontSize: '11.5px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                  scope.isSwarm ? 'Swarm Diagnostic Log' : 'Conversation Diagnostic Log',
                ),
                React.createElement(
                  'div',
                  {
                    style: {
                      fontSize: '10.5px',
                      color: 'var(--dsw-alias-label-tertiary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '220px',
                    },
                  },
                  scope.isSwarm ? (scope.title || scope.swarmId) : ('Session ' + shortSession),
                ),
              ),
              React.createElement(
                'label',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '3px 6px',
                    fontSize: '11.5px',
                    color: 'var(--dsw-alias-label-secondary)',
                    cursor: 'pointer',
                  },
                },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: includeSubagents,
                  onChange: function (e) { setIncludeSubagents(Boolean(e && e.target && e.target.checked)) },
                }),
                scope.isSwarm ? 'Include all member sessions' : 'Include subagents',
              ),
              React.createElement(
                'label',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '3px 6px',
                    fontSize: '11.5px',
                    color: 'var(--dsw-alias-label-secondary)',
                    cursor: 'pointer',
                  },
                },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: includeReasoning,
                  onChange: function (e) { setIncludeReasoning(Boolean(e && e.target && e.target.checked)) },
                }),
                'Include reasoning blocks',
              ),
              React.createElement(
                'label',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '3px 6px 6px',
                    fontSize: '11.5px',
                    color: 'var(--dsw-alias-label-secondary)',
                    borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
                    cursor: 'pointer',
                  },
                },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: fullToolOutputs,
                  onChange: function (e) { setFullToolOutputs(Boolean(e && e.target && e.target.checked)) },
                }),
                'Full tool outputs (verbose)',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  disabled: busy,
                  onClick: function () { handleDownload('md') },
                  style: menuBtnStyle,
                },
                React.createElement('span', { style: { fontWeight: 500 } }, 'Download Markdown (.md)'),
                React.createElement('span', { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-tertiary)' } }, 'Clean report for review & AI diagnosis'),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  disabled: busy,
                  onClick: function () { handleDownload('json') },
                  style: menuBtnStyle,
                },
                React.createElement('span', { style: { fontWeight: 500 } }, 'Download JSON (.json)'),
                React.createElement('span', { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-tertiary)' } }, 'Structured bundle (stream-stripped)'),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  disabled: busy,
                  onClick: handleCopyMarkdown,
                  style: menuBtnStyle,
                },
                React.createElement('span', { style: { fontWeight: 500 } }, 'Copy Markdown to Clipboard'),
                React.createElement('span', { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-tertiary)' } }, 'Paste straight into another AI chat'),
              ),
              statusMsg
                ? React.createElement(
                    'div',
                    {
                      style: {
                        marginTop: '2px',
                        padding: '4px 6px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        background: 'var(--dsw-alias-bg-layer-2)',
                        color: statusMsg.kind === 'err'
                          ? 'var(--dsw-alias-state-error-primary, #ef4444)'
                          : statusMsg.kind === 'ok'
                            ? 'var(--dsw-alias-state-success-primary, #10b981)'
                            : 'var(--dsw-alias-label-secondary)',
                      },
                    },
                    statusMsg.text,
                  )
                : null,
            )
          : null,
      )
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
                { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } },
                'Members: ' + memberSummary.working + ' working · ' + memberSummary.waiting + ' waiting · ' + memberSummary.starting + ' starting' + (memberSummary.unparked_idle > 0 ? ' · ' + memberSummary.unparked_idle + ' unparked_idle' : '') + (memberSummary.zombie > 0 ? ' · ' + memberSummary.zombie + ' zombie' : '') + (memberSummary.error > 0 ? ' · ' + memberSummary.error + ' error' : ''),
              )
            : null,
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
                      + (m.last_park_blocked_seq ? ' blocked:#' + m.last_park_blocked_seq : '')
                      + (m.context_window > 0 && m.last_input_tokens > 0
                        ? ' · ctx:' + Math.round(m.last_input_tokens / 1000) + 'k/' + Math.round(m.context_window / 1000) + 'k (' + Math.round((m.last_input_tokens / m.context_window) * 100) + '%)'
                        : ''),
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
      }).sort(function (a, b) {
        return (b.seq || 0) - (a.seq || 0)
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
            React.createElement('span', null, filtered.length + ' post(s) · newest first · collapsed'),
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
              'No board posts yet. Run /swarm <task> in the main composer to start.',
            )
          : filtered.map(function (p) {
              var isHighlighted = ui.highlightedSeq === p.seq
              var isFresh = Boolean(ui.freshPostSeqs && ui.freshPostSeqs[p.seq])
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
                  className: isFresh ? 'dsh-swarm-post-fresh' : undefined,
                  style: {
                    padding: '7px 10px',
                    borderRadius: '8px',
                    border: isHighlighted
                      ? '1px solid var(--dsw-alias-state-business-primary)'
                      : isFresh
                        ? '1px solid #eab308'
                        : '0.5px solid var(--dsw-alias-border-l2)',
                    background: isHighlighted
                      ? 'var(--dsw-alias-interactive-bg-hover)'
                      : isFresh
                        ? 'rgba(250, 204, 21, 0.14)'
                        : 'var(--dsw-alias-bg-layer-2)',
                    opacity: isSuperseded ? 0.65 : 1,
                    transition: 'background-color 0.45s ease, border-color 0.45s ease',
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
                      isFresh
                        ? React.createElement(
                            'span',
                            {
                              style: {
                                display: 'inline-block',
                                marginRight: '5px',
                                padding: '0 4px',
                                borderRadius: '3px',
                                background: '#facc15',
                                color: '#1c1917',
                                fontSize: '9.5px',
                                fontWeight: 700,
                                verticalAlign: '1px',
                              },
                            },
                            'NEW',
                          )
                        : null,
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

    function formatEventBadge(ev) {
      if (!ev) return 'No events recorded yet'
      var p = ev.payload || {}
      var shortT = ev.time ? String(ev.time).slice(11, 19) || String(ev.time) : ''
      var prefix = (shortT ? '[' + shortT + '] ' : '')
      if (ev.type === 'member.spawn') return prefix + '+ Spawned @' + p.name + ' (' + (p.role || 'worker') + ')'
      if (ev.type === 'member.kill') return prefix + '- Retired @' + p.name + (p.handover_to ? ' -> @' + p.handover_to : '')
      if (ev.type === 'member.model_switch') return prefix + 'Model switch @' + p.name + ' -> ' + (p.model || '')
      if (ev.type === 'board.post') return prefix + '#' + (p.seq || ev.seq || '?') + ' @' + (p.agent || ev.actor) + ': ' + (p.title || p.kind || 'post')
      if (ev.type === 'swarm.init') return prefix + 'Swarm initialized (' + (p.concurrency_limit || 4) + ' slots)'
      if (ev.type === 'swarm.done') return prefix + 'Swarm closed [done]'
      if (ev.type === 'plan.update') return prefix + 'Plan updated (Wave ' + (p.current_wave || 1) + ')'
      return prefix + ev.type
    }

    function renderGraphTab(snap, ui) {
      var events = snap && Array.isArray(snap.events) ? snap.events : []
      var hasEventLog = events.length > 0
      var headSeq = (snap && snap.headSeq) || 1
      var totalOffsets = hasEventLog ? (events[events.length - 1].offset || events.length) : headSeq
      var currentCursor = hasEventLog
        ? (ui.replayOffset !== null ? Math.min(ui.replayOffset, totalOffsets) : totalOffsets)
        : (ui.replaySeq !== null ? Math.min(ui.replaySeq, headSeq) : headSeq)
      var isLive = hasEventLog ? ui.replayOffset === null : ui.replaySeq === null

      var layout = hasEventLog
        ? computeRoundTableFromEvents(
            events,
            (snap && snap.members) || [],
            ui.replayOffset,
            { cx: 170, cy: 152, seatR: 102, maxSteps: MAX_VISIBLE_EDGE_STEPS },
          )
        : computeRoundTableLayout(
            (snap && snap.members) || [],
            (snap && snap.edgeEvents) || [],
            currentCursor,
            { cx: 170, cy: 152, seatR: 102, maxSteps: MAX_VISIBLE_EDGE_STEPS },
          )
      var nodeR = 16
      var tableR = 54
      var latestIsBroadcast = layout.latestEdges.some(function (ed) { return ed.broadcast === true || ed.to === '__table__' })
      var shortClock = layout.currentTime ? (String(layout.currentTime).slice(11, 19) || String(layout.currentTime)) : ''
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

      function setCursor(nextVal) {
        if (hasEventLog) {
          updateUi({ replayOffset: nextVal >= totalOffsets ? null : Math.max(1, nextVal) })
        } else {
          updateUi({ replaySeq: nextVal >= headSeq ? null : Math.max(1, nextVal) })
        }
      }

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        // Kafka-style Event Offset + Timestamp Timeline Scrubber
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '5px',
              fontSize: '11px',
              padding: '7px 9px',
              borderRadius: '8px',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-bg-layer-2)',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () { setCursor(Math.max(1, currentCursor - 1)) },
                style: {
                  cursor: 'pointer',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-3)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontSize: '11px',
                },
                title: 'Step backward one event',
              },
              '◀',
            ),
            React.createElement(
              'span',
              { style: { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
              (hasEventLog ? 'Ev ' : '#') + currentCursor + '/' + totalOffsets,
            ),
            React.createElement('input', {
              type: 'range',
              min: 1,
              max: Math.max(1, totalOffsets),
              value: Math.max(1, currentCursor),
              onChange: function (e) { setCursor(Number(e.target.value)) },
              style: { flex: 1, minWidth: '60px' },
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () { setCursor(currentCursor + 1) },
                style: {
                  cursor: 'pointer',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-3)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontSize: '11px',
                },
                title: 'Step forward one event',
              },
              '▶',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () { updateUi({ replayOffset: null, replaySeq: null }) },
                style: {
                  cursor: 'pointer',
                  padding: '2px 7px',
                  borderRadius: '4px',
                  border: '0.5px solid var(--dsw-alias-border-l2)',
                  background: isLive ? 'var(--dsw-alias-interactive-bg-hover)' : 'var(--dsw-alias-bg-layer-3)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                },
              },
              isLive ? '● Live' : 'Latest',
            ),
          ),
          hasEventLog && layout.currentEvent
            ? React.createElement(
                'div',
                {
                  style: {
                    fontSize: '11px',
                    color: layout.currentEvent.type === 'member.spawn'
                      ? '#10b981'
                      : layout.currentEvent.type === 'member.kill'
                        ? '#f97316'
                        : 'var(--dsw-alias-label-secondary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                  title: formatEventBadge(layout.currentEvent),
                },
                formatEventBadge(layout.currentEvent),
              )
            : null,
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
            // Center round table ring (highlights yellow when latest round is @all broadcast to center)
            React.createElement('circle', {
              cx: layout.cx,
              cy: layout.cy,
              r: tableR,
              fill: latestIsBroadcast ? 'rgba(250, 204, 21, 0.08)' : 'var(--dsw-alias-bg-layer-3)',
              fillOpacity: latestIsBroadcast ? 1 : 0.45,
              stroke: latestIsBroadcast ? '#facc15' : 'var(--dsw-alias-border-l2)',
              strokeWidth: latestIsBroadcast ? 1.8 : 1,
              strokeDasharray: latestIsBroadcast ? 'none' : '4 3',
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
                fill: latestIsBroadcast ? '#fef08a' : 'var(--dsw-alias-label-secondary)',
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
              latestIsBroadcast ? '@all broadcast' : (layout.seats.length + ' active' + (shortClock ? ' · ' + shortClock : '')),
            ),
            // Directed arrows (oldest dark faint first -> latest bright yellow on top!)
            layout.edges.map(function (ed, idx) {
              var fromSeat = layout.seatByName[ed.from]
              if (!fromSeat) return null
              var isBroadcast = ed.broadcast === true || ed.to === '__table__'
              var toX = isBroadcast ? layout.cx : (layout.seatByName[ed.to] && layout.seatByName[ed.to].x)
              var toY = isBroadcast ? layout.cy : (layout.seatByName[ed.to] && layout.seatByName[ed.to].y)
              if (typeof toX !== 'number' || typeof toY !== 'number') return null
              if (!isBroadcast && ed.from === ed.to) return null

              var dx = toX - fromSeat.x
              var dy = toY - fromSeat.y
              var dist = Math.sqrt(dx * dx + dy * dy) || 1
              var ux = dx / dist
              var uy = dy / dist
              var nx = -uy
              var ny = ux

              var sx = fromSeat.x + ux * (nodeR + 3)
              var sy = fromSeat.y + uy * (nodeR + 3)
              var endPad = isBroadcast ? (tableR + 6) : (nodeR + 8)
              var ex = toX - ux * endPad
              var ey = toY - uy * endPad
              var pathD
              var midX
              var midY
              if (isBroadcast) {
                pathD = 'M ' + sx.toFixed(1) + ' ' + sy.toFixed(1) + ' L ' + ex.toFixed(1) + ' ' + ey.toFixed(1)
                midX = (sx + ex) / 2
                midY = (sy + ey) / 2
              } else {
                var curveOffset = Math.min(28, Math.max(12, dist * 0.16))
                var qcx = (sx + ex) / 2 + nx * curveOffset
                var qcy = (sy + ey) / 2 + ny * curveOffset
                pathD = 'M ' + sx.toFixed(1) + ' ' + sy.toFixed(1) + ' Q ' + qcx.toFixed(1) + ' ' + qcy.toFixed(1) + ' ' + ex.toFixed(1) + ' ' + ey.toFixed(1)
                midX = 0.25 * sx + 0.5 * qcx + 0.25 * ex
                midY = 0.25 * sy + 0.5 * qcy + 0.25 * ey
              }

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
                isWorking || seat.justSpawned
                  ? React.createElement('circle', {
                      cx: seat.x,
                      cy: seat.y,
                      r: nodeR + 4,
                      fill: 'none',
                      stroke: seat.justSpawned ? '#10b981' : '#facc15',
                      strokeWidth: 1.4,
                      strokeOpacity: 0.8,
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
                    '@' + ed.from + ' -> ' + (ed.broadcast || ed.to === '__table__' ? 'Round Table (@all)' : '@' + ed.to) + ' (' + ed.kind + ')',
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
              'No directed @mention arrows up to this point in the timeline.',
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
              { id: 'overview', label: 'Control' },
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
            snap
              ? React.createElement(SwarmExportMenuButton, {
                  compact: true,
                  explicitSwarmId: targetSwarmId,
                  sessionId: sessionId,
                })
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
                  'Type /swarm <task> in the main composer to start a Swarm. Concurrency slots are managed directly by the coordinator via swarm_init and swarm_concurrency.',
                ),
              )
            : ui.activeTab === 'overview'
              ? renderOverviewTab(snap, ui, targetSwarmId)
              : ui.activeTab === 'graph'
                ? renderGraphTab(snap, ui)
                : renderBoardTab(snap, ui),
        ),
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

        ctx.slots.inject('conversation.session.header.utilities', function () {
          try {
            var d = ctx.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'dsh-swarm-export-log',
                order: 80,
                inject: function () { return { hooks: { swarmUi: uiStore } } },
              },
              SwarmExportMenuButton,
            )
            if (typeof d === 'function') disposers.push(d)
          } catch (_dupErr) {}
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
          computeRoundTableFromEvents: computeRoundTableFromEvents,
          buildExportUrl: buildExportUrl,
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
            if (tab) updateUi({ activeTab: tab === 'control' ? 'overview' : tab })
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
    exports.computeRoundTableFromEvents = computeRoundTableFromEvents
    exports.computeStateFingerprint = computeStateFingerprint
    exports.fetchSwarmState = fetchSwarmState
    exports.buildExportUrl = buildExportUrl
    exports.uiStore = uiStore
    return module.exports
  },
})
