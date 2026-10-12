// ============================================================================
// dsh-idle-alert —— 宿主端
// ============================================================================
// 职责：
//   1) 往页面注入客户端脚本（桌面端唯一有效通道：webserver/index-inject 的**内联 script 行**）
//   2) 跟踪"等待用户交互"的挂起状态（审批 / 提问），经 /dsh-idle-alert/pending.json 供前端轮询
//   3) 提供客户端脚本与提醒音资源
//
// 为什么状态由宿主出、前端轮询：
//   客户端靠 MutationObserver 猜 DOM 很不稳（弹窗结构会变）；而宿主侧的 session/event
//   有权威的 `approval/asked`、`tool/call(name=ask_user_question)`、`turn/end` 信号。
//   "宿主出状态 + 前端每秒轮询"是 dsh-whale-widget 已经跑通的既有模式（它的 /dsh-whale/wait.json）。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const ASSETS = path.join(ROOT, 'assets')

const PREFIX = '/dsh-idle-alert'
const ALERT_JS = path.join(ASSETS, 'alert.js')
const FALLBACK_AUDIO = path.join(ASSETS, 'alert.m4a')  // 兜底音效（插件自带默认音，配置的音频都找不到时用）
const SOUND_JSON = path.join(ASSETS, 'sound.json')    // 提醒音来源配置（热读，改完刷新页面即可）

const DEFAULT_MEDIA_DIR = 'C:\\Windows\\Media'
const DEFAULT_MEDIA_FILE = 'alert.m4a'
// 整体增益倍率。客户端用 Web Audio 的 GainNode 播放，所以能 >1 真正放大。
// 注意：自带的 alert.m4a 峰值已经是 0dB（满刻度），所以这里默认 1.0——
// 再往上只会削波，不会更响。想让提醒更响，应该继续处理音频本身，而不是加大 gain。
const DEFAULT_GAIN = 1.0
// 空闲多久后开始播放（毫秒）。可在 assets/sound.json 里用 idleMs 热改覆盖。
const DEFAULT_IDLE_MS = 20000

const MIME_BY_EXT = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// 挂起项超过这个时间就当作陈旧数据丢掉（防止内存泄漏 / 失效提醒）
const STALE_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// 注入行
// ---------------------------------------------------------------------------
// 桌面端 index.html 从安装包静态 dist 直出，`tapIndex`（函数变换）永远过不去；
// 唯一通道是 webserver/index-inject 推的结构化行。
//   case "script"     → createElement + textContent + append，没有 await，**不可能"加载失败"**
//   case "script-src" → await loadScript(src)，失败即 reject 掉 __DSH_BOOT_READY__ ⇒ 应用起不来
// 所以用 kind:'script' 行。客户端脚本**直接内联源码**（见 apply() 里的注入行），
// 既不建 <script src>、也不走网络 —— 那样会被浏览器缓存住旧版本。

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function headerHost(req) {
  try {
    const h = (req && req.headers) || {}
    return String(h.host || h.Host || '')
  } catch (err) {
    return ''
  }
}

