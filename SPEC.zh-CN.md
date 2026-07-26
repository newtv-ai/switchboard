# Switchboard —— 项目设计规约

> **一部手机，管所有 AI 编程 CLI。** 自部署 Web 应用 + 插件化 adapter 系统 + 原生 PTY 中继。本文是设计的唯一源头。
>
> **状态**：v1.3 · 最近更新：2026-07-26 · 核心会话生命周期整改 + 审计复审
> **本文是单一事实来源。** 任何新功能、范围调整、架构决策**都必须在写代码之前/之中**反映到本文。如果实现和本文走偏，要么改本文，要么回滚实现。更新流程见 §11 变更日志。
>
> 🌐 **语言**: [English](./SPEC.md) · 中文

---

## 0. TL;DR

一个可自部署的 Web 应用，让开发者在手机浏览器里通过 Tailscale 驱动开发机上的 AI 编程 CLI（Claude Code、Codex、Antigravity…）。插件化设计：每个 agent 以 adapter 包形式发布。核心是 agent-agnostic 的 PTY 中继，所以新 agent 当天就能在原生模式下跑，adapter 再叠加语义化 UX（聊天视图、diff 视图、快捷操作按钮、推送通知）。

**为什么选 Switchboard** —— 专为"手机控制 CLI 编程"而做：原生 PTY 中继在蜂窝网下不卡、不会有屏幕共享伪影；公开的插件 API 让任何新 agent CLI 都能以一个小 adapter 接入；Windows 服务端是一等公民（懂 ConPTY）；MIT 协议，下游派生没顾虑。

---

## 1. 愿景与不做项

### 1.1 愿景
"把手机当成 CLI 的遥控器。" 用户日常工作流仍然在桌面终端——他们照样 `cd ~/project && claude`。Switchboard 的活儿是 **把手机（或另一个浏览器）attach 到那个已经在跑的会话**，而不是替换终端。

一个开发者应该能：
- 在自己日常终端里跑 `switchboard run claude`（或者通过 shell alias 直接 `claude`）—— TUI 行为和裸 `claude` 完全一致
- 在手机浏览器打开 → 看到所有运行中的会话，attach 到任意一个
- 在手机上敲字 → 桌面终端看到同样输入；两端始终同步
- 一键继续 / 批准 / 拒绝 / 重定向 agent
- agent 完成或要输入时收到推送通知
- 跨多个项目 **并行跑多个 agent**，每个一个终端 tab，全部在手机端可见

### 1.2 不做项（v1）
我们**不**做：
- 屏幕共享 / RDP 式的桌面流
- 云托管版本（只做自部署；云是未来的商业决策）
- 原生 iOS/Android App（只做 PWA —— 显著降低交付成本）
- E2E 加密 / 多用户账号（假设单用户、单机）
- LLM 代理 / API 网关（我们驱动现有 CLI，不替换它们）
- VSCode / IDE 插件（独立范围）

如果你发现自己在做以上任何一项，停下来先更新这一节。

---

## 2. 目标用户与约束

- **主用户**：用 Windows 11 开发机的开发者，熟 `npm` 和终端。日常用 Tailscale 做私人 mesh 网络。
- **平台**：
  - 服务端：**Windows 11（优先级最高）**、macOS、Linux。原生 Node.js，不要求 Docker。
  - 客户端：任意现代移动浏览器（iOS Safari 17+，Android Chrome 120+）以及桌面浏览器。
- **协议**：MIT。所有 adapter 契约是 public-API。
- **分发**：一行 `npm i -g <name>` 完成安装。`npx <name>@latest` 一次性运行也行。不强制 Docker（Docker 可以作为可选方案）。

---

## 3. 架构总览

会话进入 SessionManager 有两种路径：

**A. Wrapped（主用例）** —— 用户在自己真实终端里跑 `switchboard run claude`。Wrapper 进程在本地拥有 PTY（所以终端 TUI 一切正常）；同时开一条 WebSocket 到服务端注册并中继字节。

**B. Server-spawned（次要）** —— 手机/浏览器请求服务端起一个新进程。适合离开桌子时想随手开一个新任务。

两种路径产出同样的 `Session` 抽象；系统其他部分（UI、adapter、推送通知）不关心是哪一种。

```
                    ╔════════════════════════════════════════╗
                    ║  Wrapped session (Mode A —— 主)        ║
                    ╚════════════════════════════════════════╝
   ┌─ User's desktop terminal ──────────────────────────────┐
   │ PS> switchboard run claude                             │
   │   ┌──────────────┐    ┌─────────────────┐              │
   │   │ wrapper proc │◄──►│ claude (PTY)    │  TUI 正常    │
   │   └───────┬──────┘    └─────────────────┘              │
   └───────────┼────────────────────────────────────────────┘
               │ WS /wrap  (pty stream + input + resize + exit)
               ▼
        ┌──────────────────────────────────────────┐
        │ Switchboard server                       │
        │                                          │
        │  Session Manager                         │◄── /sessions (REST)
        │   ├── Session #1 (Wrapped, claude)       │
        │   ├── Session #2 (Wrapped, codex)        │
        │   └── Session #3 (Server-spawned)        │
        │                                          │
        │  Adapter Registry (Phase 3)              │
        │   ├── @switchboard/adapter-claude        │
        │   ├── @switchboard/adapter-codex         │
        │   └── @switchboard/adapter-passthrough   │
        └──────────────────┬───────────────────────┘
                           │ WS /ws  (attach + pty + event + input + resize)
                           ▼
                 ┌─────────────────────────┐
                 │ Phone / Browser (PWA)   │
                 │  ├── Session list       │
                 │  ├── Terminal view      │
                 │  └── Chat view (Ph. 3+) │
                 └─────────────────────────┘

                    ╔════════════════════════════════════════╗
                    ║  Server-spawned session (Mode B)       ║
                    ╚════════════════════════════════════════╝
                 [browser] ──create──► server ──node-pty──► claude
                              ▲                  ▲
                              └── attach ────────┘
```

### 3.1 三层模型

| 层 | 做什么 | 知道 agent 吗？ | 必需？ |
|---|---|---|---|
| **L1 —— PTY 中继** | 把字节流送进/送出 PTY（本地通过 node-pty，或通过 wrapper WS 远程）。对任意 CLI 都成立。 | 不知道 | 是 |
| **L2 —— 结构化解析器** | 把 agent 的结构化输出（stream-json 等）解析成类型化事件。 | 知道（每个 adapter 不同） | 可选 |
| **L3 —— 动作注入** | 把 UI 按钮点击（"approve"、"stop"）翻译成按键 / SDK 调用。 | 知道（每个 adapter 不同） | 可选 |

