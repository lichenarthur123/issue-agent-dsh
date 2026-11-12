# DSH＋Cua Driver 桌面 Computer Use Agent PRD

- 文档版本：v1.0
- 文档状态：可进入技术验证与开发
- 目标读者：Kimi Code、后端开发、Agent 开发、测试与运维
- 首期执行入口：DSH Headless CLI
- 目标执行入口：常驻 SuperAgent＋外部指令触发
- 桌面执行器：Cua Driver
- 模型接入：远程 OpenAI 兼容 API

---

## 1. 一句话概述

建设一个运行在目标终端上的桌面 Computer Use Agent：由 DSH 调用远程视觉模型理解任务，通过 Cua Driver 获取桌面状态并执行鼠标、键盘和窗口操作；首期通过 Headless CLI 一次执行一个任务，后续演进为可持续接收 HTTP、Git 等外部指令的常驻 SuperAgent。

---

## 2. 背景与问题

用户需要在云桌面终端或本地桌面中完成网页及应用操作。目标终端通常提供一个可视化桌面，其中可打开浏览器并访问云端电脑或业务网页。

现有需求包括：

1. 获取当前桌面或目标窗口的截图、窗口及控件状态。
2. 使用鼠标、键盘完成点击、输入、滚动、拖拽等操作。
3. 由 Agent 理解自然语言任务，并持续执行“观察 → 决策 → 操作 → 再观察 → 验证”的闭环。
4. 模型部署在远端，通过用户提供的 API Key、Base URL 和模型名称调用。
5. 首期用 Headless CLI 验证任务执行能力。
6. 最终由外部指令触发，包括 HTTP 任务、消息或 Git 事件。
7. 尽可能让 Agent 的后台操作与用户的本地操作共存，但不能未经验证就承诺所有应用均不抢焦点。

---

## 3. 产品目标

### 3.1 首期目标

- 在一种明确的目标操作系统上跑通 DSH＋Cua Driver。
- 使用远程 OpenAI 兼容视觉模型完成桌面操作。
- 通过 `dsh --profile headless` 一次执行一个桌面任务。
- 支持 JSONL 事件输出、最终结构化结果、超时和取消。
- 保存任务日志、会话标识和必要的验证截图。
- 对同一桌面实施单任务串行控制。
- API Key 不进入源码、配置文件、命令行参数和日志。

### 3.2 最终目标

- 形成常驻 SuperAgent，统一接收、排队、调度和审计外部任务。
- 支持 HTTP API 和 Git Webhook 等触发器。
- 执行层与触发层解耦，可先复用 HeadlessRunner，后续再替换为 DSH SDK、ACP 或常驻 Agent Runner。
- 支持任务状态查询、取消、超时、幂等、结果回调和失败恢复。
- 建立可重复的任务成功率与稳定性评估体系。

---

## 4. 非目标与边界

首期的非目标：

1. 不同时承诺 Windows、macOS、Linux 三个平台全部可用。
2. 不修改或 Fork DSH、Cua Driver 核心源码，除非有书面确认的官方能力缺口。
3. 不支持多个 Agent 同时操作同一桌面。
4. 不支持生产环境中的支付、删除、提交审批、对外发送、自动部署等高风险操作。
5. 不建设多租户、分布式队列、多终端调度和复杂管理后台。
6. 不把模型最终回答或 DSH 退出码 0 直接视为业务任务成功。
7. 不将 Headless CLI 当作常驻 HTTP 服务使用。
8. 不默认支持运行中人工问答或审批；Headless 首期依赖预先配置的非交互安全策略。

本 PRD 中的 **SuperAgent** 指项目自研的常驻任务调度与 Agent 编排层，不指 npm 的 `superagent` 包，也不假设 DSH 已有一个同名官方 Profile。

---

## 5. 用户与典型场景

### 5.1 开发者／调试人员

通过 CLI 输入自然语言任务，观察 Agent 的模型调用、Cua Driver 工具调用和最终结果，用于验证模型与桌面环境。

### 5.2 外部业务系统

通过标准任务 API 提交任务，获取任务 ID，轮询或接收回调，最终取得结构化结果。

### 5.3 Git 事件触发场景

