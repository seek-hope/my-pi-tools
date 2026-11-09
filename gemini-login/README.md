# Gemini Login

为 Pi 提供 `gemini-login` 模型 provider，通过 Google 登录使用 Gemini CLI / Code Assist 权益。主要面向持有 Google AI Pro / Ultra 的个人账号；Google 允许的免费 Code Assist 账号也可登录。它使用账号的 CLI 额度，不能把 Gemini 网页额度转换为通用 Gemini API Key。

这是独立扩展。授权流程和接口依据 Google Gemini CLI v0.67.0；账号资格、模型开放范围和额度由 Google 决定。

## 安装与登录

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

打开 Pi 提供的 Google 授权链接，选择持有订阅的账号并授权，将 Google 页面显示的授权码粘贴回 Pi。扩展使用 PKCE，不启动本地 HTTP 服务；SSH 环境也可以在本机浏览器完成授权。一次登录最多等待五分钟，取消后可重新执行 `/login`。

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

个人账号通常会得到 Google 管理的项目。组织账号若要求显式项目，可在启动 Pi 前设置：

```bash
export GEMINI_LOGIN_PROJECT=your-google-cloud-project-id
pi
```

随后重新执行 `/login gemini-login`。使用项目 ID，不能填写项目数字编号；该项目仍需具备账号所要求的 Code Assist 权限。如果 Google 要求账号验证，请先在官方 Gemini CLI 中完成验证，再重试。

扩展仅接受 Google 返回的默认 onboarding tier，不主动选择付费升级，也默认不发送 `enabled_credit_types` 来启用额外 Google One AI Credits 消费。达到额度限制时返回错误，交由 Pi 的重试策略处理；不会自动切换至按量付费的 API Key。

Pi 中显示的 token 用量取自 Google 响应，包含缓存与 reasoning 分项。费用显示为零估算，表示不按 Gemini API 单价计费，不能用于判断订阅价格、剩余额度或 Google 最终账单。

## 常见问题

- 看不到 provider：确认安装成功并执行 `/reload`。查看扩展加载错误，而不是反复授权。
- 401 或 token 刷新失败：重新执行 `/login gemini-login`。网络错误和取消不会覆盖旧凭据。
- 403：检查当前 Google 账号的订阅、资格及项目权限。
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

测试使用模拟 HTTP 响应覆盖授权码与 PKCE、项目 onboarding、刷新与取消、SSE 分片、图片和工具往返、错误与用量，并在真实 Pi SDK 会话内执行直接工具和 codemode 调用。它们不连接 Google，也不验证账号资格或实时模型开放情况。CI 在 Node 22/24 上检查 Pi 1.5.0 基线与最新稳定版。

实际验收需本人登录，然后让所选 Gemini 模型回答简单问题并读取一个测试文件；这些请求会消耗账号额度。不要将授权码或 token 粘贴到模型对话中，应仅粘贴到 Pi 的登录输入框。

实现入口为 [src/index.ts](src/index.ts)，OAuth 与项目识别位于 [src/auth.ts](src/auth.ts)，请求转换和流式适配位于 [src/stream.ts](src/stream.ts)。网络请求固定使用 Google OAuth 与 Code Assist 域名并拒绝 HTTP 重定向。调用方的 payload / response / fetch hooks 仍遵循 Pi provider 接口，属于受信任的宿主扩展代码。

参考：[官方认证说明](https://geminicli.com/docs/get-started/authentication/)、[额度说明](https://geminicli.com/docs/quota-and-pricing/)、[官方实现 v0.67.0](https://github.com/google-gemini/gemini-cli/tree/v0.67.0/packages/core/src/code_assist)。公共 installed-app OAuth 客户端标识的来源见 [NOTICE](NOTICE)。
