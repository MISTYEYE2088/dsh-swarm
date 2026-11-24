# dsh-swarm（中文文档）

[English](README.md) · [中文](README.zh.md) · [更新日志](CHANGELOG.md)

面向 **DeepSeek Harness (`dsh`)** 的树外 **Swarm 多智能体协作插件（`/swarm`）** —— 采用 **2 文件单真相源（SSOT）事件溯源黑板**（`events.jsonl` + `offsets.json`）与每 50 条自动 Checkpoint、**按会话作用域按需解锁工具**（普通对话仅加载 1 个 `swarm_init`）、**零空转 `swarm_wait` + Stop-Hook 竞态锁**、**Git Worktree 隔离**、**内置零 Token 看门狗与合并门禁**，以及右侧栏 **Board / Control / Round Table** 实时可视化界面。

---

## 从 GitHub 一键安装（零构建步骤）

无需 clone 仓库或编译，直接从 GitHub 安装到 DSH 的 `web` profile，然后重启 `dsh web` 并强刷浏览器（`Ctrl+Shift+R`）：

```bash
# 全局安装的 dsh CLI：
dsh plugin --profile web add https://github.com/MISTYEYE2088/dsh-swarm

# 如果从 deepseek-harness 源码仓库运行：
pnpm dsh plugin --profile web add https://github.com/MISTYEYE2088/dsh-swarm
```

启动前可先检查 profile 是否已挂载成功：

```bash
dsh --profile web --dump-config | grep dsh-swarm
# PowerShell: pnpm dsh --profile web --dump-config | Select-String 'dsh-swarm'
```

### 更新与卸载

```bash
# 更新到 GitHub 最新版本
dsh plugin --profile web remove dsh-swarm
dsh plugin --profile web add https://github.com/MISTYEYE2088/dsh-swarm

# 彻底卸载
dsh plugin --profile web remove dsh-swarm
```

*（安装、更新或卸载后请重启 `dsh web`。）*

---

## 快速上手

1. **普通对话零干扰**：插件启动时全局仅注册 1 个入口工具 `swarm_init`，非 Swarm 会话不背负其余 10 个工具的 schema token。
2. **发起 Swarm**：在输入框输入 `/swarm <你的任务>`（或让模型调用 `swarm_init`）：
   ```text
   /swarm 重构鉴权中间件，补齐单元测试，并安排独立 verifier 跑真实回归验证
   ```
   - 调用 `swarm_init` 后，其余 **10 个 Swarm 工具**会自动注册到**当前主会话自己的 `agent.ctx.tools` 作用域**上，不影响其他并发会话。
   - 所有 Agent 的对话历史仍存于 DSH 原生 `~/.dsh/sessions/`；黑板协作状态存于 `~/.dsh/swarm/<sessionId>/`。
3. **打开右侧 Swarm 面板**：点击右上角 **Swarm** 徽标（或切换右侧栏 **Swarm** 标签页）：
   - **Board**：按最新楼层倒序展示，默认折叠为有意义的标题，时间戳右侧提供展开/折叠按钮；支持 `#seq` 楼层跳转、无闪烁静默轮询与新消息 3.2 秒暖黄色高亮动画（`NEW`）。
   - **Control**：纯只读运行态看板，实时展示 Merge Gate `[REJECT]` 阻断项、LLM 并发槽位（`active/limit · queued`）、看门狗状态、Wave/Track 计划、成员名册（含 `Open Session` 直达子会话）与截图进度条。并发槽位统一由 AI 协调者通过 `swarm_concurrency` 管理，杜绝后台改状态导致 AI 不知情。
   - **Round Table**：圆桌 SVG 通信拓扑——最新一轮箭头高亮明黄，历史步骤逐级变暗淡出；`@all` 广播箭头直指圆桌中央；支持按 Kafka 事件 `offset` 与时间戳回放任意波次的精确活跃成员席位。

### 适用与不适用场景
- **适合**：可拆分为写集合互斥的多条并行线、跨模块排障、架构/规范与代码分离实现、高风险改动需要独立 `verifier` 拿真实样本验收。
- **不适合**：单文件小改动或强串行小任务（编排开销大于单 Agent）。