**只实现 L1 的 adapter 也能用** —— 用户拿到一个终端视图，没有聊天和快捷操作。这就是"raw 模式"承诺。

### 3.2 Session backend 的可插拔

`Session` 接受一个 `SessionBackend` 接口而不是自己拥有 PTY。两种实现：

- `LocalPtyBackend` —— 包 `node-pty`。给 Mode B（server-spawned）用。
- `WrapperBackend` —— 包来自 `switchboard run` wrapper 的 WebSocket 连接。给 Mode A 用。

系统其他部分（Session、SessionManager、parser、action、UI）对两者完全相同。将来加新的传输类型（如 SSH 隧道 wrapper、远程 agent-as-a-service）就是加一个 backend 类，不需要大范围重构。

### 3.2 为什么 PTY-as-core（而不是 SDK-as-core）
- **新 agent 当天可用**：Antigravity 2.0 在 2026-05-19 上线时根本没有 SDK。PTY-as-core 让它当天就能在 raw 模式下用，adapter 我们慢慢写。
- **agent JSON 协议崩了能优雅降级**：Codex `--json` 不稳定（openai/codex#4776 schema 漂移，#15451 跟 MCP 一起用会静默忽略）。如果 Codex 改了 schema，用户回落到终端模式，而不是整个产品炸掉。
- **TUI 是规范 UX**：斜杠命令、设置菜单、登录流程都假设 TUI。终端模式把这些全保留。聊天模式是上层的人体工学叠加，不是替代。

---

## 4. 组件规约

### 4.1 Core：PTY 中继 & Session Manager
- **包**：`packages/core`
- **职责**：
  - 在 PTY 里 spawn agent 进程（`node-pty`，Windows 用 ConPTY）
  - 维护每会话 ring buffer（如最近 2 MB 输出）用于重连
  - 把当前 WebSocket 的输入路由到 PTY stdin
  - 从任何客户端 detach 会话——进程在断开后继续运行
  - 客户端通知窗口大小变化时 resize PTY
  - 发布会话生命周期变化（`created`、`updated`、`exited`、`removed`），让列表客户端无需轮询也能保持最新
  - Session 和 SessionManager 派发前快照监听器，回调中的清理或 detach 不会截断同一轮后续客户端通知
  - wrapper 传输短暂中断时保留原 Session，并允许 `WrapperBackend` 通道解绑后重新绑定
  - 把这次中断告知客户端（`SessionSummary.connected`），中断期间拒绝写入，绝不静默丢弃输入
  - 会话列表按创建时间倒序：实时推送的列表不能因为某个会话在刷输出就重排
- **关键 API**：
  ```typescript
  class SessionManager {
    spawn(opts: SpawnOpts): Session;
    register(opts: RegisterOpts): Session;
    list(): SessionSummary[];
    subscribe(listener: (event: SessionManagerEvent) => void): () => void;
  }
  ```

### 4.2 传输：WebSocket 协议

两个 WS 端点，用途不同：

#### `/ws` —— 浏览器 / 手机客户端协议
- **每个 UI tab 一条 WS。** 多个 tab/设备可以 attach 到同一个会话。
- **Client → Server**：
  - `list` —— 请求当前会话列表（服务端回 `sessions`）
  - `attach` `{ sessionId }` —— 订阅已有会话
  - `create` `{ adapterId, cwd?, env? }` —— spawn 一个新的服务端管理会话（Mode B）
  - `input` `{ data }` —— 原始按键
  - `resize` `{ cols, rows }`
  - `action` `{ actionId, params? }` —— L3 语义动作（adapter 翻译）
  - `kill` `{ sessionId }`
- **Server → Client**：
  - `sessions` `{ list: SessionSummary[] }` —— 初始快照，以及连接仍停留在列表模式时的实时生命周期快照；仅活动时间变化的更新按每个 Session 每秒最多一次节流
  - `ready` `{ sessionId, adapter, capabilities, replay }`
  - `pty` `{ data }` —— 原始 ANSI 字节
  - `event` `{ event: AgentEvent }` —— 结构化事件（Phase 3+）
  - `state` `{ state: AgentState }`
  - `exit` `{ code, signal? }`
  - `error` `{ message }`
  - `pty-resize` `{ cols, rows }` —— 协商后的 PTY 尺寸已变
  - `transport` `{ connected }` —— 该 Session 背后的 wrapper 掉线/恢复；为 false 时客户端禁用输入

#### `/wrap` —— Wrapper 进程协议（Mode A）
- **每次 wrapper 调用一条逻辑连接。** Wrapper 是 PTY 的拥有者；本地 PTY 持续运行时，底层 WS 可以断线重连。
- **Wrapper → Server**：
  - `register` `{ wrapperId, resumeKey, adapterId, cwd, name?, command, args, cols, rows, env? }` —— 初始握手；`wrapperId` 与密码学随机的 `resumeKey` 在 wrapper 进程生命周期内保持稳定
  - `resume` `{ wrapperId, resumeKey, sessionId, cols, rows, hasLocalViewport? }` —— 重连到同一内存 Session
  - `pty` `{ data }` —— 每个 PTY 输出块
  - `exit` `{ code, signal? }`
- **Server → Wrapper**：
  - `registered` `{ sessionId }` —— 回执，带分配的 id
  - `resumed` `{ sessionId }` —— 恢复成功，保留原 Session 与 replay buffer
  - `resume-rejected` `{ reason }` —— Session 已不存在（通常因为 server 重启）；wrapper 在同一 socket 上重新注册
  - `input` `{ data }` —— 从任意 attach 浏览器来的输入
  - `resize` `{ cols, rows }` —— 浏览器发的 resize 请求（wrapper 可以接受或忽略；v1 里本地终端尺寸是权威的）
  - `kill` `{ signal? }`
  - `error` `{ message }`

传输规则：
- wrapper 重连退避上限为 10 秒；同一 server 进程内，断线 Session 保留 30 秒宽限期。
- 重新绑定必须具备连接代际保护：旧 socket 的 close 不能解绑新连接；通过 `resumeKey` 校验的新连接可以替代旧传输，但不得创建重复 Session。替换顺序是先绑新、再释放旧句柄，避免把"根本没发生的中断"报给客户端。
- 对能自证身份的 wrapper，`register` 是幂等的：记录仍在且 `resumeKey` 匹配时直接返回同一个 Session。这覆盖了"没收到 `registered` 回执、因而没有 sessionId 可 resume"的情况。
- wrapper 传输断开期间不缓存浏览器输入：输入会被**拒绝并告知**（`transport` 帧 + 每次断开一条 `error`），而不是收下再丢掉；客户端在恢复前禁用输入。wrapper 可以保留有上限的 PTY 输出，并且只在 register/resume 成功后补发。
- Switchboard server 正常关闭时不得 kill 由 wrapper 拥有的 PTY。server 重启后 resume 被拒，wrapper 自动注册新 Session，本地 CLI 不退出。

