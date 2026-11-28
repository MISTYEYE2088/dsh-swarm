# dsh-swarm

[English](README.md) · [中文](README.zh.md) · [Changelog](CHANGELOG.md)

Out-of-tree **Multi-Agent Swarm (`/swarm`)** plugin for **DeepSeek Harness (`dsh`)** — featuring a **2-file Single-Source-of-Truth event-sourced blackboard** (`events.jsonl` + `offsets.json`) with automatic 50-event checkpoints, **per-agent lazy tool unlocking** (only `swarm_init` loaded on normal chats), **zero-token `swarm_wait`** with a Stop-Hook race lock, **isolated Git worktrees**, **built-in Watchdog & Merge Gate**, and a live right-sidebar **Board / Control / Round Table** UI.

---

## Install from GitHub (Zero Build Step)

Install directly from GitHub into your DSH `web` profile, then restart `dsh web` and hard-refresh the browser (`Ctrl+Shift+R`):

```bash
# If you installed `dsh` globally:
dsh plugin --profile web add https://github.com/MISTYEYE2088/dsh-swarm

# If you run DSH from a source checkout (deepseek-harness monorepo):
pnpm dsh plugin --profile web add https://github.com/MISTYEYE2088/dsh-swarm
```

Verify the profile loaded `dsh-swarm` before starting:

```bash
dsh --profile web --dump-config | grep dsh-swarm
# PowerShell: pnpm dsh --profile web --dump-config | Select-String 'dsh-swarm'
```

### Updating or Uninstalling

```bash
# Update to latest GitHub commit
dsh plugin --profile web remove dsh-swarm
dsh plugin --profile web add https://github.com/MISTYEYE2088/dsh-swarm

# Uninstall completely
dsh plugin --profile web remove dsh-swarm
```

*(Restart `dsh web` after installing, updating, or removing the plugin.)*

---

## Quick Start

1. **Normal chats stay clean**: By default, only a single entry tool (`swarm_init`) is visible on your main session—zero prompt bloat from the rest of the Swarm toolset.
2. **Start a Swarm**: Type `/swarm <your task>` in the composer (or ask the model to call `swarm_init`):
   ```text
   /swarm Refactor the auth middleware, add unit tests, and run an independent verification pass
   ```
   - Calling `swarm_init` dynamically unlocks the remaining **10 Swarm tools** strictly on that session (`agent.ctx.tools`).
   - All agent transcripts live in DSH's native `~/.dsh/sessions/`; blackboard events live in `~/.dsh/swarm/<sessionId>/`.
3. **Open the Swarm Right Sidebar**: Click the **Swarm** badge in the top-right header (or switch to the **Swarm** tab in the right sidebar):
   - **Board**: Newest-first message stream, collapsed by default to meaningful titles with an expand/collapse toggle right of the timestamp, clickable `#seq` floor jumps, and a smooth 3.2s yellow arrival highlight (`NEW`) with flicker-free polling.
   - **Control**: Read-only live dashboard showing Merge Gate `[REJECT]` blockers, LLM In-Flight Slots (`active/limit · queued`), Watchdog status, active Plan/Tracks, Roster with `Open Session` links, and Screenshot Progress Reel.
   - **Round Table**: Interactive SVG communication topology where the latest round's arrows glow bright yellow and older steps progressively darken and fade out, `@all` broadcasts point to the center table, and a Kafka offset/timestamp scrubber replays exact historical active seats across waves.

### When to Use (and Skip) Swarm
- **Great fit**: Independent parallel tracks with disjoint write scopes, cross-module debugging, architecture/spec + implementation split, or high-stakes edits needing an independent `verifier` with real test samples.
- **Skip Swarm**: Single-file quick edits or tightly sequential tasks where orchestration overhead exceeds a single agent.

---

## Tool Surface (Scoped Lazy Loading)