代码仓库发生指定事件后，SuperAgent 根据仓库、分支和事件类型匹配规则，生成桌面任务并执行。例如：

- 测试环境发布后，打开指定网页执行冒烟检查。
- 收到特定评论或标签后，在云桌面中执行预定义流程。
- 指定分支更新后，验证测试页面关键功能。

首期不得因为任意 Git 提交内容或评论文本而直接获得无限制桌面操作权限。

---

## 6. 总体架构

### 6.1 首期 Headless 架构

```text
用户／脚本
   │
   │ desktop-cua run --task "..."
   ▼
本地 CLI 包装层
   ├─ 环境预检
   ├─ 单桌面互斥锁
   ├─ 超时与进程监督
   ├─ JSONL 事件收集
   └─ 结果与产物归档
   │
   ▼
DSH Headless Profile
   ├─ Agent Loop
   ├─ 远程 OpenAI 兼容视觉模型
   └─ Cua Driver MCP Provider
   │
   ▼
Cua Driver
   │
   ▼
目标桌面／云桌面终端／浏览器
```

DSH Headless 官方行为是一次任务完成后打印结果并退出，不打开端口；支持 `--json` 输出按行 JSON 事件，支持 `--session-id` 继续已有会话，退出码 0 表示 Agent 轮次正常完成，其他中止或错误情况退出 1。[DSH Headless 官方说明](kimi-cite://web?url=https%3A%2F%2Fgithub.com%2Fdeepseek-ai%2Fdeepseek-harness%2Fblob%2Fmaster%2Fpackages%2Fbundle%2Fheadless%2FREADME.zh.md "citation")

### 6.2 目标 SuperAgent 架构

```text
HTTP API／Git Webhook／其他触发器
                │
                ▼
        Trigger Adapter 触发器适配层
                │
                ▼
       任务标准化、鉴权、过滤、幂等
                │
                ▼
        Task Manager＋单桌面任务队列
                │
                ▼
             Agent Runner
        ┌───────┴────────┐
        │                │
 HeadlessRunner      ResidentRunner
 首期直接复用         后续技术验证后替换
        │                │
        └───────┬────────┘
                ▼
       DSH＋视觉模型＋Cua Driver
                │
                ▼
             目标桌面
```

设计约束：SuperAgent 不得与 HTTP、Git 或 Headless 进程强耦合。触发器只产生标准任务，Runner 只接收标准任务并返回标准结果。

---

## 7. 分阶段需求

## 7.1 阶段 P0：环境与技术可行性验证

### 目标

在不开发复杂业务模块的情况下，验证模型、DSH、Cua Driver 和目标桌面能够形成闭环。

### 工作模块

1. **版本锁定**
   - 记录 Node.js、pnpm、DSH、DSH Cua Provider、Cua Driver 和操作系统版本。
   - 禁止使用未锁定的 `latest` 作为可复现交付版本。

2. **模型接入验证**
   - 配置远程 OpenAI 兼容提供商。
   - 验证文本请求、工具调用和图片输入。
   - 验证网关在系统角色、Token 字段、推理参数方面的兼容性。

3. **Cua Driver 验证**
   - 安装并完成操作系统权限配置。
   - 验证目标窗口枚举、截图、点击、输入、滚动和操作后观察。
   - 记录是否需要前台焦点、是否影响用户鼠标键盘。

4. **Headless Profile 组合验证**
   - 在 Headless Profile 中挂载 `@deepseek-ai/dsh-computer-use`。
   - 挂载 `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp`。
   - 配置 `command: cua-driver`、`args: [mcp]`。
   - 确认当前组合具有截图所需附件存储，并且模型路由声明图片输入。

Cua Driver 官方 DSH 适配文档要求截图具备附件存储和支持图像输入的模型路由；多个 Session 共享桌面时，需要调用方自行协调串行执行。[DSH Cua Driver MCP 官方说明](kimi-cite://web?url=https%3A%2F%2Fgithub.com%2Fdeepseek-ai%2Fdeepseek-harness%2Fblob%2Fmaster%2Fpackages%2Fexperimental%2Fcomputer-use-cua-driver-mcp%2FREADME.zh.md "citation")

### P0 退出条件

- 能通过 DSH Headless 完成一个无风险桌面任务。
- 模型请求中确实能够使用 Cua Driver 返回的截图或窗口状态。
- 能保存该次运行的 Session ID、工具事件和最终回答。
- 明确记录目标操作系统及目标应用的限制。

---

## 7.2 阶段 P1：Headless CLI MVP

### FR-01 环境预检 `doctor`

提供命令：

```bash
desktop-cua doctor
```

检查项：

- Node.js、pnpm、DSH 和 Cua Driver 是否可执行。
- 必要版本是否匹配。
- 必要环境变量是否存在，但不打印密钥值。
- DSH Profile 和 Cua Provider 配置是否有效。
- 模型是否声明 `[text, image]`。
- Cua Driver 权限和目标窗口是否可用。
- 输出逐项 `pass/warn/fail` 和可操作的修复建议。

### FR-02 一次性任务执行

提供命令：

```bash
desktop-cua run --task "打开测试页面并读取页面标题"
desktop-cua run --task-file ./task.txt --json
```

内部调用：

```bash
dsh --profile headless --json "<标准任务指令>"
```

要求：

- 默认创建新 Session。
- 可选支持 `--session-id` 继续已有会话，但必须校验工作目录和会话归属。
- 任务文本优先通过 stdin 传递，避免命令行转义及敏感任务内容暴露在进程列表中。
- 同一桌面通过互斥锁保证一次只运行一个任务。
- 第二个任务不得并发控制桌面；CLI MVP 可直接拒绝并返回明确错误。

### FR-03 结构化结果

CLI 向 stdout 输出一个最终结果 JSON；过程日志写 stderr，完整 DSH JSONL 事件写产物文件。

最终结果至少包含：

```json
{
  "taskId": "task_01",
  "sessionId": "session-xxx",
  "status": "succeeded",
  "agentReason": "completed",
  "verified": true,
  "answer": "页面标题为……",
  "artifactsDir": "./artifacts/task_01",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "error": null
}
```

`status` 至少支持：

```text
succeeded / failed / cancelled / timeout / unverified / busy
```

约束：

- DSH 退出码和 `agentReason` 只描述 Agent 执行状态。
- 未配置业务验证器时，可将正常完成标记为 `unverified`，不得伪造 `verified: true`。
- 失败结果必须保留可读错误码、错误信息及可诊断产物位置。

### FR-04 超时与取消

- 支持任务级总超时，默认 10 分钟且可配置。
- 收到 SIGINT／SIGTERM 时，先尝试优雅停止 DSH 和所属子进程。
- 超过优雅停止宽限期后才强制终止。
- 取消后释放桌面互斥锁。
- 已发生的桌面输入不可撤销，结果中必须明确任务停止位置未知或最后已确认状态。

### FR-05 产物与审计

每次任务生成独立目录：

```text
artifacts/<task-id>/
├── task.json
├── events.jsonl
├── result.json
├── stderr.log
├── metadata.json
└── screenshots/        # 仅保存必要验证截图
```

要求：

- 默认不保存模型 API Key、完整环境变量或无关桌面截图。
- 对密钥、Token、Cookie 等常见敏感字段脱敏。
- 产物保留期限和截图开关可配置。

### FR-06 基础安全策略

- 仅允许在专用测试桌面运行。
- 配置目标应用、窗口和网站白名单。
- 默认禁止支付、删除、提交审批、发送消息、自动部署等高风险任务。
- 不在首期使用“无审批＋无限制权限”作为默认配置。
- Headless 无运行中人工审批通道，所有允许和拒绝规则必须在执行前确定。

---

## 7.3 阶段 P2：常驻 SuperAgent

### FR-07 标准任务模型

所有触发器统一转换为：

```json
{
  "taskId": "task_01",
  "requestId": "caller-unique-id",
  "source": "http",
  "instruction": "执行桌面任务",
  "target": {
    "desktopId": "desktop-01",
    "application": "cloud-terminal",
    "urlAllowlist": ["https://example.test"]
  },
  "policy": {
    "timeoutSeconds": 600,
    "riskLevel": "low"
  },
  "metadata": {}
}
```

### FR-08 HTTP 任务接口

```http
POST   /v1/tasks
GET    /v1/tasks/:id
POST   /v1/tasks/:id/stop
GET    /v1/health
```

要求：

- 创建任务采用异步模式，立即返回任务 ID。
- 支持 `requestId` 幂等。
- 支持 API Token 鉴权、请求体大小限制和调用审计。
- 默认仅监听回环或受控内网地址，不直接暴露公网。
- 后续可增加结果 Webhook，但 P2 首轮可先实现轮询。

### FR-09 任务队列与状态管理

- 每个 `desktopId` 一个串行队列。
- P2 首期只支持一个桌面、一个队列。
- 状态至少包括：

```text
queued → running → succeeded
                  → failed
                  → cancelled
                  → timeout
                  → unverified
```

- 服务重启后，不得将遗留 `running` 任务直接重新执行。
- 对未确认是否发生桌面操作的遗留任务，标记为 `interrupted` 或 `unverified`，等待人工处理。

### FR-10 Runner 抽象

定义统一接口，禁止 HTTP 或 Git 代码直接调用 DSH：

```text
TaskRunner
├─ run(task, context) → TaskResult
├─ cancel(taskId) → CancelResult
└─ health() → RunnerHealth
```

首个实现为 `HeadlessRunner`，复用 P1 能力。

后续可新增 `ResidentRunner`，但只有在独立技术验证确认 DSH SDK、ACP 或其他常驻方式满足以下要求后才替换：

- 可创建和恢复 Session。
- 可获取工具事件和截图结果。
- 可取消任务。
- 可隔离不同任务状态。
- 不发生同桌面并发输入。

### FR-11 SuperAgent 编排

- 接收标准任务并选择目标桌面、Prompt 模板和 Runner。
- P2 不实现复杂多 Agent 协作。
- 如后续增加任务拆解，拆解结果仍须进入同一任务队列和权限策略。
- 外部指令、Git 内容和模型输出均不能绕过任务策略。

---

## 7.4 阶段 P3：Git 触发

### FR-12 Git Webhook 接入

优先实现 GitHub 或 GitLab 中的一种 Webhook，不以轮询本地 `.git` 目录作为默认方案。

要求：

- 校验 Webhook 签名。
- 使用 delivery ID／event ID＋commit SHA 做幂等。
- 配置仓库、事件类型、分支和路径过滤。
- 根据仓库规则选择固定 Prompt 模板。
- 将仓库、分支、commit、作者和事件类型写入任务元数据。
- 不执行 Webhook 中未经校验的任意脚本。
- 不允许模型仅凭 Git 评论内容自动提升权限。

### FR-13 Git 触发结果回写

可作为 P3 后续增强：

- 回写检查状态或评论。
- 回写内容只包含任务状态、结果摘要和受控产物链接。
- 不在评论中暴露截图中的敏感信息、API Key 或完整模型上下文。
- 自动 push、merge、发布和部署均不属于默认允许动作。

---

## 8. 模型与配置要求

### 8.1 用户提供的配置

```bash
export CUA_MODEL_API_KEY="<由用户提供>"
export CUA_MODEL_BASE_URL="https://example.com/v1"
export CUA_MODEL_NAME="<由用户提供>"
```

说明：仅 API Key 和模型名称不足以完成接入，还需要 Base URL，并确认服务端支持 OpenAI Completions 还是 Responses 协议。

### 8.2 DSH 模型路由

首期默认使用 DSH `dsh-llm-pi-ai` 的 OpenAI Completions 兼容配置：

```yaml
- id: llm-pi-ai
  config:
    providers:
      desktop-cua:
        apiKeyEnv: CUA_MODEL_API_KEY
        api: openai-completions
        baseURL: https://example.com/v1
        models:
          - id: <模型名称>
            input: [text, image]
```

如果实际网关只接受 `max_tokens`、不接受 `developer` 角色或具有其他兼容差异，应使用 DSH 的兼容配置修正，不修改模型适配器源码。DSH 官方模型文档明确支持 OpenAI 兼容路由、图片输入声明和相关兼容字段。[DSH 模型配置官方文档](kimi-cite://web?url=https%3A%2F%2Fdeepseek-harness.github.io%2Fdeepseek-harness%2Fguide%2Fproviders "citation")

### 8.3 配置安全

- API Key 只通过环境变量或受控密钥管理器注入。
- 示例文件只能包含占位符。
- `.env`、真实 Profile 配置、截图和产物目录必须加入 `.gitignore`。
- 日志中不得输出请求 Authorization Header。
- 不把 API Key 放入 CLI 参数、任务文本或 Git 元数据。

---

## 9. 桌面操作与完成验证

### 9.1 操作闭环

Agent 的标准执行原则：

```text
确认目标窗口
→ 获取窗口／桌面状态
→ 选择最小必要动作
→ 执行一次或一小组动作
→ 再次观察
→ 判断是否继续
→ 验证结果
```

避免：

- 未观察当前状态就连续执行大量点击。
- 根据过期截图重复点击。
- 目标窗口变化后继续向原坐标输入。
- 模型声称成功后不再验证。

### 9.2 完成验证级别

1. **Agent 完成**：DSH 轮次正常结束。
2. **界面验证**：截图或控件状态证明目标界面已达到预期。
3. **业务验证**：通过业务 API、数据库只读查询或测试页面断言证明任务成功。

P1 至少区分第 1 级和后两级；具体任务尽量达到第 2 级。高风险业务必须达到第 3 级，但高风险业务不属于首期范围。

### 9.3 人机并行

- 优先使用 Cua Driver 支持的后台窗口和控件操作。
- 对每种目标应用记录后台操作能力，不做跨应用统一保证。
- 如果必须前台操作，应暂停、失败或明确提示，不得与用户争抢输入。
- 测试人员主动操作电脑时，验证 Agent 是否能检测、暂停或安全失败。

---

## 10. 非功能需求

### 10.1 可维护性

- 首期以配置、CLI 包装层和独立模块为主，不修改 DSH/Cua Driver 源码。
- 触发器、队列、Runner、结果验证和存储分层。
- 所有外部接口使用版本化结构。
- 对 DSH 和 Cua Driver 的实验性接口做适配隔离。

### 10.2 可观测性

记录以下指标：

- 任务数、成功率、未验证率、失败率。
- 排队时长、执行时长、超时次数。
- 模型请求失败、工具调用失败和权限失败。
- 桌面锁等待和冲突次数。
- Git 触发去重次数和签名失败次数。

日志必须带 `taskId`、`sessionId`、`desktopId` 和 `requestId`。

### 10.3 可靠性

- 单任务异常不得导致 SuperAgent 进程退出。
- 子进程必须被纳入进程组管理，避免遗留孤儿进程。
- 服务关闭时停止领取新任务，并处理在途任务。
- 桌面状态未知时不得自动盲目重试。

### 10.4 安全与隐私

- 最小权限运行。
- 默认专用测试账号和测试数据。
- **任务文本、桌面截图、窗口及控件信息会发送至用户配置的远程模型服务**；使用前必须确认该数据流符合业务安全要求，默认不得处理生产敏感数据。
- 截图和事件产物具有访问控制及保留期限。
- 不对公网无鉴权开放任务接口或 Git Webhook。
- 所有外部文本都视为不可信输入，不作为系统级权限指令。

---

## 11. 建议代码模块

```text
desktop-cua-agent/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── configs/
│   ├── dsh/
│   │   ├── model.patch.example.yml
│   │   └── cua-driver.patch.example.yml
│   └── policies/
│       └── default.json
├── prompts/
│   ├── desktop-task.md
│   └── git-smoke-test.md
├── src/
│   ├── cli.ts
│   ├── config/
│   │   ├── loader.ts
│   │   └── validator.ts
│   ├── doctor/
│   │   └── checks.ts
│   ├── runner/
│   │   ├── types.ts
│   │   ├── headless-runner.ts
│   │   └── process-supervisor.ts
│   ├── desktop/
│   │   ├── mutex.ts
│   │   └── policy.ts
│   ├── results/
│   │   ├── parser.ts
│   │   ├── verifier.ts
│   │   └── artifacts.ts
│   ├── superagent/          # P2 开始实现
│   │   ├── server.ts
│   │   ├── task-manager.ts
│   │   ├── task-store.ts
│   │   └── task-queue.ts
│   └── triggers/            # P2／P3 开始实现
│       ├── http.ts
│       └── git-webhook.ts
├── scripts/
│   ├── bootstrap.ts
│   └── smoke.ts
└── tests/
    ├── unit/
    ├── integration/
    ├── e2e/
    └── fixtures/
```

要求：

- 不为了“未来可能使用”而在 P1 提前实现复杂 SuperAgent。
- P1 必须先定义 Runner 和结果类型，保证 P2 可以复用。
- 配置生成过程不得把真实密钥写入 `configs/`。

---

## 12. 开发里程碑与交付物

| 里程碑 | 主要交付物 | 验收重点 |
|---|---|---|
| M0 技术验证 | 版本清单、模型配置、Cua 配置、手工运行记录 | Headless 能完成真实桌面闭环 |
| M1 CLI 骨架 | `doctor`、配置校验、Headless 调用 | 能启动任务并获取 Session ID |
| M2 可用 MVP | 互斥锁、JSONL 收集、结果 JSON、超时取消、产物目录 | 外部脚本可稳定调用 |
| M3 安全与测试 | 白名单、脱敏、故障处理、测试用例 | 异常时不失控、不误报成功 |
| M4 SuperAgent | HTTP API、任务存储、队列、Runner 抽象 | 外部系统可异步提交和查询 |
| M5 Git 触发 | Webhook、签名校验、过滤、幂等、Prompt 映射 | 指定 Git 事件可生成一次任务 |
| M6 部署运维 | 安装脚本、版本锁定、监控、升级回滚 | 新终端可重复部署 |

每个里程碑必须同时交付：

- 可运行代码。
- 自动化测试。
- 配置示例。
- 使用说明。
- 已知限制。
- 验收结果和失败样例。

---

## 13. 验收标准

### 13.1 P0 验收

1. 远程模型文本调用成功。
2. 模型路由明确支持图片输入。
3. Cua Driver 能读取目标窗口并执行基本操作。
4. Headless 任务中能够发现并调用 Cua Driver 工具。
5. 能保存完整 JSONL 事件和最终回答。

### 13.2 P1 验收

1. `desktop-cua doctor` 能识别缺失配置和权限。
2. `desktop-cua run` 能完成一个无风险桌面任务。
3. 两个 CLI 同时运行时，第二个不会操作桌面。
4. 超时和 SIGTERM 能停止任务并释放锁。
5. 输出结果包含 Task ID、Session ID、状态、答案和产物位置。
6. API Key 不出现在源码、命令行、日志和产物中。
7. Agent 正常结束但无业务验证时，结果不得冒充已验证成功。
8. 在固定测试页上连续执行 5 次简单任务，目标至少 4 次完成；若未达到，记录失败类型并暂不进入 SuperAgent 扩展。

### 13.3 P2 验收

1. HTTP 创建任务后立即返回 Task ID。
2. 相同 `requestId` 不会重复执行。
3. 同一桌面任务严格串行。
4. 可查询状态、取消任务和处理超时。
5. SuperAgent 重启不会盲目重放状态未知的桌面任务。
6. HTTP 层不直接依赖 Headless 命令，Runner 可替换。

### 13.4 P3 验收

1. 无签名或错误签名的 Git 请求被拒绝。
2. 非白名单仓库、分支和事件不会触发任务。
3. 同一 delivery 重发不会重复执行。
4. Git 事件正确映射到固定任务模板。
5. Git 内容不能绕过桌面权限策略。

---

## 14. 测试矩阵

至少覆盖：

| 类别 | 用例 |
|---|---|
| 模型 | 无 Key、错误 Base URL、429、500、超时、不支持图片、工具调用不兼容 |
| DSH | Profile 配置错误、Provider 未挂载、Session 创建失败、会话恢复失败 |
| Cua Driver | 未安装、权限不足、进程断连、目标窗口不存在、窗口尺寸变化 |
| 桌面 | 锁屏、窗口关闭、焦点被抢、分辨率变化、用户同时输入 |
| CLI | 空任务、重复并发、超时、SIGTERM、异常退出、产物写入失败 |
| SuperAgent | 幂等、队列、取消、重启、存储失败、未完成任务恢复 |
| Git | 签名错误、重复 delivery、分支过滤、恶意评论、超大请求体 |
| 安全 | 密钥泄漏检查、截图访问控制、危险任务拒绝、网站白名单绕过 |

---

## 15. 主要风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| DSH 与 Cua 适配包仍为实验性 | 升级后接口变化 | 锁定版本、适配层隔离、升级回归 |
| 远程模型宣称兼容 OpenAI 但细节不同 | 请求失败或工具异常 | 先运行协议兼容性测试，使用 DSH compat 配置 |
| 模型实际不支持图片 | 无法形成视觉闭环 | P0 强制验证，不满足则停止后续开发 |
| Headless 退出 0 被误认为业务成功 | 错误上报 | 分离 Agent 状态与验证状态 |
| 多任务同时操作桌面 | 误点击、串任务 | 每桌面互斥锁＋串行队列 |
| 用户与 Agent 同时输入 | 操作冲突 | 后台能力验证、活动检测、暂停或安全失败 |
| 截图含敏感信息 | 数据泄露 | 最小截图、专用账号、脱敏、访问控制和保留期限 |
| Git 内容形成提示词注入 | 越权操作 | 固定模板、白名单、权限不可提升、内容视为不可信 |
| 进程异常后重复执行 | 重复业务操作 | 状态未知不重放，人工确认后恢复 |

---

## 16. 开发前待确认项

以下问题不阻碍 PRD 评审，但 Kimi Code 在进入对应阶段前必须确认：

1. 首期目标操作系统和版本是什么？只选择一个。
2. 云桌面终端是浏览器中的特定页面、独立客户端，还是其他应用？
3. 远程模型的 Base URL、协议类型、模型名称和图片输入能力是什么？
4. 模型服务是否支持工具调用？是否有速率限制和特殊兼容要求？
5. 首个端到端验收任务是什么？必须无风险且可重复。
6. 任务完成如何判断：截图、控件状态还是业务 API？
7. 是否允许保存截图？保留多久？
8. SuperAgent 首选 HTTP 触发还是 Git 触发？
9. Git 服务商是 GitHub、GitLab 还是其他平台？事件类型是什么？
10. 是否要求 Agent 与用户真正同时使用电脑，还是允许使用独立桌面会话？

---

## 17. 给 Kimi Code 的实施指令

请严格按以下顺序实施，不要跳过验证直接开发 SuperAgent：

1. 先阅读本 PRD 和“开发前待确认项”，缺失的信息标记为配置项或阻塞项，不得自行编造。
2. 检查当前环境，输出 DSH、Cua Driver、Node.js、pnpm 和操作系统版本。
3. 先完成 P0：生成最小 DSH Headless＋OpenAI 兼容视觉模型＋Cua Driver MCP 配置，运行一个无风险桌面任务。
4. 不修改 DSH 或 Cua Driver 源码；如遇官方接口问题，先记录最小复现和替代方案。
5. P0 跑通后，再建立 TypeScript CLI，实现 `doctor` 和 `run`。
6. 为 HeadlessRunner、TaskResult、任务状态和产物结构编写类型与单元测试。
7. 实现单桌面互斥锁、超时、优雅取消、JSONL 收集和结果解析。
8. 明确区分 `agentReason`、`status` 和 `verified`，不得只凭退出码判断业务成功。
9. 完成 P1 验收后，再实现常驻 SuperAgent；首个 Runner 必须复用 HeadlessRunner。
10. Git 触发最后实现，默认只支持一种 Git 服务商和一类明确事件。
11. 每个阶段结束后运行测试并报告：已完成、未通过、阻塞原因、下一步，不得把未验证功能描述为已完成。
12. 全程不得打印、提交或要求把真实 API Key 写入源码；使用占位符和环境变量。

首个建议交付目标：**一个能在指定测试桌面上执行 `desktop-cua run --task-file ./task.txt --json`、输出结构化结果并保存完整审计产物的 Headless MVP。**
