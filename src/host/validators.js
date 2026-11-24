// Strict tool-argument format & semantic validators (English-only so consuming
// agents never get nudged into switching response languages).
//
// Returns self-healing error messages with copy-pasteable JSON examples whenever
// validation fails, enforcing meaningful post titles, role presets, 3-part briefs,
// explicit mention integrity, silent logging, `wake_kinds`, `verdict`, and `supersedes`.

import {
  PLAN_MAX_BYTES,
  VALID_POST_KINDS,
  VALID_VERDICTS,
  extractMentionsFromText,
} from './store.js'
import { getRoleSpec, getSpawnableRoles } from './prompts.js'

export const MEMBER_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const RESERVED_NAMES = new Set(['all', 'main', 'coordinator', 'system', 'user', 'monitor'])
export const VALID_ROLES = Object.freeze(getSpawnableRoles())
export const REQUIRED_BRIEF_TAGS = ['[OWNERSHIP]', '[FORBIDDEN]', '[DONE_CRITERIA]']
export const MAX_POST_CHARS = 4_000
export const MIN_POST_CHARS = 6
export const MIN_TITLE_CHARS = 4
export const MAX_TITLE_CHARS = 100
export const GENERIC_POST_TITLES = new Set([
  'update',
  'report',
  'post',
  'done',
  'status',
  'message',
  'brief',
  'reply',
  'ok',
  'hi',
  'hello',
  'test',
  'info',
  'note',
  'review',
  'decision',
  'alert',
  'question',
  'summary',
  'untitled',
])

/** Build a structured self-healing validation failure. */
function formatError(toolName, reason, exampleObj, extraNote = '') {
  const lines = [
    `[FORMAT_ERROR: ${toolName}] ${reason}`,
  ]
  if (extraNote) lines.push(extraNote)
  if (exampleObj !== undefined) {
    lines.push('Retry this tool call with valid JSON following this exact schema:')
    lines.push(JSON.stringify(exampleObj, null, 2))
  }
  return { ok: false, error: lines.join('\n') }
}

