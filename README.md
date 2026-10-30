# my-pi-tools

[![CI](https://github.com/seek-hope/my-pi-tools/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/seek-hope/my-pi-tools/actions/workflows/ci.yml)

三个面向 [Pi](https://github.com/earendil-works/pi) coding agent 的独立扩展，可按需安装：

| 扩展 | 包名 | 能力 | 额外依赖 |
| --- | --- | --- | --- |
| [CodeGraph](codegraph/README.md) | `pi-codegraph` | 通过原生 MCP 查询源码、调用路径和修改影响，用 `/codegraph` 管理索引 | CodeGraph CLI |
| [Search](search/README.md) | `pi-deepseek-web` | DeepSeek + Exa 网页搜索与抓取，合并结果并处理单源失败 | 至少一个 provider 的 API Key |
| [Helper](helper/README.zh-CN.md) | `my-pi-helper` | 临时只读 Pi 会话，使用原生上下文管理并保留主会话权限 hook | 宿主工具与已配置模型 |

## 环境与安装

要求 Node.js **≥ 22.19**。Helper 支持 Pi **1.3.0 / 1.4.0**；CodeGraph 的 peer 范围为 `>=1.3.0`，Search 为 `*`，具体测试范围见各包文档。CodeGraph CLI 使用 **1.6.2**。CI 覆盖 Linux，其他平台暂无测试覆盖。

在仓库根目录执行需要的安装命令：

```bash
pi install ./codegraph
pi install ./search
pi install ./helper
```

三个包均未发布到 npm，使用本地路径安装。仅对当前项目安装可用 `pi install -l /绝对路径/my-pi-tools/<包>`；临时加载使用 `pi -e <入口文件>`，其中 CodeGraph 和 Search 的入口是 `src/index.ts`，Helper 是 `extensions/index.ts`。在已运行的 Pi 中执行 `/reload`。

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

让模型调用 `web_search` / `web_fetch`。搜索默认查询所有已配置来源并合并结果；抓取默认优先 DeepSeek，失败时回退 Exa。建议先搜索摘要，再抓取需要的页面。来源选择、配置和费用说明见 [Search README](search/README.md)。

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

## 开发与验证

三个包分别管理依赖，根目录只提供聚合脚本，不使用 npm workspaces：

```bash
npm --prefix codegraph ci --ignore-scripts
npm --prefix search ci --ignore-scripts
npm --prefix helper ci --ignore-scripts

npm run check   # 三包类型检查
npm test        # 三包离线测试
npm run smoke   # 真实 Pi + CodeGraph 集成测试，需 CodeGraph CLI
```

根目录的测试和 smoke 不调用付费 API。Search 包的 `smoke` 会调用真实搜索/抓取 API，需要凭证并可能产生费用，详见其 README。

Helper 另提供格式与兼容性检查：

```bash
npm --prefix helper run check:format
npm --prefix helper run check:compat
```

`check:compat` 使用本机安装的 Pi 1.3.0 / 1.4.0，在临时目录检查类型、完整测试和独立扩展加载。[CI](.github/workflows/ci.yml) 覆盖 Node 22/24 × Helper Pi 1.3.0/1.4.0，并运行真实 Pi/CodeGraph smoke。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [codegraph/README.md](codegraph/README.md) | 安装、MCP 查询、索引命令、配置与生命周期 |
| [search/README.md](search/README.md) | 来源选择、缓存与截断、安全边界、费用与排障 |
| [helper/README.md](helper/README.md) / [中文](helper/README.zh-CN.md) | 调用接口、工具权限、限制、配置与验证命令 |
| [helper/DESIGN.md](helper/DESIGN.md) | 会话构建、权限转发、取消清理、用量统计与源码索引 |

## License

[MIT](LICENSE) © 2026 Anchor
