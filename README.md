# my-pi-tools

[![CI](https://github.com/seek-hope/my-pi-tools/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seek-hope/my-pi-tools/actions/workflows/ci.yml)

三个面向 [Pi](https://github.com/badlogic/pi-mono) coding agent 的扩展，在同一仓库中独立开发和维护：

| 扩展 | 包名 | 能力 | 额外依赖 |
| --- | --- | --- | --- |
| [`codegraph/`](codegraph/README.md) | `pi-codegraph` | 通过 Pi 原生 MCP 接入 CodeGraph，用 `/codegraph` 管理索引并查询调用路径与修改影响 | `codegraph` CLI |
| [`search/`](search/README.md) | `pi-deepseek-web` | 合并 DeepSeek 与 Exa 的 `web_search` / `web_fetch`，单源可用时静默回退 | DeepSeek 或 Exa API Key |
| [`goal/`](goal/README.md) | `my-pi-goal` | 持久化目标、证据和检查，完成前执行独立审计；支持目标队列 | Docker Sandboxes（`sbx`） |

三者互不依赖，可以单独安装。`goal` 的中文说明见 [README.zh-CN.md](goal/README.zh-CN.md)。

## 环境要求

- **Node.js** ≥ 22.19
- **Pi** 已在 **1.3.0 / 1.4.0** 上验证
- **CodeGraph** 1.6.2（`codegraph` 扩展）
- **Docker Sandboxes**（`goal` 的验证后端，需要可用的 `sbx` 与个人镜像配置）
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

模型会先勘察工作区，给出目标、验收标准、任务和检查命令；短小的目标可以自动接受初始范围，复杂目标需要 `/goal approve`。完成前，所有已批准的检查会在全新的 microVM 中重跑，并由独立的只读审计上下文逐条给出结论。

## 仓库结构

```text
my-pi-tools/
├── codegraph/          # pi-codegraph
├── search/             # pi-deepseek-web
├── goal/               # my-pi-goal
├── .github/workflows/  # CI 与手动 microVM 验收
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

真实 microVM 验收需要个人配置，且只在具备虚拟化的机器上运行：

```bash
node goal/scripts/check-sandbox.mjs --run /path/to/profile.json
```

测试全部使用本地 mock 或离线 fixture，不需要付费 API；`smoke` 也不调用 LLM。

## CI

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：push / PR 时在 Node 22 与 24 上运行类型检查和测试，并执行真实 Pi + CodeGraph smoke。
- [`.github/workflows/sandbox.yml`](.github/workflows/sandbox.yml)：手动触发，在专用的 self-hosted runner 上运行完整 microVM 验收。

## 安全边界

- **search**：API 地址默认必须 HTTPS；抓取前校验 DNS，拒绝回环、私网、元数据和保留地址；重定向按错误处理；溢出的全文写入当前用户私有目录。上游服务仍会自行解析目标地址，本地校验不等价于网络层出站策略。
- **goal**：只隔离已批准的检查和 `audit_check`；普通 Pi 工具、状态、审批记录和审计模型请求留在宿主。每次检查使用全新 microVM 和冻结源码，不挂载 home、凭据或 socket，回收失败会阻止完成，且没有不受限的执行回退。
- **codegraph**：不自动建索引，不写入 `mcp.json` 或个人设置；为它启动的子进程关闭遥测和升级检查。图谱结果不能替代编译、测试和 lint。

## 限制

- microVM 验收是**有界实测**（16/16 个用例），不是普遍隔离证明；未覆盖完整的 IPv6/UDP 攻击面、父进程强杀/daemon 崩溃矩阵和跨平台认证。
- `goal` 尚未验证连续 5–12 小时的真实模型长跑，也不提供 daemon、自动模型切换或子代理编排。

## 文档

| 文档 | 内容 |
| --- | --- |
| [codegraph/README.md](codegraph/README.md) | 安装、MCP 暴露方式、命令、环境变量、生命周期 |
| [search/README.md](search/README.md) | provider 选择、全部配置项、缓存与截断、SSRF 说明 |
| [goal/README.md](goal/README.md) | 目标生命周期、命令、验证环境、预算、持久化与恢复 |
| [goal/docs/flow.md](goal/docs/flow.md) | 入口、状态机与验证流程（中文，含 Mermaid 图） |
| [goal/docs/docker-sandboxes-setup.md](goal/docs/docker-sandboxes-setup.md) | microVM 后端配置与网络策略 |
| [goal/docs/sandbox-boundary.md](goal/docs/sandbox-boundary.md) | 隔离范围、输入选择、安全链接、夹具授权与显式环境变量 |
| [goal/docs/docker-sandboxes-acceptance.md](goal/docs/docker-sandboxes-acceptance.md) | 实测范围、结果与限制 |
| [goal/verification/REPORT.md](goal/verification/REPORT.md) | 形式化验证方法与收据 |

## License

[MIT](LICENSE) © 2026 Anchor