对同一段 agent 输出，`pty` 和 `event` 可能同时发——`pty` 总是发；`event` 只在 adapter 有 parser 时发。客户端选择渲染哪一个。

### 4.3 Adapter 层（**真正的**插件契约）
- **SDK 包**：`packages/sdk` —— 仅类型定义，所有 adapter 依赖它
- **Adapter 是 npm 包**，默认导出一个 `AgentAdapter`。内置 adapter 在 `packages/adapter-*`；第三方 adapter 装到 `~/.<project>/adapters/` 或者在配置里引。

```typescript
// packages/sdk/src/index.ts
export interface AgentAdapter {
  manifest: AgentManifest;

  /** 构造 spawn agent 用的命令行 + env。
   *  实际的 node-pty spawn 由 core 做；adapter 只负责配置。 */
  buildCommand(opts: SpawnOpts): SpawnConfig;

  /** 可选 L2：从原始 stdout 块产出结构化事件。 */
  createParser?(): Parser;

  /** 可选 L3：把 UI 动作映射到 PTY 输入或会话操作。 */
  actions?: Record<string, ActionHandler>;
}

export interface AgentManifest {
  id: string;                // "claude" | "codex" | "antigravity" | ...
  displayName: string;
  iconUrl?: string;
  adapterVersion: string;    // 这个 adapter 的 semver
  agentVersionRange: string; // 它支持的 agent CLI 版本 semver 范围，如 "^1.0"
  capabilities: AgentCapability[];
  install?: {
    detect(): Promise<DetectResult>;       // CLI 在 PATH 上吗？什么版本？
    hint?: string;                          // 给人看的安装说明
    autoInstallCommand?: string[];          // 可选：跑这个安装
  };
}

export type AgentCapability =
  | "structured-output"   // adapter 实现了 createParser
  | "approval-flow"       // adapter 能识别 waiting-for-approval
  | "thinking"            // adapter 发 thinking 事件
  | "tool-use"            // adapter 发 tool_use 事件
  | "diff-output";        // adapter 发可解析 patch

export interface SpawnConfig {
  command: string;        // 如 "claude"
  args: string[];         // 如 ["--output-format", "stream-json", ...]
  env: Record<string, string>;
  cwd: string;
}

export interface Parser {
  /** 每个 PTY stdout 块调用一次。返回 0+ 个结构化事件。
   *  必须容忍部分块（NDJSON 跨边界等）。 */
  feed(chunk: Buffer): AgentEvent[];
  /** Adapter 对当前状态的最佳猜测；每次 feed() 后调用。 */
  getState(): AgentState;
}

export type AgentEvent =
  | { type: "text";             content: string }
  | { type: "thinking";         content: string }
  | { type: "tool_use";         id: string; tool: string; input: unknown }
  | { type: "tool_result";      id: string; output: string; isError?: boolean }
  | { type: "approval_request"; id: string; tool?: string; preview?: string }
  | { type: "diff";             path: string; patch: string }
  | { type: "usage";            inputTokens: number; outputTokens: number }
  | { type: "result";           success: boolean; summary?: string };

export type AgentState = "starting" | "running" | "thinking" | "waiting_for_approval" | "idle" | "error" | "exited";

export type ActionHandler = (ctx: ActionContext, params?: unknown) => Promise<void> | void;
export interface ActionContext {
  session: { id: string; write(data: string): void; sendKey(key: SpecialKey): void };
}
export type SpecialKey = "Enter" | "Escape" | "Tab" | "Up" | "Down" | "Ctrl+C" | "Ctrl+D";
```

非空 `capabilities` 是结构化输出契约：adapter 必须提供
`createParser()`。`SessionManager.registerAdapter()` 会丢弃没有 parser 的
能力声明并打告警，避免 UI 展示运行时根本无法产生的事件——manifest 写错的
第三方 adapter 只会失去结构化能力，而不是让整个 server 起不来。`/ws ready` 还会按该
Session 是否实际启用 parser 过滤能力（wrapped raw-TUI Session 不声明）。

**稳定性承诺**：
- `AgentAdapter`、`AgentManifest`、`AgentEvent`、`AgentState`、`SpecialKey` 从 v1.0 起是 **public stable API**。
- 破坏性变更需要 `@<scope>/sdk` 大版本号 + `docs/adapter-migration.md` 里的迁移指南。
- 新可选字段可以在小版本里加。

### 4.4 前端：PWA
- **包**：`packages/web`
- **技术栈**：React + Vite + TypeScript + xterm.js + vite-plugin-pwa
- **每会话两种视图**（可切换）：
  - **聊天视图**：把 `AgentEvent` 流渲染成聊天气泡；tool_use、diff、thinking 各有不同处理
  - **终端视图**：在 xterm.js 里渲染原始 PTY 流
- **快捷操作栏**：底部按钮栏。按钮来源是 `adapter.actions` 的 key。永远在的内置按钮：发送 Esc、发送 Ctrl+C、滚到底。
- **首页每会话卡片**：状态徽章、agent 图标、最后消息预览、最后活动时间戳。
- **PWA**：可装到主屏；当会话从 `running` 进入 `waiting_for_approval` 或 `idle` 时发 Web Push 通知。
- **移动优先**：viewport meta + safe-area inset，虚拟键盘通过 `visualViewport` API 处理。

### 4.5 鉴权与安全
- **单 bearer token**，首次启动时生成，以二维码形式打到服务端 stdout，链接到 `https://<tailscale-ip>:<port>/pair?t=<token>`
- Token 存在 `~/.<project>/config.json`（Unix 文件权限 600，Windows 用 ACL 限制）
- 服务端 **默认只绑在 tailscale 网卡上**（可配，但绑 0.0.0.0 会大声警告）
- TLS 用首次启动自动生成的自签证书；在 Tailscale 上的用户也可以信任 Tailscale 自己的加密走 HTTP（opt-in flag）
- 鉴权连接内的 WebSocket 帧被信任；不做逐帧鉴权
- **没有多用户模型。** 拿到 token 的人有完整 PTY 访问权 = RCE。这是用户接受的威胁模型。

---

### 4.6 工作群（多 AI 协作）

**工作群**把一个项目文件夹绑定到若干 agent 会话，让多个 AI CLI 共享上下文、从手机协同同一个项目。它是叠在 SessionManager 上的薄层 —— 成员就是按 id 引用的普通 Session。2026-06-27 新增（见 §8 Phase 8、§11）。

