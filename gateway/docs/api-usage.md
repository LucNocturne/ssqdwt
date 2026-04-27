# Image Gateway API 调用文档

## 接口风格

本网关同时支持两套入口:

1. **OpenAI Images API 兼容入口**: `/v1/images/generations`、`/v1/images/edits`
2. **OpenRouter 风格兼容入口**: `/api/v1/chat/completions`、`/api/v1/models?output_modalities=image`

相同点:
- 都使用 `Authorization: Bearer <api_key>`
- 都使用版本化 API 路径
- 都用 `model` 字段选择模型/规格

不同点:
- OpenRouter 主要面向 `chat/completions` 和多模型路由。
- 本网关面向图片能力,原生接口是 `/v1/images/generations` 和 `/v1/images/edits`。
- `model` 不是 OpenRouter 模型名,而是本网关固定规格名,例如 `img-standard`、`img-1k-1024x1024-low`、`img-4k-3840x2160`。

## 基础信息

```text
Base URL: https://qduet.zeabur.app
Auth:     Authorization: Bearer <GATEWAY_API_KEY>
```

`GATEWAY_API_KEY` 由服务方在环境变量中固定配置。调用方不需要创建 key,也不需要调用 `/admin/keys`。

请求头:

```http
Authorization: Bearer <GATEWAY_API_KEY>
Content-Type: application/json
```

## 健康检查

```bash
curl https://qduet.zeabur.app/health
```

返回:

```json
{
  "status": "ok",
  "time": "2026-04-27T10:35:44.128Z"
}
```

## 获取可用模型

```bash
curl https://qduet.zeabur.app/v1/models \
  -H "Authorization: Bearer <GATEWAY_API_KEY>"
```

返回示例:

```json
{
  "object": "list",
  "data": [
    {
      "id": "img-standard",
      "object": "model",
      "description": "1024x1024, medium quality",
      "credits_per_image": 1,
      "size": "1024x1024",
      "quality": "medium"
    }
  ]
}
```

常用模型:

| model | size | quality | credits/image | 用途 |
|---|---:|---:|---:|---|
| `img-standard` | 1024x1024 | medium | 1 | 默认低成本入口 |
| `img-1k-1024x1024-low` | 1024x1024 | low | 1 | 快速草图/占位图 |
| `img-1k-1024x1024` | 1024x1024 | high | 3 | 1K 高清方图 |
| `img-2k-2048x1152` | 2048x1152 | high | 3 | 2K 横屏 |
| `img-2k-2048x2048` | 2048x2048 | high | 8 | 2K 方图 |
| `img-4k-3840x2160` | 3840x2160 | high | 16 | 4K UHD 横屏 |

完整规格见 [model-matrix.md](./model-matrix.md)。

## OpenRouter 风格调用

OpenRouter 风格图片生成走 chat completions:

```text
POST /api/v1/chat/completions
```

请求体使用 `messages` 和 `modalities:["image"]`。网关会把最后一条 user message 当作图片 prompt。

curl:

```bash
curl -X POST https://qduet.zeabur.app/api/v1/chat/completions \
  -H "Authorization: Bearer <GATEWAY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "img-1k-1024x1024-low",
    "messages": [
      {
        "role": "user",
        "content": "a red circle on a white background"
      }
    ],
    "modalities": ["image"]
  }'
```

也可以用 OpenRouter 常见的 `image_config` 选择尺寸:

```bash
curl -X POST https://qduet.zeabur.app/api/v1/chat/completions \
  -H "Authorization: Bearer <GATEWAY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-image-2",
    "messages": [
      {
        "role": "user",
        "content": "a futuristic city at sunset"
      }
    ],
    "modalities": ["image"],
    "image_config": {
      "aspect_ratio": "16:9",
      "image_size": "2k",
      "quality": "high"
    }
  }'
```

返回格式:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1777286700,
  "model": "img-1k-1024x1024-low",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "Image generated.",
        "images": [
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,iVBORw0KGgo..."
            }
          }
        ]
      }
    }
  ],
  "usage": {
    "prompt_tokens": 40,
    "completion_tokens": 196,
    "total_tokens": 236,
    "credits": 1,
    "n": 1
  }
}
```

OpenRouter 风格模型列表:

```bash
curl "https://qduet.zeabur.app/api/v1/models?output_modalities=image" \
  -H "Authorization: Bearer <GATEWAY_API_KEY>"
```

## 文生图

`POST /v1/images/generations`

请求体:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `model` | string | 是 | 网关模型规格名 |
| `prompt` | string | 是 | 图片描述,最多 32 KB |
| `n` | number | 否 | 生成张数,1 到 8,默认 1 |

curl:

```bash
curl -X POST https://qduet.zeabur.app/v1/images/generations \
  -H "Authorization: Bearer <GATEWAY_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "img-1k-1024x1024-low",
    "prompt": "a red circle on a white background",
    "n": 1
  }'
