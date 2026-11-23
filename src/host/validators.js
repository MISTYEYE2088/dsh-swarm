// Strict tool-argument format & semantic validators for glm5.3 / deepseek4.1f.
//
// Returns self-healing error messages with copy-pasteable JSON examples whenever
// validation fails, while avoiding false rejections on prose `@future` mentions
// and supporting silent logging (`silent: true`), `wake_kinds` noise filtering,
// `verdict`, and `supersedes`.

import {
  PLAN_MAX_BYTES,
  VALID_POST_KINDS,
  VALID_VERDICTS,
  extractMentionsFromText,
} from './store.js'

export const MEMBER_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const RESERVED_NAMES = new Set(['all', 'main', 'coordinator', 'system', 'user', 'monitor'])
export const VALID_ROLES = Object.freeze(['worker', 'architect', 'verifier'])
export const REQUIRED_BRIEF_TAGS = ['[OWNERSHIP]', '[FORBIDDEN]', '[DONE_CRITERIA]']
export const MAX_POST_CHARS = 4_000
export const MIN_POST_CHARS = 6

/** Build a structured self-healing validation failure. */
function formatError(toolName, reason, exampleObj, extraNote = '') {
  const lines = [
    `[FORMAT_ERROR: ${toolName}] ${reason}`,
  ]
  if (extraNote) lines.push(extraNote)
  if (exampleObj !== undefined) {
    lines.push('请严格按以下正确 JSON 格式重新调用该工具：')
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
    return formatError('swarm_init', '参数必须是 JSON 对象。', {
      title: '模块排查与修复',
      concurrency_limit: 4,
      default_model: 'inherit',
    })
  }
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (title.length < 2 || title.length > 120) {
    return formatError('swarm_init', 'title 必须是非空字符串（2~120 字符）。', {
      title: 'PDF 导出乱码排查与修复',
      concurrency_limit: 4,
      default_model: 'inherit',
    })
  }
  const limit = Number(args.concurrency_limit)
  if (!Number.isInteger(limit) || limit < 1) {
    return formatError(
      'swarm_init',
      `concurrency_limit (${args.concurrency_limit}) 非法！并发槽位数（模型在途请求并发上限，≠ 成员人数上限）必须是 >= 1 的正整数（例如 2、4、6、8 等）。`,
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
      'Swarm 状态不存在或已被清理（swarm.json 未找到）！请先确认目标与并发槽位，再调用 swarm_init 初始化黑板。',
      {
        title: '任务标题',
        concurrency_limit: 4,
        default_model: 'inherit',
      },
      '请先调用 swarm_init 初始化黑板！',
    )
  }
  if (swarmMeta.status === 'DONE') {
    return formatError(
      'swarm_add',
      `当前 Swarm (${swarmMeta.swarm_id}, gen=${swarmMeta.generation ?? 1}) 已结案 (status=DONE)！如需开启新一轮 Swarm，请重新调用 swarm_init。`,
      {
        title: swarmMeta.title || '新一轮任务',
        concurrency_limit: swarmMeta.concurrency_limit || 4,
        default_model: swarmMeta.default_model || 'inherit',
      },
    )
  }
  if (swarmMeta.concurrency_confirmed !== true) {
    return formatError(
      'swarm_add',
      '尚未确认本次 Swarm 的模型并发槽位数！若用户未在指令中指定并发数，请先调用 ask_user_question 询问，再调用 swarm_init 设置 concurrency_limit（若用户已明确给出，直接调用 swarm_init 即可）。',
      {
        title: '任务标题',
        concurrency_limit: 4,
        default_model: 'inherit',
      },
      '请先调用 swarm_init 设置 concurrency_limit！',
    )
  }

  if (!args || typeof args !== 'object') {
    return formatError('swarm_add', '参数必须是 JSON 对象。', {
      name: 'impl-core',
      role: 'worker',
      workspace: 'inherit',
      brief: '[OWNERSHIP]\nsrc/core/\n[FORBIDDEN]\nsrc/ui/\n[DONE_CRITERIA]\n冒烟自测通过并 @qa-gate 验收',
    })
  }

  const role = args.role ?? 'worker'
  if (role === 'monitor') {
    return formatError(
      'swarm_add',
      '无需手动创建 role="monitor" 成员！看门狗（Watchdog）已作为零 Token 确定性后台服务自动运行（每 30 秒独立探活僵尸/报错成员）。请使用 "worker"、"architect" 或 "verifier"。',
      {
        name: args.name && args.name !== 'monitor' ? args.name : 'qa-gate',
        role: 'verifier',
        workspace: 'inherit',
        brief: '[OWNERSHIP]\ntests/\n[FORBIDDEN]\nsrc/\n[DONE_CRITERIA]\n独立推导断言并交付实测报告',
      },
    )
  }
  if (!VALID_ROLES.includes(role)) {
    return formatError('swarm_add', `role "${role}" 非法，只能是 "worker" | "architect" | "verifier"。`, {
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
      `成员名 "${rawName}" 不合法！名字必须为 1~24 位小写字母、数字和连字符（^[a-z0-9]+(?:-[a-z0-9]+)*$），且不能是保留名 (${[...RESERVED_NAMES].join('/')})。`,
      {
        name: suggested,
        role,
        workspace: args.workspace || 'inherit',
        brief: '[OWNERSHIP]\n负责模块\n[FORBIDDEN]\n禁止触碰模块\n[DONE_CRITERIA]\n完成标准与核验命令',
      },
    )
  }

  const count = args.n !== undefined ? Number(args.n) : (Array.isArray(args.tasks) && args.tasks.length > 0 ? args.tasks.length : 1)
  if (!Number.isInteger(count) || count < 1) {
    return formatError('swarm_add', `批量创建数量 n (${args.n}) 必须为 >= 1 的正整数。`, {
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
          ? `成员名 "${candidate}" 曾产出过历史记录并已退役（killed），为保持黑板因果溯源名字永久锁死！请顺延使用新名字 "${nextSuggestion}"。`
          : `成员名 "${candidate}" 已存在！请使用新名字 "${nextSuggestion}"。`,
        {
          name: nextSuggestion,
          role,
          workspace: args.workspace || 'inherit',
          brief: args.brief || '[OWNERSHIP]\n...\n[FORBIDDEN]\n...\n[DONE_CRITERIA]\n...',
        },
      )
    }
  }

  const workspace = args.workspace ?? 'inherit'
  if (!['inherit', 'share', 'branch'].includes(workspace)) {
    return formatError('swarm_add', `workspace "${workspace}" 非法，只能是 "inherit" | "share" | "branch"。`, {
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
    if (missingTags.includes('[FORBIDDEN]') && /(?:禁区|禁止|forbidden)/i.test(brief)) {
      proseHints.push('检测到正文中写了类似“禁区/禁止”的描述，但缺少字面量标签 `[FORBIDDEN]`')
    }
    if (missingTags.includes('[OWNERSHIP]') && /(?:负责|归属|ownership)/i.test(brief)) {
      proseHints.push('检测到正文中写了类似“负责/归属”的描述，但缺少字面量标签 `[OWNERSHIP]`')
    }
    if (missingTags.includes('[DONE_CRITERIA]') && /(?:完成标准|验收|done)/i.test(brief)) {
      proseHints.push('检测到正文中写了类似“完成标准/验收”的描述，但缺少字面量标签 `[DONE_CRITERIA]`')
    }
    const foundSummary = foundTags.length > 0 ? `已识别标签: ${foundTags.join(', ')}` : '已识别标签: 无'
    const hintLine = proseHints.length > 0 ? `诊断提示：${proseHints.join('；')}。请将缺失标签以字面量独立成行补齐。` : ''
    return formatError(
      'swarm_add',
      `brief 缺少必填字面量标签：${missingTags.join(', ')}（${foundSummary}）。brief 必须同时包含 [OWNERSHIP]、[FORBIDDEN] 和 [DONE_CRITERIA] 三个独立标签段。`,
      {
        name: rawName,
        role,
        workspace,
        brief: '[OWNERSHIP]\n负责模块与交付物\n[FORBIDDEN]\n严禁越界触碰的模块/行为\n[DONE_CRITERIA]\n完成标准、核验命令以及交接对象',
      },
      hintLine,
    )
  }

  if (args.fork !== undefined && args.fork !== null && args.fork !== '') {
    const forkSource = String(args.fork).trim()
    if (forkSource !== 'coordinator' && !existingMembers[forkSource]) {
      return formatError(
        'swarm_add',
        `fork 来源成员 "${forkSource}" 不存在！可用来源: coordinator, ${Object.keys(existingMembers).join(', ')}`,
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
    : (role === 'verifier' || role === 'architect')

  return {
    ok: true,
    value: {
      baseName: rawName,
      targetNames,
      group: count > 1 ? rawName : (args.group ?? null),
      role,
      can_block_merge: canBlockMerge,
      workspace,
      brief,
      provider: args.provider ?? swarmMeta.default_provider ?? 'inherit',
      model: args.model ?? swarmMeta.default_model ?? 'inherit',
      fork: args.fork ? String(args.fork).trim() : null,
      tasks: Array.isArray(args.tasks) ? args.tasks.map(String) : null,
      parent: callerName,
    },
  }
}

// #FUNC Validate `post_board` calls, supporting silent logging, strict explicit `mentions` checks, prose `@future` tolerance, `verdict`, and `supersedes`.
// #NOT  Does not let an unaddressed worker post silently unless `silent: true` is explicitly passed; never lets `@#main` broadcast or dead targets pass.
// #EDGE-IN Worker posting without any `@mention` and without `silent: true` is rejected with the active roster list → test_validator_rejects_unaddressed_worker_post
// #EDGE-IN Posting `@#main` is rejected to prevent disguised `@all` storms → test_validator_rejects_channel_main_broadcast
// #EDGE-IN Mentioning a `killed` member is rejected with active alternatives → test_validator_rejects_mentioning_killed_member
// #WHY  Strict validation on explicit `mentions` catches typos while tolerating unregistered prose `@tokens` prevents false rejections when mentioning future wave roles.
export function validatePostBoard(args, existingMembers = {}, callerName = 'coordinator', activeChannels = ['main']) {
  if (!args || typeof args !== 'object') {
    return formatError('post_board', '参数必须是 JSON 对象。', {
      mentions: ['verifier'],
      refs: [1],
      kind: 'report',
      text: '已完成 #1 排查，结果如下... 请 @verifier 核验。',
    })
  }

  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (text.length < MIN_POST_CHARS) {
    return formatError('post_board', `text 内容过短（至少 ${MIN_POST_CHARS} 字符）。`, {
      mentions: ['coordinator'],
      text: '@coordinator 已完成任务，详情见 #1。',
    })
  }
  if (text.length > MAX_POST_CHARS) {
    return formatError(
      'post_board',
      `text 长度 (${text.length}) 超过黑板上限 ${MAX_POST_CHARS} 字符！严禁把几千字完整日志贴到黑板上，请只贴关键报错摘要与命令，或用 #seq 引用前序楼层。`,
      {
        mentions: args.mentions || ['verifier'],
        refs: args.refs || [1],
        text: text.slice(0, 300) + '...\n[关键摘要] 请浓缩至 4000 字以内并引用 #楼层号。',
      },
    )
  }

  const kind = args.kind !== undefined ? String(args.kind).trim() : 'report'
  if (!VALID_POST_KINDS.includes(kind)) {
    return formatError('post_board', `kind "${kind}" 非法，只能是 ${VALID_POST_KINDS.join(' | ')}。`, {
      mentions: args.mentions || ['coordinator'],
      kind: 'report',
      text,
    })
  }

  const verdict = args.verdict !== undefined && args.verdict !== null && args.verdict !== ''
    ? String(args.verdict).trim()
    : null
  if (verdict && !VALID_VERDICTS.includes(verdict)) {
    return formatError('post_board', `verdict "${verdict}" 非法，只能是 ${VALID_VERDICTS.join(' | ')}。`, {
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
      '严禁发送 @#main！#main 是全员主频道，点名 @#main 等同于无差别唤醒全员。请直接点名具体责任人（如 @verifier 或 @coordinator）。',
      {
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
        `mentions 中指定的目标 "@${target}" 不存在！当前存活可点名成员为：${rosterSummary}（以及系统看门狗 @monitor）`,
        {
          mentions: ['coordinator'],
          text: `@coordinator ${text}`,
        },
      )
    }
    if (record.killed) {
      return formatError(
        'post_board',
        `点名的目标 "@${target}" 已经被销毁（killed），无法接收消息！当前存活可点名成员为：${rosterSummary}`,
        {
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
        `正文中点名的目标 "@${target}" 已经被销毁（killed），无法接收消息！当前存活可点名成员为：${rosterSummary}`,
        {
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
      ? (activeNames.find(n => existingMembers[n]?.role === 'verifier' || existingMembers[n]?.role === 'architect') ?? 'coordinator')
      : 'coordinator'
    return formatError(
      'post_board',
      `你是 ${callerRole} (@${callerName})，发帖必须至少点名一个接收人（例如 @${defaultTarget}），或显式传入 "silent": true 表示仅沉默记账不唤醒任何人！`,
      {
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
      `频道 "#${channel}" 不存在或已归档！当前可用频道：${activeChannels.map(c => '#' + c).join(', ')}`,
      {
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
    return formatError('swarm_wait', '必须提供整数参数 since（你已读到的最新楼层号）。', {
      since: lastRead,
      mentions_only: true,
    })
  }
  const since = Number(args.since)
  const lastReadSeq = memberRecord?.last_read_seq ?? 0
  if (!Number.isInteger(since) || since < 0) {
    return formatError('swarm_wait', `since (${args.since}) 必须是非负整数。`, {
      since: lastReadSeq,
      mentions_only: true,
    })
  }
  if (since > lastReadSeq) {
    return formatError(
      'swarm_wait',
      `你传入的 since=${since} 大于你实际读过的最新楼层 last_read_seq=${lastReadSeq}（当前黑板最新楼层为 #${headSeq}）！严禁瞎猜楼层号跳过未读消息。请先调用 read_board({"since": ${lastReadSeq}}) 阅读新帖，处理完后再调用 swarm_wait。`,
      {
        since: lastReadSeq,
        mentions_only: true,
      },
    )
  }

  let wakeKinds = null
  if (args.wake_kinds !== undefined && args.wake_kinds !== null) {
    if (!Array.isArray(args.wake_kinds)) {
      return formatError('swarm_wait', 'wake_kinds 必须是字符串数组（如 ["alert", "question", "decision", "review"]）。', {
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
        `wake_kinds 包含非法类型: ${invalid.join(', ')}。可选值: ${VALID_POST_KINDS.join(', ')}。`,
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
    return formatError('swarm_plan', '参数必须是 JSON 对象。', {
      goal: '总体目标描述',
      current_wave: 1,
      waves: [{ wave: 1, title: '第 1 波：接口协商与实现', status: 'IN_PROGRESS', members: ['arch-lead', 'impl-core', 'qa-gate'] }],
      tracks: [{ name: '子方向 A', owner: 'impl-core', status: 'IN_PROGRESS', evidence_seqs: [1] }],
    })
  }
  const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
  if (!goal) {
    return formatError('swarm_plan', 'goal 不能为空字符串。', {
      goal: '排查并修复问题，通过全部回归测试',
      current_wave: 1,
      waves: [],
      tracks: [],
    })
  }
  const bytes = Buffer.byteLength(JSON.stringify(args), 'utf8')
  if (bytes > PLAN_MAX_BYTES) {
    return formatError('swarm_plan', `plan.json 体积 (${bytes} bytes) 超过 64KB 硬上限！请精简描述文字。`)
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