- **模型**（`packages/core/src/workgroup.ts`）：`Workgroup { id, name, cwd, contextDir, members }`；`AgentMember { sessionId, adapterId, command?, role: "active"|"observer"|"idle", joinedAt }` —— `adapterId` 永远是已注册的 adapter（raw CLI 为 `passthrough`），`command` 承载无 adapter 成员的真实命令；界面显示 `command ?? adapterId`。
- **一个文件夹一个工作群**（读法一）：`create()` 解析 cwd、**要求其存在**、并**按文件夹去重**（Windows/macOS 大小写不敏感），让项目共享记忆累积而非碎片化。默认名 = 文件夹 basename。
- **成员按需启动**（Option B）：加成员即在工作群文件夹里 server-spawn 一个 CLI；有 adapter 的 CLI 走 `SessionManager.spawn`，扫描到但没有 adapter 的 CLI 走 `SessionManager.spawnRaw` 和 passthrough PTY。两者同时都是 `/sessions` 里的普通会话。
- **共享上下文 = 项目内 Markdown**，位于 `<cwd>/.switchboard/`（`context.md`、`decisions.md`、`handoff.md`、`artifacts/`、`timeline.jsonl`）—— 跨 agent 协议（参照 CCB 的 `.ccb/`）。建群时往项目 `AGENTS.md`/`CLAUDE.md` 注入带标记、幂等的块，让成员自动读它。每文件写操作串行化（单写者队列）。
- **任务**（`task-*.ts`）：分派 = 把（单行）任务写进被分派成员的 PTY stdin。跨 AI **peek** 返回另一会话的近期输出（ring buffer 去 ANSI，近似）。
- **工作流**（`workflow*.ts`）：四步 SOP（规划 → 执行 → 审计 → 修 bug → done），每步建一条阶段模板任务。
- **交接**（想法#9，手动 —— 不做 token 自动切换）：往 `handoff.md` 写笔记、翻转角色、提示目标接手。
- **持久化**：元数据存 `~/.switchboard/workgroups/<id>/`，原子 JSON 写（`fs-json.ts`）；重启后元数据重载，但成员被剪除（PTY 不跨重启 —— §9 Q3）。

#### REST + WS 接口
- `GET /api/scan` —— 探测本机 AI CLI（适配器 `install.detect()` + 探测 `gemini`/`qwen`/`opencode`/`aider`/`cursor`）。
- `GET|POST /api/workgroups`、`GET /api/workgroups/:id`
- `POST .../:id/members` 必须且只能提交 `{ adapterId }` 或 `{ command }` 之一；另有 `POST .../members/:sessionId/role`、`DELETE .../members/:sessionId`、`POST .../:id/handoff`
- `GET|POST .../:id/tasks`、`POST .../tasks/:taskId/assign`、`POST .../tasks/:taskId/status`
- `GET .../:id/workflow`、`POST .../workflow/start`、`POST .../workflow/advance`
- `GET /api/sessions/:id/peek?lines=N`
- `GET /workgroups/ws` —— 客户端发 `{type:"subscribe", workgroupId}`，任何变更收到 `{type:"workgroup.changed"}`（实时刷新），由 `appendTimeline` 发出的 `contextEvents` 驱动。

> 这些接口沿用单 token 信任模型（§4.5）—— 暴露面与 `/sessions` 相同。加成员会在用户给定的文件夹里起进程，这与 `/ws create` 已有的能力一致。

### 4.7 局域网文件传输

文件管理器把完整文件存到 `<repo-root>/downloads/`。大文件上传不再直接
append 最终文件名，而使用小型会话协议：

- `POST /api/uploads` 用 `filename`、`totalSize`、`totalChunks`（可选 `chunkSize`、`overwrite`）创建上传会话并保留文件名。分块大小由客户端在服务端上限内自行声明，两边不再被同一个常量焊死。
- `POST /api/uploads/:uploadId/chunks/:index` 把一个幂等分块写到公开下载目录之外；单块最大 5 MiB。
- `POST /api/uploads/:uploadId/complete` 校验分块数和总大小，按序组装后原子发布最终文件。
- `DELETE /api/uploads/:uploadId` 取消上传并清除临时状态。
- 已存在的文件名或同名并发上传返回 `409`，并带机器可读的 `code`（`file-exists` / `upload-in-progress`），不静默覆盖成品。`overwrite: true` 会原子替换已有文件，且只在 `file-exists` 时才向用户提供该选项。
- 未完成上传不会出现在文件列表或下载接口中；进程内会话空闲一小时后释放文件名，server 启动时清理超过 24 小时的临时目录。
- 完成结果保留五分钟幂等窗口，客户端可在成品已发布但最终响应丢失时重试。

基于可信局域网模型，有意不增加逐块密码学哈希：TCP 已检测传输损坏；
manifest 大小/数量校验、重复分块内容比较和原子发布用于防止应用层截断与
交错写入。

---

## 5. 内置 Adapter（v1）

### 5.1 `adapter-claude`
- L1 启动：裸 `claude` TUI，终端透传。
- Detect：`claude --version`。
- 目前不声明 L2 parser、结构化 capability 或 L3 action。

### 5.2 `adapter-codex`
- L1 启动：`codex --no-alt-screen`；每个 server-spawned Session 使用隔离的临时 `CODEX_HOME`。
- Detect：`codex --version`。
- 目前不声明 L2 parser、结构化 capability 或 L3 action。

### 5.3 `adapter-passthrough`
- "任意 CLI" 适配器。命令可在配置里改。无 parser。除了发按键外无 action。
- 没有专属 adapter 的 agent（Gemini CLI、自定义脚本）就用这个，直到它们拿到正式 adapter。

### 5.4 `adapter-antigravity`
- L1 启动：裸 `agy` TUI；用 `agy --version` 探测。
- 目前不声明 L2 parser、结构化 capability 或 L3 action。

---

## 6. 技术栈与理由

