# Gemini Pro 反向代理管理

把本机的 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 纳入本仓库管理。CLIProxyAPI 将 Gemini/Claude 订阅额度转换为本地 OpenAI 兼容 API，Pi 通过 `models.json` 的 `cliproxy` provider 使用它。

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

## 更新

```bash
update-cliproxyapi --check
update-cliproxyapi --dry-run
update-cliproxyapi
```

更新器从 GitHub Releases 下载当前平台的压缩包，校验 `checksums.txt`，安装到新的版本目录，原子切换 `current` 与 `~/.local/bin/cliproxyapi`，再重启用户服务。失败会恢复旧链接。每日 CLI 更新器也通过 `tools.json` 调用它。

## macOS（launchd）

同一套 `install.py` 会自动识别 macOS，不再使用 systemd：

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
