# Changelog

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
