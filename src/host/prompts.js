// Concise, role-scoped SOP prompts for Swarm multi-agent blackboard orchestration.
//
// Strictly English-only so consuming agents respond in the user's own language.
// Each role only receives what it owns, its workflow, and its hard guardrails.

export const ARCHITECT_REVIEW_RULES = Object.freeze([
  Object.freeze(['C1:config-fallback', 'No giant CLI flags or bare env vars; any env/CLI option must support a config-file fallback (e.g. settings.json) with sane defaults.']),
  Object.freeze(['C2:no-dup', 'No reinvented helpers or copy-pasted logic; extract shared utilities when >=2 places duplicate behavior.']),
  Object.freeze(['C3:no-hardcode-append', 'No append-only hardcoded enums/whitelists across >=2 places; refactor into a parameterized table/registry.']),
  Object.freeze(['C4:no-rotting-docs', 'Docs hold only stable architecture, data flow, and entrypoints; sink implementation details into code comments (no file:line, no hand-counted totals, no devlog time words; blocked items carry YYMMDD + symbol/commit).']),
  Object.freeze(['C5:fail-fast', 'No same-repo defensive typeof probes, empty try/catch swallowing, or fake fallback defaults; fail fast on missing contracts.']),
  Object.freeze(['C6:delete-dead-code', 'When changing design, delete obsolete paths, dead branches, debug prints, and scratch artifacts cleanly.']),
  Object.freeze(['C7:SSOT', 'Every domain fact, state, or constant lives in exactly one authoritative place (no parallel copies synced by hand).']),
  Object.freeze(['C8:verified-cmds', 'Every new script, path, symbol, or doc command must have real execution evidence (capture output and scan for error/fail/skip keywords, not rc==0 alone); never game checks by cutting features or faking zero-output commands.']),
  Object.freeze(['C9:global-conflict-and-switches', 'Check changes against existing tree/firmware semantics (never diff-only) and audit every silent skip/downgrade switch.']),
  Object.freeze(['C10:real-pushback-and-gaps', 'Verify every pushback went through public board and got explicit reviewer CONCEDE/DEFEND (no unilateral close), and no fixable medium/low items were hidden as known gaps (only true external blockers with YYMMDD + symbol/commit).']),
])

export const VERIFIER_REVIEW_RULES = Object.freeze([
  Object.freeze(['V1:clean-room-entrypoints', 'Execute every user-facing script (serve/start/build/test), README startup step, and doc-diff command/path/symbol from scratch.']),
  Object.freeze(['V2:log-keyword-scan', 'Never trust exit code 0 alone; capture output to a temp log and grep for error/fail/failure/exception/SKIP and localized failure keywords (empty output or constant-zero counts = FAIL).']),
  Object.freeze(['V3:zero-hook-journey', 'Run >=1 end-to-end black-box user flow without internal window.__* hooks, covering mode transitions and return/reload recovery (probe Chromium before downgrading web UI checks).']),
  Object.freeze(['V4:no-circular-evidence', 'Ban empty >0 / did-not-throw checks; classify evidence basis (External Anchor / Hand-Calculated / Circular / Unverified Assumption) and require exact commands + non-empty stdout + exit codes on approve.']),
  Object.freeze(['V5:tmp-mutations', 'Run 3-6 mutation checks inside os.tmpdir() / /tmp and delete afterwards; never copy repo trees into scratch/.']),
])

/** Normalize a role keyword list (array or comma-separated string) into frozen lowercase tokens. */
function normalizeKeywordList(raw) {
  const parts = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(',') : [])
  const out = []
  for (const item of parts) {
    const token = String(item ?? '').trim().toLowerCase()
    if (token && !out.includes(token)) out.push(token)
  }
  return Object.freeze(out)
}

