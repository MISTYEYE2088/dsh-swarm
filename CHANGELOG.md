# Changelog

## 0.3.7 (2026-11-23)

- **Scoped Lazy Tool Unlocking (DSH Native `agent.ctx.tools`)**:
  - Only `swarm_init` is registered globally at plugin startup; normal non-Swarm sessions no longer pay the prompt token overhead of the other 10 Swarm tool schemas.
  - Calling `swarm_init` (or `/swarm`, or resuming an initialized Swarm session via `agent/created`) dynamically registers the remaining 10 Swarm tools strictly on that coordinator's `agent.ctx.tools` scope (DSH emits `tools/change` and exposes them immediately on the next step, without leaking to unrelated sessions).
  - Child worker sessions deny global `swarm_init` and receive ONLY the 5 worker-usable tools (`post_board`, `read_board`, `swarm_wait`, `swarm_status`, `swarm_model`) on their own scope.

## 0.3.6 (2026-11-23)

- **Pure 2-File SSOT Cleanup (Zero Legacy Complexity)**:
  - Removed all pre-`v0.3.4` legacy synthesis, fallback, and migration branches from `src/host/store.js` (`_synthesizeLegacyEvents`, `_ensureLegacyMigrated`, legacy path fallbacks). Every Swarm is now strictly 2 files: `events.jsonl` + `offsets.json`.
- **AI-Managed Concurrency (`swarm_concurrency`) & Read-Only Browser UI**:
  - Removed all out-of-band UI mutation buttons (`Adjust slots`, `Init (N slots)`) and the `/api/dsh-swarm/action` POST route so users never mutate Swarm state behind the AI's back; browser UI is now a pure read-only projection (`/api/dsh-swarm/state` GET only).
  - Added coordinator-only AI tool `swarm_concurrency(limit, reason)` (restricted on child workers) so the Coordinator manages in-flight LLM slot limits directly with full visibility.

## 0.3.5 (2026-11-23)

- **Fixed Legacy Swarm History Vanishing on Slot Adjustments (`Adjust slots` / `swarm.update`)**:
  - Root cause: clicking `Adjust slots` on a pre-`v0.3.4` legacy swarm (which only had `swarm.json` / `board.jsonl` / `members.json` / `plan.json` and no `events.jsonl`) appended a bare `swarm.update` line into a brand-new `events.jsonl`; `readEventLog()` then saw non-empty `events.jsonl` and stopped reading the legacy files.
  - Added lossless write-time migration (`SwarmStore._ensureLegacyMigrated`) before appending any event to a legacy swarm directory, plus automatic read-time self-healing in `readEventLog()` so any already-affected legacy directory immediately recovers 100% of its history without losing slot updates.
- **UI Clarity**:
  - Renamed the middle sidebar tab from `Overview` to `Control` (`Board` | `Control` | `Round Table`) to accurately reflect its runtime control & operational contents (Merge Gate, LLM In-Flight Slots, Watchdog, Plan, Roster, Progress Reel).

## 0.3.4 (2026-11-23)

- **True Single-Source-of-Truth (SSOT) Two-File Storage + Stateless Projector & Auto-Checkpoints**:
  - Eliminated all duplicate persistence across `swarm.json`, `board.jsonl`, `members.json`, and `plan.json`.
  - Every immutable domain fact (`swarm.init`, `swarm.update`, `plan.update`, `member.spawn`, `member.kill`, `member.model_switch`, `board.post`, `board.control`, `swarm.done`, plus periodic `state.checkpoint` snapshots) is now stored in **exactly one place**: append-only `events.jsonl` (`offset` + `ts_ms`).
  - Mutable consumer offsets & live runtime telemetry (`last_read_seq`, `wait_since`, `wake_mode`, `wake_kinds`, `turn_count`, `tool_call_count`, `last_error`) live in **exactly one place**: `offsets.json` (zero overlapping domain facts).
  - Extracted pure stateless state computation into `src/host/projector.js` (`SwarmStateProjector`), removing hidden in-memory file caching. Every **50** domain events, `SwarmStore.appendEvent()` writes a compact `state.checkpoint` frame into `events.jsonl`; every state projection automatically anchors on the **second-newest** valid checkpoint and replays only the trailing ~50–100 events (O(1) bounded work even on multi-thousand-event swarms, plus crash resilience if the newest checkpoint were ever corrupted).
  - Preserved automatic read compatibility for legacy pre-v0.3.4 swarm directories on disk.
