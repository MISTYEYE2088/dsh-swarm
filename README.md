# dsh-swarm

[English](README.md) · [中文](README.zh.md) · [Architecture Spec](SPEC.md)

Out-of-tree **Swarm Mode (`/swarm`)** plugin for **DeepSeek Harness (`dsh`)** — built around a three-file plain-text blackboard (`swarm.json`, `board.jsonl`, `members.json`) plus a static `plan.json` overview, zero-token `swarm_wait` with a Stop-Hook race lock, isolated Git worktrees with dirty-tree sync, and a polite 1–6 concurrency gate tailored for self-hosted internal models (`glm5.3` / `deepseek4.1f`).

## Install (Remote or Local)

Pick either remote GitHub installation (no local clone or build step required) or local path installation, then restart `dsh web`:

```powershell
# 1) Remote install directly from GitHub (zero build step, works out of the box)
pnpm dsh plugin --profile web add https://github.com/MISTYEYE2088/dsh-swarm

# 2) Or install from a local checkout
pnpm dsh plugin --profile web add C:\portable_software\dsh\dsh-swarm

# 3) Verify profile composition without starting the server
pnpm dsh --profile web --dump-config | Select-String 'dsh-swarm'
```

## Compatibility

Declared and verified against DeepSeek Harness:

`0.2.0-rc.2` (matches `package.json` → `dsh.compatibility.dshReleases`)

- **Zero build step & no `prepare` lifecycle script**: `index.js` (Host ESM) and `client.js` (Browser classic-script combo) ship ready to load, so `dsh plugin add https://github.com/MISTYEYE2088/dsh-swarm` is never blocked by pnpm 10+ `allowBuilds`.
- **Zero `peerDependencies`**: imports only `node:` built-ins on the Host and platform seed modules in the Browser, so DSH version upgrades never require manual `dsh plugin allow-version` exemptions.
- **No `Config` export**: avoids the Cordis `resolveConfig` plain-object startup crash; row configuration is merged safely inside `apply()`.

## Key Architecture

| Mechanism | Implementation |
| --- | --- |
| **Phase-0 Concurrency Confirmation** | Blocks `swarm_add` until the Coordinator calls `ask_user_question` to confirm the concurrency budget (`2 / 3 / 4 / 6`) and model mix (`glm5.3` / `deepseek4.1f`), protecting shared internal GPU clusters. |
| **Polite Concurrency Gate (`ConcurrencyGate`)** | Wraps DSH `llm/stream` waterfall with 4 priority tiers (`P0 Coordinator > P1 Verifier > P2 Worker [fair round-robin] > P3 Monitor`), `200ms` inter-request pacing, `AbortSignal` queue cleanup, and HTTP 429 AIMD dynamic backoff. |
| **3-File Blackboard + `plan.json`** | Stored under `<DSH_HOME>/swarm/<sessionId>/`: `swarm.json`, `board.jsonl` (append-only posts + event-sourced `#channel` control frames via `replayChannelsAt`), `members.json` (5 floor cursors: `last_read_seq`, `wait_since`, `last_nudged_seq`, `last_park_blocked_seq`, `last_post_seq`; `desired_model`/`applied_model`; permanent tombstone lock on `killed` names), and static `plan.json` (≤ 64 KB, replacing the token-burning narrator). |
| **Zero-Token Idle & Stop-Hook Race Lock** | `swarm_wait` invokes `exec.concludeTurn()` to end the turn immediately at 0 idle token cost. Hooks `agent/turn-stopping` to block termination if new relevant posts arrived on `board.jsonl` during the closing window (`last_park_blocked_seq`) or if a worker forgot to call `swarm_wait`. |
| **Git Worktree + Dirty Overlay Sync** | `workspace: "share"` creates a detached git worktree and copies uncommitted staged, unstaged, and untracked files from the main workspace into a baseline snapshot so `swarm_land` computes pure worker incremental diffs and blocks `swarm_kill` if unmerged edits remain. |
| **Strict Format Guardrails for `glm5.3` / `deepseek4.1f`** | Enforces `[OWNERSHIP]`, `[FORBIDDEN]`, and `[DONE_CRITERIA]` brief sections, mandatory `@mentions` on worker reports, bans `@#main` broadcast storms, and returns self-healing JSON templates on any format violation. |

## Verification

```bash
node --check index.js && node --check client.js
npm run test:boot      # Mounts in a real @deepseek-ai/cordis Context + sibling session/event dispatch
npm test               # 30 end-to-end smoke & guardrail scenarios
npm run verify:install # Tarball pack + isolated clean install gate
```

## License

[MIT](LICENSE).
