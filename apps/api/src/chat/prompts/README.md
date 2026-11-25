# 提示词管理

这里保存发送给模型的静态提示词和工具描述。直接编辑 Markdown，无需在业务代码里查找长字符串。

## 文件入口

| 文件                           | 用途                                     |
| ------------------------------ | ---------------------------------------- |
| `agents/main.md`               | 主 Agent 的 system prompt                |
| `agents/research.md`           | Research 子 Agent 的 system prompt       |
| `tools/<工具名>.md`            | 工具描述与已有参数说明                   |
| `runtime/invalid-final.md`     | 报告为空或格式错误后的补交提示           |
| `runtime/research-recovery.md` | 工具协议解析失败后的恢复提示             |
| `runtime/report-repair.md`     | 报告参数校验失败后的修正提示             |
| `agent-prompts.ts`             | 当前时间、预算、引文长度等动态变量的组装 |
| `prompt-store.ts`              | 文件目录、章节映射、读取与变量替换       |

## 编辑 Agent 提示词

Agent 文件整体作为 system prompt 发送，保留 Markdown 标题、段落、列表和代码块。

动态数据使用 `{{变量名}}`，只支持值替换，不支持执行代码、表达式或条件语句：

```text
当前服务器 UTC 时间：{{currentTime}}。
最多 {{maxTurns}} 轮推理、{{maxCalls}} 次工具调用。
```

`agent-prompts.ts` 在每次 Agent 开始执行时生成 UTC 时间并传入变量。执行预算来自 `../agents/agent-limits.ts`，引文长度来自 Research 的校验规则。缺少变量或传入未使用变量都会报错，避免把未填充模板发送给模型。

## 编辑工具描述

工具文件使用固定的二级标题标识字段：

```markdown
# research

## description

工具的用途与使用时机。

## task

task 参数的说明。
```

`## description` 的内容成为工具的 `function.description`，其他章节成为对应字段说明。一级标题只用于阅读，不传给工具描述。保留章节 ID；新增章节时同步 `prompt-store.ts` 的 `toolSections` 和调用处。缺失、空白或重复章节会报错。

`web_search.md` 的 `url` 说明模型如何选择搜索引擎并构造完整搜索 URL。服务端直接请求该 URL，不再组合关键词或内置搜索地址。

工具的名称、参数类型、必填字段、枚举和 Zod 校验继续由 TypeScript 管理。这里只维护已有描述文字，修改说明不会自动改变接口或校验。

## 构建与生效

Nest CLI 将这些 Markdown 作为资源复制到 `dist/chat/prompts`，测试构建复制到 `.test-dist/chat/prompts`。运行时按编译模块自身目录读取，不依赖启动工作目录，也不回退读取源码。

静态文件按进程缓存，动态变量每次重新生成。修改 Markdown 后重启 API 服务生效；生产环境重新构建并部署，交付目录必须包含 Markdown 资源。开发模式的 `watchAssets` 会同步资源文件，但不能代替服务重启。