- **Flicker-Free Board Updates + Yellow Arrival Highlight Animation**:
  - Deduplicated polling across Header & Rightbar into one shared ref-counted poller with in-flight guarding and state fingerprinting (`computeStateFingerprint`): unchanged polls perform **0 React re-renders** (eliminating periodic flicker completely).
  - Newly arriving board posts smoothly glide in with a **3.2-second warm yellow highlight fade** (`dshSwarmNewPostFlash` CSS keyframe + `NEW` yellow pill) and smooth CSS color transitions.

## 0.3.3 (2026-11-23)

- **Kafka-Style Event-Sourced Architecture (`events.jsonl`) for Exact Historical Replay**:
  - Added append-only `<swarmId>/events.jsonl` recording every immutable swarm action with monotonic `offset` and millisecond timestamp `ts_ms` (`swarm.init`, `member.spawn`, `member.kill`, `member.model_switch`, `board.post`, `board.control`, `plan.update`, `swarm.done`), archived alongside the other blackboard files on close.
  - Added deterministic `replaySwarmEvents(events, { atOffset, atTsMs, atSeq })` in `src/host/store.js` plus automatic legacy synthesis for older swarms without `events.jsonl`.
  - Upgraded the Round-Table UI (`client.js`, `computeRoundTableFromEvents`) to scrub across Kafka event offsets & timestamps, restoring the **exact active seats, spawn/retire transitions, and aging yellow arrows** at every historical moment.

## 0.3.2 (2026-11-23)

- **Rightbar Board Tab UX**:
  - Removed the bottom `Post to board` composer from the browser UI (board posts are authored by Swarm agents only).
  - Reversed the Board message list to **newest-first** (`seq` descending) so the latest floor is immediately visible at the top.
- **Round-Table Topology Fixes & Center-Table Broadcast Arrows**:
  - Fixed historical `edgeEvents` in `buildSwarmProjectionSnapshot()` so peer-to-peer arrows (`@worker -> @architect`, `@verifier -> @worker`, etc.) are preserved even after wave members are retired (`killed`), and stopped spuriously routing every post to `@coordinator` just because of `wake_mode: "anything"`.
  - `@all` broadcasts (and silent/general table announcements) now render as a single directed arrow pointing straight into the **center of the Round Table** (`to: "__table__"`), highlighting the table ring in bright yellow when active in the latest round.

## 0.3.1 (2026-11-23)

- **Mandatory Meaningful Board Titles & Collapsible Rightbar Cards**:
  - `post_board` now requires a meaningful `title` (`4..100` chars; rejects empty or generic placeholders like `"update"` / `"report"` / `"done"`), stored on every `board.jsonl` post and rendered in `read_board` and `edgeEvents`.
  - In the `Crs0CG_rightbarCol` Board tab (`client.js`), all messages render **collapsed by default** showing `#seq · title`, author/badges, timestamp, and an explicit Expand/Collapse (`▸ Open` / `▾ Hide`) toggle button immediately to the right of the timestamp (plus `Expand All` / `Collapse All` and auto-expand on `#seq` jumps).
- **100% English Runtime & UI (Zero CJK Characters)**:
  - Translated all prompts (`src/host/prompts.js`), tool descriptions/outputs (`src/host/tools.js`), validators (`src/host/validators.js`), watchdog alerts (`src/host/monitor.js`), stop-hook notices (`src/host/stop-hook.js`), worktree errors (`src/host/worktree.js`), host entry (`index.js`), and browser UI (`client.js`) to clean English so multilingual models respond in the user's own language instead of being nudged by plugin strings.
