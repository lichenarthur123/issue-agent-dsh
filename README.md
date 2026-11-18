# DSH Desktop Issue Agent

## 1. 架构与职责

```text
GitHub Issue
  → git-issue-agent 轮询、去重、排队
  → （可选）Planner 一次性扩写完整执行计划（里程碑、必填字段和值、成功证据；默认关闭）
  → Executor 读取原始任务或可选完整计划：看当轮截图 + AX → 输出一个原子动作 → 执行 → 再看新截图
      ├── navigate：默认附加本机 Chrome/Edge 的 existing_profile，也可配置隔离 Chromium
      ├── launch：按应用名或 bundle id 解析并启动应用，绑定内容窗口
      ├── select：AX token 展开下拉框、点选选项、回读值
      ├── wait：纯延时，等待页面或菜单渲染完成，不调用任何桌面工具
      ├── scroll：在 AX 区域内滚动，找不到区域时退化为 PageUp/PageDown
      ├── key：单键 press_key 或带修饰键的 hotkey，用于快捷键和提交
      ├── double_click / right_click：双击或多击、右键菜单
      ├── drag：两个标签各自解析为屏幕坐标后拖动
      └── action：locate=ax 用 element_token 点击或输入；locate=ground 由 Grounder 出坐标
  → Executor 依据新截图决定下一步或直接判定完成
  → 判定完成时由 VL 模型做一次整体验证
  → 环境清理并评论回 Issue
```

| 部分 | 功能和职责 |
|---|---|
| `git-issue-agent` | 只负责 GitHub 轮询、去重、串行队列和评论回写；轮询不调用模型。 |
| DSH | 插件加载、模型调用、工具路由、事件和会话持久化。 |
| `desktop-agent` | 提供 `desktopTasks.run()`，管理可选的一次性 Planner 扩写、自主 Executor 循环、Grounder、VL Verify、桌面锁、安全、预算、结果和清理。 |
| Cua Driver | 提供截图、AX、点击、输入、窗口和应用管理等真实桌面能力。 |
| `issue-agent` Profile | 常驻服务，持续处理带指定标签的 Issue。 |
| `desktop-cua` Profile | 手动执行一条桌面任务后退出，用于调试。 |

默认模型服务：

- Planner（可选，默认关闭）：`http://10.10.10.1:8005/v1`，`qwen3.8-27b-nvfp4`（与 Executor 同一个模型，不再使用 4B 做计划扩写）
- Executor：`http://10.10.10.1:8005/v1`，`qwen3.8-27b-nvfp4`（`thinkingEffort: low`）
- Grounder：`http://10.10.10.1:8003/v1`，`ui-tars-1.5-7b`
- 会话压缩摘要：同样使用 `http://10.10.10.1:8005/v1` 的 `qwen3.8-27b-nvfp4`，通过 `enable_thinking:false` 关闭思考。

Executor 采样固定 `temperature: 0`。

思考模式由 `thinkingMode`（环境变量 `DESKTOP_THINKING_MODE`）控制，**默认 `always`**：每一轮 Executor 决策都带 `reasoningEffort`，因为实测 27B 在 `enable_thinking:false` 下会提前结束、只给散文或直接空响应，no-thinking 省下的时间会被重试全部赔回去。可选 `adaptive`（旧行为：先不思考，卡住再升级、成功后退回）和 `off`（全程不思考，也不再自动升级）。档位由 `thinkingEffort`（环境变量 `DESKTOP_THINKING_EFFORT`，**默认 `low`**）指定，通过 `chat_template_kwargs.reasoning_effort` 真正下发给 27B；服务端支持 `low` / `medium` / `xhigh`，不显式传参时服务端默认 `xhigh`，所以之前的思考开销一直是最高档。`off` 时只发送 `enable_thinking:false`、不带档位。单次决策的输出上限为 6000 tokens，推理 token 也计入其中。任务开始日志会打出 `thinking mode: always`。

