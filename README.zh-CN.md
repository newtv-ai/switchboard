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
- **手机 ↔ 开发机互传文件** —— 内置文件管理面板，可以从手机直接把文件丢到开发机的指定目录，也能把开发机上的文件下回手机。适合传截图、APK、零碎文本之类，省得开云盘。

[5 分钟上手 →](#安装) · [30 秒看架构](#30-秒看架构) · [完整 SPEC](./SPEC.md)

---

## 目录

- [为什么选 Switchboard](#为什么选-switchboard)
- [它做什么](#它做什么)
- [30 秒看架构](#30-秒看架构)
- [安装](#安装)
- [运行](#运行)
- [手机访问（局域网 / Tailscale）](#手机访问局域网--tailscale)
- [文件互传（手机 ↔ 开发机）](#文件互传手机--开发机)
- [摄像头（手机当摄像头 + 远程查看摄像头）](#摄像头手机当摄像头--远程查看摄像头)
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

**或从手机直接冷启动** —— 开发机上还没有 wrap 任何进程时，在 Web UI 里点 **+ New passthrough session**，开发机会拉起一个新 shell；进去后敲 `claude` / `codex` / 任意命令即可。手机不需要装 SSH，也无需先把桌面唤醒。

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

> **一键启动**：仓库根目录带了 `start.bat`（Windows，双击即可）和 `start.sh`（Linux / macOS，`bash start.sh`）。它们会先把 `5173` / `8787` 上的旧 dev 进程清掉，然后执行 `npm run dev`。等价于上面的"终端 A"，"终端 B"（`sw run …`）还是要单独开。

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

## 文件互传（手机 ↔ 开发机）

打开 Web UI，点头部的 **Upload** 按钮，会弹出一个小型文件管理面板：

- **手机 → 开发机**：选一个或多个文件上传，文件落在开发机的 `<仓库根目录>/downloads/` 下。上传按 5 MB 分块流式传输，几个 GB 的文件也不会撑爆内存。
- **开发机 → 手机**：在列表里点 **Download**，按浏览器正常下载流程保存。

这就是一个共享目录，没有鉴权——和 Switchboard 其他部分一致，只在局域网 / Tailscale 上跑。

### 手机上传失败？基本都是权限问题，不是 bug

手机浏览器是沙箱化的，**你选的文件它不一定有权读**，最常见的情况是：

- 微信 / QQ / Telegram / WhatsApp 等聊天 App 内部存储的图片、视频、文档。
- 另一个 App 的私有目录里的文件（比如某 App 的 Documents）。
- 部分厂商"文件"应用返回的是浏览器打不开的 URI。

解决办法对所有情况都一样：**先把文件复制到手机的公共"下载"目录**，再从那里选一次。

不同手机和语言下"下载"目录显示的名字略有不同，其实是同一个地方：

| 手机                  | 英文系统               | 中文系统       |
| ---                   | ---                    | ---            |
| Android（多数）       | `Download` 或 `Downloads` | `下载`         |
| iOS "文件" App        | `Downloads`            | `下载`         |

Switchboard 的上传对话框在检测到错误像权限相关时，会自动弹出这条提示。

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

### 往上滚能看到重复的横幅 / 状态行（scrollback 污染）
这是 Claude Code 上游问题，不是 Switchboard 的 bug。Claude Code 使用 [Ink](https://github.com/vadimdemedes/ink)（React-for-CLI），每次状态变化（加载 observations、关闭对话框、SIGWINCH 等）都做全屏重渲染：先发 `ESC[H`（光标回视口原点），再逐行 `ESC[K` 重画。当绘制内容超出视口高度时，多出的行溢出进 scrollback 缓冲区。下一次 `ESC[H` 只能回到当前视口顶部，无法擦除已经推进 scrollback 的旧帧。结果：每次重渲在 scrollback 里沉积一层"残影"，22 次重渲 = 22 份重复。桌面终端往上滚一样能看到，Switchboard 只是让它更明显。上游 issue 见 [claude-code#49086](https://github.com/anthropics/claude-code/issues/49086)、[claude-code#52027](https://github.com/anthropics/claude-code/issues/52027)。**当前缓解措施：** 手机端自动跟随最新输出，正常使用时重复帧不会出现在视野内；终端还支持双模滚动（default 模式下浏览器原生滚动，fullscreen 模式下 PgUp/PgDn 翻译）。欢迎通过 [Issues](https://github.com/newtv-ai/switchboard/issues) 反馈。

## 摄像头（手机当摄像头 + 远程查看摄像头）

Switchboard 内置可选摄像头模块，基于 [go2rtc](https://github.com/AlexxIT/go2rtc)，支持双向视频流：

| 方向 | 功能 | 使用场景 |
|------|------|---------|
| **手机 → 电脑** | 手机摄像头当电脑虚拟摄像头 | 视频会议、直播、录屏 |
| **电脑 → 手机** | 手机远程查看电脑/NAS 上的 IP 摄像头 | 安防监控、宝宝看护、3D 打印 |

### 快速上手

1. 正常启动 server（`start.bat` 或 `npm run dev`）。go2rtc 首次启动时自动从 GitHub 下载。
2. 打开网页 → 点击 **Cameras**。
3. **查看 IP 摄像头**：粘贴 RTSP URL（如 `rtsp://admin:pass@192.168.1.100:554/Streaming/Channels/1`）→ 点 Add → 点 View。
4. **手机当摄像头**：手机打开 `https://<电脑IP>:5173` → Cameras → Start Camera。
   电脑端打开 `http://localhost:1984/stream.html?src=phone_cam` 查看画面。
   在 Zoom/微信中使用：OBS → 媒体源 → URL `http://localhost:1984/api/stream.mp4?src=phone_cam` → 启动虚拟摄像头。

### 双端口访问

| 端口 | 协议 | 功能 |
|------|------|------|
| `http://<ip>:5174` | HTTP | 终端、文件传输、摄像头查看 — 除手机推流外全部功能 |
| `https://<ip>:5173` | HTTPS | 以上全部 + 手机摄像头推流（getUserMedia 要求 HTTPS） |

HTTPS 证书首次启动自动生成（自签名，5 年有效，存储在 `certs/`）。桌面浏览器首次会提示"不安全"——点一次"继续访问"之后不再出现。

### 注意事项

- **H.264 和 H.265** 都支持，go2rtc 自动处理编解码协商。
- **摄像头配置持久化**，重启不丢失（`~/.switchboard/cameras.json`）。
- **手机推流跨页面保持**——在 Cameras 页开始推流后切到 Terminal 页，推流不断。
- **go2rtc 自动下载**：首次使用从 GitHub 下载约 15MB 二进制。国内无法下载请看下方常见问题。
- **防火墙**：go2rtc WebRTC 使用 **8555** 端口（UDP+TCP）。手机推流连不上时需要开放此端口。

### 摄像头模块：添加视频流格式

Cameras 页面支持标准流媒体 URL。常见格式：

**IP 摄像头 (RTSP)**
```
rtsp://admin:password@192.168.1.100:554/Streaming/Channels/1     # 海康威视 主码流
rtsp://admin:password@192.168.1.100:554/Streaming/Channels/2     # 海康威视 子码流
rtsp://admin:password@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0  # 大华
rtsp://admin:password@192.168.1.100:554/stream1                  # 通用 ONVIF
rtsp://192.168.1.100:8554/mystream                               # RTSP 服务器（无认证）
```

**HTTP 流**
```
http://192.168.1.100:8080/video                                  # MJPEG / HTTP-FLV
https://example.com/live/stream.m3u8                             # HLS
```

**RTMP**
```
rtmp://192.168.1.100/live/stream
```

**提示：**
- 大多数 IP 摄像头 RTSP 端口是 `554`，具体 URL 路径请查看摄像头后台管理页面。
- 如果主码流带宽太大，用**子码流**（分辨率更低）可以减少占用。
- 不确定 URL 的话，试试 ONVIF 默认地址：`rtsp://<ip>:554/onvif1`。
- 添加前建议先用 VLC 测试（`媒体 > 打开网络串流`），确认能播放再添加到 Switchboard。

### 摄像头模块：go2rtc 自动下载失败

摄像头模块（`@switchboard/camera`）首次使用时会从 GitHub Releases 自动下载 [go2rtc](https://github.com/AlexxIT/go2rtc)。如果你的网络无法访问 GitHub（国内常见），可以手动安装：

1. 从镜像站或其他机器下载对应平台的二进制：
   - Windows x64: `go2rtc_win64.zip`
   - macOS Apple Silicon: `go2rtc_mac_arm64.zip`
   - macOS Intel: `go2rtc_mac_amd64.zip`
   - Linux x64: `go2rtc_linux_amd64`
   - Linux ARM64: `go2rtc_linux_arm64`

   官方发布页: https://github.com/AlexxIT/go2rtc/releases

2. 解压并放到指定位置：
   ```bash
   # Windows — 把 go2rtc.exe 放到：
   %USERPROFILE%\.switchboard\bin\go2rtc.exe

   # macOS / Linux — 解压后赋予执行权限：
   mkdir -p ~/.switchboard/bin
   # （把 go2rtc 二进制复制到这里）
   chmod +x ~/.switchboard/bin/go2rtc
   ```

3. 也可以把 `go2rtc` 放到系统 PATH 中的任意目录。

4. 重启 server，日志中应该能看到 `[camera] module loaded`。

## 项目结构

```
switchboard/
├── packages/
│   ├── sdk/         # 公开的 AgentAdapter 契约——第三方 adapter 从这里引
│   ├── core/        # Session、RingBuffer、WrapperBackend——agent-agnostic
│   ├── server/      # Fastify HTTP+WS 服务 + `sw run` CLI + 内置 adapter
│   ├── web/         # React + xterm.js 前端
│   └── camera/      # 可选：go2rtc 摄像头流媒体
├── scripts/
│   ├── install.sh   # Linux & macOS 安装脚本
│   └── install.ps1  # Windows 安装脚本
├── start.sh         # 一键启动开发态（Linux / macOS）
├── start.bat        # 一键启动开发态（Windows）
├── downloads/       # 手机↔开发机文件互传的落点目录（已 gitignore）
├── SPEC.md          # 完整设计 + 路线图；架构决策的源头
└── README.md        # 即本文（英文版）
```

## 许可

[MIT](./LICENSE) —— 随你怎么用，不担保。

---

### 致谢

PTY-wrap 架构和 [slopus/happy](https://github.com/slopus/happy) 思路一致——感谢他们先把这条路验证通了。Switchboard 围绕"直连局域网 / Tailscale"和"纯浏览器客户端（无原生 App）"做设计。