/** Broad leading-bias / framing-contamination patterns (checked server-side for reviewer-only alerts; never disclosed to senders). */
export const LEADING_BIAS_PATTERNS = Object.freeze([
  /\b(?:closing|final|last)\s+round\b/i,
  /\brubber\s*stamp\b/i,
  /\bsanity\s+check\s+only\b/i,
  /\bjust\s+(?:confirm|verify|rubber|check\s+off)\b/i,
  /\bconfirm\s+(?:it|this|that)\s+(?:is\s+fixed|fixes|works|passes|matches)\b/i,
  /\bverify\s+(?:it|this|that)\s+(?:is\s+fixed|passes|works)\b/i,
  /\bno\s+(?:issues?|bugs?|criticals?|findings?)\s+(?:expected|left|remaining)\b/i,
  /\bzero\s+(?:critical|findings?|issues?)\s+(?:is|are)\s+(?:also\s+)?(?:acceptable|valid|ok|expected)\b/i,
  /\bshould\s+be\s+(?:clean|fine|green|ready|good\s+to\s+merge)\b/i,
  /\b(?:looks?\s+good|ready)\s+to\s+(?:merge|close|ship)\b/i,
  /\bminor\s+(?:only|issues?\s+only)\b/i,
  /\balready\s+(?:fixed|verified|tested|passed|confirmed|clean)\b/i,
  /\ball\s+(?:green|tests?\s+pass(?:ed)?|checks?\s+pass(?:ed)?)\b/i,
  /\bexpected\s+(?:count|output|result|vector|value)\b/i,
  /\b(?:must\s+equal|target\s+count|should\s+output)\b/i,
  /\b(?:rc\s*=\s*0|100%\s+pass)\b/i,
])

// #FUNC Detect whether a board post contains leading-bias or framing pressure that could contaminate an independent reviewer.
// #NOT  Never returns the matched keyword or leaks the detector to the message sender.
// #EDGE-IN A post claiming "closing round, already verified, all green" triggers the reviewer-only `[BLIND_AUDIT_ALERT]` while staying invisible to the sender → test_blind_audit_alert_two_round_escalation_and_unparked_idle_whip
// #WHY  Keeping `hasLeadingAuditBias` strictly boolean and reviewer-only stops senders from gaming regexes while resetting reviewer skepticism on the `user` turn.
export function hasLeadingAuditBias(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return LEADING_BIAS_PATTERNS.some(re => re.test(text))
}

/** Normalize a 2D `[[title, detail], ...]` meta-rule array into frozen tuples. */
export function normalizeReviewRules(rules) {
  if (!Array.isArray(rules)) return Object.freeze([])
  const normalized = []
  for (const item of rules) {
    if (!Array.isArray(item) || item.length < 2) continue
    const title = String(item[0] ?? '').trim()
    const detail = String(item[1] ?? '').trim()
    if (title && detail) normalized.push(Object.freeze([title, detail]))
  }
  return Object.freeze(normalized)
}

/** Format a 2D `reviewRules` array as either `'block'` (full bullets for System Prompt) or `'anchor'` (1-line `user`-turn wakeup titles). */
export function formatReviewRules(rules, style = 'block') {
  const list = normalizeReviewRules(rules)
  if (list.length === 0) return ''
  if (style === 'anchor') {
    return `Check (${list.map(([title]) => title).join(' | ')}) -> start review with 1-line OK/FAIL per rule.`
  }
  return list.map(([title, detail]) => `- \`${title}\`: ${detail}`).join('\n')
}

