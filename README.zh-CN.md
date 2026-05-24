# Switchboard（总机）

> **一部手机，管所有 AI 编程 CLI** —— 在手机浏览器上驱动 Claude Code、Codex、Antigravity（以及未来新出的 agent）。自部署，插件化，无云端中转。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Agents](https://img.shields.io/badge/agents-Claude%20%7C%20Codex%20%7C%20Antigravity-blue.svg)](#支持的-agent)
[![Plugin API](https://img.shields.io/badge/plugin%20API-public-purple.svg)](./packages/sdk)
[![Self-hosted](https://img.shields.io/badge/self--hosted-LAN%20%2F%20Tailscale-brightgreen.svg)](#手机访问局域网--tailscale)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](./SPEC.md)

🌐 **语言**: [English](./README.md) · 中文

## 为什么选 Switchboard

- **一个界面，所有 agent** —— Claude Code、Codex、Antigravity 同在一个 PWA 里，不用每个工具装一个 App。
- **插件化，新 CLI 当天就能接** —— 接一个新 agent 只要 ~50 行的 adapter；就算还没人写 adapter，它也能在原生 PTY 模式下立刻可用。
- **真正的自部署** —— 数据只走你的局域网或 Tailscale。无云端中转，无账号，无密钥托管。
- **包裹你已有的终端** —— 桌面端依旧用你熟悉的 `claude` / `codex` 流程，手机是 *attach* 到那个活动会话，而不是另开一个并行进程。
- **手机不直连 AI 厂商，规避封号风险** —— Switchboard 只在你开发机和手机间转发终端 I/O，手机端从不登录、也不直接连 Anthropic / OpenAI / Google 的服务器。所有 API 请求依旧由开发机以你既有身份发出，官方看到的就是你日常的桌面客户端，不会被风控识别为"异常多端登录"。

[5 分钟上手 →](#安装) · [30 秒看架构](#30-秒看架构) · [完整 SPEC](./SPEC.md)

---

## 目录

- [为什么选 Switchboard](#为什么选-switchboard)
- [它做什么](#它做什么)
- [30 秒看架构](#30-秒看架构)
- [安装](#安装)
- [运行](#运行)
- [手机访问（局域网 / Tailscale）](#手机访问局域网--tailscale)
- [防火墙——开端口](#防火墙开端口)
- [支持的 agent](#支持的-agent)
- [FAQ](#faq)
- [项目结构](#项目结构)
- [许可](#许可)

---

## 它做什么

一次典型会话：

```
┌─ 你的开发机 ────────────────────────┐         ┌─ 手机 ───────────────────┐
│  PowerShell / 终端                  │         │  http://192.168.x.x:5173 │
│  ┌──────────────────────────────┐   │   WS    │  ┌────────────────────┐  │
│  │ $ sw run claude              │   │ ────▶   │  │ claude@my-project  │  │
│  │ │ Welcome to Claude Code     │   │ ◀────   │  │ > what should I…   │  │
│  │ │ > _                        │   │  局域网 │  │ [Esc][Tab][↑][↓]   │  │
│  │ └──────────────────────────────┘ │ /Tail.. │  └────────────────────┘  │
│  Server: switchboard listening :8787│         │                          │
└─────────────────────────────────────┘         └──────────────────────────┘
```

Wrapper 把 CLI 在真实 PTY 里跑起来，把输出同时镜像到 **本机终端 和 所连的手机/浏览器**，输入双向转发。手机浏览器关掉不会杀掉会话；桌面终端照常继续。

## 30 秒看架构

- **`sw`**（一个可执行）：`serve` 子命令起 Fastify HTTP+WS 服务（端口 `8787`）；`run` 子命令把任意命令包到 PTY 里并注册到本机服务。
- **浏览器 UI**：React + xterm.js，开发态用 Vite（`5173`），生产可走任意静态服务器。
- **Adapter** 按包发布——内置：`passthrough`（任意 shell）、`codex`、`antigravity`。Claude 走 passthrough。
- **v0.1 没有鉴权**：只绑在可信网络上（局域网、Tailscale）。鉴权在路线图里。

完整设计见 [SPEC.md](./SPEC.md)。

## 安装

需要 **Node.js ≥ 18.18**（推荐 22 LTS）。克隆后运行对应平台的安装脚本即可。

```bash
git clone https://github.com/newtv-ai/switchboard.git
cd switchboard
```

### Linux / macOS

```bash
./scripts/install.sh
```

### Windows（PowerShell）

```powershell
# 如果你从没跑过脚本，先允许当前用户运行签名脚本：
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

.\scripts\install.ps1
# 或者在装的时候顺便开防火墙端口（需要管理员 PowerShell）：
.\scripts\install.ps1 -OpenFirewall
```

安装脚本做了什么：
1. 校验 Node 版本。
2. `npm install`（workspaces 一次装好所有包）。
3. 编译 `@switchboard/sdk`、`@switchboard/core`、`@switchboard/server`。
4. `npm link`，把 `sw` 和 `switchboard` 命令挂到 PATH 上。

**Windows 下 node-pty 原生编译失败时**：装 [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 并勾选 "Desktop development with C++" 工作负载，然后重跑安装脚本。

## 运行

开两个终端：

```bash
# 终端 A —— 起 Switchboard 服务 + Web UI（开发态）
npm run dev
# 服务跑在 http://0.0.0.0:8787，Web 跑在 http://0.0.0.0:5173
```

```bash
# 终端 B —— 包一个 AI CLI 给手机用
sw run claude              # Anthropic Claude Code
sw run codex               # OpenAI Codex CLI
sw run agy                 # Google Antigravity CLI
sw run -- bash             # 任意命令都行
```

然后用浏览器打开 `http://localhost:5173`（或者你的局域网 IP），点中会话就进去了。

如果想用生产形态部署（不要 Vite），打 Web 包，扔到任意静态服务器后面：
```bash
npm run build -w @switchboard/web
# packages/web/dist/ 后面挂 nginx / caddy / Cloudflare Tunnel / 等等
```

## 手机访问（局域网 / Tailscale）

### 同 Wi-Fi（局域网）

1. 查开发机的局域网 IP：
   - macOS:   `ipconfig getifaddr en0`
   - Linux:   `ip -4 addr show | awk '/inet / && !/127.0.0.1/ {print $2}'`
   - Windows: `ipconfig`，找当前网卡下的 IPv4
2. 手机浏览器打开 `http://<dev-ip>:5173`。
3. 如果打不开，多半是防火墙挡了 `5173`（或 `8787`）入站。看下面的 [防火墙](#防火墙开端口) 章节。

### 任意网络（Tailscale）

在开发机和手机上都装 [Tailscale](https://tailscale.com)，登录同一个 tailnet，把局域网 IP 换成开发机的 Tailscale IP（`100.x.y.z`）即可。不用改防火墙，Tailscale 自己处理 NAT 穿透。

## 防火墙——开端口

Switchboard 绑在 `0.0.0.0`，所以局域网里任何设备都能访问（Web 在 `5173`，服务在 `8787`）。手机连不上，多半是系统防火墙挡了 TCP 入站。

### Windows

最省事的办法是用安装脚本带的开关：
```powershell
# 管理员 PowerShell
.\scripts\install.ps1 -OpenFirewall
```

或者手动加：
```powershell
# 管理员 PowerShell
New-NetFirewallRule -DisplayName 'Switchboard server (8787)' -Direction Inbound `
  -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private,Domain
New-NetFirewallRule -DisplayName 'Switchboard vite dev (5173)' -Direction Inbound `
  -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private,Domain
```

**重点——公用网络 vs 专用网络**：当你的 Wi-Fi 被识别为 **公用网络** 时，Windows 不会对 `Private,Domain` 配置文件应用上面的规则。症状就是：规则加了，端口测试还是失败。修法：
- 设置 → 网络和 Internet → Wi-Fi → 点击网络名 → **网络配置文件类型：专用**
- 或者把规则的 `-Profile` 换成 `Any`（安全性差一点）。

### macOS

macOS 自带防火墙是按 App 而不是按端口管的。如果你开了（系统设置 → 网络 → 防火墙），第一次启动服务时会弹框问要不要允许 **node** 入站，点允许就行。如果一开始误点了拒绝：
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --remove $(which node)
# 下次启动 sw 会重新弹框
```

用 `pf` 自定义防火墙的用户，在局域网网卡上放行 TCP `5173` 和 `8787` 入站即可。

### Linux（ufw）

```bash
sudo ufw allow from 192.168.0.0/16 to any port 5173 proto tcp   # 按需调整网段
sudo ufw allow from 192.168.0.0/16 to any port 8787 proto tcp
sudo ufw reload
```

### Linux（firewalld）

```bash
sudo firewall-cmd --permanent --add-port=5173/tcp
sudo firewall-cmd --permanent --add-port=8787/tcp
sudo firewall-cmd --reload
```

### Linux（iptables，无 frontend）

```bash
sudo iptables -A INPUT -p tcp --dport 5173 -s 192.168.0.0/16 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8787 -s 192.168.0.0/16 -j ACCEPT
# 用 iptables-save / netfilter-persistent 持久化
```

### 自检

从局域网另一台机器：
```bash
curl http://<dev-ip>:8787/health     # 应返回 {"ok":true,"sessions":0}
```
如果这一步通但手机不通，那大概率是手机在另一个 VLAN/SSID 上，或者你用的是开了客户端隔离的访客 Wi-Fi。

## 支持的 agent

| Adapter ID     | CLI 命令 | 自动识别于 | 特殊处理                                                                |
| ---            | ---      | ---        | ---                                                                     |
| `passthrough`  | 任意     | （默认）   | 起一个普通 shell；`sw run claude` 走的就是它                            |
| `codex`        | `codex`  | 命令名     | 注入 `--no-alt-screen` + 独立 `CODEX_HOME`（避免 SQLite 锁竞争）        |
| `antigravity`  | `agy`    | 命令名     | 直接包装；OAuth 在第一次运行时做                                        |

要覆盖自动识别，加 `--adapter <id>`。要写新的 adapter：实现 `@switchboard/sdk` 里的 `AgentAdapter` 接口，然后在 `packages/server/src/server.ts` 里注册即可。

## FAQ

### 手机显示"无法访问该网站"
- 先确认 `npm run dev` 真的在跑（看是不是有 `Server listening` + `vite ready`）。
- 从开发机本机 `curl http://<dev-ip>:8787/health`，再从局域网另一台机器 curl 一次。如果本机通、外部不通，就是防火墙问题（见上）。
- Windows 用户重点确认 Wi-Fi 配置文件是 **专用**，不是公用。公用配置文件无视你加的任何 LAN 入站规则。
- 有些路由器/访客网络开了"AP 隔离 / 客户端隔离"，禁止设备间互访。换主 Wi-Fi 或者用 Tailscale。

### 手机端 WebSocket 老掉线 / 屏幕每 10 秒闪一下
有些移动浏览器（小米 MIUI、低电量模式下的 iOS Safari）会主动关闭它认为"空闲"的 WebSocket。Switchboard 已经每 5 秒发应用层 keepalive，理论上不会有这问题。如果还是有，提个 issue 带上手机型号 + 浏览器。

### 手机连上/断开时本机终端尺寸没跟着变
Wrapper 会发 `\x1b[8;rows;cols t` 物理改本机终端窗口大小让它匹配 PTY。**这个要求终端开启"窗口尺寸上报"**：
- Windows Terminal：v1.18+ 默认开。
- iTerm2 / Apple Terminal / Alacritty / WezTerm：默认开。
- xterm：默认开；有些 `*term` fork（`urxvt` 等）默认关。

### Codex 要登录但我在远程机上
在 codex 登录界面选 **"Sign in with Device Code"**。Codex 会打印一个短码 + URL；用任意设备打开 URL（手机也行），粘贴短码授权。远程机上的 Codex 就完成登录了。

### Antigravity 提示"在你所在的区域不可用"
Google 在 **账号级别** 屏蔽了中国大陆、俄罗斯、伊朗等地区的 Antigravity。光开 VPN 没用——你还得有一个国家关联是被支持地区的 Google 账号。Switchboard 这边帮不上忙。

### 能同时跑两个 `sw run` 实例跑同一个 agent 吗
- claude：可以，没有共享状态。
- codex：可以——Switchboard 每个会话都设 `CODEX_HOME=$(mktemp -d)`，避免 [openai/codex#20213](https://github.com/openai/codex/issues/20213) 里报的 SQLite 锁死。
- agy：目前没隔离；并发会话共享 `~/.gemini/`。出问题就给每个会话单独设 `HOME=$(mktemp -d)`（完整方案还在 issue 里追踪）。

### 8787 端口被占了
```bash
PORT=9000 sw         # 或者 `switchboard`
```
客户端跟着传同样的端口：`sw run --server ws://127.0.0.1:9000 …`。

### 想公网暴露怎么办
**先别。** v0.1 没有鉴权——任何能到 `:8787` 的人都能驱动你的终端。先用 Tailscale、私有 VPN，或者前面挡一个带 HTTP basic-auth 的反向代理。鉴权在路线图里。

### 怎么打开详细 debug 日志
```bash
SWITCHBOARD_DEBUG=1 sw                # 服务端
# 会出形如：
#   [switchboard:debug] refit session=abcd1234 clients=2 ownSize={...} -> resize(47,30)
#   [switchboard:debug] /ws close code=1006 reason=… hasHandle=true …
```

## 项目结构

```
switchboard/
├── packages/
│   ├── sdk/         # 公开的 AgentAdapter 契约——第三方 adapter 从这里引
│   ├── core/        # Session、RingBuffer、WrapperBackend——agent-agnostic
│   ├── server/      # Fastify HTTP+WS 服务 + `sw run` CLI + 内置 adapter
│   └── web/         # React + xterm.js 前端
├── scripts/
│   ├── install.sh   # Linux & macOS 安装脚本
│   └── install.ps1  # Windows 安装脚本
├── SPEC.md          # 完整设计 + 路线图；架构决策的源头
└── README.md        # 即本文（英文版）
```

## 许可

[MIT](./LICENSE) —— 随你怎么用，不担保。

---

### 致谢

PTY-wrap 架构和 [slopus/happy](https://github.com/slopus/happy) 思路一致——感谢他们先把这条路验证通了。Switchboard 围绕"直连局域网 / Tailscale"和"纯浏览器客户端（无原生 App）"做设计。
