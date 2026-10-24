# `my-pi-goal` 流程图

> 本页展示业务状态与事件流。验证路径已切换到 Docker Sandboxes；快照、联网和回收细节见 [验证架构](docker-sandboxes-design.md)。

以下按当前 `GoalRuntime`、状态机、验证链路和持久化实现绘制。图中把 `ProjectState` 作为单一业务状态源，Journal、上下文投影和 TUI 都是它的派生视图。

## 1. 运行时与事件流

```mermaid
flowchart TD
  User[用户] -->|"/goal ..."| Command["/goal 命令处理器"]
  Model[模型] -->|"goal_* 工具"| Tool["工具处理器"]
  Host[Pi Host] -->|"session / agent / turn / tool 事件"| Events["GoalRuntime 事件"]

  subgraph Boot["启动与所有权"]
    Start["session_start"] --> Init["init: 加载 settings + journal"]
    Init -->|成功| State[("ProjectState")]
    Init -->|失败| Fault["fault: 通知并停止写入"]
    State --> Own["claim: session / PID / host / token"]
  end

  Command --> Guard["校验 session / revision / generation / owner"]
  Tool --> Guard
  Events --> Guard
  Guard --> State
  State <--> Journal[("ProjectStore<br/>append-only journal + snapshots/patches")]
  State --> Projection["context 投影<br/>当前目标、规则、队列规划"]
  Projection --> Model
  State --> Panel["TUI panel / status / widget"]
  State --> Queue["FIFO 队列<br/>一个 active + 多个 draft/queued"]

  Guard --> Lifecycle["生命周期操作<br/>create / plan / approve / resume<br/>pause / skip / clear"]
  Lifecycle --> Submit["goal_submit"]
  Submit --> Prepare["冻结源码、镜像与批准的检查范围"]
  Prepare --> Checks["microVM 检查<br/>只读或 ephemeral workspace"]
  Checks -->|全部通过| Audit["独立 auditor<br/>只读工具 + 证据核查"]
  Checks -->|环境问题| Env["goal_environment 指引<br/>连续失败则 paused"]
  Checks -->|实现失败| Active["active + 具体反馈"]
  Audit -->|pass| Finalize["核对输入、所有权与回收结果"]
  Finalize -->|有效| Complete["complete"]
  Finalize -->|输入变化| Env
  Finalize -->|清理失败| CleanupPaused["立即 paused + queuePaused"]
  Audit -->|fail| Active
  Audit -->|失败次数超限| Blocked["blocked"]
  Audit -->|预算不足| Budget["budget_limited"]

  Events --> Context["before_agent_start / context<br/>注入当前目标与队列规划"]
  Events --> Input["input<br/>暂停 / 补充 / amend / auto-clear"]
  Events --> Turn["turn_start / tool_execution_end / turn_end<br/>进度指纹、usage、预算"]
  Events --> Settle["agent_before_settle<br/>续跑或推进队列"]
  Events --> Shutdown["session_shutdown / session_before_tree<br/>暂停并释放所有权"]

  Input -->|stop / pause| Paused["paused"]
  Input -->|补充或 amend| Active
  Input -->|complete 且全部 terminal| Clear["下一次输入 auto-clear"]
  Settle -->|队列下一个| Active
  Shutdown --> Paused
```

## 2. Goal 状态机

```mermaid
stateDiagram-v2
  [*] --> draft: /goal &lt;objective&gt; 或 goal_create
  draft --> draft: goal_plan 复杂规格<br/>pendingSpec 等待审批
  draft --> active: 简单目标首次计划自动接受<br/>或 /goal approve 后成为当前目标
  draft --> queued: 审批时已有 active 目标
  queued --> active: /goal resume 或队列推进

  active --> verifying: goal_submit<br/>criteria 有证据且 tasks 全部完成
  verifying --> complete: 审计 pass、输入仍一致、所有权有效且清理成功
  verifying --> active: 审计 fail<br/>或收到新要求
  verifying --> paused: 审计取消 / session close
  verifying --> blocked: 审计失败次数超限
  verifying --> budget_limited: 累计 token 预算耗尽

  active --> paused: /goal pause / goal_wait<br/>session close / branch / 运行中断
  active --> blocked: 审计预算错误<br/>或需要用户输入
  active --> budget_limited: 累计 token 预算耗尽

  paused --> active: /goal resume / goal_resume
  blocked --> active: 解决阻塞后 /goal resume
  budget_limited --> active: /goal budget 后 resume

  draft --> skipped: /goal skip 或 remove
  queued --> skipped: /goal skip 或 remove
  active --> skipped: /goal skip 或 remove
  paused --> skipped: /goal skip 或 remove

  complete --> [*]
  skipped --> [*]
  complete --> cleared: /goal clear<br/>或全部 terminal 后的下一次输入 auto-clear
```

