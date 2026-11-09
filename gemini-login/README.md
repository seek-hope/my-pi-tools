# Antigravity ACP for Pi

在 Pi 的独立聊天界面中使用官方 Antigravity agent。扩展启动 `agy acp`，通过 [Agent Client Protocol（ACP）](https://antigravity.google/docs/ide/extensions/acp/) 转发消息、工具执行状态、文件修改和权限请求。Google 登录、模型调用、工具执行及会话上下文均由官方客户端管理。

适用于希望通过官方 Antigravity 使用个人 Google AI Pro / Ultra 权益的用户；具体账号资格、可选模型和配额由 Google 决定。本扩展是社区 ACP 客户端，不代表 Google 官方产品。

包名和目录保留为 `my-pi-gemini-login` / `gemini-login`，入口是 `/antigravity`。它不注册 Pi 模型 provider，也不注册供模型或 codemode 调用的代理工具。

## 安装与登录

需要 Node.js ≥ 22.19、Pi ≥ 1.5.0 稳定版，以及支持 ACP 的官方 Antigravity CLI。本项目已用 Linux 上的 `agy 1.5.3` 验证真实 ACP 握手和未登录响应。

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

该值只允许表达可执行文件路径，不能追加参数或 shell 命令。修改环境变量后需在该环境中重新启动 Pi。

## 使用

Pi 命令：

| 命令 | 行为 |
| --- | --- |
| `/antigravity` | 打开聊天界面；载入本 Pi 会话关联的官方会话，或创建新会话 |
| `/antigravity new` | 明确创建新的官方会话 |
| `/antigravity login` | 请求官方个人 Google 登录，随后打开会话 |
| `/antigravity <消息>` | 打开会话并发送第一条消息；不会清除启动期间输入的草稿 |

当前 Pi 任务结束后才能打开界面。这个界面直接与官方 agent 对话，不需要先调用 Pi 的主模型。

界面内命令：

| 命令 | 行为 |
| --- | --- |
| `/new` | 创建新会话 |
| `/load <会话 ID>` | 载入指定官方会话；失败时不会自动换成其他会话 |
| `/login` | 通过官方客户端登录个人 Google 账号 |
| `/model` | 选择服务端当前提供的模型 |
| `/config` | 查看和调整服务端提供的设置，包括思考等级 |
| `/cancel` | 取消当前任务 |
| `/help` | 显示本地命令及服务端命令列表 |
| `/exit` | 关闭聊天界面，返回 Pi |

其余消息和命令发给 Antigravity。模型名和思考等级来自当前服务端响应，不使用写死的模型清单，也不伪装为其他 ACP 客户端获取额外模型。

- `Enter` 发送，`Shift+Enter` 换行；任务执行期间可以编辑下一条草稿，完成后再发送。
- `PageUp` / `PageDown` 滚动，`Ctrl+End` 回到底部。
- `Esc` 取消正在执行的任务，包括待处理的授权；空闲时清空草稿，再按一次返回 Pi。
- `Ctrl+D` 取消任务并返回 Pi。重复退出或宿主关闭会等待同一次清理。
- 授权列表用方向键选择、`Enter` 确认；默认选中“取消此授权请求”。“持续允许”等选项的具体范围由官方服务决定。

工具输出、修改前后文本和计划会显示在对话中。当前支持文本输入；接收的图片、音频以占位文字显示，不支持附件上传或原生表单，未声明相应客户端能力。

## 会话与权限

Pi 只保存关联的官方会话 ID、项目路径和所属 Pi 会话 ID，不把主会话历史、系统提示或工具声明发送给 Antigravity。重新打开时通过 `session/load` 载入官方历史；派生到另一个 Pi 会话不会自动继承这条关联。Pi 的树导航不会回滚官方会话上下文，需要独立上下文时使用 `/new`。

Antigravity 使用自己的工具、项目规则、MCP 配置和权限策略。**这些工具不经过 Pi 的 `tool_call` / `executeTool` 权限 hook。** 官方客户端已有的允许或拒绝规则仍会生效，扩展只能展示服务端发来的权限请求；它不添加跳过权限的参数，也不代替用户批准请求。Helper 的只读范围和父权限 hook 不受影响。

取消时先撤销所有待处理授权，再发送 `session/cancel`；最多等待 5 秒确认。若服务端没有响应，会关闭扩展启动的本地 ACP 进程，并提示在官方客户端确认任务状态。不会终止共享 daemon 或其他进程；本地进程退出也不能证明远端任务已经停止。

显示内容与工具合并缓存有独立容量限制，截断会显示标记，不改变官方会话上下文。进程 stderr 会被消费，但不会复制到 Pi 对话；需要更详细诊断时查看官方 CLI 日志。ACP 格式错误、连接中断和非正常结束原因会明确显示，不能视作成功回答。该 agent 的用量不会合并到 Pi 主模型统计。

## 排障

- **找不到 CLI**：确认 `agy acp --help` 可用，或设置 `ANTIGRAVITY_ACP_COMMAND` 为完整路径。
- **Authentication required**：在界面内 `/login`；SSH 环境用终端 `agy acp --login`，再重新打开界面。
- **载入失败**：确认会话属于当前官方账号；使用 `/new` 可明确开始新会话。
- **模型不可用、配额耗尽或账号不合格**：以 Google 返回的结果为准，扩展不会换账号、换客户端身份或自动切换计费方式。
- **只看到旧的 `/login gemini-login`**：执行 `/reload`。当前版本已移除旧 Code Assist provider，不再使用 `GEMINI_LOGIN_PROJECT`。

Google 明确区分 [官方 ACP 客户端集成](https://antigravity.google/docs/ide/extensions/acp/) 与 [第三方复用产品 OAuth、封装消费者 headless 模式](https://antigravity.google/docs/faq/)。本扩展实现的是交互式 ACP 客户端，不把官方登录 token 转接成 Pi 的模型 API。

## 开发与验证

```bash
npm --prefix gemini-login ci --ignore-scripts
npm --prefix gemini-login run check
npm --prefix gemini-login test
npm --prefix gemini-login run check:format
```

离线测试使用独立 ACP 测试进程，覆盖协议校验、会话恢复、动态模型设置、真实临时文件的授权/拒绝、并发授权取消、退出清理、损坏数据、显示容量、中文终端布局和原生 Pi 扩展加载。测试不连接 Google，不消耗订阅额度。

真实官方握手与未登录错误验证不等于账号可用性验收；个人账号的登录、模型权限和实际回答需要在官方登录完成后验证。CI 覆盖 Node 22/24 与 Pi 1.5.0 / 最新稳定版。
