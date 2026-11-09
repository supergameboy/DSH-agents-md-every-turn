# Agents.md every turn

当会话当前模型命中 `deepseek`（可配置）时，在**每个模型轮次的第一步**重新注入工作区 `AGENTS.md` 指令；并在输入框下方常驻显示本会话累计注入次数。

## 为什么需要它

Harness 自带的 `dsh-agent-instructions` 只在会话第一个请求注入一次基线。模型在长会话后容易偏离那份基线，本插件把同一套指令按轮次重新送达。

## 行为

- **触发条件**：`agent/pre-step` 的 `modelSelection` 中 `provider/model` 包含 `modelPattern`（默认 `deepseek`，不区分大小写）。命中才注入，切到其它模型立即停止。
- **触发时机（任一命中即注入一次）**：
  1. **轮次边界** —— 每轮第一次请求（`cadence: turn`）；`cadence: step` 则每步都注入。
  2. **交互工具完成** —— `tool/result` 对应的调用命中 `interactionTools`（默认 `ask_user_question` + 通配 `*question*`，覆盖 MCP 提问类工具）。回答完提问后，紧接着的那一步立刻重新注入。
  3. **审批结论** —— 日志出现 `approval/decided` 后注入（`injectAfterApproval`）。
  4. **轮内用户插话** —— 同一轮内出现来源为 `user` 的 `user/message`（steering / 排队消息进入本轮）后注入（`injectAfterUserInput`）。
- **去重**：交互信号只置一次性标志，由下一次 `agent/pre-step` 消费后立即清除，因此同一步绝不重复注入；插件自己注入的消息来源是 `agents-md-every-turn`，不会被误判为用户交互。
- **文件源**：默认 `~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md`、会话 cwd 下 `AGENTS.md`（存在的才注入）。每条以 `<system-reminder>` 包裹并标注来源路径；正文里的字面 `</system-reminder>` 会被转义；按 `maxBytes` 截断并给出预算提示。
- **消息形态**：带 `source.kind: 'agents-md-every-turn'` 的普通 `user/message` 事件，进入会话日志，可回放、续会话、fork、压缩。
- **计数**：Host 侧 `sessionProjections` 单元 `agentsMdInjections`，纯同步 fold `user/message` 事件按上述 source 计数，`wire.view` 输出整数。Client 侧 `conversation.composer.dock` 的组件用 slot props 的 `useProjection('agentsMdInjections')` 读取并订阅。计数不是内存状态，重启/续会话/fork 后从日志重建。

> **Token 提示**：`~/.dsh/AGENTS.md` 实测约 3.2 KB（≈1000–1500 tokens）。当前配置为**每次触发都注入全文**，交互密集的一轮可能注入十余次，额外占用 1.5–2 万 tokens 并保留至压缩。若觉得偏重，可把 `interactionTools` 收窄、关闭 `injectAfterUserInput`，或降低 `maxBytes`。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `modelPattern` | `deepseek` | 匹配 `<provider>/<model>` 的子串；空串匹配所有模型 |
| `cadence` | `turn` | `turn` 每轮一次 / `step` 每步一次 |
| `paths` | 见上 | 指令文件路径，支持 `~`、绝对路径、相对会话 cwd |
| `maxBytes` | `65536` | 单条注入的 UTF-8 字节预算 |
| `interactionTools` | `['ask_user_question', '*question*']` | 视为「需要用户回答」的工具名；含 `*` 的条目按通配、忽略大小写匹配 |
| `injectAfterApproval` | `true` | 审批结论（`approval/decided`）后是否补注入 |
| `injectAfterUserInput` | `true` | 轮内用户插话（来源为 `user` 的消息）后是否补注入 |

## 架构

```
Host index.js
  ├─ agent/pre-step (waterfall) → 追加一条 sourced user message
  └─ sessionProjections.register({ key:'agentsMdInjections', wire.view })
                                       │ wire composition
Client client.js                        ▼
  └─ slots.inject('conversation.composer.dock')
       └─ Badge({ useProjection }) → useProjection('agentsMdInjections')
```