| 关注点 | 选型 | 理由（以及拒绝了什么） |
|---|---|---|
| 语言 | 全 TypeScript | 跨插件契约的类型安全是承重理由。 |
| Runtime | Node.js 22 LTS | node-pty 支持最好；和三个 agent 的生态匹配。Bun/Deno 被拒，原生模块兼容风险。 |
| Monorepo | npm workspaces | 哪都默认装；pnpm/yarn 被拒，最小化安装阻力。 |
| Web 框架 | Fastify + @fastify/websocket | 比 express 快；一等 TS；集成 WS。考虑过 Hono，但 Fastify 与 node-pty 集成更简单。 |
| PTY | node-pty | 行业标准（VSCode 用的也是它）。 |
| 前端 | React + Vite + xterm.js | xterm.js 必需（唯一成熟的 Web 终端）。React 提供组件生态 + PWA 工具链。 |
| PWA | vite-plugin-pwa + Workbox | 标准。 |
| 推送 | Web Push API (VAPID) | Chrome（Android）和 Safari 16.4+（iOS）都支持。 |
| Linter/formatter | Biome | 一个工具替换 eslint+prettier；更快。 |
| 测试 | Node.js `node:test` + `tsx --test` | 第一批生命周期测试直接运行 TypeScript 源码，不增加新的测试框架依赖。 |
| Build（后端） | tsup | esbuild 的零配置封装。 |
| 分发 | npm（`npm i -g`） | 一行装。后续可以用 `pkg`/Bun 出单文件。 |
| 配置存储 | `~/.claude-remote-agent/`（Windows: `%APPDATA%\claude-remote-agent\`） | 标准的 XDG-ish。 |

---

## 7. 仓库结构

```
switchboard/
├── SPEC.md                       ← 本文（单一事实来源）
├── README.md                     ← 公开门面；面向用户的介绍
├── CHANGELOG.md                  ← 发布说明
├── LICENSE                       ← MIT
├── package.json                  ← npm workspaces 根
├── tsconfig.base.json
├── biome.json
├── .gitignore
├── packages/
│   ├── sdk/                      ← adapter 契约类型（所有 adapter 依赖）
│   ├── core/                     ← PTY 中继、session manager、ring buffer
│   ├── server/                   ← Fastify HTTP+WS、鉴权、adapter 注册表、CLI 入口
│   ├── web/                      ← React PWA
│   ├── adapter-claude/
│   ├── adapter-codex/
│   └── adapter-passthrough/
├── docs/
│   ├── adapter-authoring.md      ← 怎么写第三方 adapter
│   ├── architecture-decisions.md ← ADR，随积累而长
│   └── security-model.md         ← 威胁模型细节
└── examples/
    └── adapter-template/         ← 新 adapter 的复制粘贴起点
```

---

## 8. 路线图 & 阶段闸门

每个阶段以 **闸门** 收尾——具体的验收标准。N 阶段的闸门不过，不能开 N+1 阶段。

### Phase 1 —— Scaffold & PTY Relay MVP  ✅ 完成于 2026-05-23
**范围**：让开发机上的浏览器能 attach 到一个跑着 Claude Code 的 PowerShell 会话，看到输出，发按键。

- [x] npm workspaces monorepo 搭好，所有包能编
- [x] `packages/sdk`：类型能编，已导出
- [x] `packages/core`：SessionManager 能 spawn PTY，ring buffer 能用，attach/detach 能用
- [x] `packages/server`：Fastify + WS，单一硬编码的 "passthrough" adapter，无鉴权——能干净启动
- [x] `packages/web`：最简单页面，xterm.js 通过 WS attach——能干净构建
- [x] `npm run dev` 在 localhost 把整套拉起来
- [x] **2026-05-23 闸门通过**：实地浏览器测试确认端到端可用。Claude Code v2.1.146 TUI 通过 passthrough adapter 渲染正确——ANSI 色、box-drawing 字符、alt-screen buffer 全正常。**ConPTY alt-screen 兜底（`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`）并不需要** —— §5.1 里担心的风险在当前 Claude Code + Windows 11 + node-pty 组合下并未发生。

延后的跟进任务（已记录但还没做）：
- `RingBuffer` 环绕逻辑的单元测试
- 端到端驱动 WS 协议的集成测试

**对 Phase 2 的战略含义**：既然 raw passthrough 在桌面端把 Claude Code 渲染得很好，结构化聊天视图就成了 **手机端 UX 增强**，而不是桌面渲染兜底。Mobile（Phase 4）才是它赚回成本的地方。Phase 2 范围保持紧凑：parser + 聊天视图作为另一种渲染模式，别扩张成功能竞赛。

### Phase 2 —— Wrapper CLI & Session Attach  （目标：3-4 天）—— **新，重排优先级**
替代原 Phase 2。由用户实际工作流驱动：桌面终端为主，手机 attach 到已有会话，而不是冷启动一个新会话。

- [ ] 重构 `Session` 接受 `SessionBackend` 接口
- [ ] `LocalPtyBackend` —— 抽出当前的 node-pty 逻辑
- [ ] `WrapperBackend` —— 把字节流中继到/从 wrapper WS 连接
- [ ] 服务端：加 `/wrap` WS 端点；wrapper 消息 `register` / `pty` / `exit` ↔ 服务端消息 `registered` / `input` / `resize` / `kill`
- [ ] `switchboard run [-n <name>] <command> [args...]` 作为已有 CLI 的子命令：
  - 用当前 cwd/env 在本地 PTY 里 spawn `<command>`
  - PTY → 本地 stdout 镜像（TUI 正常工作）
  - stdin → PTY 镜像（用户继续在终端里敲）
  - 开 WS 到 `ws://localhost:8787/wrap`，发 `register`，中继 PTY 块
  - 收到服务端的浏览器 `input` 时写到 PTY（浏览器输入通过 echo 自然出现在 TUI）
  - PTY 退出或 Ctrl+C 时干净退出
- [ ] Web：`list` 流程 —— 连接时显示会话选择器；选一个 → attach。"+ New" 按钮仍然走 `create`（保留 Mode B）
- [ ] 更新首页会话列表，显示：adapter、cwd、name、state、最后输出时间
- [x] 工程完成于 2026-05-23。冒烟测试确认：`switchboard run node --version` → 会话以 `wrapped` source 注册，活着时出现在 /sessions，退出时被清理。
- [x] **2026-05-23 闸门通过**：`switchboard run claude` 注册一个 wrapped 会话，手机和桌面浏览器都能在会话列表里看到，都能 attach 看到实时 TUI，双向输入同步确认（手机敲字 → 桌面看到）。多客户端 PTY 尺寸（最大 cols + 最小 rows）协商出一个可用的共享维度；快捷操作工具栏在物理键存在的桌面端隐藏。

冒烟测试中浮出的问题：
- Windows 上 node-pty 不查 PATHEXT —— `node` 解析不到 `node.exe`，`claude` 解析不到 `claude.cmd`。修法：wrapper-cli 加个 PATH+PATHEXT 感知的 `resolveCommand()`。作为 Windows 专属坑记录在案。

