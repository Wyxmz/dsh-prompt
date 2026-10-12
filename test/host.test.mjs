// ============================================================================
// dsh-idle-alert —— 宿主端单元测试
// ============================================================================
// 用假的 root/ctx 直接调用插件的 apply()，验证：
//   · 注入行（内联 script、幂等）
//   · 四条路由是否齐全
//   · approval / ask_user_question / turn-end 的挂起判定
//   · 信任栅栏（非回环 Host 拒绝）
//   · 音频与脚本资源的实际字节
//
// 跑：node test/host.test.mjs
// ============================================================================

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOUND_JSON = path.resolve(HERE, '..', 'assets', 'sound.json')

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const plugin = mod.default

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log('  PASS  ' + name)
  } catch (err) {
    console.log('  FAIL  ' + name)
    console.log('        ' + String((err && err.message) || err))
    process.exitCode = 1
  }
}

function makeRes() {
  return {
    statusCode: 200,
    headers: null,
    body: undefined,
    ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || null; return this },
    end(chunk) { if (chunk !== undefined) this.body = chunk; this.ended = true; return this },
  }
}

function setup() {
  const routes = new Map()
  const indexInjectHandlers = []
  const sessionEventHandlers = []
  const sessionDisposedHandlers = []

  const ctx = {
    get: () => undefined,          // 拿不到 connection 服务 → 插件走自己的回环检查
    on: (type, fn) => {
      if (type === 'session/event') sessionEventHandlers.push(fn)
      else if (type === 'session/disposed') sessionDisposedHandlers.push(fn)
      return () => {}
    },
    webServer: {
      register: (route) => { routes.set(route.path, route); return () => {} },
    },
  }

  const root = {
    on: (type, fn) => { if (type === 'webserver/index-inject') indexInjectHandlers.push(fn); return () => {} },
    inject: (deps, cb) => { cb(ctx) },
    effect: (fn) => { try { fn() } catch (e) {} return () => {} },
  }

  plugin.apply(root)

  return {
    routes, indexInjectHandlers, sessionEventHandlers, sessionDisposedHandlers,
    call(path, req) {
      const route = routes.get(path)
      assert.ok(route, '路由未注册: ' + path)
      const res = makeRes()
      route.handler(req || { headers: { host: '127.0.0.1:19387' }, url: path }, res)
      return res
    },
    pending(host) {
      const res = this.call('/dsh-idle-alert/pending.json', { headers: { host: host || '127.0.0.1:19387' } })
      return { res, json: res.body ? JSON.parse(res.body.toString('utf8')) : null }
    },
    emit(event, session) {
      for (const fn of sessionEventHandlers) fn(session || { id: 's1' }, event)
    },
  }
}

// ===========================================================================
console.log('\n[1] 插件形态与注入行')
// ===========================================================================
{
  const env = setup()
  check('导出 name 与 apply', () => {
    assert.equal(plugin.name, 'dsh-idle-alert')
    assert.equal(typeof plugin.apply, 'function')
  })
  check('注册了 webserver/index-inject 处理器', () => {
    assert.equal(env.indexInjectHandlers.length, 1)
  })
  check('注入行内联的是 alert.js 源码本身（不走 URL，避免被缓存）', () => {
    const table = []
    env.indexInjectHandlers[0](table)
    assert.equal(table.length, 1)
    assert.equal(table[0].kind, 'script')
    const alertSrc = fs.readFileSync(path.resolve(HERE, '..', 'assets', 'alert.js'), 'utf8')
    assert.equal(table[0].text, alertSrc, '应与 assets/alert.js 逐字一致')
    assert.equal(table[0].text.indexOf('/dsh-idle-alert/alert.js') >= 0, false, '不应再引用外部 URL')
  })
  check('重复触发不会重复注入（幂等）', () => {
    const table = []
    env.indexInjectHandlers[0](table)
    env.indexInjectHandlers[0](table)
    env.indexInjectHandlers[0](table)
    assert.equal(table.length, 1)
  })
}