function isLoopbackHost(req) {
  try {
    const raw = headerHost(req)
    if (!raw) return false
    let host = raw
    if (host.charAt(0) === '[') {
      const close = host.indexOf(']')
      host = close > 0 ? host.slice(1, close) : host
    } else {
      host = host.split(':')[0]
    }
    host = host.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch (err) {
    return false
  }
}

// 从 session/event 里抠出 callId。字段位置随 DSH 版本略有差异，全都兜一遍。
function callIdOf(event) {
  try {
    const d = (event && event.data) || {}
    const msg = d.message || {}
    const list = Array.isArray(msg.content) ? msg.content : []
    for (const c of list) {
      if (c && (c.toolCallId || c.tool_call_id)) return String(c.toolCallId || c.tool_call_id)
    }
    if (msg.callId || msg.toolCallId || msg.tool_call_id) {
      return String(msg.callId || msg.toolCallId || msg.tool_call_id)
    }
    if (msg.source && msg.source.callId) return String(msg.source.callId)
    return String(d.callId || d.call_id || d.toolCallId || '')
  } catch (err) {
    return ''
  }
}

// 解析"当前该放哪个提醒音"。
// 配置来自 assets/sound.json，**每次请求都重新读**（改完只要 Ctrl+F5，不必重启 DSH）。
// 两种写法：
//   { "file": "ding.wav" }                                  → 在 windowsMediaDir 下查找
//   { "path": "D:\\我的音效\\alert.wav" }                    → 直接用绝对路径
// 只接受音频扩展名；解析失败或文件不存在就回退到插件自带的兜底音效。
function soundInfo() {
  let cfg = {}
  try {
    cfg = JSON.parse(fs.readFileSync(SOUND_JSON, 'utf8')) || {}
  } catch (err) {
    cfg = {}
  }
  const explicit = cfg && cfg.path ? String(cfg.path) : ''
  const dir = String((cfg && cfg.windowsMediaDir) || DEFAULT_MEDIA_DIR)
  const name = String((cfg && cfg.file) || DEFAULT_MEDIA_FILE)
  // 解析顺序：① path 绝对路径 ② windowsMediaDir/file（系统音效）③ assets/file（插件自带）
  const candidates = explicit
    ? [explicit]
    : [path.join(dir, name), path.join(ASSETS, name)]
  // 整体增益倍率：sound.json 里的 gain 优先，非法值一律回落到默认
  const gainNum = Number(cfg && cfg.gain)
  const gain = (isFinite(gainNum) && gainNum > 0) ? Math.min(gainNum, 8) : DEFAULT_GAIN
  // 空闲等待时长：同样支持在 sound.json 里热改（单位毫秒）
  const idleNum = Number(cfg && cfg.idleMs)
  const idleMs = (isFinite(idleNum) && idleNum >= 0) ? Math.round(idleNum) : DEFAULT_IDLE_MS
  for (const candidate of candidates) {
    const mime = MIME_BY_EXT[path.extname(candidate).toLowerCase()]
    if (!mime) continue
    try {
      if (fs.statSync(candidate).isFile()) return { file: candidate, mime, fallback: false, gain, idleMs }
    } catch (err) {}
  }
  return { file: FALLBACK_AUDIO, mime: 'audio/mp4', fallback: true, gain, idleMs }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-idle-alert',

  apply(root) {
    // 当前等待用户交互的挂起项：id -> { kind, id, ts, session }
    // 用 Map 而不是"只留最新一条"，这样审批与提问同时挂起时各自可追溯。
    const pendings = new Map()

    const disposers = []
    root.effect(() => () => {
      for (const d of disposers) {
        try { if (typeof d === 'function') d() } catch (err) {}
      }
      disposers.length = 0
      pendings.clear()
    })

    // -----------------------------------------------------------------------
    // ① 注入行：必须**立刻**注册
    // -----------------------------------------------------------------------
    // 桌面端的注入表是宿主启动时一次性收集的（collectIndexInjections → IPC → 渲染层）。
    // 若把注册推迟到 inject 就绪之后，这一行可能永远进不了表 —— 挂件就完全不出现。
    // 所以 apply() 里第一件事就是注册它（它不依赖任何服务）。
    //
    // ⚠️ 这里**直接内联客户端脚本源码**，不再用 <script src="/…/alert.js">。
    //    走 URL 时 Chromium 会把旧版本脚本缓存住（连 Cache-Control: no-store 都拦不住），
    //    结果就是"改了代码、页面却一直跑旧版"，排查时拿旧行为反复找问题。
    //    这个文件约 10 KB，内联没有这个隐患。代价：改 assets/alert.js 后需重启 DSH。
    root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script' && typeof row.text === 'string'
            && row.text.indexOf('__DSH_IDLE_ALERT__') >= 0) return
          if (row.kind === 'script-src' && row.src
            && row.src.indexOf(PREFIX + '/alert.js') === 0) return
        }
        let src = ''
        try { src = fs.readFileSync(ALERT_JS, 'utf8') } catch (err) { src = '' }
        if (!src) return
        table.push({ kind: 'script', placement: 'body', text: src })
      } catch (err) {}
    })

    // -----------------------------------------------------------------------
    // ② 其余逻辑等 webServer 就绪
    // -----------------------------------------------------------------------
    root.inject(['webServer'], (ctx) => {
      // 资源按 mtime 热读：改了 alert.js 只要 Ctrl+F5，不必重启 DSH
      const assetCache = new Map() // path -> { mtimeMs, bytes }
      function readAsset(p) {
        const st = fs.statSync(p)
        const hit = assetCache.get(p)
        if (hit && hit.mtimeMs === st.mtimeMs) return hit.bytes
        const bytes = fs.readFileSync(p)
        assetCache.set(p, { mtimeMs: st.mtimeMs, bytes })
        return bytes
      }

      // 信任栅栏：优先委托宿主的 connection 服务（它知道 --trusted-host，能防 DNS 重绑定）；
      // 拿不到就退化为自己查 Host 是否回环。
      function rejected(req, res) {
        try {
          const conn = typeof ctx.get === 'function' ? ctx.get('connection') : null
          if (conn && typeof conn.requestRejection === 'function') {
            const code = conn.requestRejection(req)
            if (code !== undefined && code !== null && code !== false) {
              res.statusCode = typeof code === 'number' ? code : 403
              res.end()
              return true
            }
            return false
          }
        } catch (err) {
          // 栅栏自己抛异常 → 按拒绝处理（fail closed）
          try { res.statusCode = 403; res.end() } catch (e2) {}
          return true
        }
        if (!isLoopbackHost(req)) {
          try { res.statusCode = 403; res.end() } catch (err) {}
          return true
        }
        return false
      }

      function register(route) {
        try {
          disposers.push(ctx.webServer.register(route))
        } catch (err) {
          try {
            console.warn('[dsh-idle-alert] 路由注册失败 ' + route.path + '：'
              + String((err && err.message) || err))
          } catch (e2) {}
        }
      }

      // ---- 挂起状态（前端每秒轮询这个）----
      register({
        kind: 'exact',
        path: PREFIX + '/pending.json',
        handler: (req, res) => {
          if (rejected(req, res)) return
          const now = Date.now()
          const list = []
          for (const [key, p] of pendings) {
            if (now - p.ts > STALE_MS) { pendings.delete(key); continue }
            list.push({ id: p.id, kind: p.kind, ts: p.ts, session: p.session })
          }
          const sound = soundInfo()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: true,
            now,
            pending: list,
            sound: sound.file,            // 当前实际使用的提醒音（排查用）
            soundFallback: !!sound.fallback,
            gain: sound.gain,             // 整体增益倍率，客户端据此调 GainNode
            idleMs: sound.idleMs,         // 空闲等待时长（ms），同样可热改
          }))
        },
      })

      // ---- 客户端脚本 ----
      register({
        kind: 'exact',
        path: PREFIX + '/alert.js',
        handler: (req, res) => {
          if (rejected(req, res)) return
          try {
            const bytes = readAsset(ALERT_JS)
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
          } catch (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('dsh-idle-alert: alert.js unavailable')
          }
        },
      })

      // ---- 提醒音 ----
      // 支持 Range（浏览器可能只请求片段）。两条路由共用处理器：
      //   /dsh-idle-alert/sound      按 assets/sound.json 配置解析（默认用插件自带的 alert.m4a）
      //   /dsh-idle-alert/alert.m4a  插件自带的兜底音效（始终可用，不受配置影响）
      function serveAudio(req, res, file, mime) {
        let bytes
        try {
          bytes = readAsset(file)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('dsh-idle-alert: audio unavailable')
          return
        }
        const total = bytes.length
        const m = /^bytes=(\d*)-(\d*)$/.exec(String((req.headers && req.headers.range) || '').trim())
        if (m) {
          let start = m[1] === '' ? null : parseInt(m[1], 10)
          let end = m[2] === '' ? null : parseInt(m[2], 10)
          if (start === null && end !== null) {
            start = Math.max(0, total - end)
            end = total - 1
          } else {
            if (start === null) start = 0
            if (end === null || end >= total) end = total - 1
          }
          if (start > end || start >= total) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + total })
            res.end()
            return
          }
          const chunk = bytes.subarray(start, end + 1)
          res.writeHead(206, {
            'Content-Type': mime,
            'Accept-Ranges': 'bytes',
            'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
            'Content-Length': String(chunk.length),
            'Cache-Control': 'no-store',
          })
          res.end(chunk)
          return
        }
        res.writeHead(200, {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
          'Cache-Control': 'no-store',
        })
        res.end(bytes)
      }

      register({
        kind: 'exact',
        path: PREFIX + '/sound',
        handler: (req, res) => {
          if (rejected(req, res)) return
          const s = soundInfo()
          serveAudio(req, res, s.file, s.mime)
        },
      })

      register({
        kind: 'exact',
        path: PREFIX + '/alert.m4a',
        handler: (req, res) => {
          if (rejected(req, res)) return
          serveAudio(req, res, FALLBACK_AUDIO, 'audio/mp4')
        },
      })

      // ---- 挂起跟踪 ----
      disposers.push(ctx.on('session/event', (session, event) => {
        try {
          const type = String((event && event.type) || '')
          const data = (event && event.data) || {}
          const sid = (session && session.id) ? String(session.id) : 'default'
          const now = Date.now()

          // 提问：ask_user_question 是一次**挂起**的工具调用 ——
          // 模型发出后 DSH 追加 tool/call，然后卡住等用户点，期间 seq 不变、turn/end 也不会来。
          if (type === 'tool/call') {
            const toolName = String(data.name || data.toolName || '')
            if (toolName === 'ask_user_question') {
              const id = callIdOf(event) || ('q' + now)
              pendings.set(id, { kind: 'question', id, ts: now, session: sid })
            }
            return
          }

          // 用户回答完 → tool/result。按 callId 精确解除；读不到 callId 时清掉本会话的提问挂起
          // （挂起期间那一轮正卡在等用户回答，不会有别的 tool/result，所以兜底不会误清）。
          if (type === 'tool/result') {
            const cid = callIdOf(event)
            if (cid && pendings.has(cid)) {
              pendings.delete(cid)
              return
            }
            if (!cid) {
              for (const [key, p] of pendings) {
                if (p.kind === 'question' && p.session === sid) pendings.delete(key)
              }
            }
            return
          }

          if (type === 'approval/asked') {
            const id = String(data.id || ('a' + now))
            pendings.set(id, { kind: 'approval', id, ts: now, session: sid })
            return
          }

          // approval/decided 等后续事件 → 解除
          if (type.indexOf('approval/') === 0) {
            const id = String(data.id || '')
            if (id && pendings.has(id)) {
              pendings.delete(id)
              return
            }
            for (const [key, p] of pendings) {
              if (p.kind === 'approval' && p.session === sid) pendings.delete(key)
            }
            return
          }

          // 一轮结束/开始 → 清掉本会话的挂起
          if (type === 'turn/end' || type === 'turn/start') {
            for (const [key, p] of pendings) {
              if (p.session === sid) pendings.delete(key)
            }
          }
        } catch (err) {}
      }))

      // 会话销毁 → 顺手清掉它的挂起
      disposers.push(ctx.on('session/disposed', (session) => {
        try {
          const sid = (session && session.id) ? String(session.id) : ''
          if (!sid) return
          for (const [key, p] of pendings) {
            if (p.session === sid) pendings.delete(key)
          }
        } catch (err) {}
      }))
    })
  },
}
