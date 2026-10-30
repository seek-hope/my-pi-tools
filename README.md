# my-pi-tools

[![CI](https://github.com/seek-hope/my-pi-tools/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seek-hope/my-pi-tools/actions/workflows/ci.yml)

三个面向 [Pi](https://github.com/earendil-works/pi) coding agent 的扩展，在同一仓库中独立开发和维护：

| 扩展 | 包名 | 能力 | 额外依赖 |
| --- | --- | --- | --- |
| [`codegraph/`](codegraph/README.md) | `pi-codegraph` | 通过 Pi 原生 MCP 接入 CodeGraph，用 `/codegraph` 管理索引并查询调用路径与修改影响 | `codegraph` CLI |
| [`search/`](search/README.md) | `pi-deepseek-web` | 合并 DeepSeek 与 Exa 的 `web_search` / `web_fetch`，单源可用时静默回退 | DeepSeek 或 Exa API Key |
| [`helper/`](helper/README.md) | `my-pi-helper` | 临时只读 Pi 会话；原生上下文管理，保留主会话权限 hook | Pi 主会话工具与已配置模型 |

三者互不依赖，可以单独安装。Helper 的中文说明见 [README.zh-CN.md](helper/README.zh-CN.md)。

## 环境要求

- **Node.js** ≥ 22.19
- **Helper** 支持 Pi **1.3.0 / 1.4.0**；CodeGraph 的 peer 范围为 `>=1.3.0`，Search 为 `*`
- **CodeGraph** 1.6.2（`codegraph` 扩展）
- Helper 使用现有模型认证和宿主工具，无需 Docker 或额外 subagent 插件
- 已在 Linux 实机验证；其他平台尚未测试

## 安装

在仓库根目录执行：

```bash
pi install ./codegraph
pi install ./search
pi install ./helper
```

只对当前项目安装，使用 `pi install -l /绝对路径/my-pi-tools/<包>`；只想临时加载、不写配置，可以 `pi -e /绝对路径/my-pi-tools/<包>/src/index.ts`（Helper 的入口是 `extensions/index.ts`）。安装后在已运行的 Pi 中执行 `/reload`。

三个包都未发布到 npm，请从本地路径安装。

## 快速上手

### codegraph

先确认 CLI 可用，再在**目标项目**的 Pi 会话中初始化索引：

```bash
codegraph --version
```

```text
/codegraph doctor
/codegraph init
/mcp reconnect codegraph
```

索引默认建立在 Pi 会话的工作目录，而不是插件目录。之后直接提问，例如“分析登录请求的调用链，以及修改这个函数的影响范围”。`/codegraph` 不会自动建索引，也不会改写你的 MCP 配置。

### search

```bash
export DEEPSEEK_API_KEY=...   # 与 EXA_API_KEY 至少配置一个
export EXA_API_KEY=...
```

然后让模型使用 `web_search` / `web_fetch` 即可。默认 `provider="auto"` 会查询所有已配置的来源，并用 reciprocal rank fusion 合并结果；需要单一来源时传 `provider="deepseek"` 或 `"exa"`。抓取默认优先 DeepSeek，失败时静默切换到 Exa。

### helper

让主模型直接调用 `helper`，提供明确任务和必要材料。例如只读检查：

```json
{
  "task": "检查 src/export.ts 的 Unicode 文件名处理，返回具体问题和位置。",
  "context": "预期行为：下载的归档保留原始文件名。不要修改文件。"
}
```

每次调用创建一个独立的内存 Pi 会话，只提供主会话当前可调用的 `read`、`grep`、`find`、`ls`，所有工具都通过父会话权限 hook 执行。Pi 负责模型循环、普通工具错误处理、压缩和重试；Helper 保留总超时与取消，返回后清理子会话。

Helper 不继承主会话历史、系统提示、推理或压缩摘要，也不自动加载项目规则、技能或扩展。需要的材料和规则请明确传入。它采用 Pi 内置设置默认值；主会话决定如何使用返回结果。

## 仓库结构

```text
my-pi-tools/
├── codegraph/          # pi-codegraph
├── search/             # pi-deepseek-web
├── helper/             # my-pi-helper
├── .github/workflows/  # 类型检查、测试与真实 Pi/CodeGraph smoke
└── package.json        # 根级聚合脚本（不使用 npm workspaces）
```

## 开发与验证

根目录只提供聚合脚本，不改变各包的依赖解析。先分别安装依赖：

```bash
npm --prefix codegraph ci --ignore-scripts
npm --prefix search ci --ignore-scripts
npm --prefix helper ci --ignore-scripts

npm run check   # 三个包的类型检查
npm test        # 三个包的离线测试
npm run smoke   # 真实 Pi + CodeGraph 集成测试（需已安装 codegraph CLI）
```

Helper 还有格式和双版本验证入口：

```bash
npm --prefix helper run check:format
npm --prefix helper run check:compat  # Pi 1.3.0 / 1.4.0：类型、完整测试、扩展加载
```

测试使用本地 mock 或离线 provider，不需要付费 API；Helper 的 SDK 测试使用临时文件，验证只读工具、权限 hook、原生压缩/重试和取消清理，`smoke` 也不调用 LLM。

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 push / PR 时运行 Node 22 / 24 与 Helper 的 Pi 1.3.0 / 1.4.0 版本矩阵，并执行真实 Pi + CodeGraph smoke。

## 边界与限制

- **Helper**：临时只读会话，所有工具经过宿主权限 hook；上下文独立不等于文件系统沙箱，工具实现和宿主扩展必须可信。取消需要工具/provider 配合；模型回答不等于独立验收。
- **Helper** 返回文本结果，前台顺序调用，不保存子会话；没有后台队列或并行编排，也不启用宿主未开放的工具。虚拟路由模型需要为 Helper 显式配置具体模型。
- **Search**：API 地址默认必须 HTTPS；抓取前校验 DNS，拒绝回环、私网、元数据和保留地址；重定向按错误处理；溢出的全文写入当前用户私有目录。上游服务仍会自行解析目标地址，本地校验不等价于网络层出站策略。
- **CodeGraph**：不自动建索引，不写入 `mcp.json` 或个人设置；为它启动的子进程关闭遥测和升级检查。图谱结果不能替代编译、测试和 lint。

## 文档

| 文档 | 内容 |
| --- | --- |
| [codegraph/README.md](codegraph/README.md) | 安装、MCP 暴露方式、命令、环境变量、生命周期 |
| [search/README.md](search/README.md) | provider 选择、配置、缓存与截断、SSRF 说明 |
| [helper/README.md](helper/README.md) | 请求接口、只读工具、限制、配置与验证 |
| [helper/README.zh-CN.md](helper/README.zh-CN.md) | Helper 中文说明 |
| [helper/DESIGN.md](helper/DESIGN.md) | 上下文隔离、调用流程和边界 |

## License

[MIT](LICENSE) © 2026 Anchor
