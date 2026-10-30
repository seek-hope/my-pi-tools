# pi-codegraph

将 [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) 接入 Pi 的 TypeScript 扩展。

扩展通过 Pi **原生 MCP** 注册 `codegraph serve --mcp`，由 Pi 管理连接、工具发现、调用、取消、结果截断和重连。无需额外 MCP 适配器，CodeGraph CLI 需单独安装。

要求 Node.js **≥ 22.19**、Pi **≥ 1.3.0**。开发依赖为 Pi **1.4.0**，CI 使用 CodeGraph **1.6.2**，覆盖 Linux 上的 Node 22/24；其他平台暂无测试覆盖。缺少 `registerMcpServer` 的 Pi 版本会在加载时提示升级。

## 快速开始

### 1. 准备 CodeGraph CLI

```bash
codegraph --version
```

如果尚未安装，按 [上游说明](https://github.com/colbymchenry/codegraph#get-started) 安装，或使用：

```bash
npm install -g @colbymchenry/codegraph@1.6.2
```

**不需要执行 `codegraph install`**：它用于配置其他客户端，本扩展直接在 pi 会话里注册 MCP 服务。扩展不会自动下载或升级 CodeGraph。

### 2. 加载扩展

在 `my-pi-tools` 目录下安装本地包：

```bash
pi install ./codegraph
```

安装会将包路径写入 Pi 个人配置。仅为当前项目安装可用 `pi install -l /绝对路径/my-pi-tools/codegraph`。

也可以只在一次会话中加载，不写配置：

```bash
cd /你的项目
pi -e /绝对路径/my-pi-tools/codegraph/src/index.ts
```

插件运行时没有额外的 npm 依赖；`npm ci` 仅用于开发和测试。在已运行的 pi 中安装后执行 `/reload`。

### 3. 初始化你要查询的项目

在目标项目的 pi 会话中：

```text
/codegraph doctor
/codegraph status
/codegraph init
/mcp reconnect codegraph
```

- 默认项目是 **pi 会话工作目录**，不是插件所在目录。
- `/codegraph init` 是显式建索引操作，会调用 `codegraph init --yes <项目路径>`，创建 `.codegraph/` 并采用上游的非交互默认选项。不会加 `--force`，也不会改其他客户端配置。
- 已有索引不必重新初始化。读取索引、自动同步等行为由 CodeGraph 实现。
- 若服务启动时项目没有索引，上游可能将 `projectPath` 标成必填。初始化后重连可刷新 schema；不重连也可显式传入 `projectPath`。

之后直接向 pi 提问，例如：“分析登录请求的调用链，以及修改这个函数的影响范围”。

## 查询工具

默认使用 `codemode` exposure：工具可以通过 codemode 调用，不把整套 schema 常驻在模型上下文中。连接成功后，pi 自动启用 codemode；如果你的 pi 配置禁用了这一行为，需要手动启用。

CodeGraph 1.6.2 **默认只公开 `codegraph_explore`**。工具名为：

```text
mcp__codegraph__codegraph_explore
```

它返回相关源码、调用路径和修改影响信息。codemode 用法：

```javascript
text(await searchTools("codegraph", { namespace: "mcp__codegraph" }));
text(await describeNamespace("mcp__codegraph"));
text(await describeTool("mcp__codegraph__codegraph_explore"));
```

查看 schema 后调用：

```javascript
const result = await tools.mcp__codegraph__codegraph_explore({
  query: "login authenticateUser",
  projectPath: "/绝对路径/你的项目",
  maxFiles: 5,
});
text(result);
```

MCP 返回完整 `CallToolResult`，包括 `content` 和可能的 `isError`，不是裸字符串。查询其他项目时可指定 `projectPath`，但额外项目不一定有实时 watcher；注意结果中的陈旧索引提示。新项目是否建索引由用户决定。

想让模型直接看到工具，启动 pi 前设置：

```bash
PI_CODEGRAPH_EXPOSURE=direct pi
```

上游其他工具可通过 `CODEGRAPH_MCP_TOOLS` 选择，例如 `explore,node,search,callers,callees,impact,files,status`。这是 **CodeGraph 自身的环境变量**，实际工具集合以当前版本 `tools/list` 为准；若已有共享 daemon，需要重启该 daemon 才能更改它的环境。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/codegraph`、`/codegraph status` | 输出索引状态 JSON；不初始化索引 |
| `/codegraph init` | 显式初始化并建立索引，等待 pi 当前任务空闲后执行 |
| `/codegraph sync` | 手动同步已有索引；正常情况下 watcher 会自动同步 |
| `/codegraph doctor` | 输出 CLI 版本、项目路径、请求的配置和已加载工具 |
| `/codegraph help` | 查看帮助 |
| `/mcp` | pi 原生连接管理，查看 CodeGraph 连接错误与配置来源 |
| `/mcp reconnect codegraph` | 修复环境或初始化后重连 |

管理命令按顺序执行，已有命令运行时拒绝重复启动。执行结果以 pi 消息显示，不触发额外模型回合，非交互模式同样有结果。命令输出最多保留约 12 KB，完整日志写入系统临时目录 `pi-codegraph-*/command.log`（目录私有、文件权限 `0600`）；可在排障后自行删除，日志可能包含项目路径和符号名。

## 配置

环境变量在扩展加载时读取。修改 shell 环境后重启 pi；`/reload` 只能重新读取 **pi 进程当前已有的环境**。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_CODEGRAPH_COMMAND` | `codegraph` | PATH 中的可执行文件名，或绝对路径；支持 `~/`。不是 shell 命令，不接受 `npx ...` 或附加参数 |
| `PI_CODEGRAPH_PROJECT` | `.` | 项目目录，支持绝对路径、`~/`、相对 pi 会话目录的路径 |
| `PI_CODEGRAPH_EXPOSURE` | `codemode` | `codemode` / `direct` / `deferred` / `hidden` |
| `PI_CODEGRAPH_WATCH` | `1` | `0` 为 MCP 启动参数添加 `--no-watch`；只接受 `0` / `1` |
| `PI_CODEGRAPH_TIMEOUT` | `120` | MCP 单次请求和短 CLI 命令超时，秒，范围 1–3600；MCP progress 通知按 pi 规则重置超时 |
| `PI_CODEGRAPH_COMMAND_TIMEOUT` | `900` | `init` / `sync` 超时，秒，范围 1–86400 |

大型仓库首次索引可能超过默认的 15 分钟，可在启动 Pi 前提高 `PI_CODEGRAPH_COMMAND_TIMEOUT`。

示例：

```bash
PI_CODEGRAPH_COMMAND="$HOME/.local/bin/codegraph" \
PI_CODEGRAPH_PROJECT="/work/project with spaces" \
PI_CODEGRAPH_EXPOSURE=direct \
pi -e /绝对路径/my-pi-tools/codegraph/src/index.ts
```

`hidden` 只隐藏工具，**不关闭 MCP 进程或 watcher**。需要停止连接时通过 `/mcp` 禁用服务；不希望启动任何 MCP 服务时可使用 pi 的 `--no-mcp`。

### 与现有 MCP 配置的关系

- 注册只在当前会话生效，插件不会写入 `mcp.json`、个人设置、`AGENTS.md` 或其他客户端配置。
- `mcp.json` 中同名的 `codegraph` 服务优先于扩展注册。`/mcp` 会显示覆盖关系。
- `/codegraph` 的 CLI 命令仍使用 `PI_CODEGRAPH_*`，不会读取覆盖服务的 command/cwd。要保证它们与 MCP 指向同一个项目，请删除重复配置或保持一致。
- `pi mcp list` **不会加载扩展**，所以不能用来检查本扩展注册的服务；请在加载扩展的会话中使用 `/mcp`。
- 内置 MCP 被 `pi-mcp-adapter` 或其他扩展替换/禁用时，本扩展的注册可能无人处理；请启用 pi 内置 MCP。

## 生命周期与隐私

- 扩展工厂只注册能力，不启动进程；MCP 子进程由 pi 在会话开始时启动并管理。
- 不自动初始化索引，不执行安装、升级、删除索引或解锁操作。源码索引和自动同步由 CodeGraph 管理。
- 手动 CLI 命令使用参数数组执行，不经过 shell。会话关闭会取消并等待正在运行的命令；超时会终止命令进程树。
- 为本扩展启动的子进程设置 `CODEGRAPH_TELEMETRY=0`、`CODEGRAPH_NO_UPDATE_CHECK=1`，关闭 CodeGraph 遥测和升级检查。不会修改用户全局偏好，也不承诺对任意自定义可执行文件进行网络隔离。
- 设置 `CODEGRAPH_EXPLORE_DEDUP=0`，避免 pi 分支、恢复或上下文压缩后被跨调用去重隐藏必要源码。
- CodeGraph 默认可能复用共享 daemon。**已经运行的 daemon 保留原来的环境**，上述环境设置不能追溯修改它。需要强制使用独立进程时，在启动 pi 前设置 `CODEGRAPH_NO_DAEMON=1`；同一项目已有其他 writer 时可能出现锁冲突。
- pi 关闭的是它自己的 MCP 连接/客户端进程。共享 CodeGraph daemon 的空闲退出策略由上游管理，不会被插件强制杀掉，以免影响其他客户端。
- 图谱查询不能代替编译、测试或 lint。源码刚修改、跨项目查询、watcher 禁用或恢复期间，应检查结果的 freshness 提示。

## 开发与验证

```bash
cd codegraph
npm ci --ignore-scripts
npm run typecheck
npm test
npm run smoke
```

单元测试不需要 CodeGraph CLI。`smoke` 需要已安装的 CodeGraph，使用真实 pi SDK、原生 MCP transport 和 CLI，在临时项目中验证：

- 文件形式的扩展加载和会话目录解析；
- 无索引时不会自动初始化，显式 `init` 后可查询；
- MCP 工具发现、嵌套调用管线和 codemode；
- 修改源码后 watcher 自动同步，以及手动 `sync`；
- 会话关闭及临时文件清理。

Smoke 用固定 assistant 调用记录代替模型输出，**不调用 LLM，不需要 API key**；不读取个人 MCP 配置，不索引真实项目，并禁用 daemon 共享。失败的 CLI 日志可能保留在系统临时目录以便排查。

目录结构：

```text
codegraph/
├── src/config.ts     # 配置与原生 MCP 注册参数
├── src/index.ts      # 扩展入口、命令和查询指引
├── src/runner.ts     # 有超时/取消/日志的 CLI 执行器
├── test/             # 单元测试
└── scripts/smoke.ts  # 真实 Pi / CodeGraph 集成验证
```
