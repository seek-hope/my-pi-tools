# pi-deepseek-web

Pi 扩展：把 **DeepSeek Search & Fetch API** 与 **Exa Search & Contents API** 合并为 `web_search` 和 `web_fetch` 两个工具。

- `web_search` → DeepSeek `/v1/tools/search` 和/或 Exa `/search`：返回排序后的网页结果（标题、URL、摘要、站点、日期）。
  - `provider="auto"`（默认）查询所有已配置 provider；两者都可用时用 reciprocal rank fusion 合并去重。
  - `provider="both"` 要求两个 provider 都可用；`"deepseek"` / `"exa"` 限定单一来源。
- `web_fetch` → DeepSeek `/v1/tools/fetch` 或 Exa `/contents`：抓取单个页面，返回标题与 Markdown 正文。默认优先 DeepSeek；DeepSeek 不可用或抓取失败时静默回退 Exa。

至少配置一个 API Key：`DEEPSEEK_API_KEY` 或 `EXA_API_KEY`。与当前选中的模型无关（任何 Pi 模型都能调用这两个工具）。Exa 通过 REST API 接入，不依赖 Exa MCP。

## 安装

在 `my-pi-tools` 根目录安装本地包：

```bash
pi install ./search
```

这会把包路径写入 Pi 个人配置。仅为当前项目安装：

```bash
pi install -l /absolute/path/to/my-pi-tools/search
```

临时加载入口文件，不写入配置：

```bash
pi -e /absolute/path/to/my-pi-tools/search/src/index.ts
```

本扩展是多文件 TypeScript 模块，不要只复制 `index.ts`。在已经运行的 Pi 中安装后执行 `/reload`。当前开发和测试使用 **Pi 1.4.0**，manifest 中的 Pi peer 范围为 `*`；这不表示所有版本均已验证。

## 配置

所有配置都通过环境变量，缺省值可直接使用。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | 可选；与 `EXA_API_KEY` 至少配置一个。未设置时回退读取 `~/.pi/agent/auth.json` 中 `deepseek` 凭据 |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_SEARCH_BASE_URL` | `https://api.deepseek.com` | API 基地址（可指向代理）；远程地址必须使用 HTTPS |
| `DEEPSEEK_WEB_ALLOW_INSECURE_BASE_URL` | `false` | 允许非回环 HTTP API 基地址；会明文发送 API key，仅限受控环境 |
| `DEEPSEEK_SEARCH_TIMEOUT_MS` | `20000` | 单次请求超时（1s–300s） |
| `DEEPSEEK_SEARCH_MAX_RETRIES` | `2` | 可重试错误的额外尝试次数（0–5） |
| `DEEPSEEK_SEARCH_RETRY_BASE_MS` | `350` | 指数退避基数 |
| `DEEPSEEK_SEARCH_RETRY_MAX_MS` | `5000` | 单次重试等待上限（同时限制 `Retry-After`） |
| `DEEPSEEK_SEARCH_CACHE_TTL_MS` | `300000` | search 结果缓存 TTL，`0` 关闭 |
| `DEEPSEEK_SEARCH_CACHE_MAX` | `64` | search 缓存条数，`0` 关闭 |
| `DEEPSEEK_FETCH_CACHE_TTL_MS` | `600000` | fetch 页面缓存 TTL，`0` 关闭 |
| `DEEPSEEK_FETCH_CACHE_MAX` | `32` | fetch 缓存条数，`0` 关闭 |
| `DEEPSEEK_WEB_MAX_RESULT_BYTES` | `40000` | 单次工具结果字节预算（最小 1000） |
| `DEEPSEEK_WEB_MAX_RESULT_LINES` | `1200` | 单次工具结果行数预算 |
| `DEEPSEEK_WEB_MAX_SNIPPET_CHARS` | `800` | 每条搜索结果的摘要长度 |
| `DEEPSEEK_WEB_MAX_RESPONSE_BYTES` | `8388608` | 原始 HTTP 响应体上限 |
| `DEEPSEEK_WEB_ALLOW_PRIVATE_HOSTS` | `false` | 允许抓取私网/回环地址（仅限受控环境） |
| `DEEPSEEK_WEB_SPILL` | `true` | 截断时把全文写入临时文件；定期清理超过 24 小时或超过 100 个的旧文件 |
| `DEEPSEEK_WEB_DEBUG` | `false` | 向 stderr 输出请求/重试日志 |
| `EXA_API_KEY` | — | 可选；与 `DEEPSEEK_API_KEY` 至少配置一个。未设置时回退读取 `~/.pi/agent/auth.json` 中 `exa` 凭据 |
| `EXA_BASE_URL` | `https://api.exa.ai` | Exa API 基地址；远程地址必须使用 HTTPS |
| `EXA_SEARCH_TYPE` | `auto` | Exa 搜索模式，例如 `auto`、`lite`、`deep`、`deep-lite` |
| `EXA_WEB_ALLOW_INSECURE_BASE_URL` | `false` | 允许非回环 HTTP Exa 基地址；会明文发送 API key |

