# CLIProxyAPI 本地服务

这里管理 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的安装入口、版本更新和用户服务。Pi 接入 Gemini 不依赖此服务：用 `pi auth login google --api-key` 配置 [Google AI Studio](https://aistudio.google.com/apikey) 的项目密钥。Antigravity 的个人订阅登录不是第三方模型 API；参见 [Google FAQ](https://antigravity.google/docs/faq/)。

## 安装和配置

```bash
python3 gemini-proxy/install.py --dry-run
python3 gemini-proxy/install.py --no-service
# 在本机编辑配置并准备允许用于该网关的凭据，再安装或启动服务
python3 gemini-proxy/install.py
```

安装器仅在配置缺失时复制 [config.example.yaml](config.example.yaml)，不覆盖已有配置。默认只监听 `127.0.0.1:8317`。在启用服务前设置非空的客户端密钥和管理密钥；管理接口不要开放给远程主机。配置与密钥文件保持 `600`，私有目录保持 `700`。不要提交真实配置、OAuth 文件、日志或数据库。

| 用途 | 路径 |
| --- | --- |
| 程序和当前版本链接 | `~/.local/opt/cliproxyapi/<version>`、`~/.local/opt/cliproxyapi/current` |
| 命令入口 | `~/.local/bin/cliproxyapi`、`~/.local/bin/update-cliproxyapi` |
| 配置和私有状态 | `~/.config/cliproxyapi/config.yaml`、`~/.cli-proxy-api/` |
| Linux 用户服务 | `~/.config/systemd/user/cliproxyapi.service` |
| macOS 用户服务 | `~/Library/LaunchAgents/com.my-pi-tools.cliproxyapi.plist` |

## 更新与模型目录

```bash
update-cliproxyapi --check
update-cliproxyapi --dry-run
update-cliproxyapi
```

更新器按当前平台下载 release、核对 SHA-256、切换版本链接并重启服务。日常更新由 [技能与 CLI 更新器](../skills-updater/README.md) 执行。macOS 若已安装统一定时任务，代理安装器会跳过单独的更新定时器；单独安装时可用 `--no-timer` 跳过该定时器。

Pi 中**已有模型条目**的 `cliproxy` provider 可由 [模型目录同步器](../models-updater/README.md) 维护：`check-pi-models --sync` 仅追加符合条件的模型，不重建整个模型列表，也不发送推理请求。若上游停用凭据，检查服务状态，不要重新启用受限凭据。

## 查看运行状态

```bash
# Linux
systemctl --user status cliproxyapi.service
journalctl --user -u cliproxyapi.service

# macOS
launchctl print gui/$(id -u)/com.my-pi-tools.cliproxyapi
```

macOS 服务日志位于 `~/Library/Logs/cliproxyapi.log` 和 `cliproxyapi.err.log`。保留本机的出站网络设置，不要跨机器复制密钥或授权文件。
