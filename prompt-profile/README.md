# Researcher and coding expert：Pi 提示词配置

将科研与编程协作要求放入 Pi 的独立提示词分区。要求 Pi ≥ 1.5.0、Node.js ≥ 22.19。

角色定义：

> You are a researcher and coding expert working with the user in Pi. Support scientific inquiry, literature analysis, experimental and computational methods, data analysis, and software engineering. Match the depth and workflow to the task; connect scientific reasoning with reliable implementation when both are needed.

## 安装与查看

在仓库根目录执行：

```bash
pi install ./prompt-profile
```

在已运行的 Pi 会话中执行 `/reload`；新会话自动加载。`/response-style` 命令与 `response_style` 分区由本包管理，避免同时启用管理同一命令或分区的扩展。

```text
/prompt-profile   查看角色和工作原则
/response-style   查看回复风格
```

这两个命令只显示配置，不调用模型。源码修改后执行 `/reload`。

## 提示词组成

| 分区 | 作用 |
| --- | --- |
| `research_role` | 科研协作者与编程专家定位 |
| `working_principles` | 完成授权任务、核验证据、说明不确定性、保障科研可复现性、保护用户改动、按影响验证、遵守权限边界、按需选择工具 |
| `docs` | 使用当前安装版本的 Pi 文档和示例，按相关 API 查阅 |
| `response_style` | 使用用户语言和自然中文、先结论后依据、按任务控制详略、引用和文件链接、简短进展与独立完整的最终报告 |

扩展通过 `before_agent_start` 修改 `systemPromptOptions.sections`。Pi 原生基础身份句、工具列表和规则由宿主生成；科研与编程职责由 `research_role` 定义。

- 技能、项目上下文、追加提示、工具声明及权限 hook 由 Pi 和相应扩展管理。
- 使用显式 `SYSTEM.md` / `--system-prompt` 时，保留其身份和文档安排，只应用回复风格。
- 遇到已有 `forceSystemPrompt` 时不修改提示词；后续扩展的整体替换按 Pi 原生顺序生效。
- 本包只管理提示词分区，不修改模型、认证、网络、会话摘要、Pi 安装文件或技能正文。
- 提示词规则用于指导模型行为，不替代执行时的权限控制和科学验证。

## 工具协作

各工具由独立扩展提供，可按需安装：

| 工具 | 使用策略 |
| --- | --- |
| [Search](../search/README.md) | 搜索优先同时使用 Exa 和 DeepSeek（`provider="auto"`）；需要单源时优先 Exa，其次 DeepSeek。页面抓取默认先 Exa，在来源不可用或可回退的错误时再用 DeepSeek；安全拒绝、参数错误和取消不换源。显式指定来源时按指定执行 |
| [CodeGraph](../codegraph/README.md) | 优先用于已索引代码的架构、符号关系、故障与影响调查；已知文件、概念问题和文献研究使用相应工具 |
| [Helper](../helper/README.zh-CN.md) | 委派有明确路径、上下文和预期输出的独立只读调查；使用结果前检查状态与证据 |
| Pi codemode | 并行独立操作并逐项检查结果；依赖步骤和冲突写入按顺序执行 |

## 开发与验证

```bash
npm --prefix prompt-profile ci --ignore-scripts
npm --prefix prompt-profile run typecheck
npm --prefix prompt-profile test
```

测试使用真实 Pi SDK、本地模拟模型和临时文件，覆盖默认、自定义、强制系统提示组合、连续回合不重复、项目约束和技能保留、后置扩展规则保留、文件读取，以及查看命令不调用模型。测试验证集成行为，不评价模型回答质量。

## 卸载

在仓库根目录执行：

```bash
pi remove ./prompt-profile
```

然后在运行中的 Pi 会话执行 `/reload`。该操作只移除本包，不影响其他已安装扩展。
