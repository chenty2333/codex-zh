# codex-zh

在原生 Codex CLI 的终端界面与原生 `codex app-server` 之间增加中英翻译：中文输入先译为英文，Codex 的回复正文与计划译为中文。翻译使用 **DeepSeek V4.1 Flash**，API 模型名为 `deepseek-flash`，调用 `POST https://api.deepseek.com/responses`。

界面由已安装的 Codex CLI 绘制，代码执行仍由 Codex 完成。这是一个独立启动器；启动命令是 `codex-zh`，原来的 `codex` 命令仍可直接使用。

## 直接使用

本机已将密钥放入系统钥匙环。项目安装后，在你的工作目录执行：

```sh
codex-zh
```

其他常用命令：

```sh
codex-zh -C /path/to/project
codex-zh resume --last
codex-zh --passthrough
codex-zh --doctor
```

`--passthrough` 暂时关闭翻译。`--doctor` 显示 Codex 版本、翻译模型与密钥来源，不打印密钥、不调用模型。`codex-zh -- --help` 显示原生帮助。

## 内容保护与一致性

- 代码围栏、行内代码、JSON 文档、diff、明确的引号字面量，以及识别出的路径、URL、数字、标识符等，在本地替换成占位符。DeepSeek 看不到这些保护片段的实际值；返回后由本地原样填回。
- Markdown 结构、换行与首尾空白被保留。引用文件和粘贴占位符的 UTF-8 字节范围根据译文重新计算，附件本身不改动。
- DeepSeek 仅获得翻译指令和待译文本，不配置工具；每段必须按原 ID 返回。占位符丢失、重复、被修改，结构变化、截断、异常附加字段等会导致校验失败。
- 输入翻译失败时，整条输入不会提交给 Codex。输出翻译失败时，未显示的批次保留原文，已经显示的译文不被替换。
- **一个回复条目只形成一份确定译文。显示的所有增量拼接起来，就是最终回复；不会在结束时重新翻译。** 已显示译文也会用于当前会话快照和历史恢复。

为满足最后一点，代理会等到 Codex 的每个文字条目完成，再调用 DeepSeek，并按通过校验的批次显示。**这会增加首字延迟，短回复可能整段出现；不是即时的逐 token 翻译。** 工具日志、审批和中断不等待文字翻译。

字面量与结构可以通过程序校验，自然语言语义无法获得数学上的百分之百保证。系统指令要求保留否定、限制、语气和不确定性，但程序不能证明任意模型译文都完全等义。需要精确保持的文本请使用反引号、代码围栏或引号标明；尤其是没有明确边界的命令和字符串。

## 原生功能与当前边界

| 项目 | 当前行为 |
| --- | --- |
| TUI、编辑输入、快捷键 | 原生 Codex CLI |
| Codex 模型、登录、配置 | 由原生 Codex 管理；翻译模型独立配置 |
| 工具调用、文件修改、审批、中断 | 转发原生协议，工具参数和返回值不翻译 |
| 图片、技能、文件引用 | 原样保留附件，仅调整已保护的文字引用范围 |
| 中文用户消息回显 | 恢复原始中文；Codex 服务端保存的上下文是译后的英文 |
| 回复正文与计划条目 | 翻译为中文，增量和最终文字一致 |
| 菜单、工具日志、推理摘要、审批问题 | 保留原生文字，可能仍为英文 |
| 会话历史 | 用私有本地缓存恢复同一份译文；未经过代理的旧条目保留原文 |
| 非交互子命令、外部远程服务器 | 使用原来的 `codex`；本启动器面向交互 TUI、`resume`、`fork` |

**退出边界：当前版本的本地代理和 app-server 随 TUI 退出而停止，未完成的后台任务不会继续。请等任务结束再 `/quit`。** 退出时原生远程界面可能显示 reconnect 地址；那个临时地址随代理关闭而失效，恢复历史应运行 `codex-zh resume`。本版本没有驻留守护进程，也不承诺与原生后台会话生命周期完全相同。

更改翻译模型、API 地址或内容保护版本后，匹配不到的历史译文会显示原文。删除本地缓存也有相同效果；代理不会为了恢复旧历史而重新生成另一份译文。

## 在其他机器安装

需要 Node.js 22+、已登录的 Codex CLI。本项目验证版本为 Codex CLI **0.154.0**，依赖其 `--remote` 和 `app-server --stdio` 功能。

```sh
cd /path/to/codex-zh
npm ci
npm run install:local
codex-zh --doctor
```

安装脚本将 `~/.local/bin/codex-zh` 链接到本项目；已有其他同名命令时会拒绝覆盖。确保 `~/.local/bin` 在 `PATH` 中。也可直接执行 `node /path/to/codex-zh/bin/codex-zh.mjs`。

Linux 推荐通过 `secret-tool` 保存密钥。下面的命令会在终端提示输入，不需要把密钥写进命令或文件：

```sh
secret-tool store --label='codex-zh DeepSeek API key' service codex-zh credential deepseek-api-key
```

也支持已设置的 `DEEPSEEK_API_KEY` 环境变量。项目不会自动读取 `.env`；`.env*`、密钥文件、依赖和本地测试数据均被 Git 忽略，仅 `.env.example` 被纳入源码。

## 可选配置

| 环境变量 | 默认值 / 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 优先于系统钥匙环 |
| `DEEPSEEK_MODEL` | `deepseek-flash` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com`；只允许 HTTPS，测试用回环地址可用 HTTP |
| `CODEX_ZH_TIMEOUT_MS` | `60000`，单次翻译请求超时 |
| `CODEX_ZH_BATCH_CHARS` | `1800`，按完整行合并批次的目标大小，不会切断保护片段 |
| `CODEX_ZH_STATE_DIR` | `${XDG_STATE_HOME:-~/.local/state}/codex-zh` |
| `CODEX_ZH_CODEX_BIN` | `codex`，原生可执行文件 |
| `CODEX_ZH_PASSTHROUGH` | `1` 时关闭翻译 |

译文和原文映射保存在工作项目之外的私有状态目录，新建目录权限为 `700`、文件为 `600`，文件名使用哈希。它们是普通本地明文历史，不是加密存储。代理不记录 API 密钥、请求正文或模型响应正文到日志。非保护的自然语言会发送给 DeepSeek，这是翻译所必需的。

代理只监听随机的 `127.0.0.1` 端口，使用每次启动生成的随机 Bearer token；拒绝无鉴权连接与带浏览器 Origin 的连接。每个代理仅接受一个 TUI 连接。

## 验证

```sh
npm test
npm run check
npm run test:native
npm run test:tui
npm run test:live
```

前三项检查协议、内容保护、缓存和真实 app-server；`test:tui` 通过 Python 3 的伪终端驱动真实 TUI，模型和翻译 API 均为本地确定性模拟；`test:live` 使用真实 DeepSeek API 和合成文本，会消耗少量 API 额度。测试报告在被 Git 忽略的 `.test-state/` 中。

架构细节见 [docs/architecture.md](docs/architecture.md)，实际验证范围见 [docs/verification.md](docs/verification.md)。

## 协议依据

模型与接口信息核验于 2026-09-10。`deepseek-flash` 是服务端模型别名，后续对应版本以服务端公告为准。

- [DeepSeek Responses API 指南](https://api-docs.deepseek.com/guides/responses_api/)
- [DeepSeek 模型与定价文档](https://api-docs.deepseek.com/quick_start/pricing/)
- [OpenAI Codex app-server 文档](https://learn.chatgpt.com/docs/app-server)
