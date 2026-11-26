# CToken 平台 Computer-Use 模型使用说明

覆盖 `ctokenmcp.catl.com` 上的两个 computer-use 模型：`qwen3.8-27b-nvfp4`（27B 多模态）
与 `gta1-7b`（含别名 `ui-tars-1.5-7b`）。

文中的数字均为 2026-11 实测结果；标注“未验证”的部分没有实际跑过，不要直接当结论用。

---

## 1. 接入信息

| 项 | 值 |
| --- | --- |
| Base URL | `https://ctokenmcp.catl.com` |
| OpenAI SDK `base_url` | `https://ctokenmcp.catl.com/v1` |
| 对话接口 | `POST /v1/chat/completions` |
| 模型列表 | `GET /v1/models` |
| 鉴权 | `Authorization: Bearer <CTOKEN_API_KEY>` |
| 健康检查 | 无。`GET /ready` 返回 303 跳登录页，用 `GET /v1/models` 代替 |

鉴权只接受 `Authorization: Bearer`。`X-Api-Key` 和不带 key 都返回 401。

```bash
export CTOKEN_API_KEY='sk-ctoken-...'   # 不要写进仓库、日志或错误上报

curl -s -H "Authorization: Bearer $CTOKEN_API_KEY" \
  https://ctokenmcp.catl.com/v1/models
```

## 2. 可用模型

| id | 上下文 | 最大输出 | 请求体上限 | 用途 |
| --- | --- | --- | --- | --- |
| `qwen3.8-27b-nvfp4` | 501760 | 32768 | 8 MiB | 文本、看图、坐标定位 |
| `gta1-7b` | 32768 | 512 | 8 MiB | 截图定位（精度见 §5） |
| `ui-tars-1.5-7b` | 32768 | 512 | 8 MiB | `gta1-7b` 的别名，路由到同一个模型 |
| `ctoken/computer-use` | 501760 | 32768 | 8 MiB | 云平台调度名，等价于 27B |
| `ctoken/hybrid-chat` | 1024 | 256 | 8 MiB | 小模型，不适合当主力 |

请求体的 `model` 决定路由。`qwen3.8-27b-nvfp4` 与 `ctoken/computer-use` 是同一后端，
响应里的 `maas.logical_model_id` 保留你请求的名字，`maas.execution.model_id` 是实际执行名。

## 3. 通用请求字段

| 字段 | 说明 |
| --- | --- |
| `model` | 必填，见上表 |
| `messages` | 必填，OpenAI 格式；多模态用 `content` 数组 |
| `max_completion_tokens` | 输出上限。注意**不是** `max_tokens` |
| `temperature` | 定位/判定场景用 `0` |
| `stream` | `true` 时返回 SSE，见 §6 |
| `chat_template_kwargs.enable_thinking` | 仅 27B；`false` 关闭思考，延迟更低 |

## 4. 模型一：qwen3.8-27b-nvfp4

### 4.1 纯文本

```bash
curl -s https://ctokenmcp.catl.com/v1/chat/completions \
  -H "Authorization: Bearer $CTOKEN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3.8-27b-nvfp4",
    "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
    "temperature": 0,
    "max_completion_tokens": 32,
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

实测：200，约 1.1 s，返回 `OK`。

### 4.2 看图

```python
import base64, mimetypes
from pathlib import Path
from openai import OpenAI

client = OpenAI(
    base_url="https://ctokenmcp.catl.com/v1",
    api_key=CTOKEN_API_KEY,     # 从环境变量或密钥管理读取
    timeout=600.0,              # 长截图/长生成要放宽，别用默认 30s
)

raw = Path("screen.jpg").read_bytes()
mime = mimetypes.guess_type("screen.jpg")[0] or "image/jpeg"
url = f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")

