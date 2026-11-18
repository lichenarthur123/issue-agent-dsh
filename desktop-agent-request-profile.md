# desktop-agent 请求特征分析

> 数据来源：
>
> - 部署侧 `qwen3.8-27b-nvfp4`（`http://10.10.10.1:8005/v1`）2026-11-18 03:42:47–03:46:13 UTC 的引擎 10s 窗口指标，共 14 次 `POST /v1/chat/completions`，全部 200 OK。
> - 客户端代码 `packages/desktop-agent`（当前工作区）。
> - 请求契约见 `executor_request_response.md`，线上配置见 `packages/desktop-agent/cordis.patch.yml`。

## 0. 结论摘要

| 维度 | 实测/代码结论 |
|---|---|
| 调用方 | 只来自 Executor 的逐轮决策，不是聊天式多轮对话 |
| 并发 | 单并发、严格串行；同一任务同一时刻只有一次模型请求 |
| 请求量 | 3.5 分钟内 14 次，平均约 14.7s 一次，中间有 45s 空档 |
| 单请求输入 | 约 3.2k–3.8k tokens，其中截图约 1.4k–1.8k（约一半） |
| 单请求输出 | 平均约 157 tokens，含推理；最终 JSON 通常只有 40–80 tokens |
| prefill | 每次约 1.5s，约 2300 tok/s，非常稳定，无排队迹象 |
| decode | 合计约 143s，占墙钟 69%；平均约 15 tok/s（窗口含启停），瞬时 25–29 tok/s |
| 前缀缓存 | 命中约 1.3%，接近全量 prefill；理论上可缓存 1.5k–2.0k tokens |
| 报文形态 | `messages` 恒为 2 条（system + user），user 是「文本 + 末尾一张截图」，无 tools、无 response_format |

一句话：**这是“每一步都从零重建、只带一张新截图、只回一个 JSON”的短请求流**。单次请求并不大，但步数多、decode 占比高、前缀缓存几乎没生效，三者共同决定了端到端耗时。

## 1. 请求在任务循环中的位置

```
GitHub Issue
  └─ git-issue-agent 队列（串行，一次只跑一个 Issue）
       └─ desktopTasks.run()
            ├─（可选）Planner：一次性扩写计划         ← 8005，每个任务 0/1 次
            └─ 循环（最多 50 步，任务超时 600s）
                 ├─ Executor.decide()                ← 8005，每步 1 次，本次分析的 14 次
                 │    └─ 截图 + 任务/历史/反馈 → 一个动作 JSON
                 ├─ 执行动作
                 │    ├─ 指针类动作 → Grounder       ← 8003，ui-tars-1.5-7b，独立服务
                 │    └─ CUA 工具（截图、AX、点击、输入）
                 └─ 重新观察，进入下一轮
            └─ done 时 VL Verify                     ← 8005，1 次，失败可重复
```

当前生产配置为 `observationMode=screenshot`、`plannerEnabled=false`、`thinkingMode=always`、`thinkingEffort=low`（`packages/desktop-agent/cordis.patch.yml`）。因此：

- 14 次请求全部是 **Executor 决策请求**，没有 Planner 请求；
- screenshot 模式下，点击/输入/双击/右键/拖动等指针类动作还会各触发一次 **Grounder 请求**，但它们发往 8003、模型是 7B，不在本次 8005 的统计里；
- 如果任务正常 `done`，会额外出现一次 **Verifier 请求**（同样带整张截图，`max_tokens=800`）。这次窗口里没有看到明显的验证请求特征，可能任务未走到 `done`，或验证请求落在窗口外。

这意味着：**引擎侧看到的 14 次请求只是端到端调用的一半左右**。评估整体延迟时，需要把 8003 的 Grounder 调用单独统计。

## 2. 单次请求的报文特征

### 2.1 HTTP 参数

