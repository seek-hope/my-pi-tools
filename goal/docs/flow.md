# Goal 流程

Goal 负责范围、进度、执行记录和独立审查。主会话负责写文件和执行命令，临时只读审查者负责读取产物、提出问题和提交结论。实现边界见[执行与只读审查](read-only-review.md)。

## 入口与执行

```mermaid
flowchart TD
  User["用户任务"] --> Plan["勘察与 goal_plan"]
  Plan --> Scope{"初始范围可自动接受？"}
  Scope -->|是| Work["主会话执行任务"]
  Scope -->|否| Approve["用户确认范围"]
  Approve --> Work
  Work --> Progress["goal_progress 记录证据"]
  Progress --> Check["goal_check 调用主会话 bash"]
  Check -->|失败或缺少退出状态| Work
  Check -->|实际结果已记录| Submit["goal_submit"]
  Submit --> Review["新建临时只读审查上下文"]
  Review -->|补充信息| Reply["主会话补充并 goal_reply"]
  Reply --> Work
  Review -->|未通过| Work
  Review -->|通过且结果仍有效| Done["complete"]
  Done --> Queue{"有已批准的后续目标？"}
  Queue -->|是| Work
  Queue -->|否| Wait["等待真实用户输入后清理已完成状态"]
```

检查命令由主会话显式调用；`goal_submit` 和审查者不执行命令。未配置检查的目标可以直接提交审查，但仍需逐条证据、完成任务和真实产物检查。

## 状态与失效

```mermaid
stateDiagram-v2
  [*] --> draft
  draft --> queued: 范围批准且已有选中目标
  draft --> active: 范围批准并开始执行
  queued --> active: FIFO 自动推进或有效恢复
  active --> verifying: 当前检查记录齐全后提交
  verifying --> active: 未通过或需要补充信息
  verifying --> complete: 当前有效的独立结论通过
  active --> paused: 用户暂停或运行取消
  verifying --> paused: 用户暂停或审查取消
  active --> blocked: 缺少必需输入
  verifying --> blocked: 达到修复保护阈值
  active --> budget_limited: 累计预算不足
  verifying --> budget_limited: 累计预算不足
  paused --> active: 有效恢复
  blocked --> active: 解决阻塞后有效恢复
  budget_limited --> active: 调整预算后有效恢复
  active --> draft: 提议修改已批准范围
```

会话、目标、generation、所有权或范围变化会使旧回调失效。已发生的审查用量在仍具备原记录写入权时保留；过期结论不能用于完成替代目标。暂停、预算与明确停止规则不因补充信息请求而放宽。

## 审查与补充信息

```mermaid
sequenceDiagram
  participant Main as 主会话
  participant Goal as Goal 控制器
  participant Bash as 主会话 bash 工具
  participant Review as 临时只读审查者
  Main->>Goal: goal_check(已批准检查 ID)
  Goal->>Bash: ctx.executeTool(原命令)
  Bash-->>Goal: 实际退出状态与输出
  Goal-->>Main: 执行记录与源码标记
  Main->>Goal: goal_submit
  Goal->>Goal: 核对任务、证据、检查记录与未回答问题
  Goal->>Review: 新上下文与只读工具
  Review->>Review: 读取或搜索项目产物
  alt 需要补充
    Review-->>Goal: audit_request(验收条件、问题、可选检查 ID)
    Goal-->>Main: needs_info、请求 ID；结束本轮审查
    Main->>Goal: goal_reply(请求 ID、具体回答)
    Note over Main,Goal: 必要时主会话补测，再次提交新一轮审查
  else 能给出结论
    Review-->>Goal: audit_result(每条条件一个结论)
    Goal->>Goal: 核对读取内容、源码与运行身份仍有效
    Goal-->>Main: 通过、修复意见或结果失效
  end
```

回答是执行器证据，不能替代独立读取或直接使目标完成。补充请求不计入修复失败次数。主会话不会在等待审查返回的同时被要求回复，避免相互等待；下一轮使用新审查上下文并读取已保存的回答。
