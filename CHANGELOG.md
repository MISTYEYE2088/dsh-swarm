# Changelog

## 0.1.0 (2026-11-22)

- Initial release of `dsh-swarm` for DeepSeek Harness `0.2.0-rc.2`.
- Added three-file plain-text blackboard (`swarm.json`, `board.jsonl`, `members.json`) plus static `plan.json` (≤ 64 KB) and event-sourced channel replay (`replayChannelsAt`).
- Added polite shared-cluster `ConcurrencyGate` on `llm/stream` (1–6 cap, P0–P3 priority queue, fair worker round-robin, `200ms` pacing, HTTP 429 AIMD backoff) and mandatory Phase-0 `ask_user_question` concurrency confirmation gate.
- Added zero-idle-token `swarm_wait` (`exec.concludeTurn()`) and `agent/turn-stopping` Stop-Hook race lock (`last_park_blocked_seq`).
- Added isolated Git worktree manager (`workspace: "share" | "branch"`) with uncommitted staged/unstaged/untracked dirty overlay sync, pure worker incremental diff, `git apply --check` preflight landing (`swarm_land`), and unmerged `swarm_kill` protection.
- Added anti-deadlock `@monitor` daemon timer with `last_post_seq` silent-member detection, concurrency-queue awareness, 3-strike cap, and 5-tick auto-sleep.
- Added strict argument validators with self-healing JSON templates and detailed SOP prompts for self-hosted `glm5.3` / `deepseek4.1f`.
- Added Classic-Script browser Hive Board UI (`client.js`) with Header status pill, Overview & Roster, Board (`#seq` jump pills & `@mention` pills), and Graph timeline replay.