| 参数 | 实际值 | 代码位置 |
|---|---|---|
| `stream` | `true`，SSE | DSH provider |
| `stream_options` | `{ "include_usage": true }` | DSH provider |
| `model` | `qwen3.8-27b-nvfp4` | `settings.js:12` |
| `max_tokens` | `6000` | `executor.js:74` |
| `temperature` | `0` | `executor.js:75` |
| `top_p` / `top_k` / `stop` / `seed` | 不发送，用服务端默认 | — |
| `tools` | 不发送 | — |
| `response_format` | 不发送 | — |
| `chat_template_kwargs` | `{ enable_thinking: true, reasoning_effort: "low" }` | `cordis.patch.yml` |
| `messages` | 恰好 2 条：system + user | `executor.js:70-73` |
| 请求超时 | 300s（provider 级） | `cordis.patch.yml` |

补充：

- 决策解析只看普通 `content`，不看 `reasoning_content`；推理只是成本，不是协议的一部分。
- `finish_reason=length` 不会被单独识别，客户端只会因 JSON 解析失败而重试；重试时错误以 `<feedback>` 注入下一轮。
- 单次输出上限 6000 tokens 与provider 300s 超时处在同一量级：按 20 tok/s 估算，跑满 6000 tokens 正好约 300s。本批请求最大输出约 450 tokens，未触及该边界，但这是尾部风险。

### 2.2 messages 结构

```json
{
  "messages": [
    { "role": "system", "content": [{ "type": "text", "text": "<固定规则 4666B>" }] },
    { "role": "user", "content": [
        { "type": "text", "text": "<original-task>…</original-task>\n<history>…</history>\n<current-window>…</current-window>\n<screenshot-size>1568x891</screenshot-size>\n<running-apps>…</running-apps>\n…" },
        { "type": "image", "attachment": "<当轮窗口截图>" }
    ]}
  ]
}
```

关键点：**没有 assistant 轮次、没有 tool 消息、没有历史截图**。每一轮都是一个全新的单轮请求，会话状态完全由客户端拼进 user 文本。这也是后面前缀缓存分析的出发点。

### 2.3 user 文本模板与预算

screenshot 模式下（`packages/desktop-agent/src/prompt.js:90-155`）：

```
<original-task>原始任务</original-task>

<execution-plan>可选，planner 开启时才有</execution-plan>

<history>最近 5 步完整 JSON</history>
<history-summary>更早步骤摘要，可选</history-summary>
<history-omitted>省略数量说明，可选</history-omitted>

<current-window>{"pid":…,"window_id":…}</current-window>

<screenshot-size>1568x891</screenshot-size>

<page-target>可选</page-target>          ← 仅浏览器标签页绑定时
<running-apps>App(bundle;running); …</running-apps>   ← 可选
<feedback>当前失败/无进展反馈，可选</feedback>
<feedback-history>最近 5 条历史反馈，可选</feedback-history>

Decide the single next atomic action from the current screen. Return only the JSON object.
```

硬预算（`prompt-budget.js:32-36`）：

| 段 | 预算 | 超限行为 |
|---|---|---|
| system | 4800 B | 按 UTF-8 字节截断并标记 |
| user 文本 | 3000 B | 依次丢历史反馈 → 压缩 running-apps → 压缩 plan → 压缩 request → 清空 running-apps |
| history | 1500 B | 5 步+摘要 → 5 步 → 3 步 → 3 步精简 → 1 步精简 |

实际线上值：

- system = **4666 B**，未截断；
- 实测 user 文本约 **400–1700 B**（空历史时约 400 B，5 步历史 + 反馈时约 1.6–1.7 KB），远低于 3000 B 上限；
- screenshot 模式**不注入 `<current-ax>`**。AX 树仍会被采集，供 Grounder 定位、滚动区域、输入值校验使用，但不进入 Executor 的 prompt，这是每轮省下大块 token 的主要原因。

### 2.4 截图

- 来源：CUA Driver `get_window_state(include_screenshot=true)`，PNG，窗口原始分辨率；
- 实测常见尺寸：**1568×891 / 1568×900**，也有 1568×1091 和更小的弹窗；
- 客户端不做缩放；DSH 的请求图像上限是 2048×2048 像素、单图 ≤1MB，1568×891 不会触发降采样（只有超过 1MB 的大图会被重新压缩）；
- 图片在 content 数组中位于**文本之后**，这个顺序对前缀缓存有利（见第 7 节）。