`DEEPSEEK_SEARCH_TIMEOUT_MS`、重试、缓存、结果体积和 `DEEPSEEK_WEB_ALLOW_PRIVATE_HOSTS` 对两个 provider 共用；搜索与抓取缓存按 provider 独立。

## 使用

在 Pi 会话里直接让模型使用即可，例如：

```text
用 web_search 查一下 Pi coding agent 的最新扩展 API，然后抓取最相关的一页总结要点。
```

工具行为要点：

- **provider 选择**：默认 `auto` 会查询所有已配置 provider；两者都可用时合并结果。只想用单一来源时传 `provider="deepseek"` 或 `provider="exa"`；`both` 要求两者都配置。
- **合并去重**：按规范化 URL 去重，用 reciprocal rank fusion 排序；每条结果标记 `deepseek`、`exa` 或两者。单个 provider 不可用或失败时静默使用另一个 provider 的结果；在 TUI/RPC 中会提示用户检查 search 配置，但不会把 warning 写进模型结果。
- **抓取回退**：`web_fetch` 的 `auto` 优先 DeepSeek；遇到认证、限流、超时或网络错误时静默回退 Exa，不向模型追加 warning。`blocked_url`、参数错误和调用方取消不会触发回退。
- **先摘要后正文**：`web_search` 默认 `need_content=false`，只返回摘要；需要细节时对具体 URL 调用 `web_fetch`，省 token。
- **结果截断**：`web_fetch` 超过预算时会截断，并把完整内容写到 `/tmp/pi-deepseek-web/*.md`，模型可用 `read` 按 offset/limit 继续读。
- **缓存**：相同 query/URL 在 TTL 内直接命中；同一 provider 的并发重复请求会合并为一次上游调用。
- **错误可读**：认证失败、限流、超时、私网地址等都会变成简短的错误文本（含 `kind` 与提示），不会中断会话。

### 示例：直接验证 API（不经 Pi）

```bash
curl -s https://api.deepseek.com/v1/tools/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -d '{"query":"pi coding agent","count":3,"need_content":false}' | head -c 1000

# Exa（返回 highlights；需要正文时把 contents.text 设为 true 或调用 /contents）
curl -s https://api.exa.ai/search \
  -H "Content-Type: application/json" \
  -H "x-api-key: $EXA_API_KEY" \
  -d '{"query":"pi coding agent","numResults":3,"type":"auto","contents":{"highlights":{"maxCharacters":800}}}' | head -c 1000
```

## 性能与稳定性设计

