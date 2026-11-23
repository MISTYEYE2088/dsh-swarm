# dsh-swarm（中文文档）

[English](README.md) · [中文](README.zh.md) · [完整技术规格书 (SPEC.md)](SPEC.md)

面向 **DeepSeek Harness (`dsh`)** 的树外 **Swarm 多智能体协作插件（`/swarm`）** —— 基于三文件纯文本黑板（`swarm.json`、`board.jsonl`、`members.json`）+ 静态 `plan.json` 战情表、`swarm_wait` 零空转休眠 + Stop-Hook 竞态锁、带脏工作区同步的 Git Worktree 隔离，以及专为**公司内部自部署 `glm5.3` / `deepseek4.1f`（4~6 温和并发、无 Token 限额）**设计的并发闸门与强格式校验器。

## 安装（支持 GitHub 远程一键部署或本地挂载）

任选以下一种方式安装，随后重启 `dsh web`：

```powershell
# 1) GitHub 远程直接安装（零构建步骤、无 prepare 脚本拦截，开箱即用）
pnpm dsh plugin --profile web add https://github.com/MISTYEYE2088/dsh-swarm

# 2) 本地目录安装（开发/自用）
pnpm dsh plugin --profile web add C:\portable_software\dsh\dsh-swarm

# 3) 不启动服务器，直接验证 profile 配置合成结果
pnpm dsh --profile web --dump-config | Select-String 'dsh-swarm'
```

## 核心特性

1. **开局强制询问并发度（Phase 0 门禁）**：Coordinator 在调用 `swarm_add` 建人前被代码级门禁强制要求先调 `ask_user_question`，由用户选择本次并发槽位（`2 / 3 / 4 / 6`，默认推荐 `2` 温和共享模式）与模型混搭方案（`glm5.3` / `deepseek4.1f`）。
2. **温和共享集群并发网关（`ConcurrencyGate`）**：挂载于 DSH `llm/stream` waterfall，实现 `P0(Coordinator) > P1(Verifier) > P2(Worker 公平轮转) > P3(Monitor)` 优先级排队、`200ms` 礼貌请求间隔、`AbortSignal` 取消零槽位泄漏与 HTTP 429 AIMD 动态降速。
3. **三文件黑板底座 + 事件溯源频道**：
   - `swarm.json`：记录 Swarm 元信息、并发预算与状态；
   - `board.jsonl`：只追加流水账，融合普通帖与 `#channel` 的 `type: "control"` 控制帧（通过 `replayChannelsAt` 重放任意历史楼层的可见性）；
   - `members.json`：维护全员名册、双模型字段（`desired_model` / `applied_model` 原地热切）、`killed` 名字永久墓碑锁，以及 5 个楼层游标（`last_read_seq`、`wait_since`、`last_nudged_seq`、`last_park_blocked_seq`、`last_post_seq`）；新成员自动跳过开局其他人的 Brief 噪音；
   - `plan.json`：Coordinator 在开局与波次切换时写入（硬限 ≤ 64 KB），配合前端确定性合成视图，彻底砍掉烧 Token 的常驻 Narrator。
4. **零空转还不漏消息三件套**：
   - `swarm_wait` 校验 `since <= last_read_seq` 后直接调用 `exec.concludeTurn()` 结束当前 Turn，0 Token 待机；
   - 挂载 `agent/turn-stopping` 实现 **Stop Hook 竞态锁**：刚准备休眠时若有新帖落盘，立刻记录 `last_park_blocked_seq` 并 `steer` 阻止回合结束；同时拦截 `glm5.3`/`deepseek4.1f` 干完活忘调 `swarm_wait` 就直接结束回合；
   - `statusOf()` 不盲信 `wake_mode`，直接从 Session 日志尾部工具调用与 `ConcurrencyGate` 排队状态推导真实忙闲。
5. **针对 `glm5.3` / `deepseek4.1f` 的强格式校验与自愈提示**：强制检查三段式 Brief（`[OWNERSHIP]`/`[FORBIDDEN]`/`[DONE_CRITERIA]`）、Worker 发帖必含存活 `@target`、禁发 `@#main`、防跳过未读楼层、防未合并误 `kill` Worktree；任何格式错误直接返回**带正确 JSON 示例的自愈报错**。

## 自动化验证门禁

```bash
node --check index.js && node --check client.js
npm run test:boot      # 在真实 @deepseek-ai/cordis Context 挂载 + sibling session/event 拓扑验证
npm test               # 30 项真实磁盘 / Git Worktree / 并发闸门 / Stop Hook 回归测试
npm run verify:install # npm pack 打包 + 独立临时目录安装门禁（确保远程部署 100% 可用）
```

## 许可

[MIT](LICENSE)。
