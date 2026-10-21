# DSH QQ Chat Bridge

**在 QQ 里直接和 DeepSeek 对话。** 一条私聊消息 → NapCat(OneBot 11) → 本地桥 → DSH 会话 → DeepSeek 回复 → 自动发回 QQ。

- ✅ **私聊免前缀**：白名单内的主号发什么都直达模型（不用打「小D」）
- ✅ **会话自动轮换**：满 120 条 / 24 小时 / 上下文压力 15 万 token / 累计 ¥2.5，自动换新会话并携带交接摘要（零 token 生成）
- ✅ **余额闸**：余额 ≤ ¥30 自动回一句提醒并停止调用模型，充值后自动恢复
- ✅ **零依赖**：桥只有 Node 内置模块（`node:http` + `fetch`），NapCat 独立运行
- ✅ **本地优先**：配置、token、会话状态都在本机，不上传

> 本项目是「桥 + 运维脚本 + 文档」的整合版；QQ 客户端数据（消息库、媒体）**不包含**在本仓库内。

---

## 架构

```
 ┌──────────────┐   私聊消息     ┌─────────────────────────┐   HTTP 上报   ┌────────────────────┐
 │ 你的 QQ 主号  │ ─────────────► │ 小号 QQ（NapCat 注入）    │ ────────────► │ qq-bot-bridge.mjs   │
 │ <MAIN_QQ>    │                │ OneBot 11 协议            │ 127.0.0.1:19390│  /onebot 回调服务    │
 └──────────────┘ ◄───────────── └─────────────────────────┘ ◄──────────── │        │            │
        回复（OneBot API 127.0.0.1:3000）                                  └────────┼────────────┘
                                                                                     │ hub HTTP（127.0.0.1:50281/x-hub）
                                                                                     ▼
                                                                          ┌────────────────────┐
                                                                          │ DSH 会话（DeepSeek）│
                                                                          │  cwd=D:\AI\日常     │
                                                                          └────────────────────┘
```

## 快速开始（Windows）

### 0. 前提

| 依赖 | 说明 |
|---|---|
| Windows 10/11 x64 | 本机实测 Win11 26100 |
| QQ NT 客户端 | 用于 NapCat 注入的独立副本（小号登录） |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | OneBot 11 实现；需要其发行版与注入/独立客户端 |
| Node.js **22+** | 桥使用内置 `fetch`；QQ 记录工具链另需 `node:sqlite` |
| DSH | 默认对接 DSH 宿主的 session-hub（`http://127.0.0.1:<port>/x-hub`；端口见 `~/.dsh/session-hub.json`） |

### 1. 登录小号（NapCat）

1. 按 NapCat 官方文档准备独立 QQ 副本（**不要和主号共用同一客户端**，会互踢）；
2. 启动 NapCat 扫码登录小号；
3. 网络配置（写入 NapCat 的 `onebot11_<BOT_QQ>.json`）：
   - **HTTP 服务端** `127.0.0.1:3000`（供桥调用发消息，`messagePostFormat: "array"`）
   - **HTTP 客户端** `http://127.0.0.1:19390/onebot`（把 QQ 事件推给桥）
   - 两处使用**同一个随机 token**，`enable: true`
   - 可用 `src/napcat-onebot-setup.mjs` 直接改配置（见 `--help`）

### 2. 配置桥

```powershell
Copy-Item config\bot-bridge.example.json config\bot-bridge.json
# 编辑 config\bot-bridge.json：onebot.token、trigger.allowFrom、dsh.*、各绝对路径
```

### 3. 自检 + 启动

```powershell
node src\qq-bot-bridge.mjs --check      # 检查 OneBot API / DSH hub / 配置
node src\qq-bot-bridge.mjs              # 前台跑（生产建议后台任务/计划任务）
```

或用 `scripts\start-bridge.cmd`。**桥空闲时零模型调用、零费用**；只有 QQ 消息进来才会产生 token。

### 4. 验证

用主号私聊小号发一句「在吗」——桥日志出现收消息/投递/回复，QQ 侧几秒内收到回复即通。