resp = client.chat.completions.create(
    model="qwen3.8-27b-nvfp4",
    messages=[{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": url}},
        {"type": "text", "text": "用一句话说明这是什么界面"},
    ]}],
    temperature=0,
    max_completion_tokens=256,
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
)
print(resp.choices[0].message.content)
```

实测：1440×935 JPEG（210 KB），3.1–3.7 s，prompt_tokens ≈ 1324，能正确识别界面内容。

### 4.3 坐标定位（推荐用 27B）

提示词里明确要 `point_2d`，输出形如：

```
{"point_2d": [13, 14], "label": "苹果菜单图标"}
```

**返回的坐标不是截图像素，是 1000×1000 归一化值。** 用三组已知位置标定得到：

```
x_pixel = out_x * W / 1000
y_pixel = out_y * H / 1000
```

（横纵各自拉伸，不是等比缩放。）用 1024×768 与 1440×935 两张图验证过：

| 目标真实位置 | 返回 | 还原 |
| --- | --- | --- |
| (700, 320) | 683, 416 | 699, 319 |
| (900, 640) | 879, 834 | 900, 640 |
| (150, 130) | 146, 170 | 149, 130 |
| 苹果菜单 ≈(19,13) | 13, 14 | 19, 13 |

### 4.4 思考模式

`enable_thinking: true` 可被接受，实测 `13*17` 返回 `221`、耗时 2.0 s，但**响应里没有
`reasoning` 字段**（只有 `content` 和 `role`），思考过程不可见。想省时间就用 `false`。

## 5. 模型二：gta1-7b / ui-tars-1.5-7b

请求格式与 27B 相同，把 `model` 换掉即可：

```bash
python3 - screen.jpg '找到“确定”按钮的中心，返回坐标。' <<'PY' | curl -sS \
  https://ctokenmcp.catl.com/v1/chat/completions \
  -H "Authorization: Bearer $CTOKEN_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @-
import base64, json, sys
from pathlib import Path
raw = Path(sys.argv[1]).read_bytes()
mime = "image/png" if raw.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg"
json.dump({
    "model": "gta1-7b",
    "messages": [{"role": "user", "content": [
        {"type": "image_url",
         "image_url": {"url": f"data:{mime};base64," + base64.b64encode(raw).decode()}},
        {"type": "text", "text": sys.argv[2]},
    ]}],
    "temperature": 0,
    "max_completion_tokens": 128,
}, sys.stdout)
PY
```

`ui-tars-1.5-7b` 与 `gta1-7b` 是同一个模型（响应 `model` 字段统一回 `gta1-7b`），
两者共用同一份并发额度。

**输出格式不固定**，同一提示词下实测出现过三种：

| 提示词 | 输出 |
| --- | --- |
| 返回中心坐标 | `(21,52)` |
| 用 JSON 返回 `bbox_2d` | ```` ```json [ {"bbox_2d": [174, 314]} ] ``` ```` |
| 英文要求 bbox_2d | `<text>(174,304)</text>` |

`bbox_2d` 里只有两个数（不是四个），说明它其实只给了点。解析端必须同时兼容裸元组、
`<text>…</text>` 和 Markdown 代码块三种壳。

**精度警告**：在已知红块位置（中心 700,320）的合成图上，gta1 返回 `174,314`，既不是像素
也不符合 1000 归一化；缩小红块后直接回“图中不存在”。真实截图上问左上角苹果菜单，给的是
`(21,52)`，与真实位置偏差明显。

结论：gta1 速度更快（1.5–2.9 s），但**坐标不可靠**，建议只用于“有没有这个元素”的存在性
判断，或作为 27B 的降级路径；点击坐标一律以 27B 为准。

## 6. 流式

`"stream": true` 返回标准 SSE，`Content-Type: text/event-stream`。实测帧序列：

```
retry: 2000                       # 心跳/重连提示，跳过
data: {"choices":[{"delta":{"role":"assistant"},...}]}   # 0.18s
id: 1
data: {"choices":[{"delta":{"content":"1"},...}]}        # 0.67s
id: 2
data: {"choices":[{"delta":{"content":", 2, 3, "},...}]} # 0.78s
data: [DONE]                                             # 1.58s
```

要点：

- 真的逐块返回（不是一次性给全），但分块粒度由后端决定，可能一次给好几个字。
- 除了 `data:` 行，还会出现 `id: N` 和 `retry: 2000`，按 SSE 规范解析即可，别当 JSON 解。
- 想拿到增量就边收边消费，客户端和中间层都不要开响应缓冲。

## 7. 限额与性能

### 7.1 请求体

模型列表里声明 `max_request_bytes: 8388608`（8 MiB），但实测同步路径撑不住：

| 请求体（含 base64） | 结果 |
| --- | --- |
| 1.00 MiB | 200，2.8 s |
| 4.00 MiB | 504 `CT-TASK-1004 inference is still running`，51.5 s 后返回 |
| 8.00 MiB | 400 `CT-COMMON-0001 invalid JSON body`（`unexpected EOF`，被网关截断） |
| 8.50 MiB | 同上 |

**实践上限按 2 MiB 设计**。1440px、JPEG q80 的截图约 210 KB，余量充足；原始 8 MB PNG
必须压缩后再发。单条 message 内容上限 262144 字符（实测 5 万字符可通过）。

### 7.2 延迟（同一台 Mac、公网）

| 场景 | 耗时 |
| --- | --- |
| 27B 文本，32 tokens，关思考 | ≈1.1 s |
| 27B 文本，1024 tokens，开思考 | ≈2.0 s |
| 27B 看 1440×935 截图 + 描述 | 3.1–3.7 s |
| 27B 看图 + 坐标定位 | 2.3–3.7 s |
| gta1 看图 | 1.5–2.9 s |
| 流式首帧 | 0.67 s（27B 短回复） |

### 7.3 并发

同一模型并行发 3 个请求：全部 200，但耗时分别是 1.1 s / 7.1 s / 12.3 s —— **单并发排队**，
没有触发 429。上层要么串行发，要么把超时放宽到能覆盖排队时间。

## 8. 错误码

| HTTP | error_code | 含义 | 处理 |
| --- | --- | --- | --- |
| 401 | — | 未带 key / key 错 / 用了 `X-Api-Key` | 改用 `Authorization: Bearer` |
| 404 | `CT-MODEL-0001` | 模型名不在本网关 | 用 §2 表里的 id |
| 400 | `CT-COMMON-0001` | JSON 不合法（常见于请求体被截断） | 压小请求体，确认 `Content-Length` |
| 429 | — | 模型忙（本入口未观测到） | `Retry-After` 后重试 |
| 502 | — | 网关抖动 | 立刻重试一次；持续 502 看 `/v1/models` 是否也挂 |
| 504 | `CT-TASK-1004` | 同步路径等待超时，任务仍在跑 | 压小请求体；或改异步任务接口 |
| 504 | `CT-EDGE-4106` | 端侧连接断开（大图/网络抖动） | 压小图片后重试 |

网关偶发整段 502（连 `/v1/models` 一起挂），通常几秒到几十秒自愈，不是 key 问题。
重试策略：一次短退避重试即可，别无限重试。

## 9. 自测清单

四项都过才算打通：

```bash
set -e
: "${CTOKEN_API_KEY:?先 export CTOKEN_API_KEY}"