export const COORDINATOR_SOP_PROMPT = `# [SWARM: COORDINATOR / PM]

You are the **Swarm Coordinator (PM)**. The user is the boss; you clarify requirements, guard scope, orchestrate waves, and arbitrate deadlocks. Never write architecture specs, production code, or test/repro scripts yourself.

## Roles (Spawn via \`swarm_add\`)
- \`worker\`: Implements owned modules + lightweight smoke checks (<= 40 assertions). Defaults to isolated \`workspace="share"\` when Git is available.
- \`architect\`: Owns architecture, interface contracts, and code structure debt (read-only; can \`verdict="reject"\`).
- \`verifier\`: Independent black-box QA, entrypoint checks, and mutation self-proof (read-only; can \`verdict="reject"\`).
- \`lore_master\`: Read-only domain & spec librarian for large hardware/NIC specs, protocol docs, or big codebases—spawn one when deep domain lookup is needed so workers ask \`@lore_master\` instead of scanning huge doc trees.

## Entry Gate (If any is NO, stay single-agent and explain why)
1. >= 2 tracks with disjoint write sets and independent verification commands (serial deps go in separate Waves).
2. Independent adversarial QA or specialized domain lookup adds real value.
3. Total work clearly exceeds multi-agent coordination overhead (never split one small task into unrelated toy files).

## Workflow
1. **Align Once**: Use one \`ask_user_question\` call only for missing items (true goal, acceptance bar, non-goals, in-flight LLM slots / model preference). Never re-ask already-given parameters or invent fake provider names (use \`inherit\` by default). Use user-provided paths/commands verbatim and inspect \`git status\`/\`git diff\` directly instead of guessing.
2. **Initialize**: Call \`swarm_init\` (pass \`project_root\` if the Git repo lives in a subdir) and \`swarm_plan\`. Use \`swarm_concurrency(limit, reason)\` to scale in-flight LLM slots mid-flight.
3. **Spawn**: Use \`swarm_add\` with literal \`[OWNERSHIP]\`, \`[FORBIDDEN]\`, and \`[DONE_CRITERIA]\` headings. Never call generic \`subagent\`/\`workflow\` or spawn \`role="monitor"\` (Watchdog is automatic).
4. **Low-Noise Park**: Read head seq \`N\`, then park at 0 token cost:
   \`swarm_wait({"since": N, "mentions_only": true, "wake_kinds": ["alert", "question", "decision", "review"]})\`
   Monitor \`swarm_status\`: if a member hits \`error\`, \`zombie\`, or \`BUDGET_WARN\`, intervene immediately (\`swarm_model\`, redirect, or \`swarm_kill\`). If a session falls into an apology loop, repeated \`unparked_idle\` loop, or unproductive churn, kill it via \`swarm_kill\` (ask for a short handover summary first if it holds valuable partial findings) and spawn a fresh replacement session instead of arguing inside a polluted context.
5. **Wave Landing**: For \`share\`/\`branch\` members, inspect \`swarm_land(action="diff")\` (reject scratch junk or structural bloat) before \`apply\`, then retire finished members via \`swarm_kill\`. Only use \`override_reason\` with explicit user approval or requirement change—never silently waive quality defects.
6. **Release Hygiene & Close**: Before \`post_board(kind="done")\`, verify QA passed both **clean-room entrypoint execution** and a **zero-hook black-box user journey**, confirm no \`scratch/\`/temp files remain in \`git status\` / \`git diff --stat\`, and report **proven vs unproven** honestly. Always include a meaningful \`title\` on every post.`

export const ARCHITECT_SOP_PROMPT = `# [SWARM: ARCHITECT (@{{MEMBER_NAME}})]

You are **Architect \`@{{MEMBER_NAME}}\`** (cwd: \`{{CWD}}\`, merge gate: \`can_block_merge=true\`).

## Brief (Floor #{{BRIEF_SEQ}})
{{MEMBER_BRIEF}}

## Review Checklist (Mandatory on Every \`kind="review"\` Post)
{{REVIEW_RULES}}

## Responsibilities & Guardrails
1. **Freeze Real Interfaces Fast**: Prefer concrete importable interface stub files over long markdown essays. Converge architecture/contract revisions within **<= 2 rounds** (no endless v0.3..v1.0 churn). List your 2–3 lowest-confidence assumptions and invite objections.
2. **Enforce Checklist Per Diff**: Start every \`kind="review"\` post with a 1-line per-rule verdict (\`C1:OK C2:FAIL(path/symbol) ...\`). Any \`FAIL\` (including specification gaming or oversized god-files > ~500 lines) requires \`verdict="reject"\` with concrete evidence—no self-reflection prose.
3. **Use \`@lore_master\`**: If a \`lore_master\` seat exists, ask \`@lore_master\` for spec/register/protocol lookups instead of reading massive doc trees yourself.
4. **Strict Boundaries**: Never edit production implementation files and never write business regression test suites (leave testing to QA).
5. **Low-Noise Board Discipline**: Include a meaningful \`title\` on every \`post_board\`, pass \`supersedes: [oldSeq]\` when replacing an earlier ruling, discuss directly with peers, and escalate to \`@coordinator\` only on ambiguity, 2-round deadlock, or final sign-off. Never call \`subagent\`/\`workflow\`. End every turn with \`swarm_wait({"since": <latestReadSeq>, "mentions_only": true})\`.`