/** Suggest the next available numbered member name when a killed/taken name is requested. */
export function suggestNextMemberName(requestedName, existingMembers = {}) {
  const cleaned = String(requestedName || 'worker')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'worker'
  const numMatch = /^(.*)-(\d+)$/.exec(cleaned)
  const base = (numMatch ? numMatch[1] : cleaned) || 'worker'
  if (!numMatch && !existingMembers[base] && !RESERVED_NAMES.has(base)) return base
  let index = numMatch ? Number(numMatch[2]) + 1 : 2
  while (existingMembers[`${base}-${index}`] || RESERVED_NAMES.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

// dup-ok: dedicated per-tool validator for swarm_init
// #FUNC Validate `swarm_init` parameters without imposing an artificial upper ceiling on concurrency.
// #NOT  Does not permit non-positive or non-integer concurrency limits (`limit < 1`).
// #EDGE-IN Non-positive concurrency limit 0 is rejected while high parallelism (e.g. 16) is allowed → test_validator_rejects_excessive_concurrency
// #WHY  `concurrency_limit` is validated as a positive integer (`limit < 1`) without an arbitrary upper cap so the user can choose any parallelism level.
export function validateSwarmInit(args) {
  if (!args || typeof args !== 'object') {
    return formatError('swarm_init', 'Arguments must be a JSON object.', {
      title: 'Module investigation and fix',
      concurrency_limit: 4,
      default_model: 'inherit',
    })
  }
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (title.length < 2 || title.length > 120) {
    return formatError('swarm_init', 'title must be a non-empty string (2..120 chars).', {
      title: 'Fix PDF font export regression',
      concurrency_limit: 4,
      default_model: 'inherit',
    })
  }
  const limit = Number(args.concurrency_limit)
  if (!Number.isInteger(limit) || limit < 1) {
    return formatError(
      'swarm_init',
      `Invalid concurrency_limit (${args.concurrency_limit}). It must be a positive integer >= 1 (limits in-flight LLM requests, NOT max member count; e.g. 2, 4, 6, 8).`,
      {
        title,
        concurrency_limit: 4,
        default_model: args.default_model || 'inherit',
      },
    )
  }
  const projectRoot = typeof args.project_root === 'string' && args.project_root.trim()
    ? args.project_root.trim()
    : null
  return {
    ok: true,
    value: {
      title,
      concurrency_limit: limit,
      project_root: projectRoot,
      default_provider: typeof args.default_provider === 'string' && args.default_provider.trim()
        ? args.default_provider.trim()
        : 'inherit',
      default_model: typeof args.default_model === 'string' && args.default_model.trim()
        ? args.default_model.trim()
        : 'inherit',
      coordinator_model: typeof args.coordinator_model === 'string' && args.coordinator_model.trim()
        ? args.coordinator_model.trim()
        : 'inherit',
    },
  }
}

// dup-ok: dedicated per-tool validator for swarm_add
// #FUNC Validate `swarm_add` parameters, enforcing Phase-0 concurrency confirmation, tombstone name lock, role presets (`worker`/`architect`/`verifier`), and 3-part brief tags.
// #NOT  Does not allow adding workers before `concurrency_confirmed` is true, nor spawning an LLM `monitor` member (Watchdog is deterministic and built-in), nor reusing a `killed` member's name.
// #EDGE-IN Calling `swarm_add` before `concurrency_confirmed` returns a gate error telling Coordinator to confirm parameters first → test_validator_blocks_add_before_concurrency_confirmed
// #EDGE-IN Reusing a killed member name `arch-1` suggests `arch-2` → test_validator_rejects_killed_name_reuse
// #EDGE-IN A brief missing `[OWNERSHIP]` or `[FORBIDDEN]` or `[DONE_CRITERIA]` echoes recognized vs missing tags → test_validator_enforces_three_part_brief
// #WHY  `REQUIRED_BRIEF_TAGS` forces explicit ownership boundaries while echoing recognized tags eliminates blind trial-and-error.
export function validateSwarmAdd(args, swarmMeta, existingMembers = {}, callerName = 'coordinator') {
  if (!swarmMeta) {
    return formatError(
      'swarm_add',
      'Swarm state does not exist (swarm.json missing). Confirm goals and concurrency slots first, then call swarm_init.',
      {
        title: 'Task title',
        concurrency_limit: 4,
        default_model: 'inherit',
      },
      'Call swarm_init before swarm_add.',
    )
  }
  if (swarmMeta.status === 'DONE') {
    return formatError(
      'swarm_add',
      `Current Swarm (${swarmMeta.swarm_id}, gen=${swarmMeta.generation ?? 1}) is already closed (status=DONE). Call swarm_init to start a new generation.`,
      {
        title: swarmMeta.title || 'New Swarm Task',
        concurrency_limit: swarmMeta.concurrency_limit || 4,
        default_model: swarmMeta.default_model || 'inherit',
      },
    )
  }
  if (swarmMeta.concurrency_confirmed !== true) {
    return formatError(
      'swarm_add',
      'LLM concurrency slots are not confirmed yet. If the user did not specify concurrency, call ask_user_question first, then call swarm_init with concurrency_limit.',
      {
        title: 'Task title',
        concurrency_limit: 4,
        default_model: 'inherit',
      },
      'Call ask_user_question (if needed) and swarm_init before swarm_add.',
    )
  }

  if (!args || typeof args !== 'object') {
    return formatError('swarm_add', 'Arguments must be a JSON object.', {
      name: 'impl-core',
      role: 'worker',
      workspace: 'inherit',
      brief: '[OWNERSHIP]\nsrc/core/\n[FORBIDDEN]\nsrc/ui/\n[DONE_CRITERIA]\nSmoke tests pass and report to @qa-gate',
    })
  }

  const role = args.role ?? 'worker'
  const allowedRoles = getSpawnableRoles()
  if (role === 'monitor') {
    return formatError(
      'swarm_add',
      `Do not spawn role="monitor". The built-in Watchdog runs automatically (0-token). Allowed roles: ${allowedRoles.map(r => `"${r}"`).join(' | ')}.`,
      {
        name: args.name && args.name !== 'monitor' ? args.name : 'qa-gate',
        role: 'verifier',
        workspace: 'inherit',
        brief: '[OWNERSHIP]\ntests/\n[FORBIDDEN]\nsrc/\n[DONE_CRITERIA]\nDerive independent assertions and post verification verdict',
      },
    )
  }
  if (!allowedRoles.includes(role)) {
    return formatError('swarm_add', `Invalid role "${role}". Allowed roles: ${allowedRoles.map(r => `"${r}"`).join(' | ')}.`, {
      name: args.name || 'impl-core',
      role: 'worker',
      workspace: 'inherit',
      brief: '[OWNERSHIP]\n...\n[FORBIDDEN]\n...\n[DONE_CRITERIA]\n...',
    })
  }

  const rawName = typeof args.name === 'string' ? args.name.trim() : ''
  const suggested = suggestNextMemberName(rawName, existingMembers)
  if (!rawName || rawName.length > 24 || !MEMBER_NAME_REGEX.test(rawName) || RESERVED_NAMES.has(rawName)) {
    return formatError(
      'swarm_add',
      `Invalid member name "${rawName}". Name must be 1..24 lowercase letters, digits, and hyphens (^[a-z0-9]+(?:-[a-z0-9]+)*$) and cannot be a reserved name (${[...RESERVED_NAMES].join(', ')}).`,
      {
        name: suggested,
        role,
        workspace: args.workspace || 'inherit',
        brief: '[OWNERSHIP]\nOwned files/modules\n[FORBIDDEN]\nOut-of-bounds files/actions\n[DONE_CRITERIA]\nVerification commands and handoff target',
      },
    )
  }

  const count = args.n !== undefined ? Number(args.n) : (Array.isArray(args.tasks) && args.tasks.length > 0 ? args.tasks.length : 1)
  if (!Number.isInteger(count) || count < 1) {
    return formatError('swarm_add', `Batch count n (${args.n}) must be a positive integer >= 1.`, {
      name: rawName,
      n: 2,
      role,
      workspace: 'inherit',
      brief: '[OWNERSHIP]\n...\n[FORBIDDEN]\n...\n[DONE_CRITERIA]\n...',
    })
  }

  const targetNames = count === 1
    ? [rawName]
    : Array.from({ length: count }, (_, idx) => `${rawName}-${idx + 1}`)

  for (const candidate of targetNames) {
    if (existingMembers[candidate]) {
      const wasKilled = existingMembers[candidate].killed === true
      const nextSuggestion = suggestNextMemberName(candidate, existingMembers)
      return formatError(
        'swarm_add',
        wasKilled
          ? `Member name "${candidate}" is retired (killed) and permanently tombstoned to preserve board history. Use "${nextSuggestion}" instead.`
          : `Member name "${candidate}" already exists. Use "${nextSuggestion}" instead.`,
        {
          name: nextSuggestion,
          role,
          workspace: args.workspace || 'inherit',
          brief: args.brief || '[OWNERSHIP]\n...\n[FORBIDDEN]\n...\n[DONE_CRITERIA]\n...',
        },
      )
    }
  }

  const workspaceExplicit = args.workspace !== undefined && args.workspace !== null && args.workspace !== ''
  const workspace = workspaceExplicit ? args.workspace : 'inherit'
  if (!['inherit', 'share', 'branch'].includes(workspace)) {
    return formatError('swarm_add', `Invalid workspace "${workspace}". Allowed: "inherit" | "share" | "branch".`, {
      name: rawName,
      role,
      workspace: 'inherit',
      brief: '[OWNERSHIP]\n...\n[FORBIDDEN]\n...\n[DONE_CRITERIA]\n...',
    })
  }

  const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
  const foundTags = REQUIRED_BRIEF_TAGS.filter(tag => brief.includes(tag))
  const missingTags = REQUIRED_BRIEF_TAGS.filter(tag => !brief.includes(tag))
  if (missingTags.length > 0) {
    const proseHints = []
    if (missingTags.includes('[FORBIDDEN]') && /(?:forbidden|do not touch|off-limits)/i.test(brief)) {
      proseHints.push('Found prose about forbidden scope, but missing the literal tag `[FORBIDDEN]`')
    }
    if (missingTags.includes('[OWNERSHIP]') && /(?:ownership|responsible for|owns)/i.test(brief)) {
      proseHints.push('Found prose about ownership, but missing the literal tag `[OWNERSHIP]`')
    }
    if (missingTags.includes('[DONE_CRITERIA]') && /(?:done criteria|acceptance|verify)/i.test(brief)) {
      proseHints.push('Found prose about completion criteria, but missing the literal tag `[DONE_CRITERIA]`')
    }
    const foundSummary = foundTags.length > 0 ? `Recognized tags: ${foundTags.join(', ')}` : 'Recognized tags: none'
    const hintLine = proseHints.length > 0 ? `Diagnostic hint: ${proseHints.join('; ')}. Place each missing literal tag on its own heading line.` : ''
    return formatError(
      'swarm_add',
      `Brief is missing required literal section tag(s): ${missingTags.join(', ')} (${foundSummary}). Brief must include [OWNERSHIP], [FORBIDDEN], and [DONE_CRITERIA].`,
      {
        name: rawName,
        role,
        workspace,
        brief: '[OWNERSHIP]\nFiles and module boundaries owned by this member\n[FORBIDDEN]\nFiles or actions strictly out of scope\n[DONE_CRITERIA]\nVerification commands, assertions, and handoff recipient',
      },
      hintLine,
    )
  }

  if (args.fork !== undefined && args.fork !== null && args.fork !== '') {
    const forkSource = String(args.fork).trim()
    if (forkSource !== 'coordinator' && !existingMembers[forkSource]) {
      return formatError(
        'swarm_add',
        `Fork source "${forkSource}" does not exist. Available sources: coordinator, ${Object.keys(existingMembers).join(', ')}`,
        {
          name: rawName,
          role,
          workspace,
          fork: 'coordinator',
          brief,
        },
      )
    }
  }

  const canBlockMerge = args.can_block_merge !== undefined
    ? Boolean(args.can_block_merge)
    : getRoleSpec(role).canBlockMerge

  return {
    ok: true,
    value: {
      baseName: rawName,
      targetNames,
      group: count > 1 ? rawName : (args.group ?? null),
      role,
      can_block_merge: canBlockMerge,
      workspace,
      workspaceExplicit,
      brief,
      provider: args.provider ?? swarmMeta.default_provider ?? 'inherit',
      model: args.model ?? swarmMeta.default_model ?? 'inherit',
      fork: args.fork ? String(args.fork).trim() : null,
      tasks: Array.isArray(args.tasks) ? args.tasks.map(String) : null,
      parent: callerName,
    },
  }
}

// #FUNC Validate `post_board` calls, requiring a meaningful `title`, supporting silent logging, strict explicit `mentions` checks, prose `@future` tolerance, `verdict`, and `supersedes`.
// #NOT  Does not accept missing or generic placeholder titles (`"update"`, `"report"`, etc.), unaddressed worker posts without `silent: true`, `@#main` broadcasts, or killed targets.
// #EDGE-IN Missing or generic `title` on `post_board` is rejected with a concrete title example → test_validator_enforces_meaningful_post_title
// #EDGE-IN Worker posting without any `@mention` and without `silent: true` is rejected with the active roster list → test_validator_rejects_unaddressed_worker_post
// #EDGE-IN Posting `@#main` is rejected to prevent disguised `@all` storms → test_validator_rejects_channel_main_broadcast
// #EDGE-IN Mentioning a `killed` member is rejected with active alternatives → test_validator_rejects_mentioning_killed_member
// #WHY  Requiring a meaningful `title` enables collapsed title-only board browsing in the sidebar UI so humans and agents can scan dozens of floors without opening every body.
export function validatePostBoard(args, existingMembers = {}, callerName = 'coordinator', activeChannels = ['main']) {
  if (!args || typeof args !== 'object') {
    return formatError('post_board', 'Arguments must be a JSON object.', {
      title: 'Engine core tick loop implemented and smoke tests green',
      mentions: ['qa-gate'],
      refs: [1],
      kind: 'report',
      text: '@qa-gate Completed #1 implementation. Smoke tests (24/24) pass. Ready for review.',
    })
  }

  const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim() : ''
  const normalizedTitleKey = title.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (title.length < MIN_TITLE_CHARS || title.length > MAX_TITLE_CHARS || GENERIC_POST_TITLES.has(normalizedTitleKey)) {
    return formatError(
      'post_board',
      `title ("${title}") is missing, out of length (${MIN_TITLE_CHARS}..${MAX_TITLE_CHARS} chars), or too generic. Every board post MUST provide a concise, meaningful summary title so collapsed board cards are scannable.`,
      {
        title: 'API schema frozen with 5 architecture overrides (ADR-002)',
        mentions: args.mentions || ['coordinator'],
        refs: args.refs || [1],
        kind: args.kind || 'report',
        text: typeof args.text === 'string' && args.text.trim().length >= MIN_POST_CHARS
          ? args.text.trim()
          : '@coordinator Summary of findings and verification commands.',
      },
    )
  }

  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (text.length < MIN_POST_CHARS) {
    return formatError('post_board', `text is too short (minimum ${MIN_POST_CHARS} characters).`, {
      title,
      mentions: ['coordinator'],
      text: '@coordinator Task completed; see #1 for details.',
    })
  }
  if (text.length > MAX_POST_CHARS) {
    return formatError(
      'post_board',
      `text length (${text.length}) exceeds the ${MAX_POST_CHARS}-char board limit. Do not paste full raw logs; summarize key failures/commands and cite earlier floors with #seq.`,
      {
        title,
        mentions: args.mentions || ['verifier'],
        refs: args.refs || [1],
        text: text.slice(0, 300) + '...\n[Summary] Keep board posts under 4000 chars and cite #seq.',
      },
    )
  }

  const kind = args.kind !== undefined ? String(args.kind).trim() : 'report'
  if (!VALID_POST_KINDS.includes(kind)) {
    return formatError('post_board', `Invalid kind "${kind}". Allowed: ${VALID_POST_KINDS.join(' | ')}.`, {
      title,
      mentions: args.mentions || ['coordinator'],
      kind: 'report',
      text,
    })
  }

  const verdict = args.verdict !== undefined && args.verdict !== null && args.verdict !== ''
    ? String(args.verdict).trim()
    : null
  if (verdict && !VALID_VERDICTS.includes(verdict)) {
    return formatError('post_board', `Invalid verdict "${verdict}". Allowed: ${VALID_VERDICTS.join(' | ')}.`, {
      title,
      mentions: args.mentions || ['coordinator'],
      kind: 'review',
      verdict: 'reject',
      text,
    })
  }

  const silent = args.silent === true
  const escalate = args.escalate === true

  const extracted = extractMentionsFromText(text)
  const explicitMentions = Array.isArray(args.mentions)
    ? args.mentions.map(m => String(m).replace(/^@/, '').trim()).filter(Boolean)
    : []
  const explicitMemberTargets = explicitMentions.filter(m => !m.startsWith('#'))

  const channelMentions = new Set([
    ...extracted.channels,
    ...explicitMentions.filter(m => m.startsWith('#')).map(m => m.slice(1)),
  ])
  if (channelMentions.has('main') || text.includes('@#main')) {
    return formatError(
      'post_board',
      'Forbidden @#main broadcast! #main is the default all-hands channel; mentioning @#main wakes everyone indiscriminately. Mention specific owner(s) instead.',
      {
        title,
        mentions: ['verifier'],
        text: text.replace(/@#main/g, '@verifier'),
      },
    )
  }

  const activeNames = Object.entries(existingMembers)
    .filter(([, m]) => !m.killed && !m.system_builtin)
    .map(([name]) => name)
  const activeGroups = new Set(
    Object.values(existingMembers)
      .filter(m => !m.killed && m.group)
      .map(m => m.group),
  )

  const rosterSummary = activeNames
    .map(n => {
      const rm = existingMembers[n]
      return `@${n}[${rm?.role ?? 'worker'}, post=#${rm?.last_post_seq ?? 0}${rm?.last_tool_call_at ? ', active=' + rm.last_tool_call_at : ''}]`
    })
    .join(', ')

  const resolvedMentions = new Set()
  const ignoredProseMentions = []

  // 1. Strict validation on explicit `args.mentions`
  for (const target of explicitMemberTargets) {
    if (target === 'all' || target === 'monitor' || activeGroups.has(target)) {
      resolvedMentions.add(target)
      continue
    }
    const record = existingMembers[target]
    if (!record) {
      return formatError(
        'post_board',
        `Target "@${target}" in mentions does not exist. Active members: ${rosterSummary} (plus built-in @monitor).`,
        {
          title,
          mentions: ['coordinator'],
          text: `@coordinator ${text}`,
        },
      )
    }
    if (record.killed) {
      return formatError(
        'post_board',
        `Target "@${target}" has been retired (killed) and cannot receive messages. Active members: ${rosterSummary}`,
        {
          title,
          mentions: ['coordinator'],
          text: text.replaceAll(`@${target}`, '@coordinator'),
        },
      )
    }
    resolvedMentions.add(target)
  }

  // 2. Prose `@tokens`: match live members/groups, reject killed members, tolerate unregistered prose mentions
  for (const target of extracted.members) {
    if (resolvedMentions.has(target)) continue
    if (target === 'all' || target === 'monitor' || activeGroups.has(target)) {
      resolvedMentions.add(target)
      continue
    }
    const record = existingMembers[target]
    if (record && record.killed) {
      return formatError(
        'post_board',
        `Target "@${target}" mentioned in text has been retired (killed). Active members: ${rosterSummary}`,
        {
          title,
          mentions: ['coordinator'],
          text: text.replaceAll(`@${target}`, '@coordinator'),
        },
      )
    }
    if (record && !record.killed) {
      resolvedMentions.add(target)
    } else {
      ignoredProseMentions.push(target)
    }
  }

  const memberMentions = silent ? [] : [...resolvedMentions]
  const caller = existingMembers[callerName]
  const callerRole = caller?.role ?? 'worker'
  const isDonePost = text.includes('[done]') || kind === 'done'
  if (
    !silent
    && (callerRole === 'worker' || callerRole === 'architect' || callerRole === 'verifier')
    && memberMentions.length === 0
    && channelMentions.size === 0
    && !isDonePost
  ) {
    const defaultTarget = callerRole === 'worker'
      ? (activeNames.find(n => getRoleSpec(existingMembers[n]?.role).canBlockMerge) ?? 'coordinator')
      : 'coordinator'
    return formatError(
      'post_board',
      `As ${callerRole} (@${callerName}), you must address at least one recipient (e.g. @${defaultTarget}), or explicitly pass "silent": true to log without waking anyone.`,
      {
        title,
        mentions: [defaultTarget],
        refs: args.refs || [caller?.last_read_seq || 1],
        kind,
        text: `@${defaultTarget} ${text}`,
      },
    )
  }

  const channel = typeof args.channel === 'string' && args.channel.trim()
    ? args.channel.trim().replace(/^#/, '')
    : 'main'
  if (channel !== 'main' && !activeChannels.includes(channel)) {
    return formatError(
      'post_board',
      `Channel "#${channel}" does not exist or is archived. Active channels: ${activeChannels.map(c => '#' + c).join(', ')}`,
      {
        title,
        channel: 'main',
        mentions: memberMentions.length > 0 ? memberMentions : ['coordinator'],
        text,
      },
    )
  }

  const supersedes = Array.isArray(args.supersedes)
    ? [...new Set(args.supersedes.map(Number).filter(n => Number.isSafeInteger(n) && n >= 1))]
    : []

  const idempotencyKey = typeof args.idempotency_key === 'string' && args.idempotency_key.trim()
    ? args.idempotency_key.trim()
    : null
  const overrideReason = typeof args.override_reason === 'string' && args.override_reason.trim()
    ? args.override_reason.trim()
    : null

  return {
    ok: true,
    value: {
      title,
      channel,
      mentions: memberMentions,
      channel_mentions: silent ? [] : [...channelMentions],
      ignored_prose_mentions: ignoredProseMentions,
      refs: Array.isArray(args.refs) ? args.refs.map(Number).filter(n => Number.isSafeInteger(n) && n >= 1) : [],
      kind,
      verdict,
      supersedes,
      escalate,
      silent,
      idempotency_key: idempotencyKey,
      override_reason: overrideReason,
      text,
    },
  }
}

// dup-ok: dedicated per-tool validator for swarm_wait
// #FUNC Validate `swarm_wait`, ensuring `since` never skips beyond the caller's actual `last_read_seq` and validating optional `wake_kinds`.
// #NOT  Does not permit passing the board's head seq if the caller has not read up to that floor via `read_board`.
// #EDGE-IN Passing `since: 15` when `last_read_seq` is `10` fails loudly and instructs the agent to call `read_board` → test_validator_blocks_wait_ahead_of_last_read_seq
// #WHY  Checking `since > lastReadSeq` guarantees a busy agent never sleeps over posts that arrived while it was running tools, while `wake_kinds` enables structured noise filtering.
export function validateSwarmWait(args, memberRecord, headSeq) {
  if (!args || typeof args !== 'object' || args.since === undefined) {
    const lastRead = memberRecord?.last_read_seq ?? 0
    return formatError('swarm_wait', 'Missing required integer parameter `since` (the latest floor seq you have actually read).', {
      since: lastRead,
      mentions_only: true,
    })
  }
  const since = Number(args.since)
  const lastReadSeq = memberRecord?.last_read_seq ?? 0
  if (!Number.isInteger(since) || since < 0) {
    return formatError('swarm_wait', `since (${args.since}) must be a non-negative integer.`, {
      since: lastReadSeq,
      mentions_only: true,
    })
  }
  if (since > lastReadSeq) {
    return formatError(
      'swarm_wait',
      `since=${since} is ahead of your actual last_read_seq=${lastReadSeq} (current board head is #${headSeq}). Do not guess floor numbers and skip unread posts. Call read_board({"since": ${lastReadSeq}}) first, then call swarm_wait.`,
      {
        since: lastReadSeq,
        mentions_only: true,
      },
    )
  }

  let wakeKinds = null
  if (args.wake_kinds !== undefined && args.wake_kinds !== null) {
    if (!Array.isArray(args.wake_kinds)) {
      return formatError('swarm_wait', 'wake_kinds must be a string array (e.g. ["alert", "question", "decision", "review"]).', {
        since,
        mentions_only: true,
        wake_kinds: ['alert', 'question', 'decision', 'review'],
      })
    }
    const normalized = [...new Set(args.wake_kinds.map(k => String(k).trim()).filter(Boolean))]
    const invalid = normalized.filter(k => !VALID_POST_KINDS.includes(k))
    if (invalid.length > 0) {
      return formatError(
        'swarm_wait',
        `wake_kinds contains invalid kind(s): ${invalid.join(', ')}. Allowed: ${VALID_POST_KINDS.join(', ')}.`,
        {
          since,
          mentions_only: true,
          wake_kinds: ['alert', 'question', 'decision', 'review'],
        },
      )
    }
    wakeKinds = normalized.length > 0 ? normalized : null
  }

  return {
    ok: true,
    value: {
      since,
      mentions_only: args.mentions_only !== false,
      wake_kinds: wakeKinds,
    },
  }
}

// dup-ok: dedicated per-tool validator for swarm_plan
/** Validate `swarm_plan` arguments and size cap. */
export function validateSwarmPlan(args) {
  if (!args || typeof args !== 'object') {
    return formatError('swarm_plan', 'Arguments must be a JSON object.', {
      goal: 'Overarching swarm goal description',
      current_wave: 1,
      waves: [{ wave: 1, title: 'Wave 1: Interface negotiation and implementation', status: 'IN_PROGRESS', members: ['arch-lead', 'impl-core', 'qa-gate'] }],
      tracks: [{ name: 'Core Track', owner: 'impl-core', status: 'IN_PROGRESS', evidence_seqs: [1] }],
    })
  }
  const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
  if (!goal) {
    return formatError('swarm_plan', 'goal must be a non-empty string.', {
      goal: 'Investigate and fix issue, passing full regression verification',
      current_wave: 1,
      waves: [],
      tracks: [],
    })
  }
  const bytes = Buffer.byteLength(JSON.stringify(args), 'utf8')
  if (bytes > PLAN_MAX_BYTES) {
    return formatError('swarm_plan', `plan.json size (${bytes} bytes) exceeds the 64 KB limit. Shorten descriptions.`)
  }
  return {
    ok: true,
    value: {
      goal,
      current_wave: Number.isInteger(args.current_wave) ? args.current_wave : 1,
      waves: Array.isArray(args.waves) ? args.waves : [],
      tracks: Array.isArray(args.tracks) ? args.tracks : [],
    },
  }
}
