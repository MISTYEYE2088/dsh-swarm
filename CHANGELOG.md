# Changelog

## 0.4.0 (2026-11-25)

- **Unified Diagnostic Log Export for Both Swarm & Normal DSH Conversations (`src/host/log-export.js` + `/api/dsh-swarm/export`)**:
  - Added host-side `collectDiagnosticExport()` and `formatDiagnosticMarkdown()` reading DSH sessions through official Host services (`sessions`, `sessionPersistence`, `sessionQuery`) with zero external npm dependencies.
  - **Auto-detects mode strictly (`resolveSwarmId(..., { fallbackLatest: false })`)**: exporting a normal conversation exports ONLY that conversation + its native subagents (`mode="session"`) without cross-contaminating from unrelated Swarms on disk; exporting a Swarm coordinator or member session exports the full Swarm Roster, Active Plan, Merge Gate Rejections, Blackboard timeline (`events.jsonl`), and all member transcripts (`mode="swarm"`).
  - Strips noisy raw SSE `assistant/message.data.stream` delta chunks while preserving user prompts, assistant replies, optional reasoning blocks, tool calls/results (with error highlighting & clean truncation), abnormal `turn/end` reasons, compaction markers, and real token/context usage.
  - Supports **Markdown (`.md`)** (human & AI diagnostic report) and **JSON (`.json`)** (structured machine bundle) via `GET/HEAD /api/dsh-swarm/export`.