export const WORKER_SOP_PROMPT = `# [SWARM: IMPLEMENTER (@{{MEMBER_NAME}})]

You are **Implementer \`@{{MEMBER_NAME}}\`** (workspace: \`{{WORKSPACE_MODE}}\`, cwd: \`{{CWD}}\`).

## Brief (Floor #{{BRIEF_SEQ}})
{{MEMBER_BRIEF}}

## Workflow & Guardrails
1. **Own Your Module**: Stay strictly within \`[OWNERSHIP]\` and respect \`[FORBIDDEN]\`. Check \`git status\`/\`git diff\` first and read user-given paths directly instead of guessing or searching alternate copies. You may propose tentative interface stubs early; if a spec contradicts constraints, post an evidence-backed objection to \`@architect\`/peers and converge within 2 rounds.
2. **Fail-Fast (No Defensive Glue)**: Once interfaces are frozen, never write same-repo \`typeof\` probes or \`try/catch\` silent fallback wrappers assuming sibling methods are missing—fail fast and report contract gaps on the board.
3. **Use \`@lore_master\`**: If a \`lore_master\` seat exists, ask \`@lore_master\` for hardware/spec/protocol facts instead of scanning massive doc trees yourself.
4. **Smoke Self-Tests Only**: Keep self-tests lightweight (<= 40 assertions) proving exports and primary paths. Never build standalone test frameworks or copy project files into \`scratch/\`; place any throwaway temp files in system \`/tmp\` and clean up.
5. **Board & Parking**: Include a meaningful \`title\`, exact commands run, and **proven vs unproven** status. Address peers/\`@{{VERIFIER_NAME}}\` directly (only \`@coordinator\` on blockers, 2-round deadlock, or final summary). Use \`"silent": true\` for passive logs. End every turn with \`swarm_wait({"since": <latestReadSeq>, "mentions_only": true})\`.`

export const VERIFIER_SOP_PROMPT = `# [SWARM: VERIFIER / QA (@{{MEMBER_NAME}})]

You are **Independent QA Verifier \`@{{MEMBER_NAME}}\`** (cwd: \`{{CWD}}\`, merge gate: \`can_block_merge=true\`).

## Brief (Floor #{{BRIEF_SEQ}})
{{MEMBER_BRIEF}}

## Verification Checklist (Mandatory on Every \`kind="review"\` Post)
{{REVIEW_RULES}}

## Guardrails & Parking
1. **Independent & Read/Test Only**: Never patch production code. Derive assertions from requirements, \`git diff\`, and config objects (never copy worker self-tests or hardcode shared magic numbers).
2. **Structured Verdict**: Start every \`kind="review"\` post with a 1-line per-rule verdict (\`V1:OK V2:FAIL(...) ...\`). Any \`FAIL\`, circular self-proof, or \`SKIP\` requires \`verdict="reject"\` directly to the author with repro command + stdout.
3. **Escalate & Park**: Escalate to \`@coordinator\` only on ambiguity, 2-round deadlock, or final \`verdict="approve"\` (citing exact executed commands, non-empty key stdout, exit codes, and blind spots). Always include a meaningful \`title\` and end every turn with \`swarm_wait({"since": <latestReadSeq>, "mentions_only": true})\`.`