```

返回:

```json
{
  "created": 1777286700,
  "model": "img-1k-1024x1024-low",
  "data": [
    {
      "b64_json": "iVBORw0KGgo...",
      "revised_prompt": "..."
    }
  ],
  "usage": {
    "credits": 1,
    "n": 1,
    "input_tokens": 40,
    "output_tokens": 196,
    "total_tokens": 236
  }
}
```

`data[0].b64_json` 是 PNG 图片的 base64 内容。调用方需要自行解码保存。

PowerShell 解码示例:

```powershell
$res = Invoke-RestMethod -Method Post `
  -Uri "https://qduet.zeabur.app/v1/images/generations" `
  -Headers @{ Authorization = "Bearer <GATEWAY_API_KEY>" } `
  -ContentType "application/json" `
  -Body '{"model":"img-1k-1024x1024-low","prompt":"a red circle on white background","n":1}'

[IO.File]::WriteAllBytes("out.png", [Convert]::FromBase64String($res.data[0].b64_json))
```

## 图生图 / 蒙版编辑

`POST /v1/images/edits`

请求格式是 `multipart/form-data`。

字段:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `model` | string | 是 | 网关模型规格名 |
| `prompt` | string | 是 | 编辑描述 |
| `image` | file | 是 | 输入图,单图场景使用 |
| `image[]` | file[] | 否 | 多参考图,最多 10 张 |
| `mask` | file | 否 | PNG 蒙版,必须和 `image[0]` 同尺寸 |
| `n` | number | 否 | 输出张数,1 到 8,默认 1 |

限制:
- 总 body 不超过 200 MB
- 单张输入图不超过 20 MB
- 输入图格式支持 PNG/JPEG/WEBP
- mask 只支持 PNG
- 提供 mask 时,第一张输入图必须是 PNG

单图编辑:

```bash
curl -X POST https://qduet.zeabur.app/v1/images/edits \
  -H "Authorization: Bearer <GATEWAY_API_KEY>" \
  -F "model=img-standard" \
  -F "prompt=turn the red circle into a blue square" \
  -F "image=@input.png" \
  -F "n=1"
```

蒙版编辑:

```bash
curl -X POST https://qduet.zeabur.app/v1/images/edits \
  -H "Authorization: Bearer <GATEWAY_API_KEY>" \
  -F "model=img-standard" \
  -F "prompt=put a yellow star inside the masked area" \
  -F "image=@input.png" \
  -F "mask=@mask.png"
```

多参考图:

```bash
curl -X POST https://qduet.zeabur.app/v1/images/edits \
  -H "Authorization: Bearer <GATEWAY_API_KEY>" \
  -F "model=img-standard" \
  -F "prompt=combine these two images into one product poster" \
  -F "image[]=@a.png" \
  -F "image[]=@b.png"
```

## 查询用量

```bash
curl https://qduet.zeabur.app/v1/usage \
  -H "Authorization: Bearer <GATEWAY_API_KEY>"
```

返回:

```json
{
  "key_id": 1,
  "label": "env-gateway",
  "credits_balance": 999999999,
  "summary": [
    {
      "op": "generation",
      "model": "img-1k-1024x1024-low",
      "status": "success",
      "count": 1,
      "credits": 1,
      "avg_latency": 33924
    }
  ]
}
```

## JavaScript 示例

```js
const baseURL = "https://qduet.zeabur.app";
const apiKey = process.env.GATEWAY_API_KEY;

const res = await fetch(`${baseURL}/v1/images/generations`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "img-1k-1024x1024-low",
    prompt: "a red circle on a white background",
    n: 1,
  }),
});

if (!res.ok) {
  throw new Error(await res.text());
}

const json = await res.json();
const b64 = json.data[0].b64_json;
```

## Python 示例

```python
import base64
import os
import requests

base_url = "https://qduet.zeabur.app"
api_key = os.environ["GATEWAY_API_KEY"]

resp = requests.post(
    f"{base_url}/v1/images/generations",
    headers={"Authorization": f"Bearer {api_key}"},
    json={
        "model": "img-1k-1024x1024-low",
        "prompt": "a red circle on a white background",
        "n": 1,
    },
    timeout=180,
)
resp.raise_for_status()

data = resp.json()
with open("out.png", "wb") as f:
    f.write(base64.b64decode(data["data"][0]["b64_json"]))
```

## 错误响应

错误统一返回:

```json
{
  "error": {
    "type": "invalid_request",
    "message": "Unknown model 'xxx'. See GET /v1/models."
  }
}
```

常见状态码:

| HTTP | type | 说明 |
|---:|---|---|
| 400 | `invalid_request` | 参数错误、模型不存在、图片格式不支持 |
| 401 | `auth_error` | 缺少或错误的 `Authorization` |
| 402 | `insufficient_credits` | credits 不足 |
| 413 | `invalid_request` | 请求体或图片过大 |
| 429 | `upstream_error` | 上游限流 |
| 502/503/504 | `upstream_error` | 上游失败、不可用或超时 |

上游失败会自动退款。

## 接入建议

- 默认使用 `img-1k-1024x1024-low` 做连通性测试,成本低、速度快。
- 生产图片优先使用 `img-standard` 或明确尺寸的 `img-2k-*` / `img-4k-*`。
- 复杂 4K prompt 可能耗时较长,客户端超时建议设置为 180 秒以上。
- 不支持 stream、seed、transparent background。