配置位于 `packages/desktop-agent/cordis.patch.yml`。`plannerEnabled`（环境变量 `DESKTOP_PLANNER_ENABLED`）**默认 `false`**：不调用 Planner，原始任务直接进入 Executor；显式开启后，每个任务只调用一次 Planner 扩写计划，并在 prompt 中注入 `<execution-plan>`。Executor 最多进行 50 次决策（`maxSteps`），每轮执行一个原子动作，也可以由模型返回 `actions` 数组、在一轮里串行执行最多 3 个动作（例如连填三个输入框、勾选多个选项、填完后滚动）。批量只用于中间结果可预测的序列：整批结束后才重新截图一次，任何子动作失败都会中断本批并跳过剩余动作，`done`/`blocked` 不允许放在批量里。Executor 每轮都重新构造上下文：包含原始任务、可选完整计划、精简历史（动作和执行结论，**最近 5 步保留完整 JSON**，更早的步骤用 `<history-summary>` 逐条摘要，`<history-omitted>` 说明省略数量）、当前轮次的截图和 AX，以及当前反馈和最近 5 条历史反馈（`<feedback-history>`）；历史不携带旧截图或旧 AX。原始任务、计划、AX 等大段文本都有字符预算，超限时会在内容末尾显式标注 `[truncated: ...]`，不再静默截断。screenshot 模式额外按日志口径设置文本硬预算：`system` 4800B、`user` 3000B、`history` 1500B；超限时依次移除历史反馈、压缩 running-apps、计划和原始任务，历史则按「5 步+摘要 → 5 步 → 3 步 → 精简历史」降级，截断按 UTF-8 字节执行并保留显式标记。决策的 `kind` 共十种：`navigate` 默认通过 `existing_profile` 附加本机 Chrome/Edge，完成授权、真实窗口绑定、浏览器状态读取和导航；也可配置 `isolated_new` 或 `isolated_named`，已有绑定标签页时直接复用；`launch` 启动桌面应用并自动绑定正常内容窗口；`select` 选择下拉框选项；`wait` 只做 1–10 秒延时，用于等页面加载或菜单出现；`scroll` 在命中的 AX 区域内按行或页滚动，未命中时退化为 PageDown/PageUp；`key` 用单个按键或 `cmd+s` 这类组合键；`double_click`、`right_click` 在标签位置做双击或右键；`drag` 把起点和终点两个标签各自解析成坐标后拖动；`action` 点击或输入。`action` 的定位方式由 Executor 显式给出：hybrid 模式下默认 `locate:"ax"`，要求 `target` 与当轮 AX 树中元素的标签精确匹配，运行时用 `element_token` 直接点击或 `type_text` 输入，匹配不到会报错让 Executor 改标签或改用 `locate:"ground"`，此时才调用 Grounder 在当轮截图上定位坐标。Grounder 的指令会带上 `decision.action` 的上下文，并强制约束「下拉菜单展开时只点菜单内的选项，不点页面其他位置的同名文字」；选项类点击还会用 driver 的 `zoom` 把截图裁剪到上一步点击点或下拉控件附近（约 720×520）再定位，坐标通过 `from_zoom` 回译到全窗，避免点中背景里的同名文字，日志里的 `crop=(...)` 表示本轮使用了局部定位。定位方式由 `groundingMode`（环境变量 `DESKTOP_GROUNDING_MODE`）控制：**默认 `auto`，Executor 在决策里给出粗略参考坐标 `point: [x, y]`（以 `<screenshot-size>` 标注的截图像素为准），Grounder 拿到整窗截图和这个参考点后做就近精修**，参考点能避免它选中页面其他位置的同名文字；Grounder 返回点离参考点超过 450px 时，自动改用 `zoom` 以参考点为中心局部裁剪后重新定位。`executor` 表示跳过 Grounder、直接用 Executor 的坐标，`grounder` 表示忽略参考点、只用 7B。zoom 返回的坐标超出局部图范围时不再直接失败，会回退到整窗截图重试。每个输入步骤先把目标窗口提到前台并校验它「可见且应用在前台或窗口已聚焦」——driver 的 `launch_app` 刻意在后台启动并抑制抢焦点，AX 路径又能在后台、最小化甚至其他 Space 的窗口上执行，所以只靠启动调用并不能保证你在显示器上看得到。注意不要求目标窗口是 z-order 第一：同应用的小弹窗压在主窗口上时 `verified` 也会是 false，但窗口实际可见且可聚焦，这种情况不算失败。前台化失败时先按 pid 查出 bundle id、用 `open -b` 重新激活应用（这一步会还原最小化或隐藏的窗口，`bring_to_front` 本身只激活进程、不还原最小化窗口），仍不行再用 `set_window_frame` 把窗口移到主显示器中央后重试；最终无法显示时这一步直接失败并把原因回给 Executor，不再对着看不见的窗口静默操作。日志里 `window visible pid=… window=…` 表示这一轮窗口确实可见，`✕ ERROR window not visible …` 表示没能显示。用 AX `element_token` 定位的动作以 `delivery_mode:"background"` 执行，避免前台被还给终端；由 Grounder 或坐标定位的点击、输入、滚动、拖动则以 `foreground` 执行，保证像素坐标落在真实可见位置。`select` 由程序用 AX token 展开 `AXPopUpButton`、收集网页菜单项、点选匹配项、Escape 关闭菜单并回读值，不调用 `page execute_javascript`；菜单不在 AX 树里时转 Grounder 视觉点选；目标选项不存在时把真实选项列表和当前值报错回 Executor，由它改选最接近的选项或保留当前值。输入动作先按页面当前值判断是否跳过，否则全选删除后重写，不会重复追加。每个动作结束后立刻重新截图和 AX 交给 Executor 判定下一步，不再为单步单独调用验证模型；Executor 判定完成时仍须通过一次原始任务整体验证，动作失败则把错误写入下一轮上下文。同时会比较动作前后的观察（优先 AX 文本，只有纯图像窗口才退回截图哈希，避免光标和动画造成的像素差异掩盖「界面没变化」）：画面没有变化时给 Executor 明确的「无进展」反馈，要求换控件、等待或报 blocked，连续两轮无变化会升级为强制换路径，`wait` 不计入，也不会改变 adaptive 思考状态。同一 kind/target/value 的目标连续重复时，除了升级思考，还会显式告诉 Executor「这个目标已经尝试了 N 次且无效，必须改用 double_click/right_click、其他控件，或报 blocked」，反馈与无变化提示会合并，不再只是静默升级思考。真正无法推进时——控件点了没反应、界面没有出现需要的入口、缺少权限——Executor 返回 `done:true` 且 `blocked:true`，在 `response` 里说明卡在哪；该任务标记为 `blocked`（评论里同时标为未验证），而不是继续重复无效动作。每轮观察最多取 `maxElements`（默认 300，环境变量 `DESKTOP_MAX_ELEMENTS`）个 AX 元素。发送给模型的 AX 不经过任何模型摘要，而是在 `renderElements()` 中按角色、可见性、`element_token` 和重复位置确定性精简为 `Controls:`（可点击/输入控件、菜单和滚动区域）与 `Context:`（窗口标题、焦点和少量验证文本）；控件与上下文逐行计入预算，全长 12000 字符、上下文 2000 字符，超出时报告省略数量。达到元素上限时注入 `<current-ax-limit>`，达到字符上限时追加 `[truncated: ...]`，让 Executor 知道观察并不完整。执行器点击、下拉、滚动和输入校验仍使用未精简的原始元素。工具调用预算为 `maxDesktopCalls: 1000`、`maxObservationCalls: 400`、`maxObservationElements: 1500`；其中观察调用包含截图、AX、浏览器状态和 Grounder 的 `zoom`。模型长推理期间每 15 秒发一次只读 `get_session` 心跳，防止 driver 回收隔离浏览器；CUA 会话因长时间空闲结束时会自动 `start_session` 复活并重试当前调用。`launch` 的 `target` 可以是应用名或 bundle id：运行时先用 `list_apps` 按 bundle id、名称和模糊匹配解析，命中后按真实 bundle id 启动；未命中时把已安装应用名列表写进错误，让 Executor 用真实名字重试，不再猜 id。观察上下文对 Planner 提供完整 `<installed-apps>`（含运行状态），对 Executor 只提供 `<running-apps>` 以控制每轮预算，`list_apps` 结果缓存 60 秒。`action` 的 `value` 以换行结尾时，运行时输入去掉换行后的文本再补一次 `return`，用于在终端执行命令或确认搜索；`type_text` 本身不合成任何按键。任务成功后关闭隔离浏览器会话；`existing_profile` 不调用 `end_session`，保留本机浏览器会话；`keepWindowsOnFailure: true` 会保留失败或未完成的桌面现场，正常完成仍执行清理。已有窗口、标签页和应用不会被主动关闭，无法安全清理时标记为 `partial`。

