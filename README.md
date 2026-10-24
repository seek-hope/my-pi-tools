# my-pi-tools

三个独立的 Pi 扩展，放在同一工作目录中维护：

| 目录 | 包 | 作用 |
| --- | --- | --- |
| [`codegraph/`](codegraph/README.md) | `pi-codegraph` | 通过 Pi 原生 MCP 接入 CodeGraph，提供 `/codegraph` 管理命令 |
| [`search/`](search/README.md) | `pi-deepseek-web` | DeepSeek + Exa 驱动的 `web_search` / `web_fetch` |
| [`goal/`](goal/README.md) | `my-pi-goal` | 持久化目标、证据记录与独立验收 |

## 本地检查

根目录只提供聚合脚本，不改变各包的依赖解析。先分别在每个包安装依赖：

```bash
npm --prefix codegraph ci --ignore-scripts
npm --prefix search ci --ignore-scripts
npm --prefix goal install --ignore-scripts

npm run check   # 三个包的类型检查
npm test        # 三个包的离线测试
npm run smoke   # 真实 Pi + CodeGraph 集成测试（需要已安装 codegraph CLI）
```

`goal` 的验证使用 Docker Sandboxes microVM，需要已登录的 `sbx` 与个人镜像配置，支持离线、允许列表和开放出站模式；`search` 需要 `DEEPSEEK_API_KEY`、`EXA_API_KEY` 或 Pi 的 DeepSeek 登录；`codegraph` 需要可执行的 `codegraph` CLI。详细配置和边界见各包 README。

## 安全相关变更

- `search`：远程 API base URL 默认必须使用 HTTPS；key 变更后重建客户端；DNS 解析受超时和取消约束；溢出的临时文件会定期清理。
- `goal`：迟到的环境错误不会写入已被替换的目标；检查只接收冻结源码，宿主 home、凭据和 socket 不挂载到检查容器。
- `codegraph`：CodeGraph 不可用时撤回查询指引；Windows 终止失败时有直接 kill 兜底。

CI 位于 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)，包含三个包的测试和 CodeGraph smoke 测试。真实 microVM 验收由 [独立手动 workflow](.github/workflows/sandbox.yml) 在专用 runner 上执行。各包目前未声明 license/repository，发布前需要由维护者补充。