## 3. Token 构成：实测与代码预算的交叉验证

按 Qwen-VL 类视觉编码折算，1568×891 截图约 1.4k–1.8k tokens（取决于 28×28 还是 32×32 的视觉 token 折算），约占单请求的一半。与实测对照：

| 组成 | 估算 tokens | 占 3832 的比例 | 说明 |
|---|---:|---:|---|
| system（4666 B，纯英文规则） | ~1100 | 29% | 每轮完全相同 |
| user 文本（任务 + 5 步历史 + 窗口信息） | ~500–900 | 13–23% | 随历史增长，封顶于 1500 B |
| 截图（1568×891） | ~1400–1800 | 37–47% | 每轮都变，位于文本之后 |
| 模板/尾部 token | ~50 | 1–2% | — |
| **合计** | **~3.1k–3.8k** | 100% | 与实测 3199→3832 吻合 |

实测增长曲线也符合代码：

- #2 为 3199，此时 history 只有 1 步；
- 之后每步约 +60 tokens（一条精简历史 JSON 的量级）；
- #12、#13 都停在 **3832**，说明 5 步历史窗口已经填满（`RECENT_HISTORY_LIMIT = 5`，`history.js:3`），不再增长；
- #14 回落到 2777，符合「新会话/新任务、历史清空」的形态。

因此，**输入大小的上限不是模型上下文，而是客户端的 3000B/1500B 文本预算 + 一张截图**。65536 的上下文窗口对本流程完全够用，不会触发会话压缩。

## 4. 请求节奏与并发

| 特征 | 结论 | 依据 |
|---|---|---|
| 任务级并发 | 1 | `git-issue-agent` 串行 `pumpPending()`；桌面锁 `DesktopMutex` |
| 请求级并发 | 1 | 每轮 `await executor.decide()` 后才执行动作、重新截图 |
| 平均请求间隔 | ~14.7s | 206s / 14 |
| 单次耗时构成 | prefill ~1.5s + decode ~10s + 客户端动作/观察 ~2–4s | 见第 5、6 节 |
| 心跳 | 每 15s 一次 CUA `get_session`，**不是模型请求** | `task-runner.js:341-350` |
| 步数上限 | 50 步 / 任务 | `settings.js:40` |
| 任务超时 | 600s | `settings.js:22` |
| 单次模型超时 | 300s | provider 配置 |

关于 45s 空档：代码里**没有 45s 级别的固定等待**。最长的显式等待是 `wait` 动作的 10s，CUA 工具单次调用上限 30s，`ensureWindowVisible` 的重试是 300ms 级。更合理的解释是会话边界：仓库里 `artifacts/native/` 下恰好有两个会话目录，分别开始于 `03:42:47` 和 `03:44:06`，与 14 次请求的起点和 45s 空档重合。也就是说，这 45s 很可能是**前一个会话结束、后一个会话启动**，而不是 agent 在连续执行动作。建议部署侧按 session id 切分统计，避免把两次任务的间隔算进单任务耗时。

## 5. 14 次请求的逐条还原

数据来自部署侧 10s 窗口聚合（±1 个窗口边界误差）。`input tokens` 是完整 prompt tokens；`decode tokens` 是生成 tokens，含推理。

### 5.1 部署侧原始数据

下表为部署侧按 10s 窗口还原的原始记录：`input tokens` = 窗口 prompt 吞吐 × 10，prefill 速率按基线 ~2300 tok/s 折算；`decode tokens` = 窗口 generation 吞吐 × 10；`decode 耗时` 由 prefill 结束到响应完成推算。