观察模式由 `observationMode`（环境变量 `DESKTOP_OBSERVATION_MODE`）控制，**默认 `screenshot`**：Executor 每轮只看截图，提示词里不再注入 `<current-ax>`，`action`、`double_click`、`right_click`、`drag` 的 `locate` 在运行时统一强制为 `ground`，坐标全部由 Grounder 在截图上给出；`select`、`scroll`、`key` 等仍走原有 AX/键盘路径。设为 `hybrid` 恢复旧行为：Executor 同时拿截图和 AX 文本，优先用 `element_token` 操作。两种模式下 AX 树都会被采集——可选 Planner 与 Executor 共用 27B，开启 Planner 时才会在扩写前读取 AX 文本，`select`、滚动区域定位、输入值校验等执行路径也需要它，省的是 Executor 每轮的 token，不是 driver 调用。任务开始时日志会打出 `observation mode: screenshot`，可用同一条任务在两种模式下对比总步数、耗时和 Grounder 调用次数。

## 2. 浏览器登录态

`browserProfileMode`（环境变量 `DESKTOP_BROWSER_PROFILE_MODE`）**默认 `existing_profile`**：`navigate` 先通过 `list_windows` 查找本机 Google Chrome 或 Microsoft Edge 窗口，再携带 `pid`、`window_id` 和 `strategy:{kind:"existing_profile"}` 附加到该浏览器的现有登录态。`./issue-agent.sh` 会优先复用已带授权的 daemon；只有 daemon 不存在或未带授权时，才使用 `cua-driver serve --grant existing-profile` 重启并等待就绪。脚本退出不再停止 daemon，避免反复断开 CDP 会话。启动日志位于 `log/cua-driver.log`。脚本本身不启动浏览器：只有 `navigate` 且找不到 Chrome/Edge 窗口时才按需打开；遇到 New Tab 识别错误时会先通过 `defaults write ... AppleLanguages` 设置英文界面，再通过 AppleScript 优雅退出并以 `--new-window` 重启浏览器，可用 `BROWSER_APP` 和 `BROWSER_LANG` 覆盖；该语言设置会修改 Chrome/Edge 的持久显示语言偏好。

