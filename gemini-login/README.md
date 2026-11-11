# Antigravity ACP for Pi

在 Pi 的独立聊天界面中使用官方 Antigravity agent。扩展通过 [Agent Client Protocol（ACP）](https://antigravity.google/docs/ide/extensions/acp/) 转发消息、工具执行状态、文件修改和权限请求。Google 登录、Antigravity 模型调用、工具执行及官方会话上下文由 `agy` 管理；待授权操作默认由 **Pi 当前选中的模型**做风险审核，普通操作自动批准本次，高风险或无法判断时请你确认。

适用于希望通过官方 Antigravity 使用个人 Google AI Pro / Ultra 权益的用户；账号资格、可选模型和配额由 Google 决定。本扩展是社区 ACP 客户端，不代表 Google 官方产品。**Pi 模型的审核用量独立于 Antigravity 订阅额度**，可用 `/permissions manual` 关闭自动审核。

包名和目录保留为 `my-pi-gemini-login` / `gemini-login`，入口是 `/antigravity`。它不注册 Pi 模型 provider，也不注册供模型或 codemode 调用的代理工具。

## 安装与登录

需要 Node.js ≥ 22.19、Pi ≥ 1.5.0 稳定版，以及支持 ACP 的官方 Antigravity CLI。已在 Linux、Pi 1.5.1、`agy 1.5.5` 上验证真实个人账号回答和自动审核后的命令执行。

1. 按 [Google 安装说明](https://antigravity.google/docs/getting-started/) 安装 Antigravity CLI，然后确认：

   ```bash
   agy --version
   agy acp --help
   ```

2. 在本仓库根目录安装 Pi 扩展：

   ```bash
   npm --prefix gemini-login ci --ignore-scripts
   pi install ./gemini-login
   ```

3. 在 Pi 中执行：

   ```text
   /reload
   /antigravity login
   ```

   浏览器登录由官方 `agy` 发起，选择你的个人 Google 账号。凭据由官方客户端保存；无需把授权码或 token 发给 Pi 的主模型。已有有效登录时，直接 `/antigravity` 即可。

SSH 环境或浏览器不能自动打开时，在普通终端运行：

```bash
agy acp --login
```

按官方提示完成登录，再重新打开 `/antigravity`。扩展不实现自己的 OAuth、不读取或迁移旧 Pi 登录凭据，也不自动切换到 API Key / Vertex 认证。配额及已启用的额外额度按 Google 账号和官方客户端设置执行。

默认优先使用 `~/.local/bin/agy`，否则从 `PATH` 查找 `agy`。可以显式指定可执行文件路径：

```bash
export ANTIGRAVITY_ACP_COMMAND=/absolute/path/to/agy
```

该值只表示可执行文件路径，不能追加参数或 shell 命令。扩展以 `agy acp --sandbox` 启动官方客户端；沙箱是否可用及其边界由官方 CLI 和操作系统决定。修改环境变量后需重新启动 Pi。

## 使用

Pi 命令：

| 命令 | 行为 |
| --- | --- |
| `/antigravity` | 打开界面，载入当前 Pi 分支关联的官方会话，或创建新会话 |
| `/antigravity new` | 明确创建新的官方会话 |
| `/antigravity resume` | 搜索并恢复当前项目的官方会话 |
| `/antigravity login` | 请求官方个人 Google 登录，随后打开会话 |
| `/antigravity <消息>` | 打开会话并发送第一条消息；需要登录时暂存，保留启动期间输入的草稿 |

当前 Pi 任务结束后才能打开界面。输入直接发送给官方 agent；只有需要自动风险审核时才调用 Pi 模型。

界面内命令：

| 命令 | 行为 |
| --- | --- |
| `/new` | 创建新会话 |
| `/resume` | 搜索当前项目的会话列表，支持继续加载下一页 |
| `/resume <ID>`、`/load <ID>` | 载入指定官方会话；失败时不会自动换成其他会话 |
| `/login` | 通过官方客户端登录个人 Google 账号 |
| `/model [关键词]` | 搜索并选择服务端提供的模型 |
| `/thinking [关键词]` | 选择服务端提供的思考等级 |
| `/settings`、`/config` | 调整官方会话设置 |
| `/permissions [auto\|manual]` | 选择 Pi 模型自动审核，或全部由用户确认 |
| `/cancel` | 取消当前任务及所有待处理授权 |
| `/status` | 查看项目、会话、审核模型和本次打开期间的审核用量 |
| `/help`、`/hotkeys` | 查看本地命令、官方命令及当前快捷键 |
| `/exit`、`/quit` | 返回 Pi |

其余消息和命令发给 Antigravity。命令、文件路径、模型参数使用 Pi 原生补全；模型和思考等级来自当前服务端响应。选择器支持搜索，并默认选中当前配置值。服务端未提供会话列表时，可用会话 ID 恢复。

编辑器、选择器、主题和快捷键使用 Pi 的公开原生组件。以下为默认按键；修改 Pi 的相应 action 绑定后，界面操作和提示随之变化。

| 按键 | 行为 |
| --- | --- |
| `Enter` | 发送；执行中发送为补充指令（steering） |
| `Shift+Enter` | 换行 |
| `Alt+Enter` | 排队后续消息，完整任务正常结束后发送 |
| `Alt+Up` | 将待发送队列取回输入框，保留当前草稿和完整粘贴文本 |
| `Ctrl+L` | 搜索 Antigravity 模型 |
| `Ctrl+P` / `Ctrl+Shift+P` | 切换到下一个 / 上一个模型 |
| `Shift+Tab` | 切换 Antigravity 思考等级 |
| `Ctrl+O` | 展开 / 折叠工具输出 |
| `Ctrl+T` | 显示 / 隐藏思考内容 |
| `PageUp` / `PageDown`、`Ctrl+End` | 滚动历史、回到底部；选择器中使用其自身的翻页绑定 |
| `Esc` | 先关闭补全；否则取消正在执行的任务；空闲时保留草稿 |
| `Ctrl+C` | 清空草稿；500 毫秒内再按一次返回 Pi |
| `Ctrl+D` | 输入框为空时返回 Pi；有内容时保留原生编辑行为 |

模型的补充指令确认不会提前结束原任务或发送后续队列。取消、错误、断线或非正常结束后，队列保留供取回编辑，不会自动继续执行。单条消息最多 120,000 字符，队列最多 32 条、合计 512,000 字符；拒绝入队时保留草稿。切换会话前会先取回未发送的队列。

工具输出默认折叠、思考默认隐藏；需要人工授权时，操作参数和 diff 单独完整展示，不受工具折叠影响。当前支持文本输入；图片、音频以占位文字显示，不支持附件上传或原生表单。

## 自动审核与人工授权

默认使用打开界面时 Pi 选中的具体模型审核操作。顶部显示 `自动审核(Pi)`，`/permissions` 显示审核模型和用量提示；在 ACP 内切换 Antigravity 模型不会更换审核模型。授权模式保存在当前 Pi 分支的项目关联中，重新打开或 `/antigravity new` 时保留选择。

审核模型只接收最近的 ACP 用户任务、当前项目路径和待授权操作的标题、参数、位置与内容，不继承 Pi 主会话历史、系统提示、工具、技能或 MCP。请求不提供执行工具，也不执行模型输出的工具调用。明确的低风险结论只选择服务端的 `allow_once`，不会自动选择持续允许。

- 普通项目读取、源码修改、构建、测试、lint 和格式化可由模型审核后自动执行。
- 删除、提权、发布、敏感文件、凭据、项目外的文件访问、沙箱绕过等明显风险直接交给用户；其他高风险、含糊或不完整操作由模型判断后转人工。
- 模型不可用、未选具体模型、结果格式错误、20 秒超时、并发审核繁忙或操作数据过长时，保留人工授权入口。
- 取消任务、退出、追加指令、切回人工审核或操作参数 / diff 更新后，原审核失效；迟到的批准不能执行。

人工列表默认选中“取消此授权请求”；方向键选择、`Enter` 确认，`Esc` 取消本轮全部待处理授权。持续允许选项只有用户明确选中才转发，其范围由官方服务决定。

`agy 1.5.5` 的 ACP 已提供官方 `auto` 模式（`1.5.3` 当时没有）；本扩展当前仍使用 Pi 模型审核，不会自动切换服务端 mode，以兼容尚未提供该模式的旧版本并保留完整的操作详情。两种机制的权限边界不同。[Google 官方 CLI 的 auto 模式](https://antigravity.google/docs/cli/modes/)有自己的可用条件。模型审核依赖提供的数据和模型判断，不能保证识别所有危险行为，也不构成安全沙箱；复杂脚本的真实副作用不能仅凭命令名确定。

`/status` 的审核请求数和已返回 token 只统计本次打开期间的独立审核请求。取消或超时后可能缺少最终用量；这些用量不会合并到 Pi 主对话统计，收费以所选 Pi provider 为准。要完全停止此类模型请求，使用 `/permissions manual`。

## 会话与执行边界

Pi 保存官方会话 ID、项目路径、所属 Pi 会话 ID 和授权模式，不把主会话历史、系统提示或工具声明发送给 Antigravity。重新打开时通过 `session/load` 载入官方历史；派生到另一个 Pi 会话不会自动继承关联。Pi 的树导航不会回滚官方上下文，需要独立上下文时使用 `/new`。

Antigravity 使用自己的工具、项目规则、MCP 配置和权限策略。**这些工具不经过 Pi 的 `tool_call` / `executeTool` 权限 hook。** 官方客户端已有的允许或拒绝规则优先，扩展只能审核实际转交给客户端的请求；界面内 `/permissions` 控制 Pi 审核策略，官方规则仍在 `agy` 中管理。扩展不添加跳过权限的参数。Helper 的只读范围和父权限 hook 不受影响。

取消时先撤销所有待处理授权，再发送 `session/cancel`，最多等待 5 秒确认。若服务端没有响应，会关闭扩展启动的本地 ACP 进程，并提示在官方客户端确认任务状态。重复退出或宿主关闭等待同一次清理；不会终止共享 daemon 或其他进程。本地进程退出也不能证明远端任务已经停止。

显示内容与工具合并缓存有独立容量限制，截断会显示标记，不改变官方会话上下文；不完整数据不会自动批准。进程 stderr 被消费但不会复制到 Pi 对话；详细诊断可查看官方 CLI 日志。ACP 格式错误、连接中断和非正常结束原因会明确显示。Antigravity 自身的用量也不合并到 Pi 主模型统计。

## 排障

- **找不到 CLI**：确认 `agy acp --help` 可用，或设置 `ANTIGRAVITY_ACP_COMMAND` 为完整路径。
- **Authentication required**：界面内 `/login`；SSH 环境用终端 `agy acp --login`，再重新打开界面。
- **载入失败**：确认会话属于当前官方账号；使用 `/new` 可明确开始新会话。
- **自动审核不可用**：确认打开界面前选中的 Pi 具体模型能正常调用；缺少凭据、虚拟路由模型或超时会转人工。
- **模型不可用、配额耗尽或账号不合格**：以 Google 返回的结果为准，扩展不会换账号、换客户端身份或自动切换计费方式。
- **只看到旧的 `/login gemini-login`**：执行 `/reload`。当前版本不再使用旧 Code Assist provider 或 `GEMINI_LOGIN_PROJECT`。

Google 区分 [官方 ACP 客户端集成](https://antigravity.google/docs/ide/extensions/acp/)与[第三方复用产品 OAuth、封装消费者 headless 模式](https://antigravity.google/docs/faq/)。本扩展实现交互式 ACP 客户端，不把官方登录 token 转接成 Pi 模型 API。

## 开发与验证

```bash
npm --prefix gemini-login ci --ignore-scripts
npm --prefix gemini-login run check
npm --prefix gemini-login test
npm --prefix gemini-login run check:format
```

离线测试使用独立 ACP 测试进程和模拟审核模型，覆盖协议校验、会话恢复与分页、编辑和补全、模型选择、自定义快捷键、steering 与队列、真实临时文件的授权 / 拒绝、风险审核、迟到结果、参数与 diff 变更、退出清理、损坏数据、容量限制和原生 Pi 扩展加载。不连接 Google 或审核 provider，不消耗模型额度。

CI 覆盖 Node 22/24 与 Pi 1.5.0 / 最新稳定版。模拟测试和 CI 不替代真实官方服务验收；账号资格、模型清单和 CLI 行为仍可能由 Google 调整。
