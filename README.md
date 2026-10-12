# dsh-prompt

**审批/请求提醒插件**（包名 `dsh-idle-alert`）—— DSH 弹出「需要授权」或「需要选择方案（提问）」请求后，
如果你 20 秒没动鼠标，就播放提醒音；一动鼠标立刻停。

[![CI](https://github.com/Wyxmz/dsh-prompt/actions/workflows/ci.yml/badge.svg)](https://github.com/Wyxmz/dsh-prompt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

补上「DSH 正在等你点确认，而你正好在看别的地方」这段空隙：不用一直盯着窗口，
但也不会因为不知道它在等你而卡住。

## 行为规格

| # | 规则 |
|---|---|
| 1 | 「需要授权」或「需要选择方案（提问）」请求出现后开始计时 |
| 2 | **20 秒内移动了鼠标** → 这一轮不提醒，且该请求不再提醒 |
| 3 | 20 秒内没动鼠标 → 播放提醒音（**一遍**） |
| 4 | **播放期间移动鼠标 → 立刻停止**（先 30 ms 淡出，避免咔哒爆音） |
| 5 | 每个请求只提醒一轮；计时期间请求被处理掉则取消提醒 |
| 6 | 等待时长、音量、音效都可在 `assets/sound.json` 里热改，改完刷新页面即生效 |

## 特性

- **状态由宿主判定，不猜 DOM**：直接听 `approval/asked`、`tool/call(ask_user_question)` 等
  会话事件，弹窗结构改了也不会失效
- **打断干脆**：`GainNode` + `AudioBufferSourceNode` 播放，30 ms 淡出，没有爆音
- **零依赖**：不引入任何 npm 依赖，`npm test` 直接跑 Node 内置测试
- **单文件注入**：客户端脚本约 10 KB，由宿主内联注入，不受浏览器缓存影响
- **信任栅栏**：只服务回环 Host（优先复用宿主 `connection` 服务，防 DNS 重绑定）

## 安装

### 前置条件

> 本仓库叫 **dsh-prompt**，插件包名是 **dsh-idle-alert** —— profile 的 `bundles`、
> HTTP 路由前缀 `/dsh-idle-alert`、注入标识都用后者。clone 下来的目录名随意，
> 安装脚本会自己定位，不依赖目录名。

- 已安装 DSH（桌面版）
- Node.js ≥ 18（跑测试用；插件本身零依赖）
- PowerShell 7+（仅脚本安装方式需要；Windows / macOS / Linux 均可）

### 方式一：脚本安装（推荐）

```powershell
git clone https://github.com/Wyxmz/dsh-prompt.git
cd dsh-prompt
pwsh -NoProfile -File ./scripts/install.ps1
```

脚本做三件事：

1. 在 `<profile>/node_modules` 下建**目录联接（junction）**指向本仓库 —— 不复制、不占空间，
   改源码即时生效
2. 把包名写进 `<profile>/package.json` 的 `dependencies`（`link:` 相对路径）
3. 把包名追加进 `<profile>/package.json` 的 **`dsh.profile.bundles`**
   （⚠️ 只写 `dependencies` **不会**被加载，`bundles` 才是加载列表）

写 `profile/package.json` 之前会先备份成 `package.json.bak-<时间戳>`。想看它要做什么而不落盘：

```powershell
pwsh -NoProfile -File ./scripts/install.ps1 -WhatIf
```

profile 目录默认按环境变量探测：`$env:DSH_PROFILE_DIR` → `$env:DSH_HOME/profiles/$env:DSH_PROFILE`
→ `~/.dsh/profiles/desktop`。探测不到时显式指定：

```powershell
pwsh -NoProfile -File ./scripts/install.ps1 -ProfileDir '<DSH_HOME>/profiles/desktop'
```

### 方式二：手动安装

1. 把仓库放到任意目录（下称 `<插件目录>`）
2. 在 `<profile>/node_modules` 下建联接指向它：

   ```powershell
   New-Item -ItemType Junction -Path '<profile>\node_modules\dsh-idle-alert' -Target '<插件目录>'
   ```

3. 编辑 `<profile>/package.json`：

   ```json
   {
     "dependencies": {
       "dsh-idle-alert": "link:<相对或绝对路径>"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-idle-alert"
         ]
       }
     }
   }
   ```

### 重启 DSH

**装完必须重启 DSH 桌面应用**：桌面端的页面注入表是宿主启动时一次性收集的。

> ⚠️ 之后修改 `assets/alert.js` **同样需要重启** —— 客户端脚本是**内联**进注入行的，
> 走 URL 会被浏览器缓存住旧版本（连 `Cache-Control: no-store` 都拦不住）。
> `assets/sound.json` 是宿主每次请求热读的，那个改完刷新页面即可。

### 卸载

```powershell
pwsh -NoProfile -File ./scripts/uninstall.ps1
```

它只做三件事：摘掉联接（**不动**插件源码目录）、从 `dependencies` 与 `dsh.profile.bundles`
移除条目、改之前先备份。同样需要重启 DSH。

## 配置

改 `assets/sound.json`，**刷新页面**即生效（不用重启）：

```json
{
  "path": "D:\\my-sounds\\alert.wav",
  "windowsMediaDir": "C:\\Windows\\Media",
  "file": "alert.m4a",
  "gain": 1.0,
  "idleMs": 20000
}
```

| 字段 | 说明 |
|---|---|
| `path` | 提醒音的**绝对路径**（可选，优先使用）。JSON 里反斜杠要写两个 |
| `windowsMediaDir` | 系统音效目录，默认 `C:\Windows\Media`（仅 Windows） |
| `file` | 音频文件名，先在 `windowsMediaDir` 找，再在插件 `assets/` 找 |
| `gain` | 整体增益倍率，**可以 > 1**（Web Audio 真放大） |
| `idleMs` | 空闲多久后播放，毫秒。`20000` = 20 秒 |

解析顺序：① `path` 绝对路径 → ② `windowsMediaDir/file` → ③ 插件 `assets/file`。
只接受音频扩展名（`wav` / `mp3` / `ogg` / `oga` / `m4a` / `flac` / `aac`）；
都找不到就回退到插件自带的 `assets/alert.m4a`（始终可用）。

想知道当前实际用的是哪个文件、什么参数：

```js
fetch('/dsh-idle-alert/pending.json').then(r => r.json()).then(console.log)
// → sound / soundFallback / gain / idleMs
```

### 换音效

把 `path` 指向你自己的音频文件即可：

```json
{
  "path": "D:\\my-sounds\\ding.wav",
  "idleMs": 20000,
  "gain": 1.0
}
```

音量提示：内置的 `alert.m4a` 峰值已经是 0 dB（满刻度），`gain` 保持 `1.0` 就是它最响的状态，
调大只会削波。想更响，应该先处理音频本身（压缩 + 限幅），而不是加大 `gain`。

## 工作原理

**挂起状态由宿主判定，不由客户端猜 DOM。**

宿主监听 `session/event`：

| 事件 | 动作 |
|---|---|
| `approval/asked` | 记一条 approval 挂起 |
| `tool/call` 且 `name === 'ask_user_question'` | 记一条 question 挂起 |
| `tool/result` / `approval/*` / `turn/end` / `turn/start` | 解除 |

状态经 `GET /dsh-idle-alert/pending.json` 暴露，客户端每秒轮询一次。

客户端只做三件事：**空闲计时、播放、被打断**。音频在 20 秒计时期间就预解码好，
到点即播、零延迟；播放用 Web Audio 而不是 `<audio>`，因为 `HTMLAudioElement.volume` 封顶 1.0，
也没法对正在播放的声音做平滑停止。

### HTTP 路由

| 路径 | 说明 |
|---|---|
| `GET /dsh-idle-alert/pending.json` | 当前挂起请求 + 生效中的 `sound` / `gain` / `idleMs` |
| `GET /dsh-idle-alert/alert.js` | 客户端脚本（正常路径是内联注入，这条留给调试） |
| `GET /dsh-idle-alert/sound` | 按 `sound.json` 解析出的提醒音，支持 Range |
| `GET /dsh-idle-alert/alert.m4a` | 插件自带的兜底音效 |

## 目录结构

```
dsh-idle-alert/
├── package.json              # type:module + dsh.bundle.patch
├── cordis.patch.yml          # 把自己挂进 profile 配置树
├── lib/index.js              # 宿主端：注入行 + 路由 + 挂起跟踪
├── assets/
│   ├── alert.js              # 客户端：空闲计时 + 播放 + 打断
│   ├── alert.m4a             # 内置提醒音（默认音 + 兜底音）
│   └── sound.json            # 提醒音来源配置（热读）
├── scripts/
│   ├── install.ps1           # 安装（自动探测 profile）
│   └── uninstall.ps1         # 卸载
├── test/
│   ├── alert.test.mjs        # 客户端逻辑单测（假浏览器 + 可控时钟）
│   └── host.test.mjs         # 宿主端单测（假 root/ctx）
├── .github/workflows/ci.yml  # CI：Linux + Windows × Node 18/20/22
├── CHANGELOG.md
├── NOTICE.md                 # 第三方素材声明（音频版权）
├── LICENSE                   # MIT
└── README.md
```

## 调试

浏览器控制台里：

```js
const D = window.__DSH_IDLE_ALERT_DEBUG__
D.cfg          // 当前参数（idleMs / gain 会跟随 sound.json 更新）
D.armed()      // 正在计时的那一批（null = 没在计时）
D.playing()    // 是否正在播放
D.duration()   // 解码出来的音频时长
D.ctxState()   // AudioContext 状态（suspended = 还没被用户交互唤醒）
```

## 开发与测试

```bash
node test/alert.test.mjs   # 客户端：7 组场景
node test/host.test.mjs    # 宿主端：27 项断言组
npm test                   # 两个都跑
```

测试**零依赖**、不联网、不需要 DSH 在运行：客户端测试用 `node:vm` 造了假的浏览器环境
（`document` / `AudioContext` / `fetch` + 可控时钟），宿主端测试用假的 `root` / `ctx` 直接调用插件的 `apply()`。

## 已知边界

- **浏览器自动播放策略**：首次 `pointerdown` / `keydown` 时才会唤醒 `AudioContext` 并预解码音频。
  如果重启后从没点过页面，第一次提醒可能被浏览器拦掉。
- **同一时刻只播一段**：如果第一段还在放（内置音效 55.97 秒）时又有新请求到期，那一次不会叠加
  —— 避免两段音频同时响。
- **平台**：默认配置里的 `windowsMediaDir` 是 Windows 的系统音效目录；非 Windows 请用 `path`
  或直接用插件自带音效。
- **音频由宿主的 DSH 进程读取**（不受会话文件沙箱限制），插件只**读**这些文件，不改动它们。
- **音频走系统默认输出设备**。
- 换音效后如果听着还是旧的，硬刷新一次页面（响应头已带 `no-store`）。

## 音频素材与版权

`assets/alert.m4a` 是游戏《Counter-Strike 2》中 C4 炸弹的提示音效，
版权归 **Valve Corporation**，**未获授权随本仓库分发**，仅作为开箱即用的示例音效收录。

- 自己本地使用（clone 下来给自己听）通常属于私人使用范畴；
- 在公开仓库里**再分发**这个音频存在版权风险（可能被 DMCA 下架）；
- 如果你要 fork 或重新发布，**建议删掉 `assets/alert.m4a`**，换成你有权分发的音频
  （见[换音效](#换音效)），并同步修改 `assets/sound.json`。

详见 [NOTICE.md](./NOTICE.md)。MIT 许可证只覆盖本仓库的**代码与文档**，不覆盖该音频。

## 推送到 GitHub

仓库地址：<https://github.com/Wyxmz/dsh-prompt>

`package.json` 的 `author` / `repository` / `homepage` / `bugs`、`LICENSE` 的版权行、
README 徽章与 CHANGELOG 链接都已指向该仓库。首次推送：

```powershell
git remote add origin https://github.com/Wyxmz/dsh-prompt.git
# 用 SSH 的话换成：git@github.com:Wyxmz/dsh-prompt.git
git push -u origin main
```

> 提交作者当前是 `Wyxmz <Wyxmz@users.noreply.github.com>`（仓库级 git 配置）。
> 想换成真实邮箱：`git config user.email "你的邮箱"`，再
> `git commit --amend --reset-author --no-edit`。

## 许可证

[MIT](./LICENSE) © Wyxmz
（`assets/alert.m4a` 除外，见 [NOTICE.md](./NOTICE.md)）