// ===========================================================================
console.log('\n[2] 路由与资源')
// ===========================================================================
{
  const env = setup()
  check('四条路由都注册了', () => {
    assert.ok(env.routes.has('/dsh-idle-alert/pending.json'))
    assert.ok(env.routes.has('/dsh-idle-alert/alert.js'))
    assert.ok(env.routes.has('/dsh-idle-alert/sound'))
    assert.ok(env.routes.has('/dsh-idle-alert/alert.m4a'))
  })
  check('alert.js 能取到脚本内容', () => {
    const res = env.call('/dsh-idle-alert/alert.js')
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['Content-Type']), /javascript/)
    assert.match(res.body.toString('utf8'), /__DSH_IDLE_ALERT__/)
  })
  check('/sound 返回可播放的音频', () => {
    const res = env.call('/dsh-idle-alert/sound')
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['Content-Type']), /^audio\//)
    assert.equal(res.body.length > 0, true)
    assert.equal(res.headers['Accept-Ranges'], 'bytes')
  })
  check('/sound 用的正是 sound.json 里配置的那个文件', () => {
    const cfg = JSON.parse(fs.readFileSync(SOUND_JSON, 'utf8'))
    const ASSETS = path.resolve(HERE, '..', 'assets')
    // 与 soundInfo() 一致的解析顺序：path → windowsMediaDir → 插件 assets
    const candidates = cfg.path
      ? [String(cfg.path)]
      : [path.join(cfg.windowsMediaDir, cfg.file), path.join(ASSETS, cfg.file)]
    const target = candidates.find((p) => fs.existsSync(p))
    if (!target) {
      console.log('        (跳过：候选都不存在，此时应回退兜底音效)')
      const res = env.call('/dsh-idle-alert/sound')
      const bundled = path.resolve(HERE, '..', 'assets', 'alert.m4a')
      assert.equal(res.body.length, fs.statSync(bundled).size)
      return
    }
    const res = env.call('/dsh-idle-alert/sound')
    assert.equal(res.body.length, fs.statSync(target).size)
    assert.equal(env.pending().json.sound, target, 'pending.json 应报告实际用的文件')
    if (path.extname(target).toLowerCase() === '.wav') {
      assert.equal(res.body.subarray(0, 4).toString('ascii'), 'RIFF')
      assert.equal(res.body.subarray(8, 12).toString('ascii'), 'WAVE')
    }
  })
  check('pending.json 会报告当前音效、是否回退、以及增益', () => {
    const p = env.pending().json
    assert.match(String(p.sound), /\.(wav|mp3|ogg|oga|m4a|flac|aac)$/i)
    assert.equal(typeof p.soundFallback, 'boolean')
    const cfg = JSON.parse(fs.readFileSync(SOUND_JSON, 'utf8'))
    assert.equal(p.gain, cfg.gain, 'pending.json 的 gain 应与 sound.json 一致')
    assert.equal(p.idleMs, cfg.idleMs, 'pending.json 的 idleMs 应与 sound.json 一致')
    assert.equal(p.idleMs > 0, true, 'idleMs 必须是正数')
    assert.equal(typeof p.gain, 'number')
    assert.equal(p.gain > 0, true, 'gain 必须是正数')
    assert.equal(p.soundFallback, false, '自带音效存在时不应回退')
  })
  check('/alert.m4a 兜底音效是完整的 MP4/ISO-BMFF（头部有 ftyp box）', () => {
    const res = env.call('/dsh-idle-alert/alert.m4a')
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['Content-Type'], 'audio/mp4')
    assert.equal(res.headers['Accept-Ranges'], 'bytes')
    const bundled = path.resolve(HERE, '..', 'assets', 'alert.m4a')
    assert.equal(res.body.length, fs.statSync(bundled).size)
    assert.equal(res.body.subarray(4, 8).toString('ascii'), 'ftyp')
  })
  check('Range 请求返回 206 与正确的 Content-Range', () => {
    const res = env.call('/dsh-idle-alert/sound', {
      headers: { host: '127.0.0.1:19387', range: 'bytes=0-99' },
    })
    assert.equal(res.statusCode, 206)
    assert.equal(res.body.length, 100)
    assert.match(String(res.headers['Content-Range']), /^bytes 0-99\/\d+$/)
  })
  check('越界 Range 返回 416', () => {
    const res = env.call('/dsh-idle-alert/sound', {
      headers: { host: '127.0.0.1:19387', range: 'bytes=99999999-' },
    })
    assert.equal(res.statusCode, 416)
  })
  check('非回环 Host 被拒绝（403）', () => {
    const res = env.pending('evil.example.com').res
    assert.equal(res.statusCode, 403)
  })
  check('回环 Host 放行', () => {
    const res = env.pending('127.0.0.1:19387').res
    assert.equal(res.statusCode, 200)
  })
}

