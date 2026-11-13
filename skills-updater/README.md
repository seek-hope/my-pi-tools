# Skills 与 CLI 自动更新

集中管理本机 `~/.agents/skills/` 的自动更新，以及 `agent-desktop`、`markitdown`、`codegraph`、`cliproxyapi` 四个 CLI 的更新命令和用户级定时器（Linux systemd、macOS launchd）。这是独立的主机维护工具，不是 Pi 扩展；不需要 `pi install`，也不调用模型。

仓库保存技能更新程序、CLI 清单、service/timer、安装器和离线测试。技能内容、个人安装清单、登记信息、缓存、更新报告及备份留在用户目录，不进入 Git。

## macOS 定时器

macOS 使用 launchd，不使用 systemd。链接脚本并安装每日任务：

```bash
python3 skills-updater/install_macos.py --dry-run
python3 skills-updater/install_macos.py
```

任务为 `com.my-pi-tools.update-pi-toolchain`，每天 09:00 本地时间启动，随机延迟 0–10 分钟，执行 `update-pi-toolchain`（技能 + CLI）。日志：

```text
~/Library/Logs/pi-toolchain-update.log
~/Library/Logs/pi-toolchain-update.err.log
```

检查或手动触发：

```bash
launchctl print gui/$(id -u)/com.my-pi-tools.update-pi-toolchain
launchctl kickstart -k gui/$(id -u)/com.my-pi-tools.update-pi-toolchain
tail -f ~/Library/Logs/pi-toolchain-update.log
```

只需链接、不安装定时器时加 `--no-timer`。全工具链定时器已包含 `cliproxyapi`，安装时会移除重复的单独代理定时器。技能目录和 `registry.json` 属于用户数据，不在仓库中；从已有机器迁移时需单独复制 `~/.agents/` 与 `~/.local/state/scientific-skills-check/registry.json`。

## 安装与迁移

需要 Linux 或 macOS、Python ≥ 3.9、Git；Linux 使用用户级 systemd，macOS 使用 launchd。更新 `uv-tool` 来源还需要 `uv` 和已经安装的对应工具；CLI 更新还需要 `npm`、`uv`、已安装的 `codegraph`，以及通过 `gemini-proxy/install.py` 安装的 `update-cliproxyapi`。桌面通知可选依赖 `notify-send`。本机默认包来源为 `browser-use`。

在仓库根目录运行：

```bash
# 仅显示链接目标，不改动文件或 systemd
python3 skills-updater/install.py --dry-run

# 备份原入口、建立链接并启用定时器
python3 skills-updater/install.py
```

安装后：

| 本机入口 | 仓库文件 |
| --- | --- |
| `~/.local/bin/check-agent-skills` | `skills-updater/check-agent-skills.py` |
| `~/.local/bin/update-clis` | `skills-updater/update-clis.py` |
| `~/.local/bin/update-pi-toolchain` | `skills-updater/update-pi-toolchain.py` |
| `~/.config/systemd/user/check-agent-skills.service` | `skills-updater/systemd/check-agent-skills.service` |
| `~/.config/systemd/user/check-agent-skills.timer` | `skills-updater/systemd/check-agent-skills.timer` |

安装器支持 `XDG_CONFIG_HOME` 和 `XDG_STATE_HOME`，不会覆盖技能、`.skill-lock.json` 或已有 `registry.json`。原脚本和 unit 文件备份到 `~/.local/state/scientific-skills-check/install-backups/<时间戳>/`。重复安装不会重复备份已正确指向仓库的链接；更新正在运行时拒绝切换。文件替换或 systemd 激活失败时，安装器尝试恢复原入口和定时器状态。

`--no-systemd` 只安装链接，不操作定时器，适合离线部署和测试；不要在旧更新任务运行时使用。安装不会主动运行更新服务，但启用 `Persistent=true` 的定时器时，systemd 可能补执行错过的计划。

仓库路径必须长期可访问。迁移仓库位置前先停用定时器，在新位置重新运行安装器；之后查看链接与定时器状态，避免旧的绝对路径失效。脚本变更直接从仓库生效；修改 unit 文件后重新运行安装器，或执行 `systemctl --user daemon-reload` 并重启定时器。

## 调度与手动操作