授权后的首次附加可能打开浏览器固定的远程调试设置页，需要勾选对应浏览器实例，由 Driver 验证该进程拥有的 loopback DevTools 端点。Agent 会导航当前绑定的标签页，运行期间不要手动操作该窗口。任务成功时不会调用 `end_session`，本机浏览器会话和登录态会保留。

导航后会等待 500ms 再检查页面：检测到「喔唷，崩溃啦」、`Aw, Snap` 或常见 `ERR_...` 错误页时只自动重载一次；重载后仍然崩溃、`browser_consent_required`、`browser_wrong_target_refused` 或没有可用 Chrome/Edge 窗口时直接判定失败，不再让模型用 `cmd+tab` 等无关动作反复尝试。

可选 `isolated_new`（每次新建隔离 profile）和 `isolated_named`（复用命名隔离 profile，名称由 `DESKTOP_BROWSER_PROFILE_NAME` 指定，默认 `issue-agent`）。`existing_profile` 会让 Agent 操作本机已登录网站，应只处理可信 Issue，并留意网页中的提示注入。

## 3. 使用方式

在 `.env` 配置模型和固定仓库：

```bash
CUA_MODEL_API_KEY=<model-api-key>
CUA_MODEL_BASE_URL=https://example.com/v1
CUA_MODEL_NAME=<model-name>
DESKTOP_LOCAL_API_KEY=local
GITHUB_REPOSITORY=owner/repo
GITHUB_TOKEN=<issues-read-write-token>
GITHUB_TRIGGER_LABEL=agent:desktop
GITHUB_POLL_INTERVAL_SECONDS=60
```

