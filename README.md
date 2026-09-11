# codex-zh

需要 Linux、Node.js 22+、Python 3，以及已安装并登录的 Codex CLI（已验证版本：0.154.0）。

```sh
git clone git@github.com:chenty2333/codex-zh.git
cd codex-zh
npm ci
npm run install:local

export PATH="$HOME/.local/bin:$PATH"
export DEEPSEEK_API_KEY="你的 DeepSeek API Key"

codex-zh --doctor
codex-zh -C /path/to/project
```

默认模型为 `deepseek-flash`，接口地址为 `https://api.deepseek.com`；可通过 `DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL` 覆盖。

配置使用环境变量，其他可选项见 [.env.example](.env.example)。程序不自动读取 `.env`。需要长期生效时，将环境配置加入当前 shell 的启动配置中。