| # | 完成时间 (UTC) | input tokens | prefill | decode tokens | decode 耗时 |
|---:|---|---|---|---|---|
| 1 | 03:42:48.9 | ~3500（窗口起点前，估算） | ~1.5s | 短输出 | ~2s |
| 2 | 03:42:57.2 | 3199 | ~1.4s | ~110 | ~6.5s |
| 3 | 03:43:10.8 | 3496 | ~1.5s | ~171 | ~11.3s |
| 4 | ~03:43:19（access log 缺失） | 3568 | ~1.5s | ~100 | ~6s |
| — | 空闲 45s（部署侧原判：agent 本地执行动作） | — | — | — | — |
| 5 | 03:44:07.5 | ~3360 | ~1.4s | ~35 | ~2s |
| 6 | 03:44:16.6 | ~3360 | ~1.4s | ~165 | ~5.5s |
| 7 | 03:44:26.8 | 小（合入前窗口） | <1s | ~74 | ~8s |
| 8 | 03:44:43.5 | 3578 | ~1.5s | ~290 | ~14.5s |
| 9 | 03:45:01.6 | 3637 | ~1.5s | ~170 | ~15.5s |
| 10 | 03:45:12.9 | 3725 | ~1.6s | ~107 | ~9s |
| 11 | 03:45:24.9 | 3774 | ~1.6s | ~83 | ~9.7s |
| 12 | 03:45:49.9 | 3832 | ~1.6s | ~450 | ~23s |
| 13 | 03:46:07.0 | 3832 | ~1.6s | ~280 | ~15s |
| 14 | ~03:46:13（access log 缺失） | 2777 | ~1.2s | ~190 | ~5s |

精度说明：token 数是 10s 窗口聚合值（±1 个窗口边界误差），单请求 decode 耗时由 prefill 结束时间到响应完成时间推算，误差 <1s；#4、#14 的引擎侧指标完整，但 uvicorn 的 POST 完成日志缺失，不影响按引擎窗口还原。

### 5.2 结合代码的解读

- **#2 → #13 的输入增长**（3199 → 3832）来自 `<history>` 逐轮追加；`#12`、`#13` 同为 3832，说明 5 步历史窗口已填满（`RECENT_HISTORY_LIMIT = 5`，`history.js:3`），之后不再增长。
- **#14 回落到 2777**：历史清空、prompt 变短，符合新会话/新任务的特征。
- **#7 的「小」**：10s 窗口跨越了请求合入时刻的聚合伪影，不代表真实输入变小。
- **45s 空档**：代码中没有 45s 级别的固定等待（最长是 `wait` 的 10s，CUA 单次调用上限 30s）；仓库里两个 session 的 `startedAt` 恰好是 03:42:47 和 03:44:06，与该空档重合，更可能是会话边界而非连续动作。部署侧原判已保留在表中，供对照。
- **#4、#14 缺 access log**：流式长连接收尾时 uvicorn access log 不可靠，应以引擎指标为准。
- **#1 的短输出**：会话首个请求，history 为空、任务刚注入，输出通常很短。

汇总：

- 总输入约 **45.6k tokens**，均值约 **3260/次**；
- 总输出约 **2.2k tokens**，均值约 **157/次**；
- prefill 合计约 **21s**，decode 合计约 **143s**，客户端动作与空档约 **45s**，合计约 **206s**。

## 6. 服务端性能特征

| 指标 | 观测 | 解读 |
|---|---|---|
| prefill | 每次 ~1.4–1.6s，~2300 tok/s | 与输入大小近似线性，稳定，说明请求之间没有排队/抢占 |
| decode | 平均 ~15 tok/s（含窗口启停），瞬时 25–29 tok/s | 单流 27B NVFP4 的正常水平 |
| MTP | 平均接受长度 3.0–3.7，draft 接受率 67–90% | 投机解码工作正常，继续调 decode 的空间不大 |
| 失败率 | 14/14 200 OK | 无超时、无 5xx |
| 缺失 access log | #4、#14 | 长连接/流式收尾时 uvicorn access log 不可靠，建议以引擎指标为准 |

延迟归因很清楚：**prefill 只占 10%，decode 占 69%**。因此优化优先级应该是「减少 decode token → 减少步数 → 减少 prefill」，而不是优先压缩首 token 延迟。

## 7. 前缀缓存分析

### 7.1 现象

