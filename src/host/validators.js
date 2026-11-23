// Strict tool-argument format & semantic validators for glm5.3 / deepseek4.1f.
//
// Because self-hosted glm5.3 and deepseek4.1f frequently slip on complex tool
// conventions (omitting @mentions, reusing killed member names, passing a high
// `since` to `swarm_wait` to skip unread posts, or writing briefs without
// explicit ownership boundaries), every validator returns a self-healing error
// message with a copy-pasteable JSON example whenever a check fails.

import { PLAN_MAX_BYTES, extractMentionsFromText } from './store.js'

export const MEMBER_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const RESERVED_NAMES = new Set(['all', 'main', 'coordinator', 'system', 'user'])
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
  const base = String(requestedName || 'worker')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-\d+$/, '') || 'worker'
  if (!existingMembers[base] && !RESERVED_NAMES.has(base)) return base
  let index = 2
  while (existingMembers[`${base}-${index}`]) index += 1
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
      `concurrency_limit (${args.concurrency_limit}) 非法！并发限制必须是 >= 1 的正整数（例如 2、4、6、8 等）。`,
      {
        title,
        concurrency_limit: 4,
        default_model: args.default_model || 'inherit',
      },
    )
  }
  return {
    ok: true,
    value: {
      title,
      concurrency_limit: limit,
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
// #FUNC Validate `swarm_add` parameters, enforcing Phase-0 concurrency confirmation, tombstone name lock, and 3-part brief tags.
// #NOT  Does not allow adding workers before `concurrency_confirmed` is true, nor reusing a `killed` member's name, and does not cap active worker parallelism.
// #EDGE-IN Calling `swarm_add` before `concurrency_confirmed` returns a gate error telling Coordinator to ask the user first → test_validator_blocks_add_before_concurrency_confirmed
// #EDGE-IN Reusing a killed member name `monitor` suggests `monitor-2` → test_validator_rejects_killed_name_reuse
// #EDGE-IN A brief missing `[OWNERSHIP]` or `[FORBIDDEN]` or `[DONE_CRITERIA]` is rejected → test_validator_enforces_three_part_brief
// #WHY  `REQUIRED_BRIEF_TAGS` forces `glm5.3` and `deepseek4.1f` to state explicit file boundaries so parallel workers do not overwrite each other's files.
export function validateSwarmAdd(args, swarmMeta, existingMembers = {}, callerName = 'coordinator') {
  if (!swarmMeta || swarmMeta.concurrency_confirmed !== true) {
    return formatError(
      'swarm_add',
      '尚未向用户确认本次 Swarm 的并发限额！在调用 swarm_add 建人之前，你必须先调用 ask_user_question 询问用户需要几个并发（如 4 / 6 / 自定义），然后调用 swarm_init 设置 concurrency_limit。',
      {
        title: '任务标题',
        concurrency_limit: 4,
        default_model: 'deepseek4.1f',
      },
      '请先调用 ask_user_question 再调用 swarm_init！',
    )
  }

  if (!args || typeof args !== 'object') {
    return formatError('swarm_add', '参数必须是 JSON 对象。', {
      name: 'worker-1',
      role: 'worker',
      workspace: 'inherit',
      brief: '[OWNERSHIP] src/foo.js\n[FORBIDDEN] src/bar.js\n[DONE_CRITERIA] 跑通单测并汇报 @verifier',
    })
  }

  const rawName = typeof args.name === 'string' ? args.name.trim() : ''
  const suggested = suggestNextMemberName(rawName, existingMembers)
  if (!rawName || rawName.length > 24 || !MEMBER_NAME_REGEX.test(rawName) || RESERVED_NAMES.has(rawName)) {
    return formatError(
      'swarm_add',
      `成员名 "${rawName}" 不合法！名字必须为 1~24 位小写字母、数字和连字符（^[a-z0-9]+(?:-[a-z0-9]+)*$），且不能是 all/main/coordinator。`,
      {
        name: suggested,
        role: args.role || 'worker',
        workspace: args.workspace || 'inherit',
        brief: '[OWNERSHIP] 负责模块\n[FORBIDDEN] 禁止触碰模块\n[DONE_CRITERIA] 完成标准与核验命令',
      },
    )
  }

  const count = args.n !== undefined ? Number(args.n) : (Array.isArray(args.tasks) && args.tasks.length > 0 ? args.tasks.length : 1)
  if (!Number.isInteger(count) || count < 1) {
    return formatError('swarm_add', `批量创建数量 n (${args.n}) 必须为 >= 1 的正整数。`, {
      name: rawName,
      n: 2,
      role: 'worker',
      workspace: 'inherit',
      brief: '[OWNERSHIP] ...\n[FORBIDDEN] ...\n[DONE_CRITERIA] ...',
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
          ? `成员名 "${candidate}" 已被销毁（killed），按 Swarm 规范名字永久锁死不可复用！请顺延使用新名字 "${nextSuggestion}"。`
          : `成员名 "${candidate}" 已存在！请使用新名字 "${nextSuggestion}"。`,
        {
          name: nextSuggestion,
          role: args.role || 'worker',
          workspace: args.workspace || 'inherit',
          brief: args.brief || '[OWNERSHIP] ...\n[FORBIDDEN] ...\n[DONE_CRITERIA] ...',
        },
      )
    }
  }

  const role = args.role ?? 'worker'
  if (!['worker', 'verifier', 'monitor'].includes(role)) {
    return formatError('swarm_add', `role "${role}" 非法，只能是 "worker" | "verifier" | "monitor"。`, {
      name: rawName,
      role: 'worker',
      workspace: 'inherit',
      brief: '[OWNERSHIP] ...\n[FORBIDDEN] ...\n[DONE_CRITERIA] ...',
    })
  }

  const workspace = args.workspace ?? 'inherit'
  if (!['inherit', 'share', 'branch'].includes(workspace)) {
    return formatError('swarm_add', `workspace "${workspace}" 非法，只能是 "inherit" | "share" | "branch"。`, {
      name: rawName,
      role,
      workspace: 'inherit',
      brief: '[OWNERSHIP] ...\n[FORBIDDEN] ...\n[DONE_CRITERIA] ...',
    })
  }

  const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
  if (role !== 'monitor') {
    const missingTags = REQUIRED_BRIEF_TAGS.filter(tag => !brief.includes(tag))
    if (missingTags.length > 0) {
      return formatError(
        'swarm_add',
        `brief 缺少必填结构标签：${missingTags.join(', ')}！为了防止 glm5.3 / deepseek4.1f 越界改文件，brief 必须显式包含 [OWNERSHIP]、[FORBIDDEN] 和 [DONE_CRITERIA] 三段。`,
        {
          name: rawName,
          role,
          workspace,
          brief: '[OWNERSHIP]\n负责排查或修改的具体文件路径\n[FORBIDDEN]\n严禁修改或触碰的文件路径\n[DONE_CRITERIA]\n完成标准、实测验证命令以及完成后需 @verifier 或 @coordinator',
        },
      )
    }
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

  return {
    ok: true,
    value: {
      baseName: rawName,
      targetNames,
      group: count > 1 ? rawName : (args.group ?? null),
      role,
      workspace,
      brief: brief || '[OWNERSHIP] 全局黑板死锁巡检\n[FORBIDDEN] 严禁修改任何业务文件\n[DONE_CRITERIA] 发现静默死锁时发 [stall] 提醒',
      provider: args.provider ?? swarmMeta.default_provider ?? 'inherit',
      model: args.model ?? swarmMeta.default_model ?? 'inherit',
      fork: args.fork ? String(args.fork).trim() : null,
      tasks: Array.isArray(args.tasks) ? args.tasks.map(String) : null,
      parent: callerName,
    },
  }
}

// #FUNC Validate `post_board` calls, blocking `@#main` broadcasts, oversized log dumps, dead targets, and unaddressed worker reports.
// #NOT  Does not let a worker or verifier post a report that forgets to `@mention` anyone.
// #EDGE-IN Worker posting without any `@mention` is rejected with the active roster list → test_validator_rejects_unaddressed_worker_post
// #EDGE-IN Posting `@#main` is rejected to prevent disguised `@all` storms → test_validator_rejects_channel_main_broadcast
// #EDGE-IN Mentioning a `killed` member is rejected with active alternatives → test_validator_rejects_mentioning_killed_member
// #WHY  `MAX_POST_CHARS` and mandatory `@mention` checks stop `glm5.3`/`deepseek4.1f` from pasting 20KB logs or posting orphan reports that stall the swarm.
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

  const extracted = extractMentionsFromText(text)
  const explicitMentions = Array.isArray(args.mentions)
    ? args.mentions.map(m => String(m).replace(/^@/, '').trim()).filter(Boolean)
    : []

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

  const memberMentions = [...new Set([
    ...explicitMentions.filter(m => !m.startsWith('#')),
    ...extracted.members,
  ])]

  const activeNames = Object.entries(existingMembers)
    .filter(([, m]) => !m.killed)
    .map(([name]) => name)
  const activeGroups = new Set(
    Object.values(existingMembers)
      .filter(m => !m.killed && m.group)
      .map(m => m.group),
  )

  for (const target of memberMentions) {
    if (target === 'all') continue
    if (activeGroups.has(target)) continue
    const record = existingMembers[target]
    if (!record) {
      return formatError(
        'post_board',
        `点名的目标 "@${target}" 不存在！当前存活可点名成员为：${activeNames.map(n => '@' + n).join(', ')}`,
        {
          mentions: ['coordinator'],
          text: `@coordinator ${text}`,
        },
      )
    }
    if (record.killed) {
      return formatError(
        'post_board',
        `点名的目标 "@${target}" 已经被销毁（killed），无法接收消息！当前存活可点名成员为：${activeNames.map(n => '@' + n).join(', ')}`,
        {
          mentions: ['coordinator'],
          text: text.replaceAll(`@${target}`, '@coordinator'),
        },
      )
    }
  }

  const caller = existingMembers[callerName]
  const callerRole = caller?.role ?? 'worker'
  const isDonePost = text.includes('[done]') || args.kind === 'done'
  if (
    (callerRole === 'worker' || callerRole === 'verifier' || callerRole === 'monitor')
    && memberMentions.length === 0
    && channelMentions.size === 0
    && !isDonePost
  ) {
    const defaultTarget = callerRole === 'worker'
      ? (activeNames.find(n => existingMembers[n]?.role === 'verifier') ?? 'coordinator')
      : 'coordinator'
    return formatError(
      'post_board',
      `你是 ${callerRole} (@${callerName})，发帖必须至少点名一个接收人（例如 @${defaultTarget}），否则没有任何人会被唤醒接手你的结果！`,
      {
        mentions: [defaultTarget],
        refs: args.refs || [caller?.last_read_seq || 1],
        kind: args.kind || 'report',
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

  return {
    ok: true,
    value: {
      channel,
      mentions: memberMentions,
      channel_mentions: [...channelMentions],
      refs: Array.isArray(args.refs) ? args.refs.map(Number).filter(n => Number.isSafeInteger(n) && n >= 1) : [],
      kind: args.kind ?? 'report',
      text,
    },
  }
}

// dup-ok: dedicated per-tool validator for swarm_wait
// #FUNC Validate `swarm_wait`, ensuring `since` never skips beyond the caller's actual `last_read_seq`.
// #NOT  Does not permit passing the board's head seq if the caller has not read up to that floor via `read_board`.
// #EDGE-IN Passing `since: 15` when `last_read_seq` is `10` fails loudly and instructs the agent to call `read_board` → test_validator_blocks_wait_ahead_of_last_read_seq
// #WHY  Checking `since > lastReadSeq` guarantees a busy agent never sleeps over posts that arrived while it was running tools.
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
  return {
    ok: true,
    value: {
      since,
      mentions_only: args.mentions_only !== false,
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
      waves: [{ wave: 1, title: '第 1 波：只读排查', status: 'IN_PROGRESS', members: ['worker-1', 'verifier'] }],
      tracks: [{ name: '子方向 A', owner: 'worker-1', status: 'IN_PROGRESS', evidence_seqs: [1] }],
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