# 1) 鉴权 + 模型列表
curl -fsS -H "Authorization: Bearer $CTOKEN_API_KEY" \
  https://ctokenmcp.catl.com/v1/models | head -c 200; echo

# 2) 27B 文本
curl -fsS https://ctokenmcp.catl.com/v1/chat/completions \
  -H "Authorization: Bearer $CTOKEN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-27b-nvfp4","messages":[{"role":"user","content":"Reply with exactly: OK"}],"temperature":0,"max_completion_tokens":32,"chat_template_kwargs":{"enable_thinking":false}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["choices"][0]["message"]["content"])'

# 3) gta1 路由
curl -fsS https://ctokenmcp.catl.com/v1/chat/completions \
  -H "Authorization: Bearer $CTOKEN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gta1-7b","messages":[{"role":"user","content":"hi"}],"temperature":0,"max_completion_tokens":16}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["maas"]["logical_model_id"])'

# 4) 流式（应看到多个 data: 帧，最后 [DONE]）
curl -sN https://ctokenmcp.catl.com/v1/chat/completions \
  -H "Authorization: Bearer $CTOKEN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-27b-nvfp4","messages":[{"role":"user","content":"从1数到10"}],"stream":true,"max_completion_tokens":64,"chat_template_kwargs":{"enable_thinking":false}}' \
  | head -5
```

看图与定位另测：用一张已知控件位置的截图，确认 27B 返回的 `point_2d` 按
`×W/1000`、`×H/1000` 还原后落在目标上。

## 10. 与其它入口的对照

同一台边缘设备有三套对外方式，模型名对不上是正常的：

| | ctoken（本文） | 阿里云网关 `39.97.8.6:8080` | .113 直连 |
| --- | --- | --- | --- |
| 网络 | 公网 | 公网 | 公司 VPN / 节点本机 |
| 鉴权 | Bearer | `X-Api-Key` | Bearer（另一套 token） |
| 27B | `qwen3.8-27b-nvfp4` | `/vision/v1` + 同名 | `qwen3.8-27b-nvfp4` |
| gta1 | `gta1-7b` | `/grounder/v1` + 同名 | `gta1-7b` |
| 图片体积 | 实测 ≤2 MiB | 宽松 | 文档称 12 MiB |

## 11. 未验证项

- `429 model_busy`：本入口并发实测是排队，没有 429；`Retry-After` 行为未验证。
- gta1 在“标准 ui-tars 提示词格式”下精度是否会改善：未拿到官方 prompt 样例，未验证。
- 思考模式的 `reasoning` 文本：本入口不返回，是否可用 `include_reasoning` 之类的开关未验证。
- 异步任务接口（`/v1/images/tasks`、`/v1/video/generations`）与本文无关，另见媒体生成文档。