| 机制 | 实现 |
| --- | --- |
| 超时 | 每次尝试独立超时，并与调用方 `AbortSignal` 合并；外部取消不重试 |
| 重试 | 仅 429 / 408 / 5xx / 网络错误；指数退避 + 抖动 + 上限；429 尊重 `Retry-After` |
| 取消 | 工具被取消时向上游传播；所有等待者都取消时终止共享请求 |
| 单飞 | 相同 key 的并发 miss 合并为一个请求，失败不缓存 |
| 缓存 | search / fetch 独立的 TTL + LRU，命中路径刷新 LRU 顺序 |
| 结果体积 | 字节 + 行双预算；按 UTF-8 安全截断，不产生半个字符 |
| 溢出 | 全文写私有临时文件（0600），结果里给出路径；定期清理旧文件 |
| 响应体 | 流式读取并限制总字节，避免恶意大响应占满内存 |
| 重定向 | `redirect: "manual"`，3xx 视为错误，防止借重定向绕过 URL 守卫 |

## 安全说明

`web_fetch` 会做 SSRF 防护：

- 仅允许 `http` / `https`，拒绝 URL 内嵌凭据，URL 长度 ≤ 8192；
- 拒绝 `localhost`、`*.local`、`*.internal`、云元数据主机名；
- 解析 DNS 后拒绝回环、私网、链路本地、CGNAT、保留段、组播，以及 IPv4-mapped / NAT64 / 6to4 中嵌入的私网地址；
- 识别 `2130706433`、`0x7f.1`、`0177.0.0.1` 等历史 IPv4 写法。

**残余风险**：`web_fetch` 的实际抓取由 DeepSeek 或 Exa 服务完成；本地 DNS 校验只决定是否把 URL 交给所选上游，不能约束上游侧的解析结果。它用于阻止把明显的回环、私网或元数据地址发给上游，不等价于网络层出站策略。高安全环境请配合出站防火墙/代理白名单，或设置 `DEEPSEEK_WEB_ALLOW_PRIVATE_HOSTS=false`（默认）并禁止解析到内网。

## 计费

搜索与抓取分别由 [DeepSeek](https://api-docs.deepseek.com/) 和 [Exa](https://exa.ai/pricing) 计费，与模型 token 分开。默认 `auto` 在两个 provider 都配置时会同时调用两者；控制成本时可用 `provider="deepseek"` 或 `"exa"`、调小 `count`，并保持 `need_content=false`。缓存命中与请求合并都会减少实际调用次数。

## 开发与验证

```bash
npm install
npm run typecheck
npm test
```

测试完全离线：使用本地 mock HTTP 服务器覆盖请求形状、重试/超时/取消、错误映射、缓存、single-flight、SSRF、截断与临时文件溢出。

真实 API 冒烟（需要 Key）：

```bash
npm run smoke
```

`scripts/smoke.ts` 会按已配置的 provider 依次验证：search 返回结果、fetch 返回正文、SSRF 守卫拦截云元数据地址。只配置一个 Key 时只测试该 provider。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `[config] No web search API key found` | 设置 `DEEPSEEK_API_KEY` 或 `EXA_API_KEY`，或在 Pi 里 `/login deepseek` |
| `[auth]` / HTTP 401/403 | Key 无效或被禁用；检查是否用了正确环境的 Key |
| `[rate_limit]` / HTTP 429 | 降低并发与 `count`；扩展会自动按 `Retry-After` 重试 |
| `[timeout]` | 增大 `DEEPSEEK_SEARCH_TIMEOUT_MS`，或检查到 `api.deepseek.com` / `api.exa.ai` 的网络 |
| `[config] Exa is not configured` | 设置 `EXA_API_KEY`，或显式使用 `provider="deepseek"` |
| `[blocked_url]` | 目标被 SSRF 守卫拒绝；确属内网测试环境才可设 `DEEPSEEK_WEB_ALLOW_PRIVATE_HOSTS=1` |
| 结果被截断 | 用返回的临时文件路径 + `read` 的 offset/limit 继续读，或调大预算 |
| 想看请求细节 | `DEEPSEEK_WEB_DEBUG=1 pi ...`，日志写到 stderr |