- **Round-Table SVG Topology with Aging Yellow-to-Faded Arrows**:
  - Replaced the abstract list in the Topology tab with an interactive **Round-Table SVG** (`computeRoundTableLayout` + `computeEdgeVisualStyle`): members sit evenly around the blackboard circle (`coordinator` pinned at 12 o'clock), the latest round's directed arrow(s) render in **bright yellow (`#facc15`, opacity `1.0`)** with a `#seq` pill on top, and each older step progressively darkens and lowers opacity until fading out completely.

## 0.3.0 (2026-11-23)

- **P0 Reliability — Zero False Board Errors & Duplicate Posts (D-01)**:
  - Fixed `post_board` returning `value is not lossless JSON` by returning a plain `{ woken, unreachable, silentMentions }` object from `dispatchPostWakeups` and normalizing all 10 tool outputs through `toLosslessJson()`.
  - Fixed Windows NTFS `EPERM` rename collisions on `members.json` by adding retry/backoff + safe fallback in `writeJsonAtomicSync()` and moving high-frequency `session/event` telemetry into an in-memory map flushed inside `store.withLock()`.
  - Added built-in `post_board` idempotency (`idempotency_key` + 60s content-hash deduplication returning existing `#seq`).
- **P0 Reliability — Atomic `swarm_add` + Rollback & Explicit Zombie Detection (D-02 / D-04)**:
  - Reordered `swarm_add` to resolve model routes and create the live DSH agent session *before* writing to `board.jsonl` / `members.json`, rolling back worktrees and member state cleanly on any error so zero zombies or locked names remain.
  - Distinguished `starting` and `zombie` from healthy `waiting` in `statusOf()`, and released member names on `swarm_kill` when `turn_count === 0 && last_post_seq === 0` (plus optional `handover_to` / `reason`).
  - Refactored `SwarmMonitorDaemon` into a pure deterministic Watchdog (removed `role: "monitor"` from `swarm_add` and removed fake `monitor` roster rows) with a fast 30s health probe that catches `zombie` and `error` members **even while sibling workers are `working`**.
- **Noise Reduction, Board Filtering & Superseding Decisions (D-03 / D-18 / D-22 / D-24)**:
  - Added `wake_kinds` filtering to `swarm_wait`, plus `escalate: true` and `silent: true` to `post_board`.
  - Strict validation on explicit `args.mentions` while tolerating casual unregistered prose `@tokens`.
  - Added `supersedes: number[]` and `verdict: "approve" | "reject" | "override"` to `post_board`, plus `kinds`, `agent`, `limit`, and `hide_superseded` to `read_board`.
- **Peer-Accountability Org Contract, `architect` Role & Merge Gate (D-05 / D-09 / P1–P9)**:
  - Added built-in `architect` role preset (`ARCHITECT_SOP_PROMPT`) alongside upgraded PM-mode `COORDINATOR_SOP_PROMPT`, `WORKER_SOP_PROMPT`, and `VERIFIER_SOP_PROMPT` (preserving user attribution).
  - Enforced runtime merge/done gate blocking `swarm_land(action="apply")` and `[done]` while unresolved `[REJECT]` verdicts from `architect`/`verifier` remain open (with explicit `override_reason` audit escape hatch).
  - Added optional `project_root` on `swarm_init` + 1-level child `.git` repo auto-discovery so isolated worktrees (`share`/`branch`) work for subdirectory repositories.
  - Clarified `LLM In-Flight Slots` vs active member counts in `swarm_status`, `/swarm`, and the Rightbar UI (`client.js`), and avoided re-asking inline user-specified concurrency in `/swarm`.

## 0.2.0 (2026-11-23)

- Added dynamic DSH model route discovery (`discoverAvailableModels`, `resolveModelRoute`) stripping hardcoded sentinels (`"internal"`, `"inherit"`).
- Fixed child subagent tool inheritance (`agentPresets.composeFrom`) and durable parent addressing (`subagent/descriptor` v3 + `subagent/catalog` v0 + `uiWorkspace.openSession`).
- Added runtime version fingerprint, Turn-1 error surfacing, automatic blackboard archiving on `[done]` / re-init, and generation tracking.
- Mounted `/swarm` natively into the `/` slash command menu and docked the Swarm Hive UI into DSH's Right Sidebar (`Crs0CG_rightbarCol`).

## 0.1.0 (2026-11-22)

- Initial release of `dsh-swarm` for DeepSeek Harness `0.2.0-rc.2`.
