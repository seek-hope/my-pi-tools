# Pi 模型目录同步

Linux / macOS 主机工具，使用当前 Pi 的运行时和配置校验器刷新目录；不调用模型推理。原生目录（包括 OpenAI Codex、Kimi for Coding、DeepSeek）交由 Pi 刷新 `models-store.json`，仅刷新已配置认证且支持目录刷新的 provider。目录可见性不等于账号有推理权限。

`check-pi-models --sync` 在 `models.json` 内向已配置的 ByteSeek、OrcaRouter、CLIProxyAPI、AI-Life 追加符合条件的模型。保留 JSONC 注释、现有条目、默认模型、端点及认证配置；只做追加，不自动删除目录未列出的旧模型，也不更新已存在条目的参数。失败、空目录或异常响应不会清除上次成功快照。认证由 Pi 处理，必要时可能正常刷新 OAuth 凭据。

| 来源 | 同步规则 |
| --- | --- |
| ByteSeek | 聊天模型需要精确匹配的可信元数据。图像使用单独的 `byteseek-images` 凭据和目录，不写进聊天列表。网关返回有效列表但未列出图像模型时，跳过图像同步并保留已有列表。 |
| OrcaRouter | 按现有 Anthropic、Gemini、OpenAI、Cyber 命名空间和各自协议匹配；需有文本用途及足够元数据。 |
| CLIProxyAPI | 限本地 `127.0.0.1:8317`，新 ID 需要管理目录提供文本模型定义。目录为空时，仅在本地管理接口确认全部凭据已停用后才标记为跳过；原因不明仍报错。 |
| AI-Life | HTTPS 可查询认证列表；公网 HTTP 只允许查询本机显式指定同源的匿名 `/api/pricing`，**不发送密钥**。新增 GPT 条目使用 Chat Completions。按同 ID 的可信元数据开启 `reasoning`；支持 `xhigh` 的推理模型写入 `thinkingLevelMap: {"xhigh":"xhigh"}`，在 Pi 用 `/thinking xhigh` 选择。此路径不推定 `max`，目录也不证明账号授权。 |

未知用途、协议或上下文/输出规格不足的模型会保留在报告，不盲目注册。列表请求不跟随重定向；其他非回环 HTTP 地址不发送密钥。真实配置、凭据和模型目录状态不进入 Git。

## 安装和操作

需要 Python 3、Node.js ≥ 22.19 和 Pi（验证版本 1.5.2）。Linux 使用用户级 systemd、Bash 和 `flock`；macOS 使用已登录用户的 launchd：

```bash
python3 models-updater/install.py --dry-run  # Linux
python3 models-updater/install.py
python3 models-updater/install_macos.py      # macOS
check-pi-models --sync          # 手动同步，不受时间窗口限制
check-pi-models                 # 刷新原生目录，网关只检查
```

`--notify` 启用桌面提醒。默认通过 `~/.pi/agent/install/current-version` 定位 Pi 包；外部安装可设置 `PI_MODELS_PACKAGE_DIR` 自定义包根目录，`PI_CODING_AGENT_DIR` 可自定义 agent 目录。设置 `PI_OFFLINE` 时不执行联网操作。

若安装了支持目录读取的 `extensions/byteseek-images.ts`，它应从 agent 目录读取 `byteseek-image-catalog.json`，与原有图像模型合并；此扩展不是仓库的一部分，未配置时图像同步会报告跳过。AI-Life 匿名 HTTP 目录需把确认的公开源写在 `${XDG_CONFIG_HOME:-$HOME/.config}/pi-model-updates/ai-life-origin`（只写 origin，无路径、密钥和尾斜杠），并与 `models.json` 中 `ai-life` 的 HTTP API 地址同源。

如果 OrcaRouter 的认证来自 `ORCA_API_KEY`，确保 systemd 服务能读取它：可通过服务 drop-in 的 `LoadCredential=orca-api-key:/绝对路径/密钥文件` 提供，密钥文件只含密钥，权限 `600`；不要把密钥写进 unit、命令行或仓库。

## 定时与报告

Linux 的 `check-pi-models.timer` 和 macOS 的 `com.my-pi-tools.check-pi-models` 每天按本机时间 **20:00–22:00** 随机启动，窗口外不补跑。手工和定时执行共用进程锁。macOS 安装器将执行文件复制到 `~/.local/share/my-pi-tools/models-updater/`，不依赖 Desktop 路径；如果终端的 OrcaRouter 或 Kimi 环境变量在后台不可用，启动器可读取 `~/.config/pi-model-updates/{orca-api-key,kimi-api-key}`，文件只含当前机器的密钥，权限 `600`，已有环境变量优先。

停用任务：Linux 用 `systemctl --user disable --now check-pi-models.timer`；macOS 用 `launchctl disable gui/$(id -u)/com.my-pi-tools.check-pi-models` 和 `launchctl bootout gui/$(id -u)/com.my-pi-tools.check-pi-models`。

`~/.local/state/pi-model-updates/`（支持 `XDG_STATE_HOME`）保存 `last-report.txt`、`status.json`、最近一次实际写入的 `last-write-report.txt` 及上一版 `models.json.previous`。原配置只在实际写入前以 `600` 权限留存一份；目标文件先通过 Pi 校验再原子替换，过程中如发现人工修改则跳过写入。运行失败返回非零，保留成功源的独立观测。报告不保存密钥、请求头或原始响应。已有 Pi 会话运行 `/reload` 重新加载图像模型及配置。

离线验证：`npm run test:models`。覆盖协议与模型类型、匿名目录、JSONC 定点追加、已有配置保护、并发检查、失败恢复、时间窗口及安全写入。
