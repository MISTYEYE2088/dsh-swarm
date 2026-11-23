# `dsh-swarm` 插件完整工程技术规格书（v1.0）

> **目标宿主**：DeepSeek Harness (`dsh` `0.2.0-rc.2` / Cordis `4.0.4`) 树外插件（Out-of-Tree Plugin）  
> **目标模型**：公司内部自部署 `glm5.3` / `deepseek4.1f`（**无 Token 额度限制，但共享集群并发受限 `4 ~ 6` 且算力不宽裕，需温和调度、防抢占**）  
> **核心架构参考**：Antigravity `/swarm` 逆向工程（三文件黑板底座 `board.jsonl` + `members.json` + `swarm.json`、静态 `plan.json` 替代常驻 Narrator、`swarm_wait` + Stop Hook 竞态锁、四游标防漏读、两波次清场接力）+ [dsh-plugin-guide](file:///mnt/c/portable_software/dsh/dsh-plugin-guide/README.md) 全部启动安全与验证红线。

---

## 一、设计总纲：针对“内部 `glm5.3` / `deepseek4.1f` + 4~6 温和并发”的五大定制原则

1. **启动必问并发度（Phase 0 强制确认，绝不盲冲抢占集群）**
   * 公司内部模型并发总共只有 `4 ~ 6`，多人共享时不能一上来就拉满。
   * 当用户触发 `/swarm <task>` 时，**Coordinator 的第一步（由代码级 `ToolGuard` 强制拦截保证）必须调用 `ask_user_question`**，向用户确认本次任务允许占用的并发槽位数（默认推荐 `2 ~ 3` 温和模式，最高可选 `4 ~ 6`）以及角色模型分配（`glm5.3` / `deepseek4.1f` 混搭或统一）。
2. **不搞激进超卖，采用“分波次（Wave-based）+ 随用随清（Kill & Clean）”**
   * 不做 Best-of-N 投机并发，不做常驻解说员（Narrator）。
   * 模仿 24 帖实战案例的**两波次接力法**：
     * **第 1 波（只读排查波）**：2~3 个只读 Worker（`workspace: "inherit"`）+ 1 个 Verifier，查清根因交出证据后**全部 `kill` 清场**，释放上下文与会话。
     * **第 2 波（并行修复与回归波）**：按模块新建 `fixer-*`（必要时开 `share` worktree）+ `verifier-fix`，修完合并（Land）后再清场。
3. **用“三文件纯文本黑板 + 静态 `plan.json`”做唯一事实源**
   * 所有共享状态落盘到 `<DSH_HOME>/swarm/<coordinatorSessionId>/` 下的四个纯文本文件：`swarm.json`、`board.jsonl`、`members.json`、`plan.json`。
   * 既方便崩溃恢复、人工随时 `cat`/`tail -f` 排查，又天然兼容未来跨机 `--json --watch` NDJSON 流扩展。
4. **零空转还不漏消息：三层底座（`swarm_wait` + `agent/turn-stopping` Stop Hook + Transcript 判活）**
   * 成员干完活调 `swarm_wait({ since })` 直接通过 `exec.concludeTurn()` 结束当前 Turn，**休眠期 0 并发占用、0 Token 消耗**。
   * 挂载 DSH 原生 `agent/turn-stopping` 事件实现 **Stop Hook 竞态锁**：刚准备闭眼时若黑板落了新帖，直接拦截休眠并往 `inbox.nextStep` 塞入催读指令。
5. **针对 `glm5.3` / `deepseek4.1f` 的“防呆护栏 + 强制格式校验”**
   * 这两个模型容易出现：**忘加 `@mention` 导致没人接盘、调 `swarm_wait` 乱填 `since` 跳过未读楼层、把几千字日志直接贴黑板不引用 `#seq`、工具参数格式写歪、干完活不调 `swarm_wait` 直接结束回合**。
   * **对策**：① 所有新增 Tool 必须经过双层 Schema + 业务语义强校验，报错时直接返回**带正确 JSON 示例的纠错模板**；② Stop Hook 自动拦截“干完活既不发帖也不 `swarm_wait` 就想溜”的回合；③ 提示词采用极度具体的 **SOP 步骤卡 + 正反例对照**。

---

## 二、目录结构与落盘底座设计

### 2.1 插件工程目录结构（`C:\portable_software\dsh\dsh-swarm`）

```text
/mnt/c/portable_software/dsh/dsh-swarm/
├── SPEC.md                       # 本技术规格书
├── README.md                     # 安装、配置、排障与验收手册
├── package.json                  # Host (./lib/index.js) + Client (./lib/client.js) 双入口声明
├── cordis.patch.yml              # 注入 dsh-swarm 行
├── tsconfig.json
├── src/
│   ├── host/
│   │   ├── index.ts              # 入口：name, inject, apply (try/catch 启动安全), applyWith (严格测试用)
│   │   ├── config.ts             # 运行时配置合并（严禁 export plain object Config！）
│   │   ├── store.ts              # 四个纯文本文件 (swarm.json, board.jsonl, members.json, plan.json) 原子读写与文件锁
│   │   ├── channels.ts           # 事件溯源频道重放：channelsAt(seq) / activeAt(seq)
│   │   ├── concurrency-gate.ts   # 挂载 llm/stream 的温和并发闸门（P0~P3 优先级 + 最小请求间隔 + 429 AIMD）
│   │   ├── stop-hook.ts          # 挂载 agent/turn-stopping：防漏读竞态锁 + 防忘调 swarm_wait 拦截
│   │   ├── liveness.ts           # statusOf()：结合 Session 日志尾部 + ConcurrencyGate 状态推导真实 working/waiting
│   │   ├── roster.ts             # 成员生命周期：spawn / fork / model 热切 / kill 墓碑锁名 / 游标初始化
│   │   ├── worktree.ts           # inherit / share (git worktree + 脏状态同步) / branch + land 检查
│   │   ├── monitor.ts            # 3 分钟后台巡检定时器（5 类卡死检测、last_post_seq 判据、连续 5 轮静默自休眠）
│   │   ├── validators.ts         # 针对 glm5.3 / deepseek4.1f 的强格式校验器与自愈报错生成器
│   │   ├── tools.ts              # 模型工具集：swarm_init, swarm_plan, swarm_add, post_board, read_board, swarm_wait, swarm_model, swarm_land, swarm_kill
│   │   ├── commands.ts           # /swarm 人类斜杠命令（status, board, concurrency, pause, resume, kill）
│   │   ├── prompts.ts            # 针对 glm5.3 / deepseek4.1f 编写的 4 角色详尽 SOP 提示词
│   │   └── projection.ts         # 注册 ctx.sessionProjections，零核心补丁实时同步给 Web 前端
│   └── client/
│       ├── entry.ts              # window.__ModuleLoader__.load 闭包工厂（Classic Script）
│       ├── mount.ts              # 注册 conversation.session.header.actions 与 shell.overlay
│       ├── hive-view.ts          # 确定性前端合成看板（融合 plan.json + board.jsonl + 成员状态 + Graph 回放）
│       └── build.ts              # 打包构建脚本
├── lib/
│   ├── index.js
│   └── client.js
└── tools/
    ├── boot-check.mjs            # 真 Cordis Context + sibling dispatch 挂载验证
    └── smoke-test.mjs            # 四游标、Stop Hook 竞态锁、格式校验器与并发闸门自测
```

---

### 2.2 四个纯文本黑板文件精确 Schema（落盘在 `<DSH_HOME>/swarm/<coordinatorSessionId>/`）

所有文件写入均使用**同目录临时文件 + `rename` 原子替换**（`board.jsonl` 采用进程内互斥锁串行 `appendFile` + `fsync`），确保高并发下绝不写坏 JSON。

#### 1. `swarm.json`（门牌锚点与并发预算）
```json
{
  "version": 1,
  "swarm_id": "sess_01j8...",
  "title": "PDF 导出乱码排查与修复",
  "backend": "local",
  "status": "ACTIVE",
  "concurrency_confirmed": true,
  "concurrency_limit": 3,
  "default_model": "deepseek4.1f",
  "coordinator_model": "glm5.3",
  "created_at": "2026-11-22T18:45:00.000Z",
  "updated_at": "2026-11-22T19:10:00.000Z"
}
```
* **`concurrency_confirmed`**：初始为 `false`。在变为 `true` 之前，`swarm_add` 工具会被硬拦截，强制 Coordinator 先用 `ask_user_question` 询问用户并发数（`2 / 3 / 4 / 6`）。

#### 2. `board.jsonl`（只追加流水账：普通帖 + 频道 Control 帧）
每行一条严格单行 JSON，`seq` 从 `1` 开始全局单调递增：

```jsonl
{"seq":1,"type":"post","agent":"coordinator","channel":"main","mentions":["pdf-pipeline"],"refs":[],"kind":"brief","text":"@pdf-pipeline [OWNERSHIP] tools/pdf-export.js, src/fonts/* [FORBIDDEN] templates/* [DONE_CRITERIA] 查明字体映射与字形表缺失原因并贴出复现输出","time":"2026-11-22 18:46:01","origin":"coordinator@local","actor_kind":"AGENT"}
{"seq":2,"type":"post","agent":"coordinator","channel":"main","mentions":["template-dom"],"refs":[],"kind":"brief","text":"@template-dom [OWNERSHIP] templates/html/* [FORBIDDEN] tools/pdf-export.js [DONE_CRITERIA] 排查 6 套模板 DOM 文本流与 CSS 打印样式","time":"2026-11-22 18:46:02","origin":"coordinator@local","actor_kind":"AGENT"}
{"seq":3,"type":"control","action":"channel.create","agent":"coordinator","channel":"render","time":"2026-11-22 18:46:05"}
{"seq":4,"type":"control","action":"channel.subscribe","agent":"coordinator","channel":"render","target":"pdf-pipeline","time":"2026-11-22 18:46:05"}
{"seq":5,"type":"post","agent":"template-dom","channel":"main","mentions":["verifier"],"refs":[2],"kind":"report","text":"HTML 模板排查结果如下（对应 #2），请 @verifier 交叉核验...","time":"2026-11-22 18:55:12","origin":"template-dom@local","actor_kind":"AGENT"}
```

* **多频道事件溯源（`channels.ts`）**：
  * 频道的创建（`channel.create`）、订阅（`channel.subscribe`）、退订（`channel.unsubscribe`）、归档（`channel.archive`）全部作为 `type: "control"` 帧写进 `board.jsonl`。
  * `channelsAt(seq)` 与 `activeAt(seq, memberName)` 通过重放 `1..seq` 的 control 帧，精确计算任意历史时刻某成员可见的频道集合。`members.json` 里的 `channels` 字段仅作为最新快照缓存。
  * 成员默认订阅 `["main"]`。发送 `@#channel` 时唤醒该频道全体当前订阅者；**严禁发送 `@#main`**（校验器直接拒绝，防止变相 `@all` 炸毁并发槽）。
* **跨机扩展预留**：每条记录携带 `origin: "<name>@<host>"` 与 `actor_kind: "HUMAN" | "AGENT"`。当未来 `swarm.json.backend === "remote"` 时，前端/CLI 只需监听 NDJSON 增量流；一旦发现 `incoming.seq !== localHeadSeq + 1`，立即中断 watcher 触发全量快照 `resync`。

#### 3. `members.json`（全组花名册 + 四游标签到表 + 模型双字段）
```json
{
  "coordinator": {
    "session_id": "sess_01j8root",
    "role": "coordinator",
    "parent": null,
    "desired_state": "RUNNING",
    "phase": "RUNNING",
    "desired_provider": "internal",
    "desired_model": "glm5.3",
    "applied_provider": "internal",
    "applied_model": "glm5.3",
    "workspace_mode": "inherit",
    "wake_mode": "anything",
    "channels": ["main"],
    "wait_since": 4,
    "last_read_seq": 4,
    "last_nudged_seq": 4,
    "last_park_blocked_seq": 0,
    "last_post_seq": 4,
    "killed": false,
    "created_at": "2026-11-22T18:45:00.000Z"
  },
  "fixer-templates": {
    "session_id": "sess_01j8child2",
    "role": "worker",
    "group": "fixer",
    "parent": "coordinator",
    "desired_state": "RUNNING",
    "phase": "RUNNING",
    "desired_provider": "internal",
    "desired_model": "deepseek4.1f",
    "applied_provider": "internal",
    "applied_model": "deepseek4.1f",
    "workspace_mode": "share",
    "worktree_path": "/root/.dsh/swarm-worktrees/sess_01j8root/fixer-templates",
    "base_commit": "a1b2c3d4",
    "wake_mode": "mentions",
    "channels": ["main"],
    "wait_since": 20,
    "last_read_seq": 20,
    "last_nudged_seq": 20,
    "last_park_blocked_seq": 16,
    "last_post_seq": 19,
    "killed": false,
    "created_at": "2026-11-22T19:20:00.000Z"
  }
}
```

* **五个关键楼层游标（4 个核心游标 + 1 个发帖游标）**：
  1. `last_read_seq`：成员调用 `read_board` **实际读到**的最大楼层号。
     * **反开局噪音初始化规则**：在 `swarm_add` 批量建人时，如果 Coordinator 连续发了 `#1`、`#2`、`#3` 三份 Brief，新成员 `template-dom` 启动时自己的 Brief（`#2`）已经直接塞进它的首条 prompt，因此它的 `last_read_seq` 直接初始化为当时黑板最新楼层（如 `3`），**跳过别人的几千字 Brief 噪音**！
  2. `wait_since`：成员调用 `swarm_wait({ since })` 时传入的楼层号（**强校验要求 `since <= last_read_seq`**，禁止传黑板最新 `headSeq` 跳过忙活期间冒出的新帖！）。
  3. `last_nudged_seq`：系统向该成员会话注入 `[board] the latest message is #N` 催读提醒的最新楼层号（保证同一楼层绝不重复催读）。
  4. `last_park_blocked_seq`：该成员最近一次调 `swarm_wait` 或结束 Turn 时，被 Stop Hook 拦截在闸机内时的黑板楼层号。
  5. `last_post_seq`：该成员自己发帖的最新楼层号。`@monitor` 判断“被 `@` 后有没有响应”**只认 `last_post_seq` 是否大于被点名楼层**，不看 `wait_since`（因为失败的回合也可能推进 `wait_since`）。
* **名字永久墓碑锁（Immutable Name Tombstone）**：
  * 被 `kill` 的成员保留在 `members.json` 中，标记 `"killed": true, "phase": "KILLED", "desired_state": "KILLED"`。
  * **任何曾出现在 `members.json` 中的 key 永久不可复用**（例如 `monitor` 被 kill 后，第二波必须叫 `monitor-2`，否则 `swarm_add` 直接报错提示顺延命名）。

#### 4. `plan.json`（静态战情规划表 —— 彻底替代烧钱的常驻 Narrator）
由 Coordinator 通过 `swarm_plan` 工具在开局和波次切换时更新（硬限 `<= 64 KB`，Schema 校验不通过则保留上一版有效缓存）：

```json
{
  "version": 1,
  "goal": "解决 PDF 导出复制文字乱码、缺字与文本顺序颠倒问题，并通过 6 套模板在线/断网双环境回归测试",
  "current_wave": 2,
  "waves": [
    {
      "wave": 1,
      "title": "第 1 波：只读分头排查与实测复现",
      "status": "COMPLETED",
      "members": ["pdf-pipeline", "template-dom", "verifier", "monitor"],
      "summary_seq": 8
    },
    {
      "wave": 2,
      "title": "第 2 波：模板与导出脚本并行修复 + 联调验收",
      "status": "IN_PROGRESS",
      "members": ["fixer-templates", "fixer-code", "verifier-fix", "monitor-2"]
    }
  ],
  "tracks": [
    { "name": "HTML 模板与打印样式", "owner": "fixer-templates", "status": "IN_PROGRESS", "evidence_seqs": [5, 19] },
    { "name": "PDF 导出链路与校验脚本", "owner": "fixer-code", "status": "IN_PROGRESS", "evidence_seqs": [6, 16, 22] },
    { "name": "6 模板真机交叉验收", "owner": "verifier-fix", "status": "IN_PROGRESS", "evidence_seqs": [7, 21, 23] }
  ]
}
```

---

## 三、核心运行机制详解（1:1 映射到 DSH 原生 Seam）

### 3.1 零空转 + 不漏消息三件套

#### 1. `swarm_wait` 立即终结当前 Turn（0 Token 待机）
当成员调用 `swarm_wait({ since: 10, mentions_only: true })` 时：
1. **游标强校验**：检查 `since <= member.last_read_seq`。若 `since > member.last_read_seq`，拒绝休眠并返回纠错提示：
   `"[TOOL_FORMAT_ERROR] since (12) > your last_read_seq (10). You have unread posts #11..#12! Call read_board({ since: 10 }) first."`
2. **原子检查未读匹配帖**：在黑板读写锁内扫描 `seq > since` 的帖子：
   * 若存在满足唤醒条件的帖子（`mentions_only: true` 时命中 `@<name>` / `@<group>` / `@#<subscribed_channel>` / `@all`；`mentions_only: false` 时任意新帖）：
     * **不休眠**！直接把这些新帖格式化作为工具返回值返回，同时更新 `last_read_seq = headSeq`，让模型在同一回合继续处理。
   * 若不存在新匹配帖：
     * 更新 `members.json`：`wake_mode = mentions_only ? "mentions" : "anything"`, `wait_since = since`。
     * 调用 DSH 工具上下文的 **`exec.concludeTurn()`**（[docs/subsystems/tools.zh.md#L244](file:///mnt/c/portable_software/dsh/deepseek-harness/docs/subsystems/tools.zh.md#L244)），返回 `{ status: "DONE", parked_at_seq: since }`。
     * DSH `agent-loop` 收到 `concludesTurn` 标记后，**不再发起下一次 LLM 请求**，直接推进到回合收尾。

#### 2. Stop Hook 竞态锁（挂钩 DSH `agent/turn-stopping`）
在 [packages/core/agent-loop/src/agent.ts#L360](file:///mnt/c/portable_software/dsh/deepseek-harness/packages/core/agent-loop/src/agent.ts#L360) 中，DSH 的循环逻辑是：
```ts
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial('agent/turn-stopping', { turn, signal })
  signal.throwIfAborted()
}
if (turnEnds && this.inbox.nextStep.length === 0) break
target = 'next-step'
```
我们的 `stop-hook.ts` 监听 `agent/turn-stopping`：
1. **防“刚闭眼新帖到”竞态（Park Block）**：
   * 检查当前结束 Turn 的 Agent 是否属于活跃 Swarm 成员。
   * 在黑板锁内检查是否存在 `seq > Math.max(member.last_read_seq, member.wait_since)` 且匹配该成员唤醒条件的新帖。
   * 若存在（例如刚调完 `swarm_wait(10)`，第 65~67 步之间 `#11` 落盘了）：
     * 更新 `members.json[name].last_park_blocked_seq = headSeq`，`wake_mode = "working"`。
     * 调用 `agent.steer(createSystemSteerMessage("Stop hook blocked termination: [board] new messages arrived (#11); call read_board before waiting again."))`。
     * 这会把消息塞进 `agent.inbox.nextStep`，使 `this.inbox.nextStep.length > 0`，DSH 循环**立刻取消 break**，无缝进入下一 Step！
2. **防 `glm5.3` / `deepseek4.1f` “干完活忘发帖/忘休眠就结束回合”护栏**：
   * 如果一个 `worker` 或 `verifier` 在本轮 Turn 中没有调用 `swarm_wait` 就自然结束了文本输出（且自上次被唤醒以来 `last_post_seq` 没有增加，同回合拦截次数 `< 2`）：
     * Stop Hook 同样通过 `agent.steer(...)` 拦住它：
       `"Stop hook blocked termination: You did not call post_board to report your progress or swarm_wait to go to sleep. In Swarm mode, you MUST post your result with @verifier/@coordinator and then call swarm_wait({ since: <last_read_seq> })."`

#### 3. 唤醒路由与 `statusOf()` 真实判活（不盲信登记簿）
* **事件唤醒**：当 `post_board` 写入新帖 `#N` 时，解析点名目标集合（单人 `@name`、分片组 `@group`、频道 `@#channel`、全员 `@all`，以及任何处于 `wake_mode === "anything"` 的成员）。
  * 对当时**空闲（`agent.status === 'idle'`）**的目标成员：构造唤醒消息 `"[board] New message #N from @<author> mentioned you. Call read_board({ since: <last_read_seq> }) to read and respond."`，更新 `last_nudged_seq = N`，调用 `agent.steer(msg)` 唤醒它。
  * 对当时**正在忙（`agent.status === 'running'`）**的目标成员：只记录待读状态（或通过 `agent.inject()` 非唤醒注入一行提示 `"[board] the latest message is #N"` 并更新 `last_nudged_seq = N`），等它忙完准备 `swarm_wait` 时由 Stop Hook 兜底拦住。
* **真实判活 `statusOf(member)`**：
  * 前端与 `@monitor` 绝不盲信 `members.json` 里的 `wake_mode`（因为用户可能直接私聊唤醒了它，或后台命令刚回调）。
  * `statusOf()` 直接综合三处实时真源：
    1. `member.killed === true` → `'killed'`
    2. `ConcurrencyGate.isQueued(member.session_id)` → `'queued_for_llm'`（附带排队序号 `#k`）
    3. `liveAgent?.status === 'running'` 或其 Session 日志最后一个事件不是已结算的 `turn/end` / 包含 `swarm_wait -> DONE` 的结尾 → `'working'`（并从 Session 最新的 `tool/call` 事件提取当前动作摘要，如 `bash: pytest tests/pdf` 或 `read_file: templates/a.html`）。
    4. 其余情况 → `'waiting'`。

---

### 3.2 温和并发控制网关（`ConcurrencyGate` —— 保护公司共享集群）

因为公司内部 `glm5.3` / `deepseek4.1f` 只有 `4 ~ 6` 并发且多团队共享，并发控制遵循**“主动询问 + 严格上限 + 礼貌间隔 + 429 自适应退避”**四原则：

1. **全局 `llm/stream` 瀑布流闸门**：
   * 拦截 `ctx.on('llm/stream', (options, next) => ...)`。
   * 维护当前 Swarm 的 `activePermits` 与 `configuredLimit`（取自用户开局确认的 `swarm.json.concurrency_limit`，范围 `1..6`，未确认前默认 `2`）。
2. **四级优先级队列（确保主会话永远不卡顿）**：
   * `P0`：主会话（Coordinator）及用户手动打开的任何单聊会话。
   * `P1`：`@verifier`（优先让验收跑完闭环，尽快释放前序 Worker）。
   * `P2`：`@worker`（同级之间按 **Least-Recently-Served 公平轮转**，防止某一个 Worker 连续调 10 次小工具霸占并发槽）。
   * `P3`：`@monitor`（最低优先级，绝不跟干活的人抢槽位）。
3. **礼貌请求间隔（Polite Pacing）**：
   * 相邻两次获得并发槽并发往公司模型网关的请求之间，强制保持 `minRequestSpacingMs = 250ms` 微间隔，避免同一毫秒内 4 个 Worker 同时并发打爆公司 vLLM/SGLang 网关的 prefill 队列。
4. **429 / 并发超限自愈（AIMD + 自动模型热切建议）**：
   * 若公司网关返回 429 或并发拒绝错误：
     * `ConcurrencyGate` 自动将 `effectiveLimit = Math.max(1, effectiveLimit - 1)`，挂起队列 `3~8s`（带随机抖动），并通过 `agent/request-error` 返回 `{ kind: 'retry' }` 透明重试（最多 5 次）。
     * 若某个模型（如 `deepseek4.1f`）连续 3 次撞并发墙或超时，`members.json` 保留 `desired_model` 与 `applied_model`，Coordinator 或用户可一键调 `swarm_model` 将等待中的成员热切到备选模型（如 `glm5.3`），**保留完整对话历史原地续跑**。

---

### 3.3 反死锁巡检员 `@monitor`（含自休眠与 `last_post_seq` 精准判据）

完全复刻逆向文章中的精巧设计，并加上**“并发排队感知”**：

1. **独立后台定时器（不阻塞主会话）**：
   * 在 Host 侧启动一个 `every = 180_000ms`（3 分钟）的后台定时器（对应文章中 `IsDaemon: true` 的 `*/3 * * * *`）。
2. **Host 侧零 Token 预筛（5 类死锁判据）**：
   每 3 分钟先由确定性 TypeScript 代码扫描 `board.jsonl`、`members.json` 与 `ConcurrencyGate`：
   * **排除正常忙碌**：如果有任何成员处于 `working`（正在跑工具或 LLM 流式输出），或者在 `ConcurrencyGate` 里**排队等待并发槽**（`queued_for_llm`），说明团队正在正常推进，**本轮巡检直接跳过（0 Token）**！
   * 当全员都不在 `working` 也不在 `queued_for_llm`，且 `swarm.json.status === 'ACTIVE'` 时，检查以下 **5 种卡死形态**：
     1. **交卷忘点名（Orphan Report）**：某 Worker 最新一条帖子不是 `[done]`，也没有 `@` 任何人，随后自己进入了 `waiting`。
     2. **Coordinator 未读积压**：有成员 `@coordinator` 汇报或提问（`seq > coordinator.last_read_seq`），且 Coordinator 超过 3 分钟处于 `waiting`。
     3. **被点名却静默挂掉（Mentioned but Silent）**：某成员在 `#M` 被 `@`，但它的 **`last_post_seq < M`**（**注意：看 `last_post_seq` 而不是 `wait_since`！** 因为失败的回合也会推进 `wait_since`），且当前已不在运行。
     4. **环状互等（Circular Wait）**：A 最后发帖等 B，B 最后发帖等 A，双方都停在 `waiting`。
     5. **全员空等（All Idle No Action）**：所有活跃成员都在 `waiting`，且没有任何未处理的 `@`。
3. **防刷屏与自休眠机制**：
   * **同一死锁最多提醒 3 次**：记录 `stall_signature = "${kind}:${target}:${seq}"`，同一签名达到 3 次后直接升级 `@coordinator` 要求人工或换模型，不再无限刷屏。
   * **连续 5 轮（15 分钟）无进展或收到 `[done]` 自动休眠**：停掉 3 分钟定时器，将 `@monitor` 切为 `wake_mode: "anything"` 彻底零耗电挂起；一旦 `board.jsonl` 之后冒出新帖（或有人发 `@monitor resume`），Host 自动重启 3 分钟定时器。

---

### 3.4 针对 `glm5.3` / `deepseek4.1f` 的强格式校验器（`validators.ts`）

因为这两个模型遵循复杂格式的能力较弱，**绝不能只靠 Prompt 祈祷模型不犯错**，必须在每个 Tool 的 `execute()` 入口做硬性代码拦截，且**报错信息必须包含可直接照抄的修正模板**（返回 `isError: true` 的结构化纠错指引）：

| 工具名 | 强制校验规则（违反即拦截并返回修正示例） | 拦截后返回给模型的自愈提示模板 |
| :--- | :--- | :--- |
| **`swarm_add`** | ① `swarm.json.concurrency_confirmed` 必须为 `true`（否则拒绝并强制先调 `ask_user_question`）；<br>② `name` 必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` 且长度 `<= 24`，不得为 `all` / `main` / `coordinator`；<br>③ `name` **不得存在于 `members.json` 历史中**（含已 `killed` 的成员）；<br>④ `brief` 必须非空，且**必须包含三个显式标签**：`[OWNERSHIP]`、`[FORBIDDEN]`、`[DONE_CRITERIA]`；<br>⑤ 当前存活（非 killed、非 monitor）成员数不得超过 `concurrency_limit + 2`。 | `[FORMAT_ERROR: swarm_add] 原因: ${reason}。\n请立即按以下标准 JSON 格式重新调用 swarm_add：\n{\n  "name": "${suggestedName}",\n  "role": "worker",\n  "workspace": "inherit",\n  "brief": "[OWNERSHIP] 负责的文件或模块\\n[FORBIDDEN] 禁止修改的文件\\n[DONE_CRITERIA] 验收命令与完成标准"\n}` |
| **`post_board`** | ① `text` 去空白后长度必须在 `10..4000` 字符之间（超过 4000 字符拒绝，强制要求把长日志存文件或引用 `#seq`）；<br>② 禁止在 `text` 中出现 `@#main`；<br>③ 若调用方 `role === 'worker'` 或 `'verifier'`，正文中或 `mentions` 数组里**必须至少包含一个有效点名**（`@coordinator`、`@<active_member>`、`@<group>` 或 `@#<channel>`），严禁发“无头帖”！<br>④ 所有 `@target` 必须在 `members.json` 中存在且 `killed === false`（若点了一个已 `killed` 的人，直接报错并列出当前存活名单！）。 | `[FORMAT_ERROR: post_board] 原因: ${reason}。\n当前存活可点名成员: ${activeNames.join(', ')}。\n请修正后重新调用 post_board，示例：\n{\n  "mentions": ["verifier"],\n  "refs": [${lastReadSeq}],\n  "text": "已完成排查（基于 #${lastReadSeq}），修改了 xxx，实测输出如下... 请 @verifier 核验。"\n}` |
| **`read_board`** | ① `since` 必须是非负整数；<br>② 自动返回 `(since ?? member.last_read_seq)` 之后、且属于该成员当前订阅频道的帖子，并将 `member.last_read_seq` 推进到返回的最大 `seq`。 | N/A（自动容错：若模型传了字符串 `"5"`，在校验层提示或严格要求 integer） |
| **`swarm_wait`** | ① `since` 必填且为整数；<br>② **`since` 必须 `<= member.last_read_seq`**（防止模型偷懒瞎填一个大数字漏掉未读帖）；<br>③ 调用方在本次唤醒周期内如果是被 `@` 叫醒的，必须至少调过一次 `post_board` 回复（除非显式传 `no_reply_needed: true`）。 | `[FORMAT_ERROR: swarm_wait] 你传入的 since=${since} 大于你实际读过的最新楼层 last_read_seq=${lastReadSeq}（当前黑板最新为 #${headSeq}）。\n你必须先调用 read_board({"since": ${lastReadSeq}}) 阅读新帖，处理完后再调用 swarm_wait({"since": ${headSeq}})。` |
| **`swarm_plan`** | ① `goal` 非空；<br>② `waves` 与 `tracks` 数组结构合法，且 JSON 序列化体积 `<= 65536` 字节。 | `[FORMAT_ERROR: swarm_plan] plan.json 格式不合法: ${reason}。请参考标准结构传参。` |
| **`swarm_kill`** | ① 目标成员必须存在且未 killed；<br>② 权限校验：Coordinator 可 kill 任何人，Worker 只能 kill `parent === caller.name` 的帮手；<br>③ **Worktree 安全锁**：若目标成员 `workspace_mode === 'share' \| 'branch'` 且其 worktree 下有未提交/未合并改动，且未传 `force: true`，**拒绝 kill**！ | `[SAFETY_BLOCK: swarm_kill] 成员 @${target} 的独立工作区 (${worktreePath}) 还有未合并的修改！直接 kill 会永久删除其工作区。\n请先调用 swarm_land({"name": "${target}", "action": "apply"}) 合并代码，或确认废弃后传 {"name": "${target}", "force": true}。` |

---

## 四、面向 `glm5.3` / `deepseek4.1f` 的完整详尽提示词（Prompts SOP）

> 以下提示词将写入 `src/host/prompts.ts`，在对应角色会话启动时通过 `agent.ctx.systemPrompt.section()` 注入。针对 `glm5.3` / `deepseek4.1f` 的特点，采用**强编号指令 + 必填模板 + 严禁事项 + 工具调用完整示例**。

### 4.1 Coordinator（主会话协调者）完整系统提示词

```markdown
# [SWARM MODE: COORDINATOR (主协调者操作规程)]

你当前处于 **Swarm 协调者（Coordinator）** 模式。你的唯一职责是：**确认并发预算 -> 制定波次计划 -> 拆解无冲突的任务书（Brief） -> 监控黑板与合并代码 -> 向用户汇报**。

## ⛔ 四条绝对禁令（违反将导致系统拦截）
1. **禁止未问并发就建人**：在调用 `swarm_add` 创建任何成员前，你**必须**先调用 `ask_user_question` 询问用户本次允许的并发上限（2 / 3 / 4 / 6），再调用 `swarm_init` 写入并发配置。
2. **禁止亲自写业务代码**：你绝不能自己去改业务代码或跑耗时排查脚本！所有具体排查、写代码、跑测试的活，全部通过 `swarm_add` 派给 Worker 和 Verifier。
3. **禁止当传话筒复制长文本**：严禁把成员 A 的排查报告复制粘贴转给成员 B！黑板是全员共享的，一律用楼层号 `#5`、`#6` 引用（例如：“请 `@verifier` 对照 `#5` 和 `#6` 的结论跑回归测试”）。
4. **禁止复用已销毁（killed）的成员名**：被 `swarm_kill` 移除的名字永久锁死。开启第 2 波时，必须使用新名字（如 `fixer-code`、`verifier-fix`、`monitor-2`）。

---

## 📋 标准执行 SOP（严格按步骤 1 -> 6 执行）

### 步骤 1：询问并发数与模型分配（Phase 0 必做！）
收到 `/swarm` 任务后，立刻调用 `ask_user_question`：
```json
{
  "questions": [
    {
      "id": "concurrency",
      "header": "并发限额",
      "question": "公司内部模型并发资源有限，本次 Swarm 允许同时占用几个并发槽位？",
      "options": [
        { "label": "2 并发 (Recommended)", "description": "温和共享模式：最多 2 个 Agent 同时请求模型，完全不影响团队他人" },
        { "label": "3 并发", "description": "均衡模式：适合 2 个 Worker + 1 个 Verifier 并行" },
        { "label": "4 并发", "description": "标准模式：适合跨 3~4 个独立模块的排查与修复" },
        { "label": "6 并发", "description": "满载模式：仅在确认集群空闲时使用" }
      ]
    },
    {
      "id": "model_plan",
      "header": "模型选择",
      "question": "本次 Swarm 成员使用哪个内部模型？",
      "options": [
        { "label": "混搭: 协调/巡检用 glm5.3，干活/验收用 deepseek4.1f (Recommended)", "description": "兼顾响应速度与代码推理质量" },
        { "label": "全员 deepseek4.1f", "description": "全部成员统一使用 deepseek4.1f" },
        { "label": "全员 glm5.3", "description": "全部成员统一使用 glm5.3" }
      ]
    }
  ]
}
```

### 步骤 2：初始化黑板与战情表（`swarm_init` + `swarm_plan`）
拿到用户回答后：
1. 调用 `swarm_init`：设置 `title`、`concurrency_limit`、`default_model`（系统会自动创建 `swarm.json`、`board.jsonl`、`members.json` 并挂载后台 `@monitor`）。
2. 调用 `swarm_plan`：写入 `plan.json`，把任务划分为清晰的波次（推荐：**第 1 波只读排查** -> 清场 -> **第 2 波并行修复与真机验收**）。

### 步骤 3：派发成员与结构化 Brief（`swarm_add`）
* **控制并发规模**：同一波活跃的 Worker + Verifier 总数尽量 `<= concurrency_limit + 1`，不要一口气拉起七八个人排队干等。
* **读写分离与工作区选择**：
  * 只读排查成员、只查不改的 `@verifier`：一律传 `"workspace": "inherit"`。
  * 需要同时修改代码的多个作者：如果改的是完全不同的文件，可用 `"inherit"`；如果可能跑构建/测试互相影响，传 `"workspace": "share"`（独立 git worktree 副本）。
* **Brief 必填三段式格式**（缺少任一标签会被工具拒绝）：
  ```json
  {
    "name": "pdf-pipeline",
    "role": "worker",
    "workspace": "inherit",
    "model": "deepseek4.1f",
    "brief": "[OWNERSHIP]\n仅负责排查 tools/pdf-export.js 与 src/fonts/ 下的字体加载和字形映射逻辑。\n[FORBIDDEN]\n严禁修改任何文件；严禁触碰 templates/ 目录。\n[DONE_CRITERIA]\n定位乱码与缺字根因，给出具体函数名、行号及最小复现命令输出，发帖汇报并点名 @verifier 与 @coordinator。"
  }
  ```
* **每 2~3 个 Worker 必须配 1 个 `role: "verifier"` 的验收员**！

### 步骤 4：挂起等待汇报（`swarm_wait`）
本波所有成员添加完毕、且向用户简要说明分工后，调用 `read_board` 确认当前最新楼层 `N`，然后调用：
```json
{ "since": N, "mentions_only": true }
```
进入 0 Token 休眠。当 Worker / Verifier / Monitor 在黑板上 `@coordinator` 时，系统会自动唤醒你。

### 步骤 5：波次交接与清场（Kill & Next Wave）
被唤醒后，第一步**永远先调 `read_board`**：
* 若第 1 波排查结束、`@verifier` 已核实证据：
  1. 在黑板发一条阶段小结帖；
  2. 对第 1 波所有已完成的成员依次调用 `swarm_kill` 清场；
  3. 调用 `swarm_plan` 开启第 2 波，用**全新名字**（如 `fixer-code`、`fixer-templates`、`verifier-fix`）调用 `swarm_add`，并在 Brief 中用 `#5`、`#7` 引用第 1 波的证据楼层！

### 步骤 6：合并代码、最终验收与 `[done]` 收官
* 当使用 `"workspace": "share"` 的 Worker 完成修复并通过 `@verifier` 验收后：
  1. 先调用 `swarm_land({ "name": "fixer-code", "action": "diff" })` 检查改动；
  2. 再调用 `swarm_land({ "name": "fixer-code", "action": "apply" })` 将改动合并回主工作区；
  3. 合并成功后再调用 `swarm_kill({ "name": "fixer-code" })` 销毁其临时工作区。
* 全部任务验证通过后，调用 `post_board` 发送包含 `[done]` 的结案帖，清理剩余成员，并向用户输出最终总结报告。
```

---

### 4.2 Worker（一线执行成员）完整系统提示词

```markdown
# [SWARM MODE: WORKER (@{{MEMBER_NAME}} 操作规程)]

你是 Swarm 团队的执行成员 **`@{{MEMBER_NAME}}`**（所属组：`{{GROUP_NAME}}`，工作区模式：`{{WORKSPACE_MODE}}`，工作目录：`{{CWD}}`）。

## 📌 你的专属任务书（Brief）
{{MEMBER_BRIEF}}

---

## ⛔ 五条铁律（违反将被系统拦截报错）
1. **严禁越界修改**：你只能修改 `[OWNERSHIP]` 允许的文件，绝对禁止触碰 `[FORBIDDEN]` 列出的文件！
2. **禁止不点名发帖**：你每次调用 `post_board` 发帖，必须在 `mentions` 中填入目标名字（如 `["verifier"]` 或 `["coordinator"]`），并在正文中写明 `@verifier` 或 `@coordinator`。每次 `@` 都会消耗对方一整轮模型推理，**不要无脑抄送无关人员**！
3. **禁止复制粘贴长日志**：引用前人结论一律写楼层号（如 `基于 #5 的排查结论`）。贴测试输出只贴关键报错行与统计摘要（正文严禁超过 4000 字符）。
4. **禁止尝试调用子代理或生图/浏览器子代理**：Worker 会话没有创建普通 subagent 的权限。如果遇到环境缺失、目录不对或需要主会话协助，立即发帖 `@coordinator` 说明阻塞原因。
5. **干完活必须调 `swarm_wait` 休眠**：发完汇报帖后，你的最后一步工具调用**必须是 `swarm_wait({"since": <你刚读到的最新楼层号>})`**！如果不调 `swarm_wait` 就结束回复，系统的 Stop Hook 会把你硬拦回来。

---

## 🔄 标准工作循环（每次被唤醒必须严格按 1 -> 2 -> 3 -> 4 执行）

### 第 1 步：先读黑板（`read_board`）
每次开始或被唤醒时，先调用 `read_board` 读取未读消息（特别是 `@verifier` 打回给你的返工意见或 `@coordinator` 的最新指示）：
```json
{ "since": {{LAST_READ_SEQ}} }
```

### 第 2 步：在边界内干活与本地自测
* 使用文件读写与终端工具完成 `[OWNERSHIP]` 内的排查或代码修改。
* 修改代码后，**必须自己先跑一遍相关单测或校验命令**，确认没有语法错误再交卷。
* 如果是前端视觉改动且生成了截图，发帖时按固定格式附上：`Screenshot: <图片路径> | <一句话改动说明>`。

### 第 3 步：上黑板交卷或提问（`post_board`）
* **正常交卷（点名验收员）**：
  ```json
  {
    "mentions": ["{{VERIFIER_NAME}}"],
    "refs": [{{BRIEF_SEQ}}],
    "kind": "report",
    "text": "已完成 #{{BRIEF_SEQ}} 任务。\n1. 根因/修改文件：...\n2. 自测命令与输出：...\n请 @{{VERIFIER_NAME}} 交叉核验。"
  }
  ```
* **遇到阻塞（点名协调者）**：
  ```json
  {
    "mentions": ["coordinator"],
    "refs": [{{BRIEF_SEQ}}],
    "kind": "question",
    "text": "@coordinator 执行 #{{BRIEF_SEQ}} 时发现目录 xxx 缺失导致测试路径不匹配，请确认是否需要先恢复目录。"
  }
  ```

### 第 4 步：立即挂起休眠（`swarm_wait`）
发帖成功后，`post_board` 会返回当前黑板最新楼层号 `latest_seq`（假设为 `16`）。你必须紧接着调用：
```json
{
  "since": 16,
  "mentions_only": true
}
```
等待 `@verifier` 的验收结果或 `@coordinator` 的下一步指令。当工具返回 `DONE` 后，不要再输出任何多余废话。
```

---

### 4.3 Verifier（对抗式独立验收员）完整系统提示词

```markdown
# [SWARM MODE: VERIFIER (@{{MEMBER_NAME}} 独立验收规程)]

你是 Swarm 团队的**独立对抗式验收员 `@{{MEMBER_NAME}}`**。
你的唯一职责是：**拿真实命令、真实样本、真实测试去检验 Worker 交上来的结论或代码修改**。

## ⛔ 三条验收铁律
1. **只查不改（Read & Test Only）**：你绝不替 Worker 修业务代码！发现任何 bug、漏改、伪造测试通过、或校验脚本误杀，**直接在黑板上 `@对应worker` 贴出报错行号打回返工**，从源头避免两个人同时改同一份文件。
2. **点对点打回，不打扰 `@coordinator`**：
   * 验收**未通过**时：**直接 `@<作者名字>`** 打回返工，**不要** `@coordinator`！
   * 只有当所有关联 Worker 的成果都**实测通过**（或连续打回 3 次仍无法收敛）时，才发帖 **`@coordinator`** 汇总签收！
3. **眼见为实，拒绝轻信**：绝不能只看 Worker 帖子里的文字描述就说“审核通过”。你必须亲自调用 `swarm_land({"name": "<worker>", "action": "diff"})`（或 `git diff`）阅读真实代码 Diff，并亲自在终端运行测试命令！

---

## 🔄 标准验收循环（1 -> 2 -> 3 -> 4）

### 第 1 步：读取黑板新证据（`read_board`）
被 `@` 唤醒后，立即调用 `read_board` 读取 Worker 提交的报告楼层（例如 `#5`、`#6` 或 `#16`），同时对照 `#1`、`#2` 的原始 Brief 要求。

### 第 2 步：独立复测与交叉审查
1. 检查代码 Diff：确认 Worker 没有越界修改 `[FORBIDDEN]` 文件，没有删减原有测试断言。
2. 运行真实测试 / 复现脚本：验证正常路径与边界条件（如中英混排、断网/在线双环境、空输入等）。

### 第 3 步：在黑板给出明确裁决（`post_board`）
* **情况 A：发现问题 -> 直接点名作者打回返工（不抄送 Coordinator）**
  ```json
  {
    "mentions": ["fixer-code"],
    "refs": [16],
    "kind": "review",
    "text": "@fixer-code 复测 #16 未通过！\n问题位置：tools/validate.py:142 在中英混排字体切换处会把伪空格误判为失败。\n复现命令：`pytest tests/test_mixed_lang.py`\n报错输出：`AssertionError: unexpected space at pos 18`\n请修复并补充单测后再 @{{MEMBER_NAME}} 复测。"
  }
  ```
* **情况 B：全部实测通过 -> 点名 Coordinator 签收**
  ```json
  {
    "mentions": ["coordinator"],
    "refs": [16, 19, 22],
    "kind": "review",
    "text": "@coordinator 已完成全部实测核验（基于 #16, #19, #22）：\n1. 代码 Diff 核查无越界、无弱化断言；\n2. 实测命令 `pytest` 24/24 全部通过；\n3. 6 套模板产物核验无乱码缺字。\n可以合并收官。"
  }
  ```

### 第 4 步：立即挂起休眠（`swarm_wait`）
用最新楼层号调用 `swarm_wait({ "since": <latest_seq>, "mentions_only": true })` 进入休眠。
```

---

### 4.4 Monitor（后台反死锁巡检员）完整系统提示词

```markdown
# [SWARM MODE: MONITOR (@{{MEMBER_NAME}} 巡检员规程)]

你是后台反死锁巡检员 **`@{{MEMBER_NAME}}`**。平时你处于休眠状态；只有当后台巡检定时器检测到**全组既无人正在运行工具/请求模型、也无人在并发队列排队，但黑板长时间停滞且未发出 `[done]`** 时，才会唤醒你。

## 🔍 五类死锁诊断表（按顺序排查）
被唤醒后，先调用 `read_board` 与 `swarm_status` 查看最新帖子与各成员的 `last_post_seq` / `last_read_seq`：
1. **交卷漏 `@`**：最后一个发帖的 Worker 贴了结果却没 `@verifier` 或 `@coordinator` -> 发帖点名 `@verifier`（或 `@coordinator`）接手该楼层。
2. **被 `@` 却静默（`last_post_seq < 被点名楼层`）**：某成员在 `#M` 被点名，但它的 `last_post_seq < M` 且当前处于 `waiting` -> 发帖 `@<该成员> [stall] 你在 #M 被点名但尚未回复，请调用 read_board 推进或说明阻塞原因`。
3. **Coordinator 未读积压**：`coordinator.last_read_seq < 最新发给 coordinator 的楼层` -> 发帖 `@coordinator [stall] 成员已在 #N 完成汇报，请查阅并推进下一阶段（或检查等待中的成员是否需要收尾）`。
4. **环状互等**：两个成员互相等待对方先改 -> 发帖 `@coordinator [stall]` 请求主协调者拍板裁决顺序。
5. **模型卡死或异常中断**：若同一成员已被你催醒 2 次仍无反应 -> 第 3 次直接发帖 `@coordinator [stall] @<成员> 连续催醒无响应，可能发生异常或模型卡死，建议检查 git status 或调用 swarm_model / 重启新成员接替`。

## ⛔ 巡检纪律
* 帖子正文必须简短精准，以 `[stall]` 开头，**只 `@` 那个能解开当前僵局的唯一责任人**，严禁 `@all`！
* 发完催醒帖后，立刻调用 `swarm_wait({ "since": <latest_seq>, "mentions_only": true })` 回到休眠。
```

---

## 五、Worktree 隔离与脏工作区同步设计（`worktree.ts`）

针对并行修改代码时的文件冲突，提供三种 `workspace_mode`：

1. **`inherit`（默认，零开销）**：
   * 成员 `cwd` 直接指向主会话 `cwd`。用于第 1 波只读排查、全部 `@verifier`、`@monitor`，以及严格按不同文件划分的小修改。
2. **`share`（推荐并行改代码，基于 `git worktree` + 脏状态同步）**：
   * 目标路径：`<DSH_HOME>/swarm-worktrees/<swarmId>/<memberName>`。
   * **解决 `git worktree` 丢未提交改动的经典坑**：
     1. 用 `spawn('git', ['worktree', 'add', '--detach', worktreeDir, 'HEAD'], { cwd: mainCwd, shell: false, windowsHide: true })` 创建共享底层 `.git/objects` 的轻量工作树。
     2. 用 `spawn('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])` 读取主工作区当前所有的 staged、unstaged 和 untracked 改动列表。
     3. 将修改/新增文件按相对路径直接流式复制到 `worktreeDir`，将已删除文件在 `worktreeDir` 中删除。
     4. 在 `worktreeDir` 中创建一个本地临时基线提交（或记录 baseline tree hash `git write-tree`），从而让 `swarm_land({ action: "diff" })` 能**精确算出该 Worker 自己写的净增量 Diff**，不会把用户原有的未提交改动混进去！
3. **`branch`（完全隔离分支克隆）**：
   * 为高风险大改创建独立分支 `swarm/<swarmId>/<memberName>`。
4. **安全销毁锁（Land-First-Kill-Later）**：
   * `swarm_kill` 执行前检查 `git status --porcelain` 与相对基线 tree 的 diff。只要有未通过 `swarm_land({ action: "apply" })` 合并回主工作区的改动，且没有显式传 `force: true`，一律拦截报错，防止误删 Worker 写好的代码。

---

## 六、前端战情看板设计（`client.js` + `hive-view.ts` —— 砍掉 Narrator，纯确定性渲染）

吸取谷歌砍掉常驻 `narrator` 的教训：**绝不养一个常驻 LLM 去写 `view.json` / `view.html`**，全部由 `projection.ts` + 前端 `client.js` 用确定性代码实时合成！

### 6.1 Host → Browser 零核心补丁同步通道
* Host 在 `ctx.root.sessionProjections.register(swarmProjection)` 注册 `swarm` 投影。
* 每当 `board.jsonl`、`members.json`、`plan.json`、`swarm.json` 或 `ConcurrencyGate` 水位发生变化，Host 触发一次轻量投影更新，DSH 的 `api-session-controller` 自动将其增量推送到浏览器的 `ctx.sessions` store。

### 6.2 Classic-Script 浏览器产物规范（防 Combo Parse 崩溃）
`lib/client.js` 严格遵守 [web-plugin-authoring-reference.md](file:///mnt/c/portable_software/dsh/dsh-plugin-guide/web-plugin-authoring-reference.md)：
* 顶层只有唯一一句 `window.__ModuleLoader__.load({ id: 'dsh-swarm', factory: (require) => { ... } })`。
* **零 ESM (`import`/`export`)、零未编译 JSX**，全部使用 `React.createElement` 与平台内置 `@deepseek-ai/dsh-client-ui-primitives` (`StateDot`)。
* `exports.inject = ['slots', 'sessions', 'uiWorkspace']`（绝不注入 `timer` 等 host-only 服务）。

### 6.3 看板四大视图（挂载于 `conversation.session.header.actions` + `shell.overlay`）
1. **顶栏状态胶囊（Header Pill）**：
   * 显示：`🐝 Swarm: <title> · 槽位 2/3 (排队 1) · #24 帖` + 动态 `StateDot`。点击开关右侧 Swarm 面板。
2. **Tab 1 — Overview & Roster（蜂群总览与花名册）**：
   * **并发水位仪表盘**：实时展示 `已用槽位 / 用户设定上限 (2/3)`、排队成员列表、模型分布（`glm5.3` vs `deepseek4.1f`）。
   * **波次进度卡片（来自 `plan.json`）**：渲染当前 Wave、各 Track 负责人与关联证据楼层胶囊（点击 `#5` 直接跳到 Board 第 5 楼）。
   * **成员列表（Active / Waiting / Killed）**：
     * Coordinator 显示皇冠蜂王图标 👑🐝，Working 成员显示绿色闪烁 `StateDot` + **从 Session 日志尾部提取的当前实时工具动作**（如 `Running: pytest tests/...`），Waiting 成员显示休眠游标（`wait_since: #20`, `last_park_blocked: #16`）。
     * 点击任意成员行，调用 `ctx.uiWorkspace.openSession(...)` 直接切进该成员的完整对话上下文，并支持人类直接发私聊纠偏。
   * **Progress Reel（截图对比卷轴）**：自动扫描 `board.jsonl` 中匹配 `Screenshot: <path> | <caption>` 的帖子，渲染前后对比缩略图时间线。
3. **Tab 2 — Board（黑板消息流）**：
   * 渲染每层帖子的 `#seq`、作者徽章、频道标签（`#main` / `#render`）、时间与正文。
   * **自动将正文中的 `#5`、`#16` 渲染为可点击跳转的高亮楼层胶囊**，将 `@name` 渲染为角色颜色胶囊。
   * 未读分割线（`New`）：根据当前查看成员的 `last_read_seq` 动态绘制未读线。
   * 顶部支持按成员双向过滤（某人发的 + `@` 某人的）、按频道过滤、`Follow` 自动滚底开关。
4. **Tab 3 — Graph（`@mention` 拓扑与时间轴回放）**：
   * 纯确定性 SVG 有向图：节点为成员（按 Wave 分上下半圈布局），有向边为 `post_board` 中的 `@mention`，线宽按 `@` 次数加权。
   * 底部配 **Replay 滑块（`#1 ──●─── #24 [Live]`）**：拖动滑块即可按 `1..K` 楼重放当时的激活关系（借助 `channelsAt(K)` 与帖子序列），一眼看清哪一轮发生了 `@verifier -> @fixer` 打回返工！

---

## 七、DSH 启动安全与验证Checklist（对齐 `verification-standards.md` S1–S8）

1. **防 `Config` 启动雷（S3）**：
   * `src/host/index.ts` **不导出 `Config`**（在 `apply(ctx, rawConfig)` 内部做默认值合并与类型检查），从根源杜绝 `resolveConfig` 报 `TypeError: Cannot read properties of undefined (reading 'validate')`。
2. **启动异常隔离（S3）**：
   * `index.js` 顶层只有纯 import 与常量声明，零 I/O、零副作用。
   * `export function apply(ctx, config)` 外层包裹 `try { applyWith(ctx, config) } catch (e) { ctx.logger?.warn(e) }`，确保插件任何非预期异常绝不会让用户的 DSH Web Profile 启动崩溃；同时导出 `export function applyWith(ctx, config)` 供 `tools/boot-check.mjs` 做严格断言。
3. **跨平台无 Shell 进程调用（S7）**：
   * `worktree.ts` 中所有 `git` 命令一律 `spawn('git', [...args], { cwd, shell: false, windowsHide: true })`，严禁拼接命令字符串或 `shell: true`。
4. **必过五步自动化验收脚本（`tools/boot-check.mjs` & `tools/smoke-test.mjs`）**：
   * **Check 1（导出与无 Config 检查）**：`import('./lib/index.js')` 验证 `name === 'dsh-swarm'`、`typeof apply === 'function'`、`Config === undefined`。
   * **Check 2（真实 Cordis 拓扑挂载 + Sibling Dispatch）**：在真实 `@deepseek-ai/cordis` `Context` 中作为 sibling 插件挂载，用 `storeCtx.events.dispatch('emit', [carrier, 'session/event', session, event])` 验证事件监听可达（满足 S1，绝不用 `root.emit` 假绿测试）。
   * **Check 3（Stop Hook 竞态锁实测）**：模拟成员读到 `#10` 后准备结束 Turn，同时往 `board.jsonl` 写入 `#11 (@worker)`，触发 `agent/turn-stopping`，断言：① Turn 未终止（`inbox.nextStep.length === 1`）；② `members.json` 中 `last_park_blocked_seq === 11`。
   * **Check 4（强格式校验自愈测试）**：故意向 `swarm_add` 传已 killed 的名字、向 `post_board` 传无 `@mention` 的正文、向 `swarm_wait` 传 `since > last_read_seq`，断言全部被拦截并返回包含 JSON 示例的 `[FORMAT_ERROR]`。
   * **Check 5（并发闸门与 Classic Script 校验）**：
     * 模拟 `concurrency_limit = 3` 下 6 个 Agent 同时请求 `llm/stream`，断言任意时刻 `inFlight <= 3` 且 P0 Coordinator 永远优先拿槽，AbortSignal 取消排队请求后 `activePermits` 归零无泄漏。
     * 运行 `node --check lib/client.js` 并在沙箱 `window.__ModuleLoader__` 桩下执行，断言成功注册 `id: 'dsh-swarm'` 且 `inject` 不含任何 host-only 服务。
   * **Check 6（Profile 合成验证）**：`dsh --profile web --dump-config` 确认 `dsh-swarm` 正常合成。

---

## 八、分阶段开发交付计划（Implementation Milestones）

* **Phase 1（底座与防呆工具层）**：实现 `store.ts`（四文件原子读写 + `channels.ts`）、`validators.ts`（强格式校验与自愈报错）、`tools.ts`、`prompts.ts`（针对 `glm5.3`/`deepseek4.1f` 的 SOP 提示词）。
* **Phase 2（零空转调度与温和并发闸门）**：实现 `concurrency-gate.ts`（`llm/stream` 拦截 + Phase 0 `ask_user_question` 并发询问强制门禁）、`stop-hook.ts`（`agent/turn-stopping` 竞态锁）、`roster.ts` & `liveness.ts`、`monitor.ts`（3 分钟巡检 + 自休眠）。
* **Phase 3（Worktree 隔离与合并）**：实现 `worktree.ts`（`share` 模式 `git worktree` + 脏工作区同步 + `swarm_land` + `swarm_kill` 未合并保护锁）。
* **Phase 4（Web 战情看板与全链路验收）**：实现 `projection.ts` + `client/hive-view.ts`（Header 胶囊 + Overview/Roster + Board `#seq` 胶囊 + SVG Graph 时间轴回放）+ `tools/boot-check.mjs` & `tools/smoke-test.mjs`。
