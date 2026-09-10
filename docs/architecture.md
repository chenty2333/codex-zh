# 实现与一致性约束

```text
原生 codex TUI
   │ 鉴权的 loopback WebSocket / JSON-RPC
   ▼
codex-zh Bridge
   ├── 用户 text：保护 → DeepSeek Responses → 校验 → 英文
   ├── 正文与 plan：完整源条目 → 翻译批次 → 校验 → 中文增量
   ├── 原文/译文缓存：~/.local/state/codex-zh
   └── 工具、审批、附件、控制事件：原样转发
   │ JSON-lines stdin/stdout
   ▼
原生 codex app-server → 原生模型、工具和工作目录
```

## 协议范围

输入仅变换 `turn/start` 和 `turn/steer` 中 `type=text` 的文本。其他输入内容与协议字段保持原样。文字引用的 `text_elements[].byteRange` 是 UTF-8 字节偏移，通过冻结其原文并在译文中定位，重新计算偏移；不会把中文字符数当作字节数。

输出仅变换 `agentMessage` 和 `plan` 的 `item/started`、`item/*/delta`、`item/completed` 及相关历史快照。工具与服务器发起的请求即时转发，避免审批被翻译请求阻塞。输入和正文输出分别按 thread 排队；中断直接触发 AbortController，并继续向原生服务端转发。

应用层输入回显通过 `clientUserMessageId` 与内容摘要恢复原始文本。摘要兼容原生服务端补齐的 `text_elements=[]`、`placeholder=null`、图片 `detail=null` 字段。

## 唯一译文

1. 缓冲 Codex 源文字增量，等待 `item/completed` 的权威原文。服务端最终文本可与先前增量不同，因此不能提前承诺译文。
2. 原文分解为本地保护片段和自然语言片段。按完整记录合并批次，分别向 DeepSeek 请求严格 JSON 结构。
3. 消费 Responses SSE，验证 `response.completed` 成功且其文字与已接收的 DeepSeek 增量相同；检查记录 ID、数量、字段和保护标记。
4. 整个批次通过校验后才释放一个或多个本地增量。每个增量追加到唯一的 `state.emitted`。
5. `item/completed.text` 直接使用 `state.emitted`，不调用第二次翻译。`turn/completed` 和后续历史读取使用同一份缓存。

核心不变量为：`concat(已发送文字增量) === item/completed.text === 同条目的最终快照文字`。这针对文字内容，不要求 TUI 的换行布局与源 Markdown 字节相同。

## 失败与取消

输入是整条提交事务：任何翻译、范围校验、用户映射持久化失败，都向 TUI 返回错误而不发送 `turn/start` / `turn/steer`。已经处理的其他独立控制请求不受影响。

输出以批次为提交单位。失败、超时或取消时，已提交前缀不可变，剩余原文完整保留；因此某条回复可能同时含中英文。源文本保护器拒绝异常格式时，也保留原文。代理不会将 DeepSeek 的错误响应正文插入用户回复。

持久化在写盘前先更新进程内缓存，因此磁盘故障不会让本次已显示的译文在最终快照中变回英文。写盘采用私有临时文件加原子 rename；持久化失败会提示以后恢复历史可能显示原文。缓存读取错误不会丢掉整个历史响应。

## 代码导航

| 文件 | 作用 |
| --- | --- |
| `bin/codex-zh.mjs` | 启动原生 TUI，镜像 app-server 所需配置参数，管理进程生命周期 |
| `src/server.mjs` | 鉴权 WebSocket、stdio 帧处理、进程清理与输出背压 |
| `src/bridge.mjs` | 白名单字段变换、请求关联、消息排序、中断和历史恢复 |
| `src/protected-text.mjs` | 字面量和 Markdown 保护、完整性校验、UTF-8 引用重定位 |
| `src/deepseek.mjs` | 翻译指令、Responses 请求、SSE 与结构化返回校验 |
| `src/translator.mjs` | 翻译批次、提交、失败回退与缓存 |
| `src/store.mjs` | 私有本地缓存、哈希键与原子写入 |
| `src/config.mjs` | 环境配置与系统钥匙环读取 |

本实现面向当前 Codex v2 app-server 消息，不改写未知协议方法。新增原生消息类型需要先确认格式并补充对应验证后才能翻译；默认透传保留兼容性。