14 次请求的 prefix cache 命中约 **1.3%**，平均每请求只有约 40–50 tokens 命中，几乎等于全量 prefill。客户端日志里对应 `cache=0` 或极小值。

### 7.2 客户端本应能命中多少

虽然每个请求是全新的单轮请求，但相邻两轮的 prompt **确实是前缀关系**：

```
system(4666B) + <original-task> + <execution-plan?> + <history>旧条目 …
                                                  ↑ 到这里为止逐字节相同
                                                  ↓ 新一步追加一条历史后分叉
<current-window> … <screenshot-size> … <running-apps> … <feedback> … + 新截图
```

- 历史只追加、不重写，且 `<history-summary>` 排在 `<history>` 之后，不会提前破坏前缀；
- `<current-window>` 的 pid/window_id 在单任务内稳定；
- **变化最大的截图放在 user content 的最后**，不会影响它之前的文本前缀。

按第 3 节的拆分，可缓存前缀约为 **1.5k–2.0k tokens**（system ~1.1k + 任务 + 已结束的历史 + 固定段），占单请求的 **45–55%**。

### 7.3 修复后的实际收益

按 2300 tok/s 的 prefill 速率：

```
1.5k–2.0k cached tokens / 2300 tok/s ≈ 0.65–0.87s / step
14 步 ≈ 9–12s，约占 206s 的 4–6%
```

这里需要修正一个容易高估的预期：**缓存不可能覆盖截图**。每轮截图都不同，且视觉 token 通常占一半，所以“每步省 1–1.5s、14 步省 20s”偏乐观；可复现的收益在 **0.6–0.9s/步**，仍值得做，但不是数量级改善。

### 7.4 为什么现在没命中：三个可验证的假设

1. **引擎侧前缀缓存未开启，或对混合 Mamba/GDN 架构不生效。**
   启动日志里的 `Mamba cache mode is set to 'align'` 说明该模型走的是混合状态缓存路径；部分推理栈对这类模型的 radix/prefix cache 支持有限，或者只在特定对齐条件下复用。

2. **缓存 key 覆盖了整段 prompt（含图片），而不是按 token 前缀匹配。**
   如果引擎用「完整请求体哈希」做缓存键，那么每轮新截图都会让整个键失效，命中率自然会掉到 1% 量级。这是最值得先排除的一条：它和“文本前缀明明相同却几乎不命中”的现象完全吻合。

3. **模板/分词在系统段之前引入了每请求变化的 token。**
   客户端没有时间戳、请求 id 之类的内容，但 chat template 或网关可能在最前面插入可变字段。这会让第一个 block 就失配。

建议按下面三个实验定位，成本很低：

| 实验 | 请求 | 预期 |
|---|---|---|
| A. 完全相同重放 | 同一 body 连发两次（同图同文） | 第二次 `cached_tokens` 应接近总 prompt；若仍为 0，说明缓存整体未生效 |
| B. 同文换图 | 文本完全相同，只换截图 | 若 `cached_tokens` 掉到 0，说明缓存 key 包含图片/整包哈希 |
| C. 同图增历史 | 同一张图，history 逐步追加 | 命中长度应在历史分叉处停止，而不是从头开始 |

如果 A 命中、B 不命中，问题在缓存键；如果 A 也不命中，问题在引擎开关或模型架构支持。

## 8. 优化空间排序

| 优先级 | 手段 | 预期收益 | 代价/风险 |
|---:|---|---|---|
| 1 | 修复前缀缓存 | 0.6–0.9s/步，单任务 9–12s | 服务端改动；不影响输出质量 |
| 2 | 降低截图 token | 1568×891 → 1120×636 可省约 0.6–0.9k tokens，约 0.3–0.4s/步 | 必须在客户端缩放并同步修改 `<screenshot-size>`，否则 Executor 给的 `point` 会与坐标空间错位；小字/图标识别可能变差，需要 A/B 成功率 |
| 3 | 减少步数 | 每少一步约省 11s（prefill 1.5s + decode ~9–10s） | 依赖模型质量与批量动作（`actions` 最多 3 个，已支持） |
| 4 | 压缩推理 token | 输出从 157 降到 80，约省 3–4s/步 | `thinkingMode=off` 已被实测否决（会提前结束/空响应）；只能尝试 `adaptive` 或更强约束 |
| 5 | 降低 `max_tokens` | 降低尾部超时风险 | 6000 与 300s 超时同量级；改小可能在难步骤截断 JSON |