| Tool | Scope / Role | Purpose |
| --- | --- | --- |
| `swarm_init` | **Global entry tool** (Coordinator) | Initialize Swarm, pin immutable `anchors` & optional host `gate_commands`, probe Git worktrees, and dynamically unlock the other 10 tools |
| `swarm_plan` | Coordinator (unlocked after init) | Publish/update Wave & Track plan (≤ 64 KB), `anchors`, and optional host `gate_commands` |
| `swarm_add` | Coordinator (unlocked after init) | Atomically spawn `worker`, `architect`, `verifier`, `red_team`, or `lore_master` with pre-spawn `[OWNERSHIP]` overlap detection, lossless `adopt_worktree_from` takeover, and isolated `review_target` snapshot worktrees |
| `swarm_concurrency` | Coordinator (unlocked after init) | Adjust in-flight LLM request slots dynamically (`limit >= 1`) |
| `swarm_land` | Coordinator (unlocked after init) | `diff`, `gate` (host `gate_commands`), `preflight_all`, or `apply` isolated worktree edits (enforces `[REJECT]` gates, `reviewed_diff_hash`, scope/sensitive blacklists, and host gates) |
| `swarm_kill` | Coordinator (unlocked after init) | Retire a member (with optional `keep_worktree: true` for takeover and `handover_to` successor transfer) |
| `post_board` | Coordinator + Workers | Post titled message with `@mentions`, `kind`, `verdict`, authorized `supersedes`, `blind_group`/`blind_quorum` sealed barriers, automatic worker commit snapshots, and objective reviewer `witness` telemetry |
| `read_board` | Coordinator + Workers | Read board posts with `since`, `channel`, `mentions_only`, `kinds`, `hide_superseded`, `limit`, blind-review/sealed-group projection, and read-only `seance_member` handover capsules |
| `swarm_wait` | Coordinator + Workers | Park at 0 idle token cost (`exec.concludeTurn()`) until matching board activity arrives; Stop-Hook prevents missed-message races |
| `swarm_status` | Coordinator + Workers | Inspect live member liveness (`working`/`waiting`/`starting`/`zombie`/`error`), turn/tool counts, slots, Watchdog, and merge gate |
| `swarm_model` | Coordinator + Workers | Hot-swap a member's `provider/model` in place while preserving conversation history |

---

## Key Architecture

- **2-File Single Source of Truth (`events.jsonl` + `offsets.json`)**:
  - `events.jsonl`: Append-only immutable event log storing **all domain facts** (`swarm.init`, `swarm.update`, `plan.update`, `member.spawn`, `member.kill`, `member.model_switch`, `board.post`, `board.control`, `swarm.done`).
  - `offsets.json`: Mutable per-member **consumer cursors & runtime telemetry ONLY** (`last_read_seq`, `wait_since`, `wake_mode`, `wake_kinds`, `turn_count`, `tool_call_count`, `last_error`). Zero overlapping domain facts.
- **Stateless Projector + 50-Event Auto-Checkpoints (`src/host/projector.js`)**: Every 50 domain events, a compact `state.checkpoint` frame is appended to `events.jsonl`. `SwarmStateProjector` automatically anchors on the **second-newest** valid checkpoint, keeping replay strictly $O(1)$-bounded even on multi-thousand-event swarms while surviving a torn newest checkpoint.
- **Polite Concurrency Gate (`ConcurrencyGate`)**: Wraps DSH `llm/stream` with priority tiers (`Coordinator > Verifier/Architect > Worker round-robin`), pacing, `AbortSignal` cleanup, and HTTP 429 AIMD backoff. Works with any model configured in DSH (`inherit` or `provider/model`).
- **Built-in Deterministic Watchdog & Merge Gate**: Zero-token host timer detects zombies (`0 turns` past threshold) even while peers are active; `[REJECT]` verdicts from `verifier`/`architect` block `swarm_land` and `[done]` until resolved or explicitly overridden.
- **100% English Runtime & UI**: Enforced by automated smoke tests so multilingual models never drift output languages.

---

## Compatibility & Verification

Verified against DeepSeek Harness **`0.2.0-rc.2`** (zero build step, zero `prepare` scripts, zero `peerDependencies`, no `Config` export):

```bash
node --check index.js && node --check client.js
npm test               # 70 end-to-end smoke, SSOT, blind-review, witness, host-gate, and UI tests
npm run verify:install # Tarball pack + isolated clean install gate
npm run test:boot      # Real @deepseek-ai/cordis mount check (set DSH_CORDIS_PATH if needed)
```

## License

[MIT](LICENSE)