- 静态 `dsh.client` bundle **不使用** `host.call`（那是动态 Cordis 包专用）；也不通过 `ctx.remote.*` 轮询。Client 只渲染框架已算好的值。
- 服务依赖：`sessions`、`workingDirectory`、`fs`、`sessionProjections` 通过 `inject` 声明；运行时读取统一走 `ctx.get(name)` + undefined 检查，pre-step 监听器整体 try/catch 兜底，插件异常绝不拖垮一轮。

## 已知行为与边界

- **插件重启会在当前轮多注入一次**：「本轮已注入」是内存标记，重载插件（或改配置后重启）会清空它，于是同一轮的下一次 `pre-step` 会补一次全文。这是有意的取舍 —— 避免为了让标记durable而引入额外 projection 与历史扫描；代价是重启数次就多注入数次。
- **交互后的注入是「全文」**：按你的选择，每次都送完整指令，不再区分精简模式。
- **`approval/decided` 依赖 `ask` 策略**：会话策略为 `never` 时审批请求被确定性拒绝、不产生人工交互，因此该触发不会命中；这类会话的日志里只会出现 `approval/policy`。
- **计数只统计注入**：交互触发注入同样计入徽标，因此徽标数字会随交互次数明显增长。

## 安装

### 方式 0：从本仓库克隆后安装

```bash
git clone https://github.com/supergameboy/DSH-agents-md-every-turn.git
```

```
plugin_manager { action: "install_bundle", target: "<克隆下来的目录绝对路径>" }
```

克隆目录要保留，删除后插件失效（见方式 B）。

### 方式 A：从 tarball 安装（推荐）

`npm pack` 产出的 `.tgz`，文件清单由 `package.json` 的 `files` 决定。

```
plugin_manager { action: "install_bundle", target: "<绝对路径>/<包名>-1.0.0.tgz" }
```

或 CLI：`dsh plugin --profile <profile> install <tgz 绝对路径>`

pnpm 会把包内容解包进 `~/.dsh/profiles/<profile>/node_modules/.pnpm/`，profile 里只保留指向那份副本的链接。因此**安装完成后 tgz 可以删除**，插件不依赖你当初发出去的文件。

### 方式 B：从目录安装

```
plugin_manager { action: "install_bundle", target: "<解压后目录的绝对路径>" }
```

这种方式记录的是指向该目录的链接，**目录不能删除或移动**，否则插件失效。好处是改动源码后重启插件即生效，适合本地迭代开发。

### 注意事项

- **profile 相互独立**：装到哪个 profile 就只对那个 profile 生效，换 profile 要重新安装。
- **`~/.dsh/AGENTS.md` 必须存在**：默认路径是"存在才注入"，目标机器上缺这个文件时插件会**静默不注入**，看起来像没生效。请确认该文件存在，或在 `cordis.patch.yml` 的 `paths` 里指向自己的指令文件。
- **包名带 `@local` 作用域**：本地安装无所谓。若要发布到 npm 供他人按包名安装（从而获得版本更新能力），需改成自有 scope、移除 `"private": true` 后再 publish。
- **升级**：先 `remove_bundle` 再 `install_bundle`；直接重装会返回 `already-installed`。

## 验证

插件自带两套可独立运行的检查，不依赖 DSH 运行时（用假的 Host/Client 上下文驱动真实代码）：

```bash
node verify/verify-host.mjs     # Host 侧：注入逻辑、交互触发、计数 projection
node verify/verify-client.mjs   # Client 侧：composer.dock 组件的取值与渲染
```

覆盖范围包括：模型匹配、轮次与交互两路触发、一次性标志、通配工具名、审批与插话信号、自身注入不误判、非匹配模型全部静默、畸形事件不外溢、字节预算截断、以及计数 fold 的引用不变性。

真实日志取证（确认信号链路而非纯单元假设）：会话日志中 `tool/call` 携带 `{turn, step, callId, name, arguments}`，`tool/result` 携带 `message.toolCallId`，两者可按 callId 配对；`agentsMdInjections` projection 的取值与日志中实际注入的批次数严格一致。

