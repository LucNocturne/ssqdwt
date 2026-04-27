# 图片生成 API 对外使用文档

本文档面向 API 调用方,只说明如何接入和调用。

## 1. 接入信息

```text
Base URL: https://qduet.zeabur.app
API Key: 由服务方提供
```

所有需要鉴权的接口都使用 Bearer Token:

```http
Authorization: Bearer <API_KEY>
```

请求和响应默认使用 JSON。图片结果以 base64 data URL 或 base64 字符串返回,调用方自行解码保存。

## 2. 推荐调用方式:OpenRouter 风格

推荐使用 OpenRouter 风格的 Chat Completions 接口:

```text
POST /api/v1/chat/completions
```

完整 URL:

```text
https://qduet.zeabur.app/api/v1/chat/completions
```

### 2.1 最小请求

```bash
curl -X POST https://qduet.zeabur.app/api/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
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

### 2.2 使用尺寸配置

如果调用方习惯 OpenRouter 图片参数,也可以使用 `image_config`:

```bash
curl -X POST https://qduet.zeabur.app/api/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
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
      "image_size": "2k",
      "aspect_ratio": "16:9",
      "quality": "high"
    }
  }'
```

`image_config` 支持:

| 字段 | 示例 | 说明 |
|---|---|---|
| `image_size` | `1k` / `2k` / `4k` | 输出尺寸档位 |
| `aspect_ratio` | `1:1` / `16:9` / `9:16` | 输出比例 |
| `quality` | `low` / `medium` / `high` | 画质档位,以可用规格为准 |
| `size` | `1024x1024` | 直接指定像素尺寸 |

如果同时传了网关模型名和 `image_config`,优先使用明确的网关模型名。

### 2.3 返回格式

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
    "total_tokens": 236
  }
}
```

图片在:

```text
choices[0].message.images[0].image_url.url
```

该字段是 `data:image/png;base64,...` 格式。

## 3. 兼容调用方式:Images API

如果调用方已经按 OpenAI Images API 接入,也可以直接使用图片接口。

### 3.1 文生图

```text
POST /v1/images/generations
```

```bash
curl -X POST https://qduet.zeabur.app/v1/images/generations \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "img-standard",
    "prompt": "a red circle on a white background",
    "n": 1
  }'
```

响应:

```json
{
  "created": 1777286700,
  "model": "img-standard",
  "data": [
    {
      "b64_json": "iVBORw0KGgo...",
      "revised_prompt": "..."
    }
  ],
  "usage": {
    "n": 1,
    "input_tokens": 40,
    "output_tokens": 196,
    "total_tokens": 236
  }
}
```

图片在:

```text
data[0].b64_json
```

### 3.2 图生图 / 蒙版编辑

```text
POST /v1/images/edits
```

请求格式是 `multipart/form-data`。

单图编辑:

```bash
curl -X POST https://qduet.zeabur.app/v1/images/edits \
  -H "Authorization: Bearer <API_KEY>" \
  -F "model=img-standard" \
  -F "prompt=turn the red circle into a blue square" \
  -F "image=@input.png" \
  -F "n=1"
```

蒙版编辑:

```bash
curl -X POST https://qduet.zeabur.app/v1/images/edits \
  -H "Authorization: Bearer <API_KEY>" \
  -F "model=img-standard" \
  -F "prompt=put a yellow star inside the masked area" \
  -F "image=@input.png" \
  -F "mask=@mask.png"
```

多参考图:

```bash
curl -X POST https://qduet.zeabur.app/v1/images/edits \
  -H "Authorization: Bearer <API_KEY>" \
  -F "model=img-standard" \
  -F "prompt=combine these two images into one product poster" \
  -F "image[]=@a.png" \
  -F "image[]=@b.png"
```

上传限制:

| 项 | 限制 |
|---|---|
| 总请求体 | 最大 200 MB |
| 单张输入图 | 最大 20 MB |
| 输入图格式 | PNG / JPEG / WEBP |
| 输入图数量 | 1 到 10 张 |
| mask | 仅 PNG,且必须与第一张输入图同尺寸 |
| `n` | 1 到 8 |

## 4. 模型和规格

调用方可以通过接口获取模型列表:

```bash
curl "https://qduet.zeabur.app/api/v1/models?output_modalities=image" \
  -H "Authorization: Bearer <API_KEY>"
```

也可以使用 Images API 风格:

```bash
curl https://qduet.zeabur.app/v1/models \
  -H "Authorization: Bearer <API_KEY>"
```

### 4.1 1K 规格

| model | 尺寸 | 画质 | 推荐用途 |
|---|---:|---|---|
| `img-standard` | 1024x1024 | medium | 默认入口、缩略图、通用测试 |
| `img-1k-1024x1024-low` | 1024x1024 | low | 快速草图、占位图 |
| `img-1k-1024x1024` | 1024x1024 | high | 1K 高清方图 |
| `img-1k-1024x768` | 1024x768 | high | 4:3 横图 |
| `img-1k-768x1024` | 768x1024 | high | 3:4 竖图 |

### 4.2 2K 规格

| model | 尺寸 | 画质 | 推荐用途 |
|---|---:|---|---|
| `img-2k-2048x2048` | 2048x2048 | high | 2K 方图 |
| `img-2k-2048x1536` | 2048x1536 | high | 4:3 横图 |
| `img-2k-1536x2048` | 1536x2048 | high | 3:4 竖图 |
| `img-2k-2048x1152` | 2048x1152 | high | 16:9 横图 |
| `img-2k-1152x2048` | 1152x2048 | high | 9:16 竖图 |
| `img-2k-2048x1365` | 2048x1365 | high | 3:2 横图 |
| `img-2k-1365x2048` | 1365x2048 | high | 2:3 竖图 |
| `img-2k-2048x1638` | 2048x1638 | high | 5:4 横图 |
| `img-2k-1638x2048` | 1638x2048 | high | 4:5 竖图 |
| `img-2k-2048x1024` | 2048x1024 | high | 2:1 banner |
| `img-2k-1024x2048` | 1024x2048 | high | 1:2 竖版 banner |

### 4.3 4K 规格

| model | 尺寸 | 画质 | 推荐用途 |
|---|---:|---|---|
| `img-4k-3840x2160` | 3840x2160 | high | 4K UHD 横屏 |
| `img-4k-2160x3840` | 2160x3840 | high | 4K UHD 竖屏 |
| `img-4k-3840x1920` | 3840x1920 | high | 2:1 超宽横图 |
| `img-4k-1920x3840` | 1920x3840 | high | 1:2 超高竖图 |
| `img-4k-3840x1646` | 3840x1646 | high | 21:9 电影宽屏 |
| `img-4k-1646x3840` | 1646x3840 | high | 9:21 超高竖图 |

## 5. 解码图片

### 5.1 JavaScript

```js
const dataUrl = response.choices[0].message.images[0].image_url.url;
const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
```

### 5.2 Python

```python
import base64

data_url = response["choices"][0]["message"]["images"][0]["image_url"]["url"]
base64_data = data_url.split(",", 1)[1]

with open("out.png", "wb") as f:
    f.write(base64.b64decode(base64_data))
```

### 5.3 PowerShell

```powershell
$dataUrl = $response.choices[0].message.images[0].image_url.url
$base64 = $dataUrl -replace '^data:image/png;base64,', ''
[IO.File]::WriteAllBytes("out.png", [Convert]::FromBase64String($base64))
```

## 6. 错误格式

错误响应统一是 JSON:

```json
{
  "error": {
    "type": "invalid_request",
    "message": "Unknown model"
  }
}
```

常见状态码:

| HTTP | 说明 |
|---:|---|
| 400 | 请求参数错误、模型不存在、图片格式不支持 |
| 401 | API Key 缺失或错误 |
| 402 | 账户额度不足 |
| 413 | 请求体或上传图片过大 |
| 429 | 请求过多 |
| 502 | 图片服务临时失败 |
| 503 | 服务暂不可用 |
| 504 | 生成超时 |

## 7. 接入建议

- 连通性测试优先使用 `img-1k-1024x1024-low`。
- 正式通用场景优先使用 `img-standard`。
- 需要明确比例时,直接选择对应的 `img-2k-*` 或 `img-4k-*` 模型名。
- 客户端超时时间建议设置为 180 秒以上。
- 当前不支持 stream、seed、透明背景。