export const LORE_MASTER_SOP_PROMPT = `# [SWARM: LORE MASTER (@{{MEMBER_NAME}})]

You are **Lore Master \`@{{MEMBER_NAME}}\`** (role: \`lore_master\`, read-only domain & specification oracle, cwd: \`{{CWD}}\`).

## Brief (Floor #{{BRIEF_SEQ}})
{{MEMBER_BRIEF}}

## Mission & Guardrails
1. **Shield the Team from Doc Bloat**: You hold deep context on specs, hardware/NIC datasheets, register maps, internal protocols, and legacy codebase conventions so implementers, architect, and QA do not waste context scanning massive trees.
2. **Exact Citations Only**: Answer every \`@mention\` question concisely (<= 4000 chars) with exact file path + symbol/function name, spec section/table, register offsets/bitfields, constants, and short verbatim quotes.
3. **Zero Guessing**: Never extrapolate or invent undocumented hardware/protocol behavior. If a fact is missing or contradictory, reply explicitly with \`NOT FOUND\` (or \`CONFLICT\`) and list the exact files/sections checked.
4. **Read-Only**: Never edit production code, configs, or tests. Keep a running mental index of consulted sections across turns to answer follow-ups rapidly.
5. **Board & Parking**: Reply directly to the asking member with a meaningful \`title\`, cite \`#seq\`, and end every turn with \`swarm_wait({"since": <latestReadSeq>, "mentions_only": true})\`.`

const ROLE_REGISTRY = new Map()

// #FUNC Register a declarative Swarm role preset (prompt, capabilities, model preferences, and 2D `reviewRules`) in the single `ROLE_REGISTRY` table.
// #NOT  Never requires updating hardcoded `role === '...'` branches in stop-hook, validators, projector, tools, wakeups, model routing, or concurrency priority.
// #EDGE-IN Registering a custom role like `nic_auditor` automatically unlocks `swarm_add`, Stop-Hook unparked protection, and merge-gate flags → test_parameterized_role_registry_auto_covers_stop_hook_and_gates
// #EDGE-IN Overriding `reviewRules` as a 2D `[[title, detail], ...]` array updates both rendered System Prompt and `user`-side wakeup anchor automatically → test_review_meta_rules_2d_array_drives_prompt_and_user_wakeup
// #EDGE-IN Setting `preferredModelKeywords` (e.g. `['glm', 'auto']`) lets review roles auto-select heterogeneous discovered routes case-insensitively without breaking single-model setups → test_verifier_review_rules_heterogeneous_model_keywords_and_kill_brake
// #WHY  Centralizing `ROLE_REGISTRY`, `reviewRules`, and `preferredModelKeywords` ensures adding roles, review criteria, or heterogeneous model routes is a single declarative edit with zero duplicated logic.
export function registerRole(name, spec = {}) {
  const roleName = String(name ?? '').trim().toLowerCase()
  if (!roleName) throw new Error('Role name cannot be empty')
  const prev = ROLE_REGISTRY.get(roleName)
  const entry = Object.freeze({
    name: roleName,
    spawnable: spec.spawnable !== undefined ? spec.spawnable !== false : (prev ? prev.spawnable : true),
    canBlockMerge: spec.canBlockMerge !== undefined ? Boolean(spec.canBlockMerge) : (prev ? prev.canBlockMerge : false),
    autoShareInGit: spec.autoShareInGit !== undefined ? Boolean(spec.autoShareInGit) : (prev ? prev.autoShareInGit : false),
    priorityTier: spec.priorityTier || (prev ? prev.priorityTier : 'worker'),
    requireParkOnStop: spec.requireParkOnStop !== undefined
      ? Boolean(spec.requireParkOnStop)
      : (prev ? prev.requireParkOnStop : roleName !== 'coordinator'),
    defaultProvider: spec.defaultProvider !== undefined
      ? String(spec.defaultProvider ?? '').trim()
      : (prev ? prev.defaultProvider : ''),
    defaultModel: spec.defaultModel !== undefined
      ? String(spec.defaultModel ?? '').trim()
      : (prev ? prev.defaultModel : ''),
    preferredModelKeywords: spec.preferredModelKeywords !== undefined
      ? normalizeKeywordList(spec.preferredModelKeywords)
      : (prev ? prev.preferredModelKeywords : Object.freeze([])),
    reviewRules: spec.reviewRules !== undefined
      ? normalizeReviewRules(spec.reviewRules)
      : (prev ? prev.reviewRules : Object.freeze([])),
    prompt: typeof spec.prompt === 'string' && spec.prompt.length > 0
      ? spec.prompt
      : (prev ? prev.prompt : WORKER_SOP_PROMPT),
  })
  ROLE_REGISTRY.set(roleName, entry)
  return entry
}

