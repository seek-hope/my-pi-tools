# Gemini Login（旧版 Code Assist）

为 Pi 提供 `gemini-login` 模型 provider，使用旧版 Gemini CLI / Code Assist 的 Google OAuth 入口。仅适用于 Google 仍支持的 Code Assist 账号与许可，例如符合要求的组织 Standard / Enterprise 账号。

**个人 Google AI Pro / Ultra 订阅不再适用于此入口。** Google 已于 **2026 年 6 月 18 日**停止通过 Gemini CLI / Code Assist 服务个人免费账号及 Google AI Pro / Ultra 用户，并要求迁移至 Antigravity。见 [Google 官方停用公告](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)和 [Gemini CLI 官方说明](https://github.com/google-gemini/gemini-cli/blob/v0.67.0/README.md)。设置项目 ID、重新授权或升级订阅不能恢复这个已停用的个人入口。

这是独立扩展，授权流程和接口依据 Gemini CLI v0.67.0。它不实现 Antigravity 登录，也不能将个人订阅转换成通用 Gemini API Key。组织许可另有服务生命周期，账号资格和模型开放范围仍以 Google 为准。

## 安装与登录（符合要求的组织账号）

需要 Node.js ≥ 22.19、Pi ≥ 1.5.0 稳定版。在仓库根目录执行：

```bash
npm --prefix gemini-login ci --ignore-scripts
pi install ./gemini-login
```

在 Pi 中执行：

```text
/reload
/login gemini-login
```

Pi 中显示名称为 `Google Code Assist (legacy)`，provider ID 仍为 `gemini-login`。打开授权链接，选择拥有相应 Code Assist 组织许可的账号，将 Google 页面显示的授权码粘贴回 Pi。扩展使用 PKCE，不启动本地 HTTP 服务；SSH 环境也可以在本机浏览器完成授权。一次登录最多等待五分钟，取消后可重新执行 `/login`。

登录后通过 `/model` 选择 `gemini-login` 下的模型。也可以启动新会话：

```bash
pi --provider gemini-login --model gemini-3.1-pro-preview
```

当前目录包含以下具体模型。列出模型不表示你的账号已获访问权限；服务端可能返回 403 或 404。

| 模型 ID | 显示名称 |
| --- | --- |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview |
| `gemini-3-flash` | Gemini 3.5 Flash，对应官方 CLI 的 Code Assist backend 名称 |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite |
| `gemini-2.5-pro` | Gemini 2.5 Pro |

模型的上下文、图片限制和 thinking 能力复用 Pi 的 Google 模型目录。支持文本与图片输入、流式回答、thinking、工具调用和多轮工具结果；工具既可直接调用，也可通过启用的 codemode 调用。本扩展不额外注册模型工具。

## 凭据、项目与额度

Access token、refresh token、过期时间和 Code Assist 项目 ID 交由 Pi 的凭据存储管理，默认保存在 Pi agent 目录的 `auth.json`。不要提交或分享该文件。扩展不读取 Gemini CLI 的现有凭据文件，也不另建 token 缓存；Pi 负责串行刷新和保存更新后的凭据。

重新登录可切换账号。使用 `/logout` 选择此 provider，可从 Pi 删除凭据；若要撤销 Google 端授权，请使用 Google 账号的第三方应用授权管理页面。

Google 可能返回账号已关联的项目。组织许可若需要显式指定项目，请使用管理员配置并授予权限的项目，在启动 Pi 前设置：

```bash
export GEMINI_LOGIN_PROJECT=your-google-cloud-project-id
pi
```

随后重新执行 `/login gemini-login`。使用项目 ID，不能填写项目数字编号；该项目仍需具备账号所要求的 Code Assist 权限。如果 Google 要求账号验证，请先在官方 Gemini CLI 中完成验证，再重试。

扩展使用 Google 返回的默认 onboarding tier；未返回默认值时，采用官方 CLI 的 `legacy-tier` 回退。账号能否完成初始化由 Google 决定。扩展不主动选择付费升级，也默认不发送 `enabled_credit_types` 来启用额外 Google One AI Credits 消费。达到额度限制时返回错误，交由 Pi 的重试策略处理；不会自动切换至按量付费的 API Key。

Pi 中显示的 token 用量取自 Google 响应，包含缓存与 reasoning 分项。费用显示为零估算，表示不按 Gemini API 单价计费，不能用于判断订阅价格、剩余额度或 Google 最终账单。

## 常见问题

- 看不到 provider：确认安装成功并执行 `/reload`。查看扩展加载错误，而不是反复授权。
- `UNSUPPORTED_CLIENT`：Google 拒绝了这个客户端。个人免费及 Pro / Ultra 入口已经停用，请按官方公告迁移；反复授权无法恢复。
- `UNKNOWN` 或其他新错误码：扩展会保留服务端错误码和脱敏后的 `reasonMessage`，并标明失败阶段。不能只根据 `UNKNOWN` 推断地区、年龄或项目问题。
- 401 或 token 刷新失败：符合要求的组织账号可重新执行 `/login gemini-login`。网络错误和取消不会覆盖旧凭据。
- 提示缺少项目：Google 完成初始化后仍未返回项目。先查看是否同时出现账号资格限制；确实需要自有项目时再设置 `GEMINI_LOGIN_PROJECT`。
- 403：检查组织许可、账号资格及项目权限。初始化失败时会附上 Google 返回的资格原因和说明。诊断会隐藏本次登录的 token、授权码、配置的项目 ID 和邮箱，不保存完整响应或额外凭据副本。
- 404：该模型或资源可能尚未向账号开放，尝试目录中的其他模型。
- 429：CLI / Code Assist 额度或速率受到限制，等待恢复；网页聊天是否可用不能证明 CLI 额度仍有剩余。
- 流中断或缺少结束事件：返回错误并保留已收到的文本，避免把不完整回答当作成功。

不支持 Antigravity、Gemini 网页会话 cookie、服务账号或 Vertex AI。这些是不同的认证与产品入口。

## 开发与验证

```bash
npm --prefix gemini-login run check
npm --prefix gemini-login test
npm --prefix gemini-login run check:format
```

测试使用模拟 HTTP 响应覆盖授权码与 PKCE、项目 onboarding、停用客户端与未知错误诊断、凭据脱敏、刷新与取消、SSE 分片、图片和工具往返、错误与用量，并在真实 Pi SDK 会话内执行直接工具和 codemode 调用。它们不连接 Google，不能证明账号具备资格，也不能证明个人订阅入口仍然可用。CI 在 Node 22/24 上检查 Pi 1.5.0 基线与最新稳定版。

实际验收需本人登录，然后让所选 Gemini 模型回答简单问题并读取一个测试文件；这些请求会消耗账号额度。不要将授权码或 token 粘贴到模型对话中，应仅粘贴到 Pi 的登录输入框。

实现入口为 [src/index.ts](src/index.ts)，OAuth 与项目识别位于 [src/auth.ts](src/auth.ts)，请求转换和流式适配位于 [src/stream.ts](src/stream.ts)。网络请求固定使用 Google OAuth 与 Code Assist 域名并拒绝 HTTP 重定向。调用方的 payload / response / fetch hooks 仍遵循 Pi provider 接口，属于受信任的宿主扩展代码。

参考：[官方认证说明](https://geminicli.com/docs/get-started/authentication/)、[额度说明](https://geminicli.com/docs/quota-and-pricing/)、[官方实现 v0.67.0](https://github.com/google-gemini/gemini-cli/tree/v0.67.0/packages/core/src/code_assist)。公共 installed-app OAuth 客户端标识的来源见 [NOTICE](NOTICE)。