---

## AI 工具清单（按作用域按需解锁）

| 工具名 | 作用域 / 角色 | 职责 |
| --- | --- | --- |
| `swarm_init` | **全局常驻入口**（Coordinator） | 初始化 Swarm、探测 Git 仓库/子目录仓库，并动态解锁当前会话的其余 10 个 Swarm 工具 |
| `swarm_plan` | Coordinator（init 后解锁） | 发布/更新 Wave 与 Track 计划（≤ 64 KB） |
| `swarm_add` | Coordinator（init 后解锁） | 原子创建 `worker` / `architect` / `verifier` / `lore_master`（Git 可用时 `worker` 默认自动启用 `share` 隔离 worktree） |
| `swarm_concurrency` | Coordinator（init 后解锁） | 动态调整在途 LLM 并发请求槽位上限（`limit >= 1`） |
| `swarm_land` | Coordinator（init 后解锁） | 对隔离 worktree 执行 `diff` 或 `apply` 合入主工作区（受 `[REJECT]` 门禁保护） |
| `swarm_kill` | Coordinator（init 后解锁） | 退役成员并清理 worktree（未开工时释放名字复用，已发言则墓碑化保留历史） |
| `post_board` | Coordinator + 子成员 | 发带标题黑板帖，支持 `@mentions`、`kind`、`verdict`（`approve`/`reject`/`override`）、`supersedes`、`escalate`、`silent` |
| `read_board` | Coordinator + 子成员 | 按 `since` / `channel` / `mentions_only` / `kinds` / `include_superseded` / `limit` 读帖并推进游标 |
| `swarm_wait` | Coordinator + 子成员 | 调用 DSH 原生 `exec.concludeTurn()` 实现 0 Token 待机，配合 Stop-Hook 竞态锁防漏消息 |
| `swarm_status` | Coordinator + 子成员 | 查看成员真实活性（`working`/`waiting`/`starting`/`zombie`/`error`）、轮次/工具计数、并发槽位与门禁 |
| `swarm_model` | Coordinator + 子成员 | 原地热切成员 `provider/model` 并保留完整上下文 |

---

## 核心架构

- **2 文件单真相源（SSOT）**：
  - `events.jsonl`：追加写不可变事件流，存储**全部领域事实**（初始化、计划、成员生命周期、模型切换、黑板帖、频道控制帧、结案）。
  - `offsets.json`：仅存储成员**可变消费游标与运行期遥测**（`last_read_seq`、`wait_since`、`wake_mode`、`turn_count`、`last_error` 等），与领域事实零重叠。
- **无状态投影工具类 + 50 条自动 Checkpoint（`src/host/projector.js`）**：每 50 条领域事件自动写入轻量 `state.checkpoint`；每次状态计算自动从**倒数第二新（第二新）**有效 checkpoint 起推，几千条消息仍保持 $O(1)$ 常数级计算开销且天然容错。
- **礼貌并发网关（`ConcurrencyGate`）**：挂载 DSH `llm/stream`，支持优先级排队、请求节流、`AbortSignal` 槽位回收与 HTTP 429 AIMD 自适应退避；适配 DSH 中配置的任意模型路由（`inherit` 或 `provider/model`）。
- **零中文运行态约束**：所有运行时提示词、工具返回与 UI 文案均保持 100% 英文（由自动化测试强制门禁），避免模型因局部中文漂移回复语言。

---

## 兼容性与本地验证

已验证兼容 DeepSeek Harness **`0.2.0-rc.2`**（零构建、无 `prepare` 脚本、零 `peerDependencies`、无 `Config` 导出）：

```bash
node --check index.js && node --check client.js
npm test               # 51 项端到端回归测试（SSOT、Checkpoint、作用域懒加载、UI 防闪烁等）
npm run verify:install # npm pack 打包 + 独立干净目录安装门禁
npm run test:boot      # 真实 @deepseek-ai/cordis 挂载验证（可按需设 DSH_CORDIS_PATH）
```

## 许可

[MIT](LICENSE)
