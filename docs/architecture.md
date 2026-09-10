# 实现与一致性约束

```text
原生 codex TUI
   │ 鉴权的 loopback WebSocket / JSON-RPC
   ▼
codex-zh Bridge
   ├── 用户 text：保护 → DeepSeek Responses → 校验 → 英文
   ├── 正文与 plan：完整源条目 → 翻译批次 → 校验 → 中文增量
   ├── 当前回合临时文字：有容量上限，回合结束释放，不写盘
   └── 工具、审批、附件、控制事件：原样转发
   │ JSON-lines stdin/stdout
   ▼
原生 codex app-server → 原生模型、工具和工作目录
```

## 协议范围

输入仅变换 `turn/start` 和 `turn/steer` 中 `type=text` 的文本。其他输入内容与协议字段保持原样。文字引用的 `text_elements[].byteRange` 是 UTF-8 字节偏移，通过冻结其原文并在译文中定位，重新计算偏移；不会把中文字符数当作字节数。

输出仅变换 `agentMessage` 和 `plan` 的实时 `item/started`、`item/*/delta`、`item/completed` 及当前回合最终快照。历史请求和响应完全透传，包括 `thread/resume`、`thread/read`、`thread/fork` 及所有历史分页。工具与服务器发起的请求正常情况下即时转发；输入和正文输出分别按 thread 排队。中断直接触发 AbortController，并继续向原生服务端转发。

应用层输入回显通过 `clientUserMessageId` 与内容摘要恢复原始文本。摘要兼容原生服务端补齐的 `text_elements=[]`、`placeholder=null`、图片 `detail=null` 字段。

## 唯一译文

1. 缓冲 Codex 源文字增量，等待 `item/completed` 的权威原文。服务端最终文本可与先前增量不同，因此不能提前承诺译文。
2. 原文分解为本地保护片段和自然语言片段。按完整记录合并批次，分别向 DeepSeek 请求严格 JSON 结构。
3. 消费 Responses SSE，验证 `response.completed` 成功且其文字与已接收的 DeepSeek 增量相同；检查记录 ID、数量、字段和保护标记。
4. 整个批次通过校验后才释放一个或多个本地增量。每个增量追加到唯一的 `state.emitted`。
5. `item/completed.text` 直接使用 `state.emitted`，不调用第二次翻译。当前 `turn/completed` 使用相同文字，然后删除该回合所有临时输入与回复。以后读取历史会得到原文。

核心不变量为：`concat(已发送文字增量) === item/completed.text === 同条目的最终快照文字`。这针对文字内容，不要求 TUI 的换行布局与源 Markdown 字节相同。

## 失败与取消

输入是整条提交事务：任何翻译、范围校验或容量预留失败，都向 TUI 返回错误而不发送 `turn/start` / `turn/steer`。输入回显映射仅保存在当前回合内存中，不存在持久化步骤。

输出以批次为提交单位。失败、超时或取消时，已提交前缀不可变，剩余原文完整保留；因此某条回复可能同时含中英文。源文本保护器拒绝异常格式时，也保留原文。代理不会将 DeepSeek 的错误响应正文插入用户回复。

## 有限内存

每次接纳待译输入或回复前，先预留四倍单条文本上限的字符预算，覆盖源文本与最多三倍上限的译文/回退结果。完成输入提交或文字翻译后，预留缩减为仍需保留的实际文字大小；当前回合结束、取消订阅或关闭连接时释放。条目数另有上限，避免大量短消息的元数据无限增长。没有得到回应的输入映射最多保留 60 秒；一旦明确属于活动回合，则随回合清理。

翻译器每次提交批次前检查当前译文长度，并为全部未提交原文预留空间，避免取消或后续失败时丢失尾部。回复在源增量积累阶段超限时，先发出已有原文前缀，再将该条目转为原文转发；后续最终条目由原生 TUI 处理。整个回合达到预算时也对新条目采取原文转发，不挤掉已显示的译文。

传输层限制同时等待 Bridge 处理的帧数为 128，待处理帧/待发送文字达到 8 MiB 时暂停读取上游 stdout。单个 JSON 帧原有的 128 MiB 上限保留；大历史响应仅临时解析并转发，不加入翻译缓存。正常翻译不会依赖上游任务完成，队列能够在翻译完成或超时后继续推进。过载时可能延后读取后续控制事件。

这些是保留文字和队列的边界，不是 V8/Node、临时解析结构或原生 TUI 的总内存限制。

## 原生持久化

启动器对 TUI 和 app-server 都追加本次进程的 `history.persistence="none"`，避免原生输入回溯文件另存翻译前的中文 prompt。会话 rollout 仍保存实际提交的英文用户消息与 Codex 原始输出，供原生 `resume` 使用。全局 Codex 配置不改动。

## 代码导航

| 文件 | 作用 |
| --- | --- |
| `bin/codex-zh.mjs` | 启动原生 TUI，镜像 app-server 所需配置参数，管理进程生命周期 |
| `src/server.mjs` | 鉴权 WebSocket、stdio 帧处理、进程清理与输出背压 |
| `src/bridge.mjs` | 白名单字段变换、请求关联、消息排序、中断和历史恢复 |
| `src/protected-text.mjs` | 字面量和 Markdown 保护、完整性校验、UTF-8 引用重定位 |
| `src/deepseek.mjs` | 翻译指令、Responses 请求、SSE 与结构化返回校验 |
| `src/translator.mjs` | 无缓存的翻译批次、容量检查、提交与失败回退 |
| `src/config.mjs` | 环境配置与系统钥匙环读取 |

本实现面向当前 Codex v2 app-server 消息，不改写未知协议方法。新增原生消息类型需要先确认格式并补充对应验证后才能翻译；默认透传保留兼容性。
