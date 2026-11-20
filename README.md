# my-pi-tools

[![CI](https://github.com/seek-hope/my-pi-tools/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seek-hope/my-pi-tools/actions/workflows/ci.yml)

四个面向 [Pi](https://github.com/earendil-works/pi) coding agent 的独立扩展，外加主机技能/CLI 更新、模型目录同步与代理管理工具。下表中扩展注册的工具既可直接调用，也可在启用 codemode 后通过脚本调用：

| 扩展 | 包名 | 能力 | 额外依赖 |
| --- | --- | --- | --- |
| [CodeGraph](codegraph/README.md) | `pi-codegraph` | 通过原生 MCP 查询源码、调用路径和修改影响，用 `/codegraph` 管理索引 | CodeGraph CLI |
| [Search](search/README.md) | `pi-deepseek-web` | DeepSeek + Exa 网页搜索与抓取，合并结果并处理单源失败 | 至少一个 provider 的 API Key |
| [Helper](helper/README.zh-CN.md) | `my-pi-helper` | 临时只读 Pi 会话，使用原生上下文管理并保留主会话权限 hook | 宿主工具与已配置模型 |
| [Prompt Profile](prompt-profile/README.md) | `pi-research-coding-profile` | 科研与编程角色、工作原则、文档指引及回复风格 | 无 |

## 环境与安装

要求 Node.js **≥ 22.19**。Helper 和 Prompt Profile 要求 Pi **≥ 1.5.0**；CodeGraph 的 peer 范围为 `>=1.3.0`，Search 为 `*`，具体测试范围见各包文档。CodeGraph 集成测试使用 CLI **1.6.3**。CI 覆盖 Linux，其他平台不在 CI 测试范围内。

在仓库根目录执行需要的安装命令：

```bash
pi install ./codegraph
pi install ./search
pi install ./helper
pi install ./prompt-profile
```

四个包均使用本地路径安装，未发布到 npm。仅对当前项目安装可用 `pi install -l /绝对路径/my-pi-tools/<包>`；临时加载使用 `pi -e <入口文件>`，其中 CodeGraph、Search 和 Prompt Profile 的入口是 `src/index.ts`，Helper 是 `extensions/index.ts`。在已运行的 Pi 中执行 `/reload`。

## 快速上手

### CodeGraph

先确认 `codegraph --version` 可用，再在**目标项目**的 Pi 会话中执行：

```text
/codegraph doctor
/codegraph init
/mcp reconnect codegraph
```

已有索引无需重新初始化。默认索引目录是 Pi 会话工作目录，扩展不会自动建索引或改写 MCP 配置。之后可以直接提问，例如“分析登录请求的调用链与修改影响”。配置和查询方式见 [CodeGraph README](codegraph/README.md)。

### Search

至少设置一个 API Key：

```bash
export DEEPSEEK_API_KEY=...
export EXA_API_KEY=...
```

让模型调用 `web_search` / `web_fetch`。搜索优先通过 `auto` 同时查询 Exa 和 DeepSeek 并合并结果；需要单一来源时优先 Exa，其次 DeepSeek。抓取默认先用 Exa，仅在来源不可用或允许回退的错误时改用 DeepSeek。建议先搜索摘要，再抓取需要的页面。来源选择、配置和费用说明见 [Search README](search/README.md)。

### Helper

让主模型调用 `helper`，明确提供任务和材料：

```json
{
  "task": "检查 src/export.ts 的 Unicode 文件名处理，返回具体问题和位置。",
  "context": "预期行为：下载的归档保留原始文件名。"
}
```

每次调用创建独立的临时只读会话。工具仅限宿主可调用的 `read`、`grep`、`find`、`ls`，全部经过主会话权限 hook。主会话历史和项目规则不会自动继承，请将必要说明放入 `context`。Pi 管理循环、压缩和重试，Helper 管理总超时、取消和清理。

只读工具与上下文隔离不等于文件系统沙箱；模型回答也不等于独立验收。工具配置、结果字段和其他限制见 [Helper 中文说明](helper/README.zh-CN.md)或 [English README](helper/README.md)。

### Prompt Profile

将默认角色设为 **researcher and coding expert**，通过独立分区提供科研证据、可复现性、代码修改、权限与回复原则。使用 `/prompt-profile` 查看角色和工作原则，使用 `/response-style` 查看回复风格。它不注册模型工具，也不替代工具权限控制。提示词组合规则见 [Prompt Profile README](prompt-profile/README.md)。

## 技能与 CLI 自动更新

本机的技能更新，以及 `agent-desktop`、`markitdown`、`codegraph`、`cliproxyapi` 四个 CLI 的更新，统一由 [skills-updater/](skills-updater/README.md) 管理。Linux 使用 systemd，在每天 20:00–22:00 间随机启动、不跨时补跑；macOS 使用 launchd，保持每天 09:00 后随机延迟 0–10 分钟运行；它是独立主机工具，不是 Pi 扩展。实际技能、来源记录、CLI 状态和备份仍保存在用户目录。

```bash
python3 skills-updater/install.py --dry-run  # 预览安装/迁移
python3 skills-updater/install.py            # 备份原入口并链接到仓库

# 手动统一更新；也可用 --skills-only / --tools-only / --dry-run
~/.local/bin/update-pi-toolchain
```

### Gemini 接入与可选本地代理

在 Pi 中使用 Gemini，直接运行 `pi auth login google --api-key`，输入 [Google AI Studio](https://aistudio.google.com/apikey) 的项目密钥，再用 `/model` 选择 `google` 下的模型。API 按项目计费，不使用 Antigravity 订阅登录，也不需要本地代理。

[gemini-proxy/](gemini-proxy/README.md) 独立管理 CLIProxyAPI 的回环服务和版本更新；已配置网关的模型目录由下面的同步器维护。

### 模型目录同步

[models-updater/](models-updater/README.md) 刷新 Pi 原生目录缓存，并将已支持网关的新模型追加到配置，保留已有条目和默认模型。Linux 和 macOS 的模型定时任务均在每天 20:00–22:00 间随机启动；可手动运行 `check-pi-models --sync` 立即同步。

```bash
python3 models-updater/install.py        # Linux
python3 models-updater/install_macos.py  # macOS
```

## 开发与验证

四个包分别管理依赖，根目录只提供聚合脚本，不使用 npm workspaces：

```bash
npm --prefix codegraph ci --ignore-scripts
npm --prefix search ci --ignore-scripts
npm --prefix helper ci --ignore-scripts
npm --prefix prompt-profile ci --ignore-scripts

npm run check   # 四包类型检查
npm test        # 四包、技能/CLI 更新器与模型检测离线测试（另需 Python ≥ 3.10）
npm run smoke   # 真实 Pi + CodeGraph 集成测试，需 CodeGraph CLI
```

根目录的测试和 smoke 不调用付费 API。Search 包的 `smoke` 会调用真实搜索/抓取 API，需要凭证并可能产生费用，详见其 README。

Helper 另提供格式与兼容性检查：

```bash
npm --prefix helper run check:format
npm --prefix helper run check:compat
```

`check:compat` 自动发现本机安装的 Pi ≥ 1.5.0 稳定版，在临时目录检查 Helper 类型、完整测试和独立扩展加载。[CI](.github/workflows/ci.yml) 对四个包检查 Pi 1.5.0 基线与最新稳定版，在 Node 22/24 上运行类型检查、测试和独立加载，并运行真实 Pi/CodeGraph smoke。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [codegraph/README.md](codegraph/README.md) | 安装、MCP 查询、索引命令、配置与生命周期 |
| [search/README.md](search/README.md) | 来源选择、缓存与截断、安全边界、费用与排障 |
| [helper/README.md](helper/README.md) / [中文](helper/README.zh-CN.md) | 调用接口、工具权限、限制、配置与验证命令 |
| [helper/DESIGN.md](helper/DESIGN.md) | 会话构建、权限转发、取消清理、用量统计与源码索引 |
| [prompt-profile/README.md](prompt-profile/README.md) | 科研与编程角色、提示词分区、扩展组合和查看命令 |
| [skills-updater/README.md](skills-updater/README.md) | 技能与 CLI 自动更新、systemd/launchd 安装、来源、报告和备份恢复 |
| [gemini-proxy/README.md](gemini-proxy/README.md) | CLIProxyAPI 安装、配置、更新和运维 |
| [models-updater/README.md](models-updater/README.md) | 模型目录同步、夜间定时任务、差异报告、安全边界与验证 |

## License

[MIT](LICENSE) © 2026 Anchor