- **Native DSH UI Extension for Log Export (`client.js`)**:
  - Mounted `SwarmExportMenuButton` in `conversation.session.header.utilities` (visible on **every** normal conversation and Swarm session, right beside `dsh-session-id` and DSH's header menu) AND in the Swarm Right Sidebar toolbar (next to Refresh).
  - Provides 1-click **Download Markdown (`.md`)**, **Download JSON (`.json`)**, and **Copy Markdown** (with clipboard fallback + inline status feedback), plus toggles for `Include subagents / members` and `Include reasoning`.
- **Real Context Usage Telemetry (`swarm_status` + Export)**:
  - Tracked `request/context` (`contextWindow`) and `assistant/message` (`usage.inputTokens`) in live member telemetry, surfacing real `ctx=42.0k/128.0k(33%)` in `swarm_status` and exported Swarm rosters.

## 0.3.13 (2026-11-24)

- **Watchdog 10-Minute Sliding Window for `unparked_idle` + Coordinator Apology/Idle Loop Breaker**:
  - Kept the 1st `unparked_idle` detection identical (direct `[Watchdog Auto-Resume]` whip to the worker), and replaced immediate next-30s escalation with a 10-minute sliding window (`UNPARKED_IDLE_WINDOW_MS = 600_000`): if a single session slips into `unparked_idle` `>= 2` times within 10 minutes (even with incremented turn count), Watchdog posts a board alert mentioning both `@member` (requiring an explanation on the board) and `@coordinator` (to decide next action), with duplicate suppression for the window.
  - Updated `COORDINATOR_SOP_PROMPT` to explicitly kill & respawn a fresh session when a member falls into an apology loop or repeated `unparked_idle` churn (asking for brief handover notes first if it holds valuable partial findings), and added direct `git status`/`git diff` + user-provided-path anchor discipline across Coordinator and Worker prompts.
- **2D `VERIFIER_REVIEW_RULES` (`V1..V5`) + Automatic `user`-Side Wakeup Anchor**:
  - Added `VERIFIER_REVIEW_RULES` as a 2D `[[title, detail], ...]` array on `ROLE_REGISTRY.verifier.reviewRules` (`V1:clean-room-entrypoints`, `V2:log-keyword-scan`, `V3:zero-hook-journey`, `V4:no-circular-evidence`, `V5:tmp-mutations`), driving both `VERIFIER_SOP_PROMPT` (`{{REVIEW_RULES}}`) and dynamic `user`-turn wakeup anchors in `dispatchPostWakeups` with zero duplicated code.
- **Role-Level Heterogeneous Model Parameterization (`defaultModel` / `preferredModelKeywords`)**:
  - Added `defaultProvider`, `defaultModel`, and case-insensitive `preferredModelKeywords` to `ROLE_REGISTRY` / `registerRole` (configurable via `config.roles.<role>`), defaulting `architect` and `verifier` to `['glm', 'auto']`.
  - `resolveModelRoute()` now matches discovered DSH routes case-insensitively (preferring routes distinct from the parent session for heterogeneous auditing, e.g. GLM-5.3 named `auto`), always honoring explicit caller overrides and degrading seamlessly to `inherit` when no matching route exists.
- **`swarm_kill` Running-Member Safety Brake + Handover ("Last Words") Prompt**:
  - `swarm_kill` now blocks terminating a currently `working` or `queued` member unless `force: true` is passed, displaying its live `stepSummary` and prompting the coordinator to request a brief handover summary ("last words") via `post_board` if its partial findings are meaningful.

## 0.3.12 (2026-11-24)

- **Asymmetric Reviewer-Only `[BLIND_AUDIT_ALERT]` (Zero Sender Leak)**:
  - Added `hasLeadingAuditBias()` in `src/host/prompts.js` with broad framing/closing-pressure/expected-count patterns.
  - When a post with leading bias wakes a `canBlockMerge` reviewer (`architect`/`verifier`), `dispatchPostWakeups` injects `[BLIND_AUDIT_ALERT]` strictly into the reviewer's `user` wakeup message (instructing from-scratch inspection and prohibiting disclosing the alert or trigger to the sender). Senders never see the alert and cannot game keywords.
- **Expanded 2D `ARCHITECT_REVIEW_RULES` (`C9` + `C10`)**:
  - Added `C9:global-conflict-and-switches` (verify against full tree/firmware semantics & audit silent skip switches) and `C10:real-pushback-and-gaps` (enforce public-board pushback with reviewer `CONCEDE`/`DEFEND` and ban hiding fixable medium/low items as known gaps).
- **2+ Consecutive Rejects Auto-Escalation (`[ESCALATE_TO_HUMAN]`)**:
  - Derived `consecutive_rejects` directly from `events.jsonl` in `computeActiveRejections` (zero new state); hitting `>= 2` consecutive rejects surfaces `[ESCALATE_TO_HUMAN]` in `post_board`, `swarm_status`, and Coordinator wakeups to break local-patching loops.
- **State-Machine Anti-Slacking Detector (`unparked_idle` + Automatic Re-Wake Whip)**:
  - Fixed `statusOf()` so an active non-coordinator member with `wake_mode === 'working'` whose turn ended without `swarm_wait` is classified as `unparked_idle` (not falsely masked as `waiting`).
  - Watchdog `healthTick()` detects `unparked_idle` even while peers are working, sends a direct `[Watchdog Auto-Resume]` whip on 1st strike, and escalates a `[WATCHDOG_ALERT]` to `@coordinator` if ignored.

## 0.3.11 (2026-11-24)

- **2D Array Meta Review Rules (`ARCHITECT_REVIEW_RULES` / `roleSpec.reviewRules`) + Dynamic `user`-Side Wakeup Anchor**:
  - Defined `C1..C8` architectural review meta-rules as a single 2D `[[title, detail], ...]` array in `src/host/prompts.js` (overridable per role via `registerRole` or `config.roles.<role>.reviewRules`).
  - `renderRolePrompt()` expands full `[title, detail]` bullets into the System Prompt, while `dispatchPostWakeups()` dynamically injects a compact 1-line `user`-turn wakeup anchor derived solely from `rule[0]` titles (zero hardcoded summary strings, directly mitigating DeepSeek system-prompt decay).
- **Anti-Reward-Hacking Verifier & Log-Scan Hardening**:
  - Updated `VERIFIER_SOP_PROMPT` to capture command output and scan for error/fail/skip/localized failure keywords instead of trusting exit code `0` alone, require real executed commands + non-empty stdout on `verdict="approve"`, and classify evidence basis (External Anchor / Hand-Calculated / Circular / Unverified Assumption).
  - Updated `COORDINATOR_SOP_PROMPT` so `override_reason` is reserved for explicit user approval or requirement changes.
  - Updated `LORE_MASTER_SOP_PROMPT` to cite `file path + symbol/function name` instead of brittle `file:line`.

## 0.3.10 (2026-11-24)

- **Parameterized Single-Source-of-Truth Role Registry (`ROLE_REGISTRY` / `registerRole`)**:
  - Replaced all hardcoded `role === '...'` branches across `stop-hook.js`, `validators.js`, `projector.js`, `store.js`, `tools.js`, and `index.js` with a single declarative role table in `src/host/prompts.js` (`registerRole`, `getRoleSpec`, `getSpawnableRoles`).
  - Every non-coordinator role automatically inherits Stop-Hook unparked protection (`requireParkOnStop: true` by default), merge-gate defaults (`canBlockMerge`), auto-worktree defaults (`autoShareInGit`), concurrency priority (`priorityTier`), and custom prompts—and custom roles can also be declared via `config.roles` in `cordis.patch.yml` with zero code changes.

## 0.3.9 (2026-11-23)

- **Compact Wire Format & Token Optimization (~60–75% Smaller Recurring Injections)**:
  - Compacted all high-frequency Swarm messages injected into agent contexts: board wakeups (`[board] #N @agent (kind): title -> read_board(since=M)`), `post_board` receipts (`OK #N (read=#N, woke:@x)`), `read_board` headers/rows (`HH:MM:SS` only, omit default `#main` & repetitive UUID), `swarm_wait` receipts (`PARKED #N (mentions)`), `swarm_status` roster lines (~63% shorter per member), Stop-Hook notices, and tool parameter schemas.
  - Extended Stop-Hook unparked-member protection to cover `lore_master` alongside `worker`, `architect`, and `verifier`.

## 0.3.8 (2026-11-23)

- **New Role Preset: `lore_master` (Read-Only Domain & Spec Oracle)**:
  - Dedicated read-only librarian role for massive hardware/NIC specs, register maps, internal protocols, and large codebases so implementers, architect, and verifier ask `@lore_master` for exact `file:line`/register citations instead of burning context scanning doc trees. Runs at `PRIORITY.VERIFIER` to unblock waiting workers fast (`can_block_merge: false`, `workspace: "inherit"`).
- **Lean Role-Scoped SOP Prompts (`src/host/prompts.js`)**:
  - Cut prompt length by ~45%, removed attribution meta-history and cross-role leakage, and added crisp operational guardrails: real interface stubs first (<=2 doc rounds), ban same-repo defensive glue, Architect structural-debt review, Verifier clean-room entrypoint audit + zero-hook black-box user journey + `/tmp`-only mutation tests.
- **Tier-B Zero-New-State Runtime Guardrails**:
  - `swarm_add`: defaults `role="worker"` to isolated `workspace="share"` automatically when Git worktree is available (while honoring explicit `workspace="inherit"` and keeping read-only roles on `"inherit"`).
  - `post_board(kind="done")`: runs `git status --porcelain` on `project_root` and emits `[RELEASE_HYGIENE_WARN]` when dirty files or `scratch/`/`mutants/` artifacts remain.
  - `swarm_status`: flags active members with `>= 80` tool calls via `[BUDGET_WARN]` using existing `tool_call_count` telemetry.

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
