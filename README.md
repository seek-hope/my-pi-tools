# my-pi-tools

[![CI](https://github.com/seek-hope/my-pi-tools/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seek-hope/my-pi-tools/actions/workflows/ci.yml)

三个面向 [Pi](https://github.com/badlogic/pi-mono) coding agent 的扩展，在同一仓库中独立开发和维护：

| 扩展 | 包名 | 能力 | 额外依赖 |
| --- | --- | --- | --- |
| [`codegraph/`](codegraph/README.md) | `pi-codegraph` | 通过 Pi 原生 MCP 接入 CodeGraph，用 `/codegraph` 管理索引并查询调用路径与修改影响 | `codegraph` CLI |
| [`search/`](search/README.md) | `pi-deepseek-web` | 合并 DeepSeek 与 Exa 的 `web_search` / `web_fetch`，单源可用时静默回退 | DeepSeek 或 Exa API Key |
| [`goal/`](goal/README.md) | `my-pi-goal` | 持久化目标、证据和检查；由临时只读 subagent 审查完成情况并可请求补充信息 | Pi 主会话工具 |

三者互不依赖，可以单独安装。`goal` 的中文说明见 [README.zh-CN.md](goal/README.zh-CN.md)。

## 环境要求

- **Node.js** ≥ 22.19
- **Pi** 已在 **1.3.0 / 1.4.0** 上验证
- **CodeGraph** 1.6.2（`codegraph` 扩展）
- **goal** 使用主会话的现有工具执行检查，无需 Docker 或额外子代理插件。
- 已在 Linux 实机验证；其他平台尚未测试

## 安装

在仓库根目录执行：

```bash
pi install ./codegraph
pi install ./search
pi install ./goal
```

只对当前项目安装，使用 `pi install -l /绝对路径/my-pi-tools/<包>`；只想临时加载、不写配置，可以 `pi -e /绝对路径/my-pi-tools/<包>/src/index.ts`（`goal` 的入口是 `extensions/index.ts`）。安装后在已运行的 Pi 中执行 `/reload`。

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

### goal

```text
/goal 修复 CSV 导出中的 Unicode 文件名，并验证现有格式兼容性
/goal approve
/goal
```

模型会先勘察工作区，给出目标、验收标准、任务和检查命令；短小目标可以自动接受初始范围，复杂目标需要 `/goal approve`。主会话通过 `goal_check` 执行已批准的检查；`goal_submit` 启动临时只读 subagent 审查产物。审查者可请求补充信息，主会话通过 `goal_reply` 回答后再次提交。

## 仓库结构

```text
my-pi-tools/
├── codegraph/          # pi-codegraph
├── search/             # pi-deepseek-web
├── goal/               # my-pi-goal
├── .github/workflows/  # 类型检查、测试与真实 Pi/CodeGraph smoke
└── package.json        # 根级聚合脚本（不使用 npm workspaces）
```

## 开发与验证

根目录只提供聚合脚本，不改变各包的依赖解析。先分别安装依赖：

```bash
npm --prefix codegraph ci --ignore-scripts
npm --prefix search ci --ignore-scripts
npm --prefix goal ci --ignore-scripts --legacy-peer-deps

npm run check   # 三个包的类型检查
npm test        # 三个包的离线测试
npm run smoke   # 真实 Pi + CodeGraph 集成测试（需已安装 codegraph CLI）
```

`goal` 还有额外的验证入口：

```bash
cd goal
npm run check:format
npm run check:load     # 真实扩展注册检查
npm run verify:setup   # 首次运行：准备 TLA+ 工具
npm run check:compat   # Pi 1.3.0 / 1.4.0 双版本检查
npm run verify:coverage
npm run verify:formal
npm run verify:evidence
```

测试全部使用本地 mock 或离线 fixture，不需要付费 API；`smoke` 也不调用 LLM。

## CI

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：push / PR 时在 Node 22 与 24 上运行类型检查和测试，并执行真实 Pi + CodeGraph smoke。


## 安全边界

- **search**：API 地址默认必须 HTTPS；抓取前校验 DNS，拒绝回环、私网、元数据和保留地址；重定向按错误处理；溢出的全文写入当前用户私有目录。上游服务仍会自行解析目标地址，本地校验不等价于网络层出站策略。
- **goal**：写文件和执行命令由主会话负责；临时审查者只有显式列出的只读和反馈工具，不加载项目扩展或 MCP。Goal 核对真实检查记录、源文件版本和审查中读取的产物，阻止过期结果完成任务；它不提供操作系统级隔离。
- **codegraph**：不自动建索引，不写入 `mcp.json` 或个人设置；为它启动的子进程关闭遥测和升级检查。图谱结果不能替代编译、测试和 lint。

## 限制

- 主会话工具实现、权限检查和文件系统是可信基础；源码标记与读取内容复核不是原子快照，忽略目录、外部依赖和服务的变化需要主动重跑检查。
- `goal` 尚未验证连续 5–12 小时的真实模型长跑；默认每轮一个临时审查者，不提供常驻 daemon 或并行子代理编排。

## 文档

| 文档 | 内容 |
| --- | --- |
| [codegraph/README.md](codegraph/README.md) | 安装、MCP 暴露方式、命令、环境变量、生命周期 |
| [search/README.md](search/README.md) | provider 选择、全部配置项、缓存与截断、SSRF 说明 |
| [goal/README.md](goal/README.md) | 目标生命周期、命令、验证环境、预算、持久化与恢复 |
| [goal/docs/flow.md](goal/docs/flow.md) | 入口、状态机与验证流程（中文，含 Mermaid 图） |
| [goal/docs/read-only-review.md](goal/docs/read-only-review.md) | 主会话执行、只读审查、补充信息往返、版本核验与迁移 |
| [goal/verification/REPORT.md](goal/verification/REPORT.md) | 形式化验证方法与收据 |

## License

[MIT](LICENSE) © 2026 Anchor