随 Phase 2 一起落地的手机可用性跟进（本来应该是 Phase 5）：
- **visualViewport 驱动的 `--app-h`**：布局在虚拟键盘上方自动收缩。CSS `100dvh` 在 MIUI/小米浏览器上不可靠；`window.visualViewport` API 在 iOS Safari + Android Chrome + MIUI 上给出正确的"键盘感知"视口高。
- **快捷操作工具栏**：Esc / Tab / ⇧Tab / ↑↓←→ / Ctrl+C —— 手机虚拟键盘打不出来的字节。每个按钮用 `onPointerDown + preventDefault` 保持焦点在 xterm helper textarea 上（这样 IME 面板不会在两次点击之间消失）。
- **逐客户端尺寸跟踪 + split policy（MIN cols, MIN rows）**：`Session.attach()` 现在返回一个 `ClientHandle`，跟踪每个 attach 客户端上报的视口。`refitToClients()` 在所有 attach 客户端里取 `min(cols)` 和 `min(rows)`。理由：alt-screen TUI（claude code、codex）里，光标位置如果在小客户端 rows 之上会被裁掉，那部分内容根本就不会进入小客户端的 xterm buffer——所以输入提示要在小客户端上可达就需要 MIN rows。Cols 不匹配会裁右边但左边（提示所在）还能渲染，所以 MAX cols 让宽客户端继续可用。

### Phase 3 —— Adapter 插件系统 & Claude/Codex Adapter  （目标：3-4 天）—— 原 Phase 2
- [ ] Adapter 注册表：启动时从 `packages/adapter-*` 加载 adapter；为外部解析留出余地
- [ ] `adapter-passthrough` 正式独立成包（当前住在 `packages/server`）
- [ ] `adapter-claude` 实现 L1（spawn）和 L2（NDJSON parser → AgentEvent）—— 只给 Mode B；Mode A 永远走 raw 流
- [ ] `adapter-codex` 同上，加上对 schema 漂移的容忍 parser
- [ ] Wrapper 加 `--adapter <id>` flag 选择哪个 adapter 的 `buildCommand` 被调用（而不是跑字面命令）
- [ ] 闸门：wrapped Claude 会话显示 raw TUI；server-spawned Claude 会话提供终端视图 ↔ 聊天视图切换

### Phase 4 —— 鉴权、安全、配对  （目标：2 天）—— 原 Phase 3
- [ ] Bearer token 生成 + 受限权限存储
- [ ] 服务端 stdout 上的二维码配对流程
- [ ] 默认绑 tailscale 网卡；0.0.0.0 大声警告
- [ ] 自签 TLS 自动出证书
- [ ] 闸门：Tailscale 上的手机浏览器 → 扫码 → 落到鉴权会话列表 → 无 token 访问失败

### Phase 5 —— 移动 UX & PWA  （目标：4-5 天）—— 原 Phase 4
- [ ] PWA manifest + service worker（可装到主屏）
- [ ] 移动键盘处理（visualViewport API，输入框保持在键盘上方）
- [ ] 快捷操作栏接到 `adapter.actions`
- [ ] Web Push：配对时订阅，状态转移时通知（`waiting_for_approval`、从 `running` 进入 `idle`）
- [ ] 聊天视图为拇指优化（44px 点击靶、滑动手势）
- [ ] 闸门：装到 iPhone 主屏 → 起 Claude 会话 → 把 App 切到后台 → 通知触发 → 点开批准

### Phase 6 —— 多会话 & 项目切换打磨  （目标：2-3 天）—— 原 Phase 5
- [ ] 首页列出所有会话，带状态徽章
- [ ] 创建会话流程：选 adapter、选 cwd（最近列表自动补全）、选初始 prompt
- [ ] 会话能熬过服务端重启吗？（决策：v1 **不**做 —— 进程树和父进程一起死。持久会话延后，已在 §12 邀请贡献者认领。）
- [ ] 闸门：3 个并行会话跨不同项目，手机上切换互不丢状态

### Phase 7 —— 打磨 & 开源发布  （目标：1 周）
- [ ] README 带功能列表、"为什么选 Switchboard" 亮点
- [ ] `docs/adapter-authoring.md` 带可工作的例子
- [ ] `examples/adapter-template/` 可以 fork
- [ ] CI：lint + typecheck + tests + 多平台构建矩阵（windows/macos/linux）
- [ ] npm 发布到选定 scope（见 §10）
- [ ] GitHub 发布带 binaries（可选，走 pkg）
- [ ] 闸门：陌生人在干净的 Windows 上 `npm i -g <name>`，5 分钟内能跑起来

---

### Phase 8 —— 多 AI 工作群  ✅ 完成于 2026-06-27
**范围**：把 N 个并列会话升级为手机可遥控的多 AI 工作群 —— 共享上下文、任务分派、四步工作流、手动交接。见 §4.6。

- [x] P0 文档：项目级 `AGENTS.md`/`CLAUDE.md`、README "相关项目"、SPEC §7 同步
- [x] P1 CLI 扫描（`detect()` + `cli-scanner.ts` + `/api/scan`）+ 新增 `claude` 适配器
- [x] P2 工作群模型 + 管理器 + 项目内 `.switchboard/` 共享上下文 + 前端
- [x] P3 任务 + 分派 + 跨 AI peek + 任务看板
- [x] P4 四步工作流模板
- [x] P5 手动交接（想法#9；有意不做 token 自动切换 —— 无用量数据源）
- [x] 工作群实时 WS 广播（`/workgroups/ws`）
- [x] 闸门：`scripts/test-workgroups.ps1` —— 30/30 端到端检查通过（含无 Adapter raw 启动和重启持久化）

---

## 9. 开放问题

| # | 问题 | 何时需要决定 | 暂行答案 |
|---|---|---|---|
| ~~Q1~~ | ~~最终项目名~~ | ~~Phase 7 之前~~ | **2026-05-23 已决**：`switchboard`。见 §10。 |
| ~~Q2~~ | ~~npm scope~~ | ~~Phase 7 之前~~ | **2026-05-23 已决**：`@switchboard/*`。见 §10。 |
| ~~Q3~~ | ~~持久会话策略~~ | ~~Phase 5 设计时~~ | **2026-05-24 已外移**：不在 v1 范围内；已在 §12 邀请贡献者认领 |
| Q4 | Adapter 要不要沙箱化（独立进程）？ | Phase 2 设计时 | v1 不做 —— adapter 是 npm 代码，信任级别和 core 一致 |
| Q5 | 推送通知提供方 —— 自部署 VAPID vs 中继服务？ | Phase 4 | 自部署 VAPID；用户首次启动时生成 key |
| Q6 | Claude Code 登录流程（浏览器 OAuth）怎么走手机 WS？ | Phase 2 测试时 | 可能弹"请在桌面打开这个 URL"；手机驱动不了 localhost 回调 |
| Q7 | 要不要随 npm 一起出 Docker 镜像？ | Phase 7 | 要 —— 仓库里放 Dockerfile，给偏好 Docker 的用户用 |

