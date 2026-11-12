# DSH Desktop Issue Agent

## 1. 架构与职责

```text
GitHub Issue
  → git-issue-agent 轮询、规划、排队
  → DSH 创建并运行 Agent
  → desktop-agent 执行安全、预算和结果管理
  → Cua Driver 操作 macOS 桌面
  → git-issue-agent 将结果评论回 Issue
```

| 部分 | 功能和职责 |
|---|---|
| `git-issue-agent` | 定时轮询固定仓库；轮询不调用模型。发现任务后先生成 CUA 步骤，再串行启动 Agent，最后回写评论。 |
| DSH | 插件加载、模型调用、Agent 循环、工具路由、事件和会话持久化。 |
| `desktop-agent` | 桌面互斥、安全策略、行动预算、超时、结果记录；任务结束后关闭本任务新建的窗口和应用。 |
| Cua Driver | 提供截图、界面树、点击、输入、窗口和应用管理等真实桌面能力。 |
| `issue-agent` Profile | 常驻服务，持续处理带指定标签的 Issue。 |
| `desktop-cua` Profile | 手动执行一条桌面任务后退出，用于调试。 |

每个 Issue 都有独立 Agent、Session、行动预算和结果目录。已有窗口、标签页和应用不会被插件主动关闭；无法安全清理时记录为 `partial`，不强制杀进程。

## 2. 使用方式

在 `.env` 配置模型和固定仓库：

```bash
CUA_MODEL_API_KEY=<model-api-key>
CUA_MODEL_BASE_URL=https://example.com/v1
CUA_MODEL_NAME=<model-name>
GITHUB_REPOSITORY=owner/repo
GITHUB_TOKEN=<issues-read-write-token>
GITHUB_TRIGGER_LABEL=agent:desktop
GITHUB_POLL_INTERVAL_SECONDS=60
```

启动常驻服务：

```bash
./issue-agent.sh
```

在 GitHub 创建一个开放 Issue，添加 `agent:desktop` 标签。正文写清楚目标、应用、输入和预期结果，例如：

```text
标题：计算器验证

打开计算器，计算 5 + 5，确认界面显示 10，然后回复结果。
```

插件会先整理执行计划，再操作桌面。运行期间保持 Mac 解锁，并尽量不要使用鼠标键盘。完成后可在 Issue 评论中看到计划和结果。

常用命令：

```bash
./verify.sh                 # 手动验证一次桌面任务
./clear-cache.sh            # 停止服务，清空队列和投影缓存
npm test                    # 单元测试
npm run test:e2e            # 使用本地模拟 GitHub 验证完整链路
```

执行结果和事件日志位于 `artifacts/native/<session-id>/`；Issue 队列位于 `artifacts/issue-agent/issues.json`。
