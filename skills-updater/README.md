# Skills 自动更新

集中管理本机 `~/.agents/skills/` 的自动更新脚本和用户级 systemd 定时器。这是独立的主机维护工具，不是 Pi 扩展；不需要 `pi install`，也不调用模型。

仓库保存更新程序、默认包来源、service/timer、安装器和离线测试。技能内容、个人安装清单、登记信息、缓存、更新报告及备份留在用户目录，不进入 Git。

## 安装与迁移

需要 Linux、Python ≥ 3.10、Git 和用户级 systemd。更新 `uv-tool` 来源还需要 `uv` 和已经安装的对应工具；桌面通知可选依赖 `notify-send`。本机默认包来源为 `browser-use`。

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
| `~/.config/systemd/user/check-agent-skills.service` | `skills-updater/systemd/check-agent-skills.service` |
| `~/.config/systemd/user/check-agent-skills.timer` | `skills-updater/systemd/check-agent-skills.timer` |

安装器支持 `XDG_CONFIG_HOME` 和 `XDG_STATE_HOME`，不会覆盖技能、`.skill-lock.json` 或已有 `registry.json`。原脚本和 unit 文件备份到 `~/.local/state/scientific-skills-check/install-backups/<时间戳>/`。重复安装不会重复备份已正确指向仓库的链接；更新正在运行时拒绝切换。文件替换或 systemd 激活失败时，安装器尝试恢复原入口和定时器状态。

`--no-systemd` 只安装链接，不操作定时器，适合离线部署和测试；不要在旧更新任务运行时使用。安装不会主动运行更新服务，但启用 `Persistent=true` 的定时器时，systemd 可能补执行错过的计划。

仓库路径必须长期可访问。迁移仓库位置前先停用定时器，在新位置重新运行安装器；之后查看链接与定时器状态，避免旧的绝对路径失效。脚本变更直接从仓库生效；修改 unit 文件后重新运行安装器，或执行 `systemctl --user daemon-reload` 并重启定时器。

## 调度与手动操作

默认按本机时区，每天 **09:00 后随机延迟 0–10 分钟**运行。错过执行时间会在用户级 systemd 恢复后补执行。不设置系统级任务、不修改 linger，也不调整其他定时器。

```bash
# 查看下次执行时间和最近结果
systemctl --user list-timers check-agent-skills.timer
systemctl --user status check-agent-skills.service
journalctl --user -u check-agent-skills.service -n 50 --no-pager

# 只检测：刷新 Git 缓存、生成报告，但不更新技能和来源记录
~/.local/bin/check-agent-skills --dry-run

# 立即更新（也会升级登记的 uv 工具）
systemctl --user start check-agent-skills.service

# 暂停自动更新
systemctl --user disable --now check-agent-skills.timer
```

`--dry-run` **并非完全不写磁盘**：它仍会刷新 Git 缓存、写入报告、历史和状态文件；不会升级 uv 工具、替换技能、备份技能或改写来源记录。包来源只比较当前已安装版本，不查询远端包是否有新版本。

更新失败返回非零状态，让 systemd 和手动调用能够识别失败。运行中的任务与手动检测共享文件锁，重复启动会退出，不同时修改同一份技能和来源记录。

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
uv tool install --force 'markitdown[pptx]'
markitdown deck.pptx
```

`agent-desktop` 的 CLI 不在技能目录里，由 npm 单独管理。本机已将它链接到 `~/.local/bin/agent-desktop`，并确认 `agent-desktop status` 能读取当前 Wayland 会话的 AT-SPI 权限。CLI 更新不经过技能定时器，需要手动执行：

```bash
npm install -g --allow-scripts=agent-desktop agent-desktop@latest
agent-desktop status
```

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

恢复技能前先停用定时器，确认更新服务不在运行，再从 `backups/` 复制所需版本；重新启用后仍会按上游同步。恢复旧机制时，用 `install-backups/` 内的脚本和 unit 替换对应链接，执行 `systemctl --user daemon-reload`，再按需要启用定时器。备份和历史不会自动清理。

Pi 在启动或 `/reload` 时重新加载技能。定时更新完成不会强制刷新正在运行的 Pi 会话。

## 开发与验证

无第三方 Python 运行依赖。仓库根目录执行：

```bash
python3 -B -m unittest discover -s skills-updater/test -v
# 等价入口，也纳入根 npm test 和 CI
npm run test:skills
```

测试使用临时 HOME、本地 Git 上游和模拟 uv/systemd，不访问 GitHub、不升级真实工具、不修改本机技能。覆盖目录哈希、更新与还原、备份、dry-run、上游移除、自动登记、失败退出、并发锁、非法状态、分阶段替换、安装幂等及回滚。真实 systemd 调度和本机来源检查另行验证，离线测试不代替它们。