> `cleared` 不是 `GoalStatus`：它会从当前 session 的 `ProjectState` 移除目标，但 journal 保留历史。`queuePaused`、`activeId`、`owner` 和 `pendingSpec` 是与 `status` 正交的运行时字段。

## 3. `goal_submit` 验证链路

```mermaid
flowchart TD
  Submit["goal_submit"] --> Problems{"completionProblems<br/>有缺失证据或未完成任务?"}
  Problems -->|是| Reject["拒绝提交<br/>保持 active"]
  Problems -->|否| Verify["transition: verifying<br/>冻结源码、镜像、环境和批准范围"]

  Verify --> HasChecks{"存在 approved checks?"}
  HasChecks -->|是| NextCheck["取下一个 approved check"]
  HasChecks -->|否| Audit["独立 auditor"]
  NextCheck --> RunCheck["全新 microVM 检查并确认回收"]
  RunCheck -->|退出码 0| More{"还有检查?"}
  More -->|是| NextCheck
  More -->|否| Audit
  RunCheck -->|清理失败| CleanupPaused["立即 paused + queuePaused<br/>保留 cleanup_pending lease"]
  RunCheck -->|沙箱启动/环境错误| EnvFail["增加 environment failure 计数"]
  EnvFail --> EnvCount{"连续失败 >= 3?"}
  EnvCount -->|否| EnvGuidance["回到 active<br/>使用 goal_environment 调整"]
  EnvCount -->|是| EnvPaused["paused + queuePaused"]
  RunCheck -->|非环境失败| ImplFail["回到 active<br/>返回具体失败输出"]

  Audit --> Verdict{"审计结果"}
  Verdict -->|pass| Finish["核对失败锁、当前输入和所有权<br/>删除私有验证输入"]
  Finish -->|全部有效| Complete["complete"]
  Finish -->|输入变化或环境错误| EnvFail
  Finish -->|清理失败| CleanupPaused
  Finish -->|审计复跑失败| ImplFail
  Finish -->|所有权失效| Stale["不写入旧结果"]
  Verdict -->|fail| Failure{"预算原因?<br/>失败次数超限?"}
  Failure -->|预算| Budget["budget_limited"]
  Failure -->|次数超限| Blocked["blocked"]
  Failure -->|可重试| ImplFail
  Verdict -->|取消| Paused["paused + queuePaused"]
```

## 读图后的优化方向

1. **`draft` 语义过载**：初始草稿和“等待 scope 审批”都用 `draft`，实际差异藏在 `pendingSpec`、`approved` 和 `directStart` 中。可以拆成显式的 `planning` 与 `awaiting_approval` 状态。
2. **状态维度过多**：`status`、`approved`、`pendingSpec`、`directStart`、`queuePaused`、`activeId`、`owner` 共同决定行为，容易产生隐藏状态。建议集中定义转移表，并为关键不变量写断言。
3. **派生视图重复**：journal、内存 `ProjectState`、context 消息和 TUI widget 各自投影。建议明确“状态源 → 投影”的边界，避免四处修补同一状态。
4. **提交流程分支复杂**：已提取 `VerificationContext` 管理冻结输入、检查复跑、失败锁和销毁；`goal_submit` 仍组合审计、预算、取消和状态写入。后续可继续集中终止原因，减少重复的清理与错误分支。
5. **事件重入与 fencing**：`before_agent_start`、`input`、`turn_end`、`agent_before_settle` 都可能写入状态。可考虑用单一串行化 reducer/actor 统一处理，降低 generation/owner 校验的分散程度。