默认按本机时区，每天 **09:00 后随机延迟 0–10 分钟**运行技能和 CLI 更新。错过执行时间会在用户级 systemd 恢复后补执行。不设置系统级任务、不修改 linger，也不调整其他定时器。service 的 `TimeoutStartSec=1800`，为较大的技能和官方 CLI 下载留出时间；服务用 `/usr/bin/python3` 启动包装器，避免继承项目的虚拟环境，PATH 中保留 npm 的 pi-node bin。

```bash
# 查看下次执行时间和最近结果
systemctl --user list-timers check-agent-skills.timer
systemctl --user status check-agent-skills.service
journalctl --user -u check-agent-skills.service -n 50 --no-pager

# 统一入口：技能 + CLI
~/.local/bin/update-pi-toolchain

# 只检查，不执行更新
~/.local/bin/update-pi-toolchain --dry-run

# 分开执行
~/.local/bin/update-pi-toolchain --skills-only
~/.local/bin/update-pi-toolchain --tools-only
~/.local/bin/update-clis --only codegraph

# 立即运行 systemd 服务；暂停自动更新
systemctl --user start check-agent-skills.service
systemctl --user disable --now check-agent-skills.timer
```

技能的 `--dry-run` **并非完全不写磁盘**：它仍会刷新 Git 缓存、写入报告、历史和状态文件；不会升级 uv 工具、替换技能、备份技能或改写来源记录。CLI 的 `--dry-run` 只读取当前版本并显示将要运行的命令，不查询远端最新版，也不执行任何更新命令。

两个更新器分别使用文件锁；同一更新器重复启动会退出。统一入口即使技能更新失败也会继续更新 CLI，最后以非零状态报告失败项。CLI 的单个工具失败不会阻塞后续工具。

## 来源与更新策略

延续本机已有策略：

- Git 来源从 `~/.agents/.skill-lock.json` 的 `skills` 条目读取；兼容其中的 `sourceUrl`、`skillPath`、`skillFolderHash`，保留其他字段。按来源默认分支的远端 `HEAD` 检查，不固定到安装时的 commit。
- Git 缓存使用浅克隆和部分克隆，比对技能目录的 Git tree 哈希，有变化时才按需取回文件。部分克隆是否节省流量取决于上游服务器支持。
- `registry.json` 补充包来源和未进入安装器锁文件的 Git 技能。首次缺少登记文件时，使用脚本内的 `DEFAULT_REGISTRY`；已有登记文件不会被默认值重置。
- 已安装但未登记的目录，如果名称匹配已知 Git 上游的技能，会自动登记到 `extraGitSkills`。不会把上游新增但本机未安装的技能全部装入。
- `uv-tool` 来源先运行 `uv tool upgrade <package>`，再同步包内技能目录；升级失败则不继续复制该包。默认 `browser-use` 路径为 `~/.local/share/uv/tools/browser-use/lib/python*/site-packages/browser_use/skills/browser-use`。
- 本地内容与记录哈希不同，更新前会备份，然后恢复为上游版本。`__pycache__`、`.pyc`、`.pyo` 不参与本地哈希；其余哈希遵循 Git 的文件和忽略规则。
- 上游已移除的技能保留本地副本并报告；无法识别来源的目录只报告，不删除。已登记但本机缺失的技能会重新安装。
- 技能先复制到临时目录，再替换原目录；复制失败不会先删除原技能。顶层技能是符号链接、无法计算本地哈希、来源路径非法或状态 JSON 损坏时拒绝覆盖。

`registry.json` 的配置示例：

```json
{
  "version": 1,
  "packageSkills": {
    "browser-use": {
      "type": "uv-tool",
      "package": "browser-use",
      "skillDirGlob": "~/.local/share/uv/tools/browser-use/lib/python*/site-packages/browser_use/skills/browser-use"
    }
  },
  "extraGitSkills": {}
}
```

该文件中的 `skillFolderHash`、`updatedAt` 等字段由运行时维护；不要提交整份个人状态到仓库。包路径使用非默认 `UV_TOOL_DIR` 时，需要在登记文件中调整 `skillDirGlob`。不再自动更新某项时，应在锁文件及登记文件中移除对应来源；仍在已知上游中同名存在的本地目录可能重新被发现。

