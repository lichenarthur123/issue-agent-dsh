# 在全新 macOS 上安装 DSH Desktop Issue Agent

本文面向执行安装的 Agent。按顺序执行，不要在验收前启动 GitHub 轮询。所有命令默认在仓库根目录执行。

## 1. 安装前确认

需要：

- 一台已解锁的 macOS 机器；真实桌面测试期间不要操作鼠标键盘。
- Google Chrome 或 Microsoft Edge。
- 可访问的 OpenAI 兼容 Executor、Grounder 和默认模型服务。
- 如需 GitHub Issue 轮询：仓库读写 Token 和目标仓库权限。

版本基线：

| 组件 | 基线 |
|---|---|
| Node.js | 24.22.2；运行时要求 22+ |
| npm | 11.19.1 |
| DSH | 0.2.2-rc.1 |
| Cua Driver | 0.28.0；更新版本需重新验收 |

不要复制原机器的 `.tools`、`.env`、`artifacts`、`log` 或 DSH profile。它们会在本机重新生成。

## 2. 安装系统依赖

安装 Homebrew 后执行：

```bash
brew install node@24 python
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version
npm --version
python3 --version
```

安装 Cua Driver（官方安装脚本会安装 `/Applications/CuaDriver.app` 和 `cua-driver` CLI）：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)"
cua-driver --version
```

官方说明：https://cua.ai/docs/cua-driver/quickstart

如果 `cua-driver` 不在 PATH，可先使用：

```bash
export PATH="/Applications/CuaDriver.app/Contents/MacOS:$PATH"
```

## 3. 获取代码并安装 Node 依赖

```bash
git clone https://github.com/lichenarthur123/issue-agent-dsh.git
cd issue-agent-dsh
npm ci
npx dsh --version
```

预期 DSH 版本为 `0.2.2-rc.1`。`npm ci` 必须使用仓库中的 `package-lock.json`，不要先删除锁文件。

## 4. 初始化 DSH profiles

```bash
bash scripts/prepare-profiles.sh
```

该脚本在仓库 `.tools/dsh-home/profiles` 下创建：

- `desktop-cua`：安装 Cua MCP 模块并链接本地 desktop-agent。
- `issue-agent`：链接 desktop-agent、git-issue-agent 和 Cua MCP 模块。

可通过 `DSH_HOME` 使用其他隔离目录：

```bash
DSH_HOME="$PWD/artifacts/fresh-install/dsh-home" bash scripts/prepare-profiles.sh
```

脚本可重复执行。只有 Cua MCP 模块缺失时才调用包管理器下载。

## 5. 配置模型与 GitHub

```bash
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

- `CUA_MODEL_API_KEY`、`CUA_MODEL_BASE_URL`、`CUA_MODEL_NAME`：DSH 默认云模型。
- `DESKTOP_LOCAL_API_KEY`：本地 OpenAI 兼容服务的非空占位 key，默认 `local`（仅回滚到局域网直连时使用）。
- `GW_KEY`：阿里云公网网关的 API Key，也可放在 `~/.workbench/relay.env` 的 `GW_KEY=` 一行，`issue-agent.sh` 和 `scripts/doctor-macos.sh` 会自动加载。
- `GITHUB_REPOSITORY`、`GITHUB_TOKEN`：仅在验收完成后需要轮询时配置。

同时核对两个文件中的服务地址：

- `profiles/issue-agent/cordis.patch.yml`：`spark-planner`、`spark-executor`、`spark-grounder` 的 baseURL、模型 ID 和 `apiKeyEnv`（默认分别走 `http://39.97.8.6:8080/vision/v1` 和 `/grounder/v1`；对应的 `*-local` 是局域网回滚路由）。
- `packages/desktop-agent/cordis.patch.yml`：Executor/Planner/Grounder 使用的 provider 和模型 ID。Grounder 默认 `provider: spark-grounder`、`model: ui-tars-1.5-7b`。

当前实现中这些 profile 值不是 `.env` 插值，必须按目标环境修改。Executor 需要文本+图片输入；Grounder 默认 `ui-tars-1.5-7b`。网关要求 `X-Api-Key` 或 `Authorization: Bearer`，读超时 600s。不要把真实 `.env` 提交到 Git。

先检查不依赖模型的安装状态：

```bash
bash scripts/doctor-macos.sh --skip-model
```

再检查模型 `/models` 接口：

```bash
bash scripts/doctor-macos.sh
```

`FAIL` 必须处理完再继续；`WARN` 需要逐项确认。

## 6. 授予 macOS 权限

在系统设置中允许 CuaDriver 使用：

- 辅助功能（Accessibility）
- 屏幕录制（Screen Recording）

可用官方授权流程：

```bash
cua-driver permissions grant
cua-driver permissions status
```

启动带本机浏览器登录态授权的 daemon：

```bash
cua-driver serve --grant existing-profile
```

保持该进程运行。`./issue-agent.sh` 和测试 runner 也会复用或启动它。

注意：