---

## 10. 命名（2026-05-23 已决）

**项目名：`switchboard`** —— 中文"总机"。

理由：老式电话总机操作员的比喻 —— 多条线路（agent）通过一个面板（用户的手机）路由。一张图同时抓住"多 agent" + "随地遥控"。在开发工具圈里有辨识度，无显著品牌撞车。

### 命名映射
- 项目 / repo 名：`switchboard`
- npm scope（workspace + 未来发布）：`@switchboard/`
- 内部包名：`@switchboard/{sdk,core,server,web,adapter-claude,adapter-codex,adapter-passthrough}`
- 文件系统目录：用户克隆时可以叫任何名字（历史本地路径 `Claude Remote Agent` 是改名前的遗留；对公开 repo 的克隆用户不是约束）
- GitHub org/repo（Phase 7 之前定）：`github.com/switchboard-dev/switchboard` 是工作假设；发布前需要确认可用
- 域名（Phase 7 之前定）：偏好 `switchboard.dev`

### 被拒候选（不要再翻案）
- `tether` —— 撞 Tether（USDT）加密币品牌；SEO 输
- `paige` —— 聪明（page + AI）但是个名字；不显眼
- `palmpilot` —— Palm Inc. 商标遗留
- `claude-remote-agent`（原占位）—— 撞 Anthropic "Claude Agent SDK" 名；多 agent 范围扩展后变得误导

---

## 11. 变更日志纪律

防止 spec 烂掉的规则：

1. **任何新功能**，无论多小，**在写代码之前**都在本文加一节/一行。如果代码里有但文档里没有，立刻补文档。
2. **任何放弃的计划**（本文里某项我们决定不做）移到"被拒想法"区域，一行写明理由，不要删。（防止重新讨论同一个死胡同。）
3. **解决开放问题的任何架构决策** 把答案搬进正文，从 §9 里移除问题。
4. **阶段闸门完成** 把 Phase N 改成 "✅ 完成于 YYYY-MM-DD"，列出交付了什么、延后了什么。
5. **版本号**：每次有意义的变更在本文顶部递增版本。v0.x = 预发布，v1.0 = 首次 npm 发布。

### 近期变更
- 2026-07-26 — v1.3 — **审计复审修复**（针对 v1.2 整改的复审）：wrapped Session 传输断开时不再静默吞掉输入——新增 `SessionSummary.connected`、`/ws` 的 `transport` 帧、被拒绝的写入，以及界面上的 "wrapper offline" 标记。没收到 `registered` 回执的 wrapper 可凭 resumeKey 重新注册回同一个 Session，不必干等宽限期。会话列表按创建时间排序，实时更新不会让行在手指下重排。声明了 capability 却没有 parser 的 adapter 只会被降级并告警，不再让 server 启动失败。`AgentMember.command` 把 raw CLI 的命令与 adapter id 分开。上传改为由客户端声明 `chunkSize`、返回机器可读的错误 `code`，并支持显式 `overwrite` 原子覆盖。
- 2026-07-23 — v1.2 — **核心可靠性整改**：列表模式 `/ws` 客户端实时收到 Session 快照，纯活动时间更新按 Session 节流；监听器按快照派发，清理不会吞掉浏览器退出帧；浏览器发送能容忍 socket 关闭竞态。wrapper 传输采用稳定进程标识与恢复凭据、带代际保护的后端重新绑定、30 秒 server 宽限期、有上限的 PTY 输出缓冲、封顶退避和限时退出帧 flush。server 正常关闭时保留 wrapper 拥有的 PTY；server 重启后拒绝旧 resume，wrapper 自动注册新 Session。扫描到但无 adapter 的 CLI 现在可通过 raw passthrough 加入工作群；结构化 capability 必须有 parser；安装器按明确依赖顺序构建 Camera；文件上传改为隐藏分块会话和原子发布；运行时基线统一为 Node.js 22+。新增 Node/tsx 生命周期与上传测试，覆盖真实传输连续十次闪断及 server 重启恢复。
- 2026-06-27 — v1.1 — **多 AI 工作群**（Phase 8、§4.6）：CLI 扫描 + `claude` 适配器；工作群模型（一文件夹一群、去重、Option-B 启动）；项目内 `.switchboard/` 共享上下文 + AGENTS/CLAUDE 注入；任务 + 分派 + peek；四步工作流；手动交接；实时 `/workgroups/ws` 广播；原子 JSON 持久化。`scripts/test-workgroups.ps1` 28/28 通过。有意不做 token 自动切换（无用量数据源）。
- 2026-05-29 — **v1.0.0** — **首个正式版。** v0.9 以来新增：(1) **摄像头模块**（`@switchboard/camera`，可选 go2rtc sidecar）—— 手机当摄像头（WebRTC WHIP）+ 远程查看 IP 摄像头；开发期 HTTP(5174)/HTTPS(5173) 双端口；自签证书含局域网 IP 的 SAN。(2) **跌倒告警 → Web Push** —— 落地了 §4.4 / Q5 规划的自托管 VAPID Web Push 管道：`POST /api/alarm` webhook（可选 `X-Falldown-Signature` HMAC，由 `SWITCHBOARD_ALARM_SECRET` 控制），VAPID 密钥首启自动生成到 `certs/`，`/api/push-subscribe` + service worker + PWA 铃铛开关；点"检测到跌倒"通知跳到摄像头页。触发源是**外部**检测器，与原计划的 agent 状态变更通知不同（后者仍是未来工作）。见 README 的**告警通知**一节。(3) 所有包 0.1.0 → 1.0.0。
- 2026-05-23 — v0.9 — **Phase 2 闸门通过**：跨手机 + 桌面的多客户端实地测试通过。Wrapper 在 headless 跑（没有本地 TTY）时尊重服务端驱动的 resize，所以后台 wrapper 正确采纳浏览器协商的 PTY 尺寸。快捷操作栏在 ≥ 600px 视口（有物理键盘）下隐藏。
- 2026-05-23 — v0.8 — **多客户端会话尺寸**：`Session.attach()` 返回 `ClientHandle`；逐客户端跟踪视口；PTY 在所有 attach 客户端上 refit 到 `min(cols)` + `min(rows)`。修了"桌面视图在手机最后 attach 时变窄"和"手机在桌面也 attach 时看不到输入提示"两个问题。
- 2026-05-23 — v0.7 — **Phase 2 手机可用性修复**（从 Phase 5 提前）：visualViewport 驱动的 `--app-h` 实现键盘感知布局；快捷操作栏（Esc/Tab/⇧Tab/方向键/Ctrl+C）让 TUI 导航无需硬件键盘。
- 2026-05-23 — v0.6 — **Phase 2 工程完成**：core 重构使用可插拔 `SessionBackend`（LocalPtyBackend / WrapperBackend）。加 `/wrap` WS 端点（localhost-only）。加 `switchboard run` 子命令。web 重构为 SessionList + TerminalView。Wrapper 端到端冒烟通过。实地浏览器闸门待定。还：发现 Windows ConPTY 不查 PATHEXT —— 加了 `resolveCommand()` helper。
- 2026-05-23 — v0.5 — **架构转向**：主用例澄清为"包一个已有的桌面终端"，而不是"从手机 spawn"。加入 Mode A（wrapper）为主，保留 Mode B（server-spawn）为次。SPEC §1/§3 愿景 + 架构重写。§4.2 WS 协议现在定义两个端点（`/ws` 给浏览器，`/wrap` 给 wrapper）。Phase 顺序重排：新 Phase 2 = wrapper CLI；老 Phase 2（adapter 系统）挪到 Phase 3；老 Phase 6（Codex）合并到 Phase 3。还：移动 UI 小修（CJK 裁剪、侧间距收窄、移动字体）。
- 2026-05-23 — v0.4 — **Phase 1 闸门通过**：实地浏览器测试确认 Claude Code TUI 通过 passthrough adapter 渲染正确（不需要 alt-screen 兜底）。加入 Phase 2 优先级的战略说明 —— 聊天视图成手机 UX play，不是桌面修复。
- 2026-05-23 — v0.3 — Phase 1 搭好：4 个包（`sdk`、`core`、`server`、`web`）实现并干净编译。服务端启动并提供 /health、/adapters、/ws；web 通过 Vite 构建。实地浏览器闸门待定。
- 2026-05-23 — v0.2 — 项目名落定：`switchboard`。§10 重写为决策；归档被拒候选。架构图包名更新为 `@switchboard/*`。Open Question Q1 关闭。
- 2026-05-23 — v0.1 — 初稿。