**自动更新意味着持续信任上游内容。** 技能可以携带可执行脚本和指令，更新器不会审计这些内容，也不是沙箱。本地定制会被备份后覆盖；需要长期保留的修改应放在自己管理的来源中。这里迁移的是既有自动更新机制，不把第三方技能内容或其许可证并入本仓库。

## CLI 更新清单

CLI 命令、版本检查和超时由 [`tools.json`](tools.json) 声明。每个命令都是以 argv 数组执行的，不经过 shell；新增工具时加一个条目即可，删除或设 `enabled: false` 可停用。默认包含：

| id | 更新方式 | 说明 |
| --- | --- | --- |
| `agent-desktop` | `npm install -g --allow-scripts=agent-desktop agent-desktop@latest` | 安装后确保 `~/.local/bin/agent-desktop` 指向 npm 的 bin；技能文本仍由 Git 更新器同步 |
| `markitdown` | `uv tool install --python 3.12 --force 'markitdown[pptx]'` | 固定 Python 3.12，保留 PPTX 读取所需的 extra |
| `codegraph` | `codegraph upgrade` | 使用 CodeGraph 自己的版本目录和升级器，不使用 npm 覆盖 |
| `cliproxyapi` | `update-cliproxyapi` | 从 GitHub Releases 下载、校验 SHA-256、切换版本并重启 `cliproxyapi.service`；由 `gemini-proxy/` 提供 |

运行状态写入 `~/.local/state/pi-toolchain-updates/`：`last-report.txt`、`status.json`、`history.log` 和 `update.lock`。失败会保留在状态和 systemd journal 中；不会因为单个工具失败而跳过其余工具。工具缺失、更新命令超时或更新后版本检查失败都算失败。

`agent-desktop` 的 npm 安装脚本只对包名显式放行，不使用全局 `--ignore-scripts=false`；链接目标默认是 `~/.npm/bin/agent-desktop`，如果 npm 全局 prefix 不同，需要修改 `tools.json` 的 `link.target`。`codegraph` 仍由自身的上游更新器决定版本、签名和安装位置；`cliproxyapi` 的版本目录、校验和 systemd 重启由 `gemini-proxy/update.py` 负责；本仓库不复制它们的二进制或凭证。

## 已追加的技能与工具

本机在本轮追加了以下来源，并登记在个人 `registry.json` 的 `extraGitSkills` 中（不是仓库默认值）：