- `existing_profile` 会操作本机 Chrome/Edge 的真实登录态，只处理可信任务。
- 浏览器附加失败时，恢复逻辑可能修改 `AppleLanguages` 并重启浏览器。
- 测试默认使用独立的 `amashop-task` 浏览器 profile，不依赖本机网站登录态。

## 7. 本地测试网站

仓库已包含完整 AmaShop 测试站点：

- `tests/website/index.html`
- `tests/website/serve.sh`

测试 runner 会自动在 `127.0.0.1:8765` 启动它。也可手动启动：

```bash
bash tests/website/serve.sh
```

另一个终端检查：

```bash
curl -I http://127.0.0.1:8765/
```

用例入口的 `?reset=1` 会清空并重建演示数据，然后从 hash 中移除该参数。端口被占用时 runner 会复用现有站点，因此手动启动前应确认 8765 上确实是本仓库的网站。

## 8. 分阶段验收

### 8.1 单元测试和语法检查

```bash
npm test
npm run check
```

全部通过后再继续。

### 8.2 插件链路 SMOKE

```bash
bash tests/desktop-task/run.sh --smoke
```

只验证 DSH、插件和结果收集，不操作浏览器。

### 8.3 最小真实桌面验收

```bash
bash tests/desktop-task/run.sh TC02
```

该用例验证：本地网站、隔离浏览器、27B Executor、7B Grounder、数量输入、购物车、VL 校验和业务 JSON 提取。

### 8.4 完整本地验收

```bash
bash tests/desktop-task/run.sh TC01 TC02 TC03
```

预期 `summary: 3/3 passed`。日志位于：

```text
tests/desktop-task/results/<timestamp>/
artifacts/native/<session-id>/
```

如果失败，先查看对应 `stderr.log`、`verdict.json` 和最后截图，不要通过 `--allow-unverified` 掩盖问题。

### 8.5 可选：验证本地经验记忆

经验记忆默认关闭。开启后跑两轮同一用例，确认写入和注入都生效：

```bash
DESKTOP_MEMORY_ENABLED=true DESKTOP_MEMORY_ROOT=memory bash tests/desktop-task/run.sh TC02
cat memory/experience.md
grep "memory saved\|memory loaded" tests/desktop-task/results/<timestamp>/stderr.log
grep "task succeeded" tests/desktop-task/results/<timestamp>/stderr.log
```

任务结束后经验是异步更新的：`memory saved lessons=...` 可能比 `task succeeded` 晚几秒出现，稍等再看。第二轮开头应出现 `memory loaded lessons=...`，并对比两轮 `task succeeded` 行的 `steps` 和 `duration`。若总结调用失败，日志只有 `memory update skipped`，任务本身仍然成功，旧经验保持不变。记忆文件可能包含操作痕迹，`memory/` 不要提交到仓库。

## 9. 启动 GitHub Issue Agent

确认本地验收完成后，在 `.env` 中配置 GitHub，然后执行：

```bash
bash scripts/doctor-macos.sh --github
./issue-agent.sh
```

默认轮询带 `agent:desktop` 标签的开放 Issue。测试阶段不要连接生产仓库，建议先使用专用测试仓库和最小权限 Token。

## 10. 常见问题

| 问题 | 处理方式 |
|---|---|
| `cua-driver: command not found` | 检查 CuaDriver 安装和 PATH；不要只复制 CLI，macOS 权限关联到 CuaDriver.app。 |
| 截图或点击权限失败 | 运行 `cua-driver permissions grant`，检查辅助功能和屏幕录制。 |
| `browser_wrong_target_refused` | 确认 daemon 带 `--grant existing-profile`；隔离测试可重跑以创建新浏览器实例。 |
| Restore pages / Translate 弹窗 | 保持当前代码的自动恢复开启，不要连续手动点击；持续出现时检查浏览器启动状态。 |
| 模型连接失败 | 用 `curl $BASE_URL/models` 检查地址、网络和鉴权；Executor 必须支持图片。 |
| 8765 端口被占用 | 确认现有页面是否为 AmaShop；否则停止旧进程后重试。 |
| desktop is busy | 等待当前任务结束；确认无运行中的 issue-agent 后再清理过期桌面锁。 |
| profile/MCP 模块缺失 | 重新运行 `bash scripts/prepare-profiles.sh`。 |
| 经验记忆未生效 | 确认 `DESKTOP_MEMORY_ENABLED=true`；检查 `memory/experience.md` 是否存在，以及日志是否有 `memory loaded` 或 `memory update skipped`。失败或没有执行历史的任务不会更新经验。 |
| 需要清空 Issue 队列 | 使用 `./clear-cache.sh`；它会停止常驻 issue-agent，但不会删除截图和原始会话。 |

## 11. 完成标准

只有满足以下条件才算安装完成：

- doctor 无 `FAIL`。
- 单元测试和语法检查通过。
- SMOKE 通过。
- 本地网站可访问。
- TC02 通过；完整交付时 TC01–TC03 全部通过。
- 如需 GitHub 轮询，`doctor --github` 通过，且目标仓库不是未授权的生产环境。