### 被拒想法
- *(暂无)*

---

## 12. 给其他开发者 —— 欢迎认领

下列项目都**不在已承诺的路线图上**，但欢迎 PR。每一项都被切到足够小，有动力的贡献者可以基本独立完成。如果想接哪一项，先开个 issue，我们一起把设计聊清楚。

### 跨服务端 / 终端重启的持久会话

当前 Switchboard 会话会在 `switchboard` 重启（Mode B）或 wrapper 终端关闭（Mode A）时死掉。要解决的场景：一个跑了很久的 agent 任务不应该因为维护重启或者手抖关了终端就丢。

三条可行实现路径，按复杂度从低到高：
- **tmux / screen / zellij 包裹** —— 最轻；要求用户机器装 tmux
- **Detached node daemon** 持有 PTY —— 最重；跨平台的 PID/句柄折腾，Windows 没有 `setsid`
- **OS 级托管**（systemd user service / launchd / Windows Service）—— 安装最重，自己写的代码最少

或者设计一个可插拔 backend 让用户自选。

### `adapter-antigravity`

目前通过 `passthrough` 包装。Antigravity 2.0 稳定后（截至 2026-05 还没 SDK），可以做一个一等 adapter 去解析它的结构化输出。需要的技能：TypeScript、能读 TUI 字节流。可以参考 `packages/adapter-codex` 的实现。

### 语音输入

WebSpeech API → 手机端 PTY input。Tap-to-talk 和 push-to-talk 两种模式。难点是 iOS Safari 的支持 —— Android Chrome 上开箱即用。

### 会话共享（多设备只读跟看）

多个设备跟看同一个会话但不能输入。适合结对编程或者实时演示。需要在 WS 协议里加上 per-attachment 的 `mode: "rw" | "r"`，以及一个用来抢占/释放写入权的 UI 入口。

### 公网域名 + 多人协作编程

当前的威胁模型假设单用户在可信网络（局域网 / Tailscale）上。自然的延伸是：**把 Switchboard 反代到 `<your>.dev` 之类的域名后面，让多个开发者一起驱动同一个 agent 会话** —— 类似结对编程：一个人发 prompt，另一个改方向，两人都实时看着同一个 TUI。

需要做的：
- **多用户鉴权** —— 超越 v1 的单 bearer token。SSO（Google / GitHub OAuth）、按用户身份、按会话的 ACL（owner / editor / viewer）。
- **写入权仲裁** —— 两人同时敲字时谁说了算？基于锁（先到的持有，其他人看到 "X 正在输入"），或者类似 CRDT 编辑器的合并模型。锁式简单很多，v1 大概率应该走这条。
- **在场感 UI** —— 已连接用户列表、"X 加入 / 离开" toast，可选光标或选区指示、可选侧边语音 / 文字频道。
- **反代部署菜谱** —— 一份 nginx / Caddy / Cloudflare Tunnel 的成熟配置，带 WS sticky session 和合理的 TLS 设置。

构建在上面的"会话共享（只读）"之上。会动到鉴权（§4.5）和 `/ws` 协议（§4.2）。

### 多工作机管理：一部手机管多台开发机

当前手机只连一台开发机上的 Switchboard 服务。很多用户有家用台式机 **加上** 公司笔记本 **加上** 云端 VM，希望**一个手机 UI 把这些机器上的会话全部汇总展示**。

需要做的：
- **服务发现** —— 手动配置（一份带 `[server.name]` 段的配置文件）、Tailscale 原生（枚举 tailnet 里打了某 label 的机器），或者局域网走 mDNS。
- **客户端多路复用** —— PWA 同时持 N 条 WebSocket，合并各自的 `sessions` 列表到一个首页，选中会话时连到对应的服务器。
- **逐服务器鉴权** —— bearer token 模型扩展到"每个服务器一个 token"；扫码配对流程把新服务器注册进手机。
- **Tailscale 部署菜谱** —— 所有开发机都在同一个 tailnet 时的推荐部署方式。

对单人用户也有用（一部手机管自己几台机器），同时也是任何团队级 Switchboard 部署的前置依赖。

---

## 13. 参考资料

- slopus/happy —— github.com/slopus/happy（主要灵感来源；Switchboard 在同样的思路上扩展了一套公开插件 API 和一等的 Windows 原生服务）
- Claude Agent SDK —— code.claude.com/docs/en/agent-sdk
- Codex CLI noninteractive —— developers.openai.com/codex/noninteractive
- Codex JSON schema drift —— openai/codex#4776, #15451
- Claude Code Windows ConPTY rendering —— anthropics/claude-code#14599, #42670
- Antigravity 2.0 launch —— developers.googleblog.com/build-with-google-antigravity-...