// ===========================================================================
console.log('\n[3] 挂起判定：审批')
// ===========================================================================
{
  const env = setup()
  check('初始没有挂起', () => {
    assert.equal(env.pending().json.pending.length, 0)
  })
  check('approval/asked → 出现一条 approval 挂起', () => {
    env.emit({ type: 'approval/asked', data: { id: 'ap-1' } })
    const p = env.pending().json
    assert.equal(p.pending.length, 1)
    assert.equal(p.pending[0].id, 'ap-1')
    assert.equal(p.pending[0].kind, 'approval')
    assert.equal(p.pending[0].session, 's1')
  })
  check('approval/decided → 解除', () => {
    env.emit({ type: 'approval/decided', data: { id: 'ap-1' } })
    assert.equal(env.pending().json.pending.length, 0)
  })
  check('decided 事件缺 id 时按会话兜底解除', () => {
    env.emit({ type: 'approval/asked', data: { id: 'ap-2' } })
    assert.equal(env.pending().json.pending.length, 1)
    env.emit({ type: 'approval/decided', data: {} })
    assert.equal(env.pending().json.pending.length, 0)
  })
}

// ===========================================================================
console.log('\n[4] 挂起判定：提问')
// ===========================================================================
{
  const env = setup()
  check('tool/call ask_user_question → 出现一条 question 挂起', () => {
    env.emit({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'call-1' } })
    const p = env.pending().json
    assert.equal(p.pending.length, 1)
    assert.equal(p.pending[0].kind, 'question')
    assert.equal(p.pending[0].id, 'call-1')
  })
  check('别的工具调用不会误判成提问', () => {
    env.emit({ type: 'tool/call', data: { name: 'pwsh', callId: 'call-2' } })
    assert.equal(env.pending().json.pending.length, 1)
  })
  check('tool/result 按 callId 精确解除', () => {
    env.emit({ type: 'tool/result', data: { message: { toolCallId: 'call-1' } } })
    assert.equal(env.pending().json.pending.length, 0)
  })
  check('tool/result 的 callId 在 message.source.callId 上时也能解除', () => {
    env.emit({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'call-3' } })
    assert.equal(env.pending().json.pending.length, 1)
    env.emit({ type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call-3' } } } })
    assert.equal(env.pending().json.pending.length, 0)
  })
  check('tool/result 完全读不到 callId 时按会话兜底', () => {
    env.emit({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'call-4' } })
    assert.equal(env.pending().json.pending.length, 1)
    env.emit({ type: 'tool/result', data: { message: { content: [] } } })
    assert.equal(env.pending().json.pending.length, 0)
  })
}

// ===========================================================================
console.log('\n[5] 会话与轮次清理')
// ===========================================================================
{
  const env = setup()
  check('turn/end 清掉本会话的挂起', () => {
    env.emit({ type: 'approval/asked', data: { id: 'ap-9' } })
    assert.equal(env.pending().json.pending.length, 1)
    env.emit({ type: 'turn/end', data: {} })
    assert.equal(env.pending().json.pending.length, 0)
  })
  check('只清本会话，别的会话不受影响', () => {
    env.emit({ type: 'approval/asked', data: { id: 'x-s1' } }, { id: 's1' })
    env.emit({ type: 'approval/asked', data: { id: 'x-s2' } }, { id: 's2' })
    assert.equal(env.pending().json.pending.length, 2)
    env.emit({ type: 'turn/end', data: {} }, { id: 's1' })
    const p = env.pending().json
    assert.equal(p.pending.length, 1)
    assert.equal(p.pending[0].id, 'x-s2')
  })
  check('session/disposed 清掉该会话的挂起', () => {
    for (const fn of env.sessionDisposedHandlers) fn({ id: 's2' })
    assert.equal(env.pending().json.pending.length, 0)
  })
  check('审批与提问可同时挂起，各自可达', () => {
    env.emit({ type: 'approval/asked', data: { id: 'both-a' } })
    env.emit({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'both-q' } })
    const kinds = env.pending().json.pending.map((x) => x.kind).sort()
    assert.deepEqual(kinds, ['approval', 'question'])
  })
}

console.log('\n' + (process.exitCode ? 'FAILED' : 'ALL PASSED') + '  (' + passed + ' 项断言组通过)')
