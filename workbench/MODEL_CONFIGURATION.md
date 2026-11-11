# 模型配置

## 文件与生效方式

运行 `npm run setup` 后填写 `.env` 和 `models.config.json`。修改后重启工作台，右上角“模型配置”可以查看生效值。

```dotenv
deepmath_model_base_url=https://your-resource.services.ai.azure.com/openai/v1
AZURE_OPENAI_API_KEY=填写模型服务的Key
deepmath_models_file=./models.config.json
```

所有模型共用同一接口地址和 Key。接口地址填到 `/v1`，应用会追加 `/responses` 或混合模式所用路径。Key 由本机模型代理读取，页面显示配置状态。

## 字段

| 字段 | 含义 |
| --- | --- |
| `defaultModel` | 默认模型的 `id`，必须存在于已启用列表 |
| `models[].id` | 稳定标识，保存在项目与任务记录中 |
| `displayName` | 网页显示的模型名称 |
| `apiModel` | 模型服务实际接收的模型名或 Azure 部署名 |
| `apiMode` | 默认 `responses`，也支持 `azure-deepseek-pro-hybrid` |
| `reasoningEffortSupported` | 该部署是否接受推理强度参数 |
| `reasoningEffort` | 默认推理档位，须包含在可选列表中 |
| `reasoningEfforts` | 页面可选档位，按实际部署支持范围填写 |
| `maxOutputTokens` | 单次生成预算，可设 128–262144，须符合部署实际上限 |
| `webSearch` | 启用模型服务的网页检索，默认 `false` |
| `enabled` | 设为 `false` 可从可用模型列表移除 |
| `description` | 可选的模型说明 |

配置中的预算包含模型生成的内容，实际推理与正文用量由上游决定。部署不支持推理参数时，使用模板中的 `false`、空字符串和空数组。

## Pro 与 Flash 示例

将下面内容放入 `models.config.json`，并把 `apiModel`、推理档位和预算改成实际部署支持的值。

```json
{
  "defaultModel": "deepseek-flash",
  "models": [
    {
      "id": "deepseek-pro",
      "displayName": "DeepSeek Pro",
      "apiModel": "DeepSeek-V4-Pro",
      "apiMode": "azure-deepseek-pro-hybrid",
      "webSearch": true,
      "reasoningEffort": "high",
      "reasoningEfforts": ["high", "max"]
    },
    {
      "id": "deepseek-flash",
      "displayName": "DeepSeek Flash",
      "apiModel": "FW-DeepSeek-V4.1-Flash",
      "apiMode": "responses",
      "reasoningEffort": "high",
      "reasoningEfforts": ["low", "high", "max"],
      "maxOutputTokens": 8192
    }
  ]
}
```

混合模式把 Azure Chat Completions 与托管检索组合成工作台需要的 Responses 流。其他模型使用 `responses`，要求服务支持 Responses 格式、流式输出和工具调用。

## 调度与上下文

并发与公平调度使用内置默认值，单个模型额度池最多 8 个并发请求。需要调整时，在 `models.config.json` 顶层添加可选的 `scheduler`，例如：

```json
"scheduler": {
  "defaults": { "maxConcurrent": 4 },
  "models": {
    "your-deployment-name": { "tpm": 100000, "rpm": 60, "utilization": 0.8 }
  }
}
```

模型名须与 `apiModel` 一致，额度按实际服务填写。省略时保留并发控制和上游限流恢复。高级环境变量 `deepmath_model_limits` 可覆盖整个 `scheduler`。

当前会话窗口为 128000 token，页面按运行器回传的可用窗口和最近用量统计。自动压缩遵循运行器现有逻辑。

## 兼容旧环境变量

仍可使用单行 JSON 环境变量 `deepmath_models` 和 `deepmath_default_model`，它们分别覆盖文件中的模型列表和默认模型。`CODEX_BIN` 可指定 Codex CLI 的完整路径。配置检查运行 `npm run check`。