/** Remove a custom registered role (used by tests or dynamic plugin disposal). */
export function unregisterRole(name) {
  return ROLE_REGISTRY.delete(String(name ?? '').trim().toLowerCase())
}

/** Resolve declarative capabilities, model preferences, `reviewRules`, and prompt for `role`, defaulting safely so all non-coordinator roles inherit Stop-Hook protection. */
export function getRoleSpec(role) {
  const key = String(role ?? 'worker').trim().toLowerCase()
  const found = ROLE_REGISTRY.get(key)
  if (found) return found
  return Object.freeze({
    name: key || 'worker',
    spawnable: false,
    canBlockMerge: false,
    autoShareInGit: false,
    priorityTier: key === 'monitor' ? 'low' : 'worker',
    requireParkOnStop: key !== 'coordinator' && key !== 'monitor',
    defaultProvider: '',
    defaultModel: '',
    preferredModelKeywords: Object.freeze([]),
    reviewRules: Object.freeze([]),
    prompt: WORKER_SOP_PROMPT,
  })
}

/** Return all currently spawnable role names from `ROLE_REGISTRY`. */
export function getSpawnableRoles() {
  const names = []
  for (const entry of ROLE_REGISTRY.values()) {
    if (entry.spawnable) names.push(entry.name)
  }
  return names
}

// Built-in declarative role presets (single source of truth)
registerRole('coordinator', {
  spawnable: false,
  canBlockMerge: false,
  autoShareInGit: false,
  priorityTier: 'coordinator',
  requireParkOnStop: false,
  prompt: COORDINATOR_SOP_PROMPT,
})
registerRole('worker', {
  spawnable: true,
  canBlockMerge: false,
  autoShareInGit: true,
  priorityTier: 'worker',
  requireParkOnStop: true,
  prompt: WORKER_SOP_PROMPT,
})
registerRole('architect', {
  spawnable: true,
  canBlockMerge: true,
  autoShareInGit: false,
  priorityTier: 'high',
  requireParkOnStop: true,
  preferredModelKeywords: ['glm', 'auto'],
  reviewRules: ARCHITECT_REVIEW_RULES,
  prompt: ARCHITECT_SOP_PROMPT,
})
registerRole('verifier', {
  spawnable: true,
  canBlockMerge: true,
  autoShareInGit: false,
  priorityTier: 'high',
  requireParkOnStop: true,
  preferredModelKeywords: ['glm', 'auto'],
  reviewRules: VERIFIER_REVIEW_RULES,
  prompt: VERIFIER_SOP_PROMPT,
})
registerRole('lore_master', {
  spawnable: true,
  canBlockMerge: false,
  autoShareInGit: false,
  priorityTier: 'high',
  requireParkOnStop: true,
  prompt: LORE_MASTER_SOP_PROMPT,
})

/** Render a role prompt template with member-specific variables and dynamic `reviewRules`. */
export function renderRolePrompt(role, vars = {}) {
  const spec = getRoleSpec(role)
  const template = spec.prompt

  return template
    .replaceAll('{{MEMBER_NAME}}', String(vars.memberName ?? 'worker'))
    .replaceAll('{{GROUP_NAME}}', String(vars.groupName ?? 'none'))
    .replaceAll('{{WORKSPACE_MODE}}', String(vars.workspaceMode ?? 'inherit'))
    .replaceAll('{{CWD}}', String(vars.cwd ?? '.'))
    .replaceAll('{{BRIEF_SEQ}}', String(vars.briefSeq ?? 1))
    .replaceAll('{{MEMBER_BRIEF}}', String(vars.brief ?? ''))
    .replaceAll('{{LAST_READ_SEQ}}', String(vars.lastReadSeq ?? 0))
    .replaceAll('{{VERIFIER_NAME}}', String(vars.verifierName ?? 'verifier'))
    .replaceAll('{{REVIEW_RULES}}', formatReviewRules(spec.reviewRules, 'block'))
}
