# openclaw-xaapi-auth

OpenClaw 插件，通过 [xaapi.ai](https://xaapi.ai) API 中转站使用 GPT Codex、Claude 和 Gemini 模型。

## 支持的模型

- **OpenAI Codex**: gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.1-codex-mini (通过 `/v1/responses` 端点)
- **Claude**: claude-opus-4-6, claude-sonnet-4-6, claude-sonnet-4-5, claude-haiku-4-5 等 (通过 Anthropic Messages API)
- **Gemini**: gemini-3-pro-high, gemini-3-flash, gemini-2.5-pro, gemini-2.5-flash 等 (通过 Anthropic Messages API)

模型列表从 xaapi.ai 实时获取，会自动显示你的 API Key 可用的所有模型。

## 安装

```bash
openclaw plugins install openclaw-xaapi-auth
openclaw plugins enable openclaw-xaapi-auth
```

## 配置

```bash
openclaw models auth login --provider xaapi
```

认证流程：
1. 选择模型供应商（Claude / OpenAI / Gemini）
2. 输入 xaapi.ai API Key
3. 自动获取可用模型列表
4. 选择要启用的模型
5. 设置主模型和备用模型

每次配置新的供应商时，之前设置的备用模型会保留（追加模式）。

## 特性

- 三大模型供应商一个插件搞定
- 模型列表实时从 API 获取，始终保持最新
- 备用模型追加模式，多次配置不丢失
- 零成本计费（通过 xaapi.ai 统一计费）
