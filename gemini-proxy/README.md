# Gemini Pro 反向代理管理

提供 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的主机安装、服务管理、版本更新和 Pi 模型同步。CLIProxyAPI 将 Gemini/Claude 订阅额度转换为本地 OpenAI 兼容 API，Pi 通过 `models.json` 的 `cliproxy` provider 使用它。

代理默认只监听 `127.0.0.1:8317`。真实配置、OAuth 凭证、`kv.db`、日志和 API key 都不进入 Git。

## 本机路径

| 内容 | 路径 |
| --- | --- |
| 版本化二进制 | `~/.local/opt/cliproxyapi/<version>`，`current` 链接 |
| 命令入口 | `~/.local/bin/cliproxyapi` |
| 配置 | `~/.config/cliproxyapi/config.yaml`（权限 600） |
| OAuth/数据 | `~/.cli-proxy-api/`（权限 700） |
| systemd 用户服务 | `~/.config/systemd/user/cliproxyapi.service` |
| Pi 模型同步 | `~/.local/bin/cliproxy-pi-sync` |

## 安装/接管

```bash
python3 gemini-proxy/install.py --dry-run
python3 gemini-proxy/install.py
```

安装器只做三件事：

- 如果配置不存在，从 `config.example.yaml` 创建并提示编辑；已有配置绝不覆盖。
- 把 service、`cliproxy-pi-sync`、`cliproxy-antigravity-login` 和 `update-cliproxyapi` 链接到本仓库；已有文件先备份为 `*.bak-时间戳`。
- `systemctl --user daemon-reload`、启用并重启 `cliproxyapi.service`。

需要已有 `cliproxyapi` 二进制；缺失时先安装对应 release，或运行 `update-cliproxyapi`。

## 配置与登录

```bash
# 编辑本机配置：监听地址、management key、API key、出站代理
$EDITOR ~/.config/cliproxyapi/config.yaml

# 走一次 Gemini/Antigravity OAuth
cliproxy-antigravity-login

# 把代理当前可用模型写入 Pi 的 models.json（provider: cliproxy）
cliproxy-pi-sync
cliproxy-pi-sync --verify   # 可选：真实请求验证
```

`cliproxy-pi-sync` 只保留 Claude 系列和 Gemini 3.8+，并自动创建缺失的 `cliproxy` provider；provider 名称是 `Gemini Pro (CLIProxyAPI)`。写入 `models.json` 后，在 Pi 中 `/reload` 或重启 Pi。

## 有额度但返回 429

Google Antigravity 的 `429 RESOURCE_EXHAUSTED` 不一定代表额度耗尽。先比较同一账号、同一模型的最小请求与真实 Pi 请求：最小请求成功、完整系统提示失败时，应检查提示文字，而不是盲目重试、重新登录或关闭冷却。

`config.example.yaml` 在 `oauth.providers.antigravity.sensitive-words-replace` 中配置了 Pi 默认身份说明与文档索引的精确等义替换：

```yaml
oauth:
  providers:
    antigravity:
      sensitive-words-replace:
        "You are a coding assistant running inside pi, a coding agent harness.": "Assist with software development using the tools provided by Pi."
        "codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)": "codemode usage, classification, and image generation (docs/codemode.md)"
```

已有安装需把这两条规则合并到本机配置的 `oauth.providers.antigravity` 下；保留原有 `auth-dir` 等字段，不要创建重复的 `oauth` 键。安装器和每日二进制更新器不会覆盖已有配置。CLIProxyAPI 会热加载，无需修改 Pi 的系统提示或重新授权。

规则只改写系统提示中这两段原文，不使用隐藏字符，不删除权限约束，不改用户消息、工具定义或模型路由。它们不是所有 429 的通用解法；配额、并发和上游服务异常仍需分别检查。`cliproxy-pi-sync --verify` 仅验证最小请求，不能代替完整 Pi 会话验收。诊断日志可能含完整对话，应留在权限受限的本机目录，不要上传原始日志。

## 更新

```bash
update-cliproxyapi --check
update-cliproxyapi --dry-run
update-cliproxyapi
```

更新器从 GitHub Releases 下载当前平台的压缩包，校验 `checksums.txt`，安装到新的版本目录，原子切换 `current` 与 `~/.local/bin/cliproxyapi`，再重启用户服务。失败会恢复旧链接。每日 CLI 更新器也通过 `tools.json` 调用它。

## macOS（launchd）

同一套 `install.py` 会自动识别 macOS，使用 launchd 管理服务：

```bash
python3 gemini-proxy/install.py --dry-run
python3 gemini-proxy/install.py
```

它会写入 `~/Library/LaunchAgents/com.my-pi-tools.cliproxyapi.plist`，并通过 `launchctl bootstrap gui/$(id -u)` 启动。日志在：

```text
~/Library/Logs/cliproxyapi.log
~/Library/Logs/cliproxyapi.err.log
```

`update-cliproxyapi` 在 macOS 上同样下载 `darwin_aarch64`/`darwin_amd64` 包、校验 SHA-256，并用 `launchctl kickstart -k` 重启。macOS 配置中的 `requests.proxy-url` 应留空，除非本机另有出站代理。

安装器还会创建每日更新 LaunchAgent：

```text
Label: com.my-pi-tools.cliproxyapi-update
时间: 每天 09:00 本地时间，脚本内随机延迟 0–10 分钟
日志: ~/Library/Logs/cliproxyapi-update.log / .err.log
```

检查或手动触发：

```bash
launchctl print gui/$(id -u)/com.my-pi-tools.cliproxyapi-update
launchctl kickstart -k gui/$(id -u)/com.my-pi-tools.cliproxyapi-update
```

不需要定时器时使用 `python3 gemini-proxy/install.py --no-timer`。如果已启用 `skills-updater/install_macos.py` 的全工具链定时器，代理安装器会自动跳过单独的代理定时器；全工具链的 `tools.json` 已包含 `cliproxyapi`。

## 运维命令

```bash
systemctl --user status cliproxyapi
systemctl --user restart cliproxyapi
systemctl --user stop cliproxyapi
journalctl --user -u cliproxyapi -f
```

## 安全边界

- 代理仅绑定回环地址；不要把 `8317` 直接暴露到公网。
- 不要在 Git 中提交 `config.yaml`、`.keys`、`~/.cli-proxy-api`、日志或数据库。
- Mac 不能直接使用 Linux 的 `127.0.0.1:8317`；需要 SSH 隧道或显式修改监听地址/防火墙后再配置。
- 本仓库只管理系统服务、版本和 Pi 模型同步，不复制上游 OAuth 凭证。
