# AmaShop 桌面交互测试（desktop-task）

直接调用 `ctx.desktopTasks.run(record)` 的本地测试包。它复用 `issue-agent` profile 的模型、Executor、Planner、VL 校验、桌面锁、预算和清理逻辑，只通过一个 `--patch` 覆盖层关掉 GitHub 轮询插件，所以执行阶段与“手动启动 issue-agent 并发一条 issue”是同一条代码路径。

## 目录

```text
tests/desktop-task/
├── run.sh                 # 入口：加载 .env、准备 profile、启动 runner
├── run.mjs                # 用例编排、产物收集、断言、汇总
├── cases.mjs              # 10 条 AmaShop 用例 + SMOKE
├── lib/assert.mjs         # state JSON 提取与断言
├── plugin/                # 小插件 @local/desktop-task-once
│   ├── package.json
│   └── src/index.js       # 调用 ctx.desktopTasks.run(record)
├── profile/
│   └── desktop-task.yml   # --patch：disabled git-issue-agent，插入插件
└── results/               # 每次运行的产物（gitignored）
```

## 前置条件

- macOS、本机 Chrome 或 Edge，保持解锁；测试期间不要动鼠标键盘。
- `.env` 里已有模型配置；`run.sh` 会像 `issue-agent.sh` 一样 `source .env`。
- 首次使用先运行 `bash scripts/prepare-profiles.sh`，准备 `$DSH_HOME/profiles` 和 Cua Driver MCP 模块；之后 `run.sh` 会复用并自动维护 profile 软链。
- Cua Driver 需要带 `--grant existing-profile`。若未启动，runner 会尝试启动；若已有 daemon 但没授权，会直接报错并给出重启命令。
- AmaShop 站点未启动时，runner 会自动在 8765 端口拉起，跑完关闭；如果端口已被占用则直接复用。

建议先停掉常驻 issue-agent，避免两边抢桌面：

```bash
pkill -f 'node .*dsh --profile issue-agent'
```

`run.sh` 检测到常驻服务时只会打印 warning，不会替你杀掉它。

## 用法

```bash
# 查看用例
bash tests/desktop-task/run.sh --list

# 冒烟：只回答数字 2，验证插件链路
bash tests/desktop-task/run.sh --smoke

# 跑全部 10 条（串行）
bash tests/desktop-task/run.sh

# 跑指定用例
bash tests/desktop-task/run.sh TC02 TC07

# 跑 3 条代表用例（购物车 / 结算 / 签收弹窗）
bash tests/desktop-task/run.sh --suite smoke

# 按标签筛选
bash tests/desktop-task/run.sh --tag orders

# 只打印将要执行的用例
bash tests/desktop-task/run.sh --dry-run
```

`--timeout <秒>` 可覆盖单条任务超时；`--allow-unverified` 会把 `unverified` 当作通过（默认严格）。

## 每条用例怎么跑

1. `run.mjs` 把用例转成 record：

   ```json
   { "key": "local-amashop#TC02", "repository": "local/amashop", "issue": { "title": "...", "body": "..." } }
   ```

   这与 `git-issue-agent` 轮询得到的 record 结构一致，`run(record)` 会用 `title + "\n\n" + body` 作为原始任务，并用二者做完成校验。

2. 以子进程启动：

   ```bash
   dsh --profile issue-agent --patch tests/desktop-task/profile/desktop-task.yml
   ```

   环境变量 `DESKTOP_TASK_FILE` 指向 record，`DESKTOP_TASK_OUT` 指向结果文件。覆盖层把 `git-issue-agent` 设为 disabled，并插入 `desktop-task-once`。

3. 插件在 `apply` 里调用 `ctx.desktopTasks.run(record)`，先写结果文件；如果开启了经验记忆，再等待异步总结完成后退出（最多等 120 秒）。dsh 的 stdout/stderr 落在用例目录。

4. runner 读取结果，按用例断言：

   - 状态必须是 `succeeded`（或用 `--allow-unverified` 放宽到 `unverified`）；
   - 从最终回复里提取页脚「自动化测试：查看当前业务状态」的 JSON，按路径断言；
   - 断言回复中必须出现的关键文案。

5. 用与 GitHub 回评完全相同的 `buildComment()` 生成 `comment.md`。

## 产物

每次运行生成 `results/<UTC 时间戳>/`：

```text
<run>/
├── site.log               # 仅在 runner 拉起站点时存在
├── cua-driver.log         # 仅在 runner 拉起 driver 时存在
├── summary.json
└── TC02/
    ├── record.json        # 传给插件的 record
    ├── result.json        # desktopTasks.run() 的原始返回
    ├── comment.md         # 与 issue 回评同样的 Markdown
    ├── verdict.json       # 断言结果与失败原因
    ├── stdout.log
    └── stderr.log         # Executor/Planner 日志、模型耗时、工具调用
```

截图与原始事件在 `artifacts/native/<session-id>/`，`session-id` 见 `result.json` 和 `comment.md`。

## 通过标准

- `status=succeeded`：完成时 VL 校验接受。
- state JSON 断言全部匹配。
- 文案断言全部出现。

`unverified` 默认算失败，但通常意味着“模型认为做完了、校验器没接受”，先看截图和 `stderr.log` 再判断。

## 调整用例

用例在 `cases.mjs`，每条包含：

- `id` / `title` / `tags` / `timeoutSeconds`
- `body`：发给 Executor 的任务，也是完成校验的预期
- `assertions.state`：对页脚 JSON 的路径断言，支持 `equals`、`exists`、`startsWith`、`includes`
- `assertions.answer`：最终回复里必须出现的文案

写 `body` 时尽量把预期写成“页面上可见的值/文案”，并让 agent 把页脚 JSON 附在回复末尾；否则断言没有可解析的状态来源。

## 注意

- 用例串行执行，因为真实桌面只有一个。单条通常 1–8 分钟，10 条约 30–90 分钟。
- 每条用例的入口 URL 带 `?reset=1`（`http://127.0.0.1:8765/#/home?reset=1`）：站点加载时会清空 `localStorage` 并把该参数从 hash 中移除，因此刷新不会再清数据。这样每条用例起点确定，又少了一次点按钮/确认框的操作。
- 页脚「重置演示数据」按钮改用页内 `<dialog>` 确认（不再用原生 `confirm()`）。原生模态框会阻塞 CUA 的窗口聚焦与观测，agent 无法继续操作。
- 浏览器默认走 `isolated_named`（profile 名 `amashop-task`），只用一个专用窗口，避开本机 Chrome 的其他窗口/Space。需要改回复用登录态时：
  ```bash
  AMASHOP_BROWSER_PROFILE_MODE=existing_profile bash tests/desktop-task/run.sh TC02
  ```
- 不要把 `DESKTOP_BROWSER_PROFILE_MODE` 改成 `isolated_new`：每次 `navigate` 都会新建 profile，跨页面状态会丢。需要隔离时用 `isolated_named`。
- 观察模式与手动 `./issue-agent.sh` 走同一份配置（`packages/desktop-agent/cordis.patch.yml`，当前 `screenshot`）。临时对照混合模式：
  ```bash
  AMASHOP_OBSERVATION_MODE=hybrid bash tests/desktop-task/run.sh TC02
  ```
- 如果执行中途 Ctrl-C，runner 会向当前 dsh 发 SIGTERM；dsh 的插件会停止 Agent、释放桌面锁并清理它打开的窗口。
- 这套测试不是 headless CI：它驱动真实桌面和本机浏览器，必须保持机器解锁。