启动常驻服务：

```bash
./issue-agent.sh
```

创建开放 Issue，添加 `agent:desktop` 标签。正文写清楚目标、应用、输入和预期结果，例如：

```text
标题：计算器验证

打开计算器，计算 5 + 5，确认界面显示 10，然后回复结果。
```

运行期间保持 Mac 解锁，尽量不要使用鼠标键盘。以下日志示例包含可选 Planner 调用；默认 `plannerEnabled=false` 时不会有开头的计划扩写日志。终端日志按节点区分：

```text
◈ MODEL 2026-11-16T07:24:34.767Z call qwen3.8-27b-nvfp4
◈ MODEL 2026-11-16T07:24:35.435Z qwen3.8-27b-nvfp4 input=1880 output=419 time=668ms
◈ MODEL 2026-11-16T07:24:35.435Z qwen3.8-27b-nvfp4 response={"plan":"1. 打开 AmaShop\n2. ..."}
◆ PLAN plan:
1. 打开 AmaShop
2. ...
◈ MODEL 2026-11-16T07:24:38.101Z qwen3.8-27b-nvfp4 input=5110 output=96 time=12386ms
◈ MODEL 2026-11-16T07:24:38.101Z qwen3.8-27b-nvfp4 response={ "done": false, "kind": "navigate", ... }
◆ PLAN step 1: navigate Navigate to http://127.0.0.1:8765/#/home | locate=ax | url=http://127.0.0.1:8765/#/home
▶ EXEC navigated pid=123 window=456 url=http://127.0.0.1:8765/#/home
▶ EXEC step 1 succeeded | Navigated to http://127.0.0.1:8765/#/home | calls=browser_prepare:succeeded,…
▶ EXEC AX ok pid=123 window=456 elements=132 snapshot=s000000a1
⌖ GROUND point=(381,734) window=460x816
✓ VERIFY passed: 任务已完成
◆ PLAN task succeeded | steps=8 | duration=93000ms | 已上架…
```

所有日志带 ISO 时间戳；MODEL 的 call 行会列出本轮输入的分段字节数：`sys`（系统提示）、`user`（任务、plan、窗口信息等用户文本）、`history`（最近 5 步历史，单独计量）、`image`（截图原始字节），没有的段不显示；返回行包含模型名、输入/输出 tokens、耗时和完整返回，服务端上报前缀缓存统计时还会附带 `cache=<命中 tokens>`。其中 `input` 始终是完整 prompt tokens（DSH 上报的是扣掉缓存后的未命中部分，日志会加回去），`cache` 是其中命中前缀缓存的部分，两者可以直接算命中率；`cache=0` 表示本轮没有命中或服务端没有上报。EXEC 日志包含工具错误，执行和验证结论会进入下一轮 Executor 上下文。普通状态行最长 180 字符，模型返回不截断，可通过 `NO_COLOR=1` 关闭颜色。执行结果和事件位于 `artifacts/native/<session-id>/`，Issue 队列位于 `artifacts/issue-agent/issues.json`。

常用命令：

```bash
./verify.sh                 # 手动验证一次桌面任务
./clear-cache.sh            # 停止服务，清空队列和投影缓存
npm test                    # 单元测试
npm run test:e2e            # 使用模拟 GitHub 验证完整链路
E2E_USE_LOCAL=1 npm run test:e2e  # 使用本地 8005 模型配置验证，不覆盖为云端模型
E2E_VERBOSE=1 node tests/e2e/amashop-flow.mjs  # 使用真实模型和 CUA 验证 AmaShop 上架
```