## 配置参考（`config/bot-bridge.example.json`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `onebot.api` | `http://127.0.0.1:3000` | NapCat HTTP 服务端地址 |
| `onebot.token` | — | OneBot token（与 NapCat 两处配置一致；**不要提交到 git**） |
| `callback` | `127.0.0.1:19390 /onebot` | 桥接收 NapCat 事件的 HTTP 服务 |
| `dsh.session` / `dsh.sessionFile` | `new` / `out/bot-session.json` | 绑定会话；`sessionFile` 记录当前会话 id |
| `dsh.cwd` | `D:\AI\日常` | 新会话工作区（决定人格/记忆/权限） |
| `dsh.replyTimeoutMs` | `180000` | 等待模型回复的超时 |
| `trigger.mode` | `"all"` | `all`=白名单私聊直通；`keyword`=需命中关键词 |
| `trigger.keyword` | `["小D","小d","ds"]` | 关键词模式用；当前生产为 `all` 模式 |
| `trigger.allowFrom` | `[]` | 允许触发的 QQ 号（**必填**，否则任何人不触发） |
| `trigger.groups` | `false` | 是否处理群聊（默认关闭） |
| `reply.sendBack` | `true` | 是否把模型回复发回 QQ |
| `reply.maxChars` | `1200` | 单条回复最大字符数（超出截断） |
| `reply.noReplyText` | — | 模型无产出时的兜底回复 |
| `rotation.enabled` | `true` | 是否启用会话自动轮换 |
| `rotation.everyMessages` | `120` | 处理满 N 条 QQ 消息后轮换 |
| `rotation.everyHours` | `24` | 会话存活超过 N 小时轮换 |
| `rotation.pressureTokens` | `150000` | 上下文压力超过 N token 轮换 |
| `rotation.costYuan` | `2.5` | 本段估算成本 ≥ ¥N 轮换 |
| `rotation.cwd/outDir/index/rotateScript/stateFile/pendingFile` | — | 新会话工作区、交接件目录、轮换索引文件、轮换脚本、状态文件 |
| `balance.enabled` | `true` | 余额闸 |
| `balance.endpoint` | `http://127.0.0.1:50281/x-balance` | DSH 余额端点（端口随宿主） |
| `balance.tokenFile` | `~/.dsh/balance-widget.json` | 余额端点 token 来源（不读入 git） |
| `balance.floorYuan` | `30` | ≤ ¥N 停止调用模型 |
| `balance.checkSeconds` | `300` | 余额检查间隔 |

## 目录结构

```
src/     qq-bot-bridge.mjs（桥）  qq-bot-rotate.mjs（轮换）  qq-activate.mjs（UIA 关键词只读兜底）
         napcat-onebot-setup.mjs（写 NapCat 网络配置）  napcat-qr-page.mjs（扫码登录页）  qq-chat-read.ps1（UIA 读 QQ 聊天窗口）
config/  bot-bridge.example.json  napcat-network.example.json
scripts/ start-bridge.cmd  check-bridge.cmd
docs/    00-索引 / 01-文档整理与现状 / 02-Token与成本核算 / 03-从零构建提示词 / 04-功能详解 / 05-运维手册 / 06-清单与哈希
```

## 安全与边界

- **不做**：群发、加好友、主动私聊陌生人、绕过 QQ 风控、解密/读取 QQ 数据库（本仓库不包含 QQ 数据）。
- **隔离**：小号独立客户端；白名单 `allowFrom` 之外任何人私聊都不会触发；群聊默认关闭。
- **token 不入库**：`config/bot-bridge.json`、`out/`、`*.log` 均在 `.gitignore` 中；仓库只留 example。
- **合规**：仅用于自己的账号/设备；遵守 QQ 与 NapCat 的使用条款；账号风险由使用者自负。
- **隐私**：会话内容只落本机 DSH 会话与本地日志；Docker/云部署请自建隔离。

## 已知限制

- NapCat 实例重启后**不保留登录态**，需要重新扫码（桥不用重启，重连后事件照常推送）。
- 只支持私聊（当前生产），群聊需 `trigger.groups: true` 且自行处理刷屏/权限。
- 桥假设 DSH session-hub 可达；DSH 宿主重启后端口/token 会变，需重读 `~/.dsh/session-hub.json`。
- 轮换交接件只保留最近 10 轮摘要（约 2 KB），更早历史在旧会话/`projcache` 中，不重放全文。
- `qq-activate.mjs` / `qq-chat-read.ps1` 走 UI Automation：QQ 必须已打开对应聊天窗口；提权窗口（管理员 QQ）读不到。
- 回复经过 `reply.maxChars` 截断；超长内容建议让模型自行分段或写入文件后再发。

## 文档

- [`docs/04-功能详解.md`](docs/04-功能详解.md) —— 架构、消息生命周期、轮换、余额闸、配置全解
- [`docs/05-运维手册.md`](docs/05-运维手册.md) —— 部署/启动/排查/备份/升级
- [`docs/03-从零构建提示词.md`](docs/03-从零构建提示词.md) —— 给 AI 的一份「从零再造」提示词
- [`docs/02-Token与成本核算.md`](docs/02-Token与成本核算.md) —— 实测 token 与估算成本
- [`docs/01-文档整理与现状.md`](docs/01-文档整理与现状.md) —— 本机原始文档清单与归档边界
- [`docs/06-清单与文件哈希.md`](docs/06-清单与文件哈希.md) / [`docs/07-发布前审查.md`](docs/07-发布前审查.md) —— 文件哈希与上传前审查

## License

代码与文档采用 **MIT**（见 [LICENSE](LICENSE)）。NapCat、QQ 客户端、DSH 均为第三方软件，遵循各自的许可证；本仓库**不包含**它们的二进制。
