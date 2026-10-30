# Pi Helper

[English](README.md) · [设计说明](DESIGN.md)

将一个明确的只读任务委派给临时 Pi 会话。Pi 负责模型循环、普通工具错误处理、上下文压缩和 provider 重试；所有文件工具仍经过主会话权限 hook。返回回答或部分结果后，子会话会被清理。

支持 **Pi 1.3.0 / 1.4.0**，要求 Node.js ≥ 22.19。这个包与 CodeGraph、Search 相互独立。

## 安装与调用

在仓库根目录执行：

```bash
pi install ./helper
```

已运行的 Pi 会话需要执行 `/reload`。Helper 是由主模型直接调用的 model-only 工具：

```json
{
  "task": "检查 src/export.ts 的 Unicode 文件名处理，返回具体问题和文件位置。",
  "context": "预期行为：下载的归档保留原始文件名。"
}
```

`task` 不能为空白，最多 20,000 字符；可选 `context` 最多 120,000 字符。请求只接受这两个字段。请明确提供路径、相关项目规则和必要材料。

调用在主会话工作目录中前台顺序执行。每次对话独立，只接收固定 Helper 提示、明确提供的请求和可用工具。不继承主会话历史、系统提示、推理和摘要，也不自动加载 `AGENTS.md`、技能、提示模板、扩展或 MCP。需要遵守的项目规则请放入 `context`。

子会话没有 TUI，不保存对话记录，也不能继续委派任务。补充材料时需要重新调用；Helper 不排队运行后台任务或自动续跑主会话。

## 工具与权限

可用工具是 `read`、`grep`、`find`、`ls` 与主会话当前可调用工具的交集。没有写入、编辑或命令工具，也不会用本地内置工具替代宿主未开放的工具。

Pi 默认工具选择可能只向 Helper 提供 `read`。需要文件发现和定向搜索时，将下面配置合并进项目 `.pi/settings.json`，保留已有工具选择：

```json
{
  "defaultTools": ["+grep", "+find", "+ls"]
}
```

使用默认工具选择的会话执行 `/reload` 或重启后生效。显式使用 `--tools` 时，也需要包含这些工具。这项设置同时向主会话开放导航工具。

每次工具调用都经过主会话权限 hook，保留参数校验、参数改写、结果过滤、取消和终止行为。子会话收到过滤后的内容及参数改写提示；其他父会话 hook 不会被复制。

缺少文件、读取范围越界、grep 正则不受支持等普通工具错误会交回模型纠正。主会话在执行前拒绝调用时，Helper 停止；宿主的 `terminate` 优先，并继续传播到主会话工具结果。转发机制见[设计说明](DESIGN.md#parent-tool-hooks)。

工具实现和宿主扩展属于可信部分。自定义的 `read` 工具必须确实只读。这是工具能力限制与上下文隔离，不是操作系统或文件系统沙箱。

## 会话管理与限制

Pi 管理对话增长、上下文压缩和临时 provider 错误重试。子会话采用 **Pi 内置默认设置**，包括默认启用的压缩和重试；不继承个人或项目 Pi 设置及运行时开关。子会话关闭缓存预热、安装遥测和分析遥测。压缩根据所选模型的上下文窗口触发，会产生模型用量；获得恢复机会不等于保证成功。

总超时、调用方或主会话取消、会话关闭都会中止子会话，包括重试等待和摘要请求。清理时等待中止完成，再释放会话。取消需要 provider 和工具配合；忽略取消信号的实现可能延迟返回。

返回字段分别限制长度：`output` 与 `lastTool.output` 各最多 32,000 字符，`reason` 最多 4,000 字符。这不是整个结果对象或子会话上下文的总上限。截断会明确标注，回答过长返回部分 `limited` 结果。Helper 没有独立的轮次、工具调用次数或序列化上下文限制；超时也不是 token 或金额预算。

## 结果与用量

结果包含 `status`、`model`、`output`、`reason`、`partial`、`turns`、`toolCalls`、`toolsUsed`、`usage`、`usageIncomplete` 和 `outputTruncated`。部分结果可能附带 `lastTool`，包含工具名、错误标志和有长度上限的文本摘录；成功回答不附带原始工具摘录。

| 状态 | 含义 |
| --- | --- |
| `answered` | 正常最终回答，也可能是缺少证据的说明 |
| `error` | provider 或会话失败、宿主拒绝，或没有正常最终回答 |
| `cancelled` | 调用方、会话、关闭事件或模型取消 |
| `limited` | 总超时、未恢复的模型输出限制或回答过长 |
| `terminated` | 宿主工具要求终止 |

`answered` 表示模型返回了回答，不代表整个任务已经独立验收。其他状态均为 `partial: true`，尽可能保留最后一段非空模型文本；它可能只是中途发现。非法参数和配置可能在生成结果前直接被拒绝。

`turns` 统计原生轮次，包含开始后、请求 provider 前被取消的轮次，不计摘要请求。`toolCalls` 统计转发给父会话的调用，包括被拒绝的请求；`toolsUsed` 是涉及的唯一工具名。

`usage` 包含普通模型请求、压缩和重试尝试已报告的用量。用量缺失或非法、请求失败或取消、请求尚未结束时，`usageIncomplete` 为真。Pi 单独统计嵌套宿主工具用量，聚合细节见[用量设计](DESIGN.md#usage)。

## 配置

可选配置按以下顺序加载，项目值覆盖个人值：

1. `<Pi agent 目录>/my-pi-helper.json`
2. `<工作目录>/.pi/my-pi-helper.json`

```json
{
  "timeoutSeconds": 1200
}
```

| 字段 | 默认值 | 可选值 |
| --- | --- | --- |
| `timeoutSeconds` | 1,200 | 1–3,600 秒的整数 |
| `provider`、`model` | 主会话模型 | 已配置模型的非空标识，必须同时设置 |
| `thinking` | 主会话思考等级 | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |

Helper 复用宿主已配置的 provider 和请求时认证，不复制凭证。它需要使用**具体模型**，不能直接使用虚拟路由选择。如果主会话使用虚拟模型，请显式设置 Helper 的 `provider` 和 `model`。

未知字段、非法范围和不完整的模型选择会被拒绝。Helper 配置不会修改主会话设置。

## 开发与验证

```bash
npm --prefix helper ci --ignore-scripts
npm --prefix helper run check
npm --prefix helper test
npm --prefix helper run check:format
npm --prefix helper run check:compat
```

`check:compat` 默认使用 `~/.pi/agent/install/releases` 的安装版本，也可以在 `--` 后指定其他目录。它将包复制到临时目录，分别检查两个 Pi 版本的类型、完整测试和独立扩展加载，不修改当前安装。CI 覆盖 Node 22 和 24。

测试使用真实 SDK、离线 provider 和临时文件。导航测试需要 `rg` 和 `fd`（或 `fdfind`）；CI 安装这些工具并禁用自动下载。覆盖范围见[验证设计](DESIGN.md#verification)。测试验证集成行为，不评价模型回答质量。

[MIT](../LICENSE)