| 技能 / 工具 | 上游 | 仓库内目录 | 许可 |
| --- | --- | --- | --- |
| `pptx` | [anthropics/skills](https://github.com/anthropics/skills) | `skills/pptx` | Apache-2.0 |
| `ppt-master` | [hugohe3/ppt-master](https://github.com/hugohe3/ppt-master) | `skills/ppt-master` | MIT |
| `agent-desktop` | [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) | `skills/agent-desktop` | Apache-2.0 |
| `agent-desktop-linux` | 同上 | `skills/agent-desktop-linux` | Apache-2.0 |

登记后先运行 `check-agent-skills --dry-run` 确认待安装项，再运行 `check-agent-skills`。这四个技能会像其他 Git 来源一样按上游 `main` 更新；`ppt-master` 约 13,000 个文件、80 MB，首次安装或首次更新可能较慢。

**依赖说明**：本机的 `~/.local/bin/python3` 指向一个项目虚拟环境，不应把通用 PPT 依赖装进去。以下命令使用 `uv` 的临时环境，不修改该环境：

```bash
# Anthropic pptx：创建、缩略图、校验（已验证）
uv run --no-project --with python-pptx --with defusedxml --with lxml --with pillow \
  python "$HOME/.agents/skills/pptx/scripts/thumbnail.py" deck.pptx thumbs

# pptxgenjs 已全局安装；Node 脚本需要显式指定全局模块路径
NODE_PATH="$(npm root -g)" node make-deck.cjs

# PPT Master：完整性门禁（仅标准库）
python3 "$HOME/.agents/skills/ppt-master/scripts/attribution_guard.py"

# PPT Master：已用这组核心依赖验证 SVG → 原生 PPTX
uv run --no-project --with python-pptx --with XlsxWriter --with skia-pathops \
  --with uharfbuzz --with PyYAML --with pillow --with numpy \
  python "$HOME/.agents/skills/ppt-master/scripts/svg_quality_checker.py" . \
  --quick-generate --canonical-authoring --stage final --json
uv run --no-project --with python-pptx --with XlsxWriter --with skia-pathops \
  --with uharfbuzz --with PyYAML --with pillow --with numpy \
  python "$HOME/.agents/skills/ppt-master/scripts/svg_to_pptx.py" . -o out.pptx \
  --quick-generate --primary-language en

# 需要 OCR、PDF、音频、网页源等完整能力时（包含可选和 AGPL 组件，先阅读 requirements.txt）
uv run --no-project --with-requirements "$HOME/.agents/skills/ppt-master/requirements.txt" \
  python "$HOME/.agents/skills/ppt-master/scripts/svg_quality_checker.py" . \
  --quick-generate --canonical-authoring --stage final --json
uv run --no-project --with-requirements "$HOME/.agents/skills/ppt-master/requirements.txt" \
  python "$HOME/.agents/skills/ppt-master/scripts/svg_to_pptx.py" . -o out.pptx \
  --quick-generate --primary-language en
```

Anthropic 技能还建议用 `markitdown` 读取内容和做 QA；本机已安装带 PPTX 支持的版本：

```bash
uv tool install --python 3.12 --force 'markitdown[pptx]'
markitdown deck.pptx
```

`agent-desktop` 的 CLI 不在技能目录里，由 npm 安装并已链接到 `~/.local/bin/agent-desktop`；CLI 更新由上面的 `tools.json` 负责，也可手动执行 `npm install -g --allow-scripts=agent-desktop agent-desktop@latest`。本机确认 `agent-desktop status` 能读取当前 Wayland 会话的 AT-SPI 权限。

`--allow-scripts` 用于安装可选的本地原生二进制包装；不要全局打开 npm 脚本执行。`agent-desktop` 的技能文本来自 Git 上游，CLI 版本与技能文本可能短暂不一致；遇到命令差异时先升级 CLI，再用 `agent-desktop skills get platform` 读取与当前二进制匹配的平台指南。

## 本地文件与恢复

默认路径如下；缓存、状态、unit 路径分别遵循相应 XDG 环境变量。

| 路径 | 用途 |
| --- | --- |
| `~/.agents/skills/` | 实际技能目录，保持不变 |
| `~/.agents/.skill-lock.json` | 技能安装器的来源与哈希记录 |
| `~/.cache/skills-upstream/` | 上游 Git 缓存 |
| `~/.local/state/scientific-skills-check/registry.json` | 包来源及补充 Git 来源 |
| 同目录 `last-report.txt`、`status.json`、`history.log` | 最近报告、结构化状态和检查历史 |
| 同目录 `backups/<时间戳>/<技能名>/` | 被覆盖的本地技能修改 |
| 同目录 `install-backups/<时间戳>/` | 迁移前的脚本和 unit 文件 |
| 同目录 `update.lock` | 并发锁；不要在任务运行时删除 |
| `~/.local/state/pi-toolchain-updates/` | CLI 更新报告、状态、历史和并发锁 |

恢复技能前先停用定时器，确认更新服务不在运行，再从 `backups/` 复制所需版本；重新启用后仍会按上游同步。恢复旧机制时，用 `install-backups/` 内的脚本和 unit 替换对应链接，执行 `systemctl --user daemon-reload`，再按需要启用定时器。备份和历史不会自动清理。

Pi 在启动或 `/reload` 时重新加载技能。定时更新完成不会强制刷新正在运行的 Pi 会话。

## 开发与验证

无第三方 Python 运行依赖。仓库根目录执行：

```bash
python3 -B -m unittest discover -s skills-updater/test -v
# 等价入口，也纳入根 npm test 和 CI
npm run test:skills
```

测试使用临时 HOME、本地 Git 上游和模拟 npm/uv/codegraph/cliproxyapi 命令，不访问网络、不升级真实工具、不修改本机技能。覆盖目录哈希、更新与还原、备份、dry-run、上游移除、自动登记、失败退出、并发锁、非法状态、分阶段替换、安装幂等及回滚；CLI 测试还覆盖版本变化、缺失工具、失败隔离、超时、链接安全和统一入口。真实 systemd 调度和本机来源检查另行验证，离线测试不代替它们。