不建议投入的方向：

- **首 token 延迟/流式分块**：客户端要等完整 JSON 才能解析，TTFT 不影响决策；
- **提高 decode 吞吐**：MTP 已工作良好，单流 25–29 tok/s 接近该配置上限；
- **扩大并发**：桌面操作天然串行，且 `DesktopMutex` 明确禁止并行。

## 9. 对部署验收清单的补充

在 `executor_request_response.md` 第 11 节之外，建议再验证：

- [ ] 接受 `messages` 只有 2 条、且 user 为「长文本 + 末尾图片」的单轮请求；
- [ ] `enable_thinking:true + reasoning_effort:"low"` 下，推理不会挤掉最终 JSON；
- [ ] 返回的 `usage.prompt_tokens_details.cached_tokens` 是真实前缀命中值（客户端会记录并用于成本观测，填 0 会让所有缓存优化无法度量）；
- [ ] SSE 在长 decode（>60s）下不被中间层超时切断，且有 keep-alive；
- [ ] 提供**每请求**的引擎指标（prompt/decode tokens、prefill/decode 时间、cache 命中），不要只依赖 uvicorn access log——本批已有 2 次缺失；
- [ ] 相同请求重放时缓存行为符合预期（对应第 7.4 节的实验 A）。

## 10. 如何把窗口估算校准成精确值

客户端每条模型调用都会打两行日志（`packages/desktop-agent/src/log.js:33-67`）：

```
◈ MODEL call qwen3.8-27b-nvfp4 thinking | sys=4666B user=612B history=1043B image=483120B
◈ MODEL qwen3.8-27b-nvfp4 input=3832 cache=0 output=280 time=14820ms
```

字段对应关系：

| 客户端日志 | 引擎指标 | 说明 |
|---|---|---|
| `input` | `prompt_tokens` | 客户端已把 `cached_tokens` 加回，等于完整输入 |
| `cache` | `prompt_tokens_details.cached_tokens` | 前缀命中 |
| `output` | `completion_tokens` | 含推理 tokens |
| `time` | 请求墙钟 | 含网络与 SSE 收尾 |
| `sys/user/history/image` | — | 分段字节数，可反推 token 构成 |

拿到这批日志（stdout 或 `artifacts/native/<session>/events.jsonl` 对应的运行记录）后，可以把本文所有 ±1 窗口的估算替换成精确值，并直接核对「#12/#13 平台期」「#14 回落」是否对应历史窗口滑动和新会话。

## 附录：关键代码位置

| 内容 | 位置 |
|---|---|
| Executor 请求组装（messages / max_tokens / temperature） | `packages/desktop-agent/src/executor.js:32-86` |
| screenshot 模式 user 模板与压缩顺序 | `packages/desktop-agent/src/prompt.js:90-155` |
| system prompt 与 4800B 预算 | `packages/desktop-agent/src/prompt.js:4-49`、`prompt-budget.js:32` |
| 历史 5 步窗口与降级 | `packages/desktop-agent/src/history.js:3,82-96` |
| 主循环、重试、完成验证 | `packages/desktop-agent/src/task-runner.js:516-672` |
| Verifier 请求（截图 + 800 tokens） | `packages/desktop-agent/src/verifier.js:17-51` |
| Planner 请求（默认关闭，1200 tokens） | `packages/desktop-agent/src/planner.js:240-280` |
| Grounder 请求（8003，7B，100 tokens） | `packages/desktop-agent/src/grounder.js:41-113` |
| 默认参数（模式、步数、超时） | `packages/desktop-agent/src/settings.js:10-58` |
| usage / cache 日志口径 | `packages/desktop-agent/src/log.js:55-67` |