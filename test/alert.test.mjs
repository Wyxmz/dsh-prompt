// ============================================================================
// dsh-idle-alert —— 客户端逻辑单元测试
// ============================================================================
// 用 node:vm 造一个假的浏览器环境（document / AudioContext / fetch + 可控时钟），
// 直接跑真实的 assets/alert.js，逐条验证行为。
//
// 当前行为规格：
//   1. 弹窗后 20 秒内没动鼠标 → 播放提醒音（一遍）
//   2. 播放期间移动鼠标 → 立刻停止
//   3. 20 秒计时期间移动鼠标 → 本轮不提醒
//   4. 每个请求只提醒一轮
//
// 跑：node test/alert.test.mjs
// ============================================================================

import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ALERT_JS = path.resolve(HERE, '..', 'assets', 'alert.js')
const SOURCE = fs.readFileSync(ALERT_JS, 'utf8')

const IDLE = 20000

// ---------------------------------------------------------------------------
// 假的时钟
// ---------------------------------------------------------------------------
function makeClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    get now() { return now },
    setTimeout(fn, ms) {
      const id = ++seq
      timers.set(id, { at: now + Number(ms || 0), fn })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let pick = null
        for (const [id, t] of timers) {
          if (t.at <= target && (pick === null || t.at < pick.t.at)) pick = { id, t }
        }
        if (!pick) break
        now = pick.t.at
        timers.delete(pick.id)
        pick.t.fn()
      }
      now = target
    },
  }
}

// ---------------------------------------------------------------------------
// 假的 document
// ---------------------------------------------------------------------------
function makeDom() {
  const listeners = new Map()
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      const arr = listeners.get(type)
      if (arr.indexOf(fn) < 0) arr.push(fn)
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type)
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type })
    },
    count(type) { return (listeners.get(type) || []).length },
  }
}

// ---------------------------------------------------------------------------
// 环境：假 AudioContext
// ---------------------------------------------------------------------------
// 假 source 暴露给断言用：
//   .volume  → 关联 GainNode 的当前增益（即播放幅度）
//   .played  → 是否 start 过
//   .stopped → 是否被 stop 过（"立刻停止"就靠它验证）
//   .onended → 测试里手动调用，模拟"这段自然播完了"
function createEnv() {
  const clock = makeClock()
  const dom = makeDom()
  const audios = []
  const fetched = []
  const pending = { list: [], gain: undefined }

  class FakeGain {
    constructor() {
      const self = this
      this.gain = {
        value: 1,
        cancelScheduledValues() {},
        setValueAtTime(v) { self.gain.value = v },
        linearRampToValueAtTime(v) { self.gain.value = v },
      }
      this.connected = null
    }
    connect(dest) { this.connected = dest; return dest }
  }

  class FakeSource {
    constructor() {
      this.onended = null
      this.buffer = null
      this._gain = null
      this.played = false
      this.stopped = false
    }
    connect(node) { this._gain = node; return node }
    start() { this.played = true; audios.push(this) }
    stop() { this.stopped = true; if (this.onended) this.onended() }
    get volume() { return this._gain ? this._gain.gain.value : null }
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.currentTime = 0
      this.destination = { __destination: true }
    }
    createBufferSource() { return new FakeSource() }
    createGain() { return new FakeGain() }
    decodeAudioData(ab, ok) {
      const buf = { __buffer: true, duration: 55.97 }
      if (typeof ok === 'function') ok(buf)
      return Promise.resolve(buf)
    }
    resume() { this.state = 'running'; return Promise.resolve() }
  }

  const sandbox = {
    document: dom,
    AudioContext: FakeAudioContext,
    fetch: (url) => {
      const u = String(url)
      fetched.push(u)
      if (u.indexOf('pending.json') >= 0) {
        return Promise.resolve({
          json: () => Promise.resolve({ ok: true, pending: pending.list, gain: pending.gain, idleMs: pending.idleMs }),
        })
      }
      return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)) })
    },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    console,
  }
  sandbox.window = sandbox
  const ctx = vm.createContext(sandbox)
  vm.runInContext(SOURCE, ctx, { filename: 'alert.js' })

  const dbg = () => sandbox.__DSH_IDLE_ALERT_DEBUG__

  return {
    clock, dom, audios, fetched, pending,
    debug: dbg,
    isArmed: () => !!dbg().armed(),
    isPlaying: () => !!dbg().playing(),
    async flush(n = 4) {
      for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
    },
    async tick(ms) {
      clock.advance(ms)
      await this.flush()
    },
  }
}

// ---------------------------------------------------------------------------
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

// ===========================================================================
// [1] 20 秒没动鼠标 → 播放一遍
// ===========================================================================
{
  console.log('\n[1] 20 秒没动鼠标 → 播放一遍')
  const env = createEnv()
  env.pending.list = [{ id: 'a1', kind: 'approval' }]
  await env.flush()

  check('首次轮询后进入空闲计时', () => assert.equal(env.isArmed(), true))
  check('20 秒之前一声不响', () => {
    env.clock.advance(IDLE - 1)
    assert.equal(env.audios.length, 0)
  })
  check('第 20 秒开始播放，增益 = gain', () => {
    env.clock.advance(1)
    assert.equal(env.audios.length, 1)
    assert.equal(env.audios[0].played, true)
    assert.equal(env.audios[0].volume, env.debug().cfg.gain)
    assert.equal(env.isPlaying(), true)
  })
  check('取的是 /dsh-idle-alert/sound', () => {
    assert.equal(env.fetched.indexOf('/dsh-idle-alert/sound') >= 0, true)
  })
  check('解码出的音频时长是 55.97 秒（完整那段，没被裁）', () => {
    assert.equal(env.debug().duration(), 55.97)
  })

  env.audios[0].onended()          // 自然播完
  check('播完后 playing 复位', () => assert.equal(env.isPlaying(), false))
  check('播完后不再重播（等 2 分钟也没有第二段）', () => {
    env.clock.advance(120000)
    assert.equal(env.audios.length, 1)
  })
  check('播完后不留残余 mousemove 监听', () => assert.equal(env.dom.count('mousemove'), 0))
}

// ===========================================================================
// [2] 20 秒内移动了鼠标 → 不播
// ===========================================================================
{
  console.log('\n[2] 20 秒内移动了鼠标 → 不播')
  const env = createEnv()
  env.pending.list = [{ id: 'b1', kind: 'question' }]
  await env.flush()
  check('已进入计时', () => assert.equal(env.isArmed(), true))
  check('第 10 秒动了鼠标 → 计时取消', () => {
    env.clock.advance(10000)
    env.dom.fire('mousemove')
    assert.equal(env.isArmed(), false)
  })
  check('之后即使一直不动也不再响', () => {
    env.clock.advance(120000)
    assert.equal(env.audios.length, 0)
  })
  check('监听已摘除', () => assert.equal(env.dom.count('mousemove'), 0))
}

// ===========================================================================
// [3] 播放期间移动鼠标 → 立刻停止
// ===========================================================================
{
  console.log('\n[3] 播放期间移动鼠标 → 立刻停')
  const env = createEnv()
  env.pending.list = [{ id: 'c1', kind: 'approval' }]
  await env.flush()
  await env.tick(IDLE)
  check('已经在播', () => {
    assert.equal(env.audios.length, 1)
    assert.equal(env.isPlaying(), true)
  })

  const src = env.audios[0]
  env.dom.fire('mousemove')
  check('playing 标志立刻复位', () => assert.equal(env.isPlaying(), false))
  check('立刻摘掉监听', () => assert.equal(env.dom.count('mousemove'), 0))
  check('增益已被拉向 0（淡出）', () => assert.equal(src.volume, 0))
  check('stop() 还没调（要先淡出 30ms）', () => assert.equal(src.stopped, false))

  env.clock.advance(60)
  check('淡出结束后真正 stop()', () => assert.equal(src.stopped, true))
  check('之后不会自己又响一遍', () => {
    env.clock.advance(120000)
    assert.equal(env.audios.length, 1)
  })
}

// ===========================================================================
// [4] 计时期间请求被处理掉 → 取消提醒
// ===========================================================================
{
  console.log('\n[4] 计时期间请求已被处理 → 不提醒')
  const env = createEnv()
  env.pending.list = [{ id: 'd1', kind: 'approval' }]
  await env.flush()
  check('已进入计时', () => assert.equal(env.isArmed(), true))

  env.pending.list = []
  await env.tick(1000)
  check('计时被取消', () => assert.equal(env.isArmed(), false))
  check('20 秒后也不响', () => {
    env.clock.advance(120000)
    assert.equal(env.audios.length, 0)
  })
}

// ===========================================================================
// [5] 播放期间来了新请求 → 新请求独立计时，但不与正在播的重叠
// ===========================================================================
{
  console.log('\n[5] 播放期间来了新请求 → 独立计时、不叠加')
  const env = createEnv()
  env.pending.list = [{ id: 'e1', kind: 'approval' }]
  await env.flush()
  await env.tick(IDLE)
  check('第一段在播', () => {
    assert.equal(env.audios.length, 1)
    assert.equal(env.isPlaying(), true)
  })

  env.pending.list = [{ id: 'e1', kind: 'approval' }, { id: 'e2', kind: 'question' }]
  await env.tick(1000)
  check('e2 独立进入空闲计时', () => assert.equal(env.isArmed(), true))

  await env.tick(IDLE)     // e2 到期，但第一段还在播
  check('不会叠加播放第二段', () => {
    assert.equal(env.audios.length, 1)
    assert.equal(env.isPlaying(), true)
  })
}

// ===========================================================================
// [6] 完整流程：播放 → 手动打断 → 再等一个请求仍能正常播
// ===========================================================================
{
  console.log('\n[6] 打断之后，下一个请求仍能正常触发')
  const env = createEnv()
  env.pending.list = [{ id: 'f1', kind: 'approval' }]
  await env.flush()
  await env.tick(IDLE)
  env.dom.fire('mousemove')
  env.clock.advance(60)
  check('第一段已停止', () => {
    assert.equal(env.audios[0].stopped, true)
    assert.equal(env.isPlaying(), false)
  })

  env.pending.list = [{ id: 'f2', kind: 'question' }]
  await env.tick(1000)
  check('f2 进入计时', () => assert.equal(env.isArmed(), true))
  await env.tick(IDLE)
  check('f2 正常播放', () => {
    assert.equal(env.audios.length, 2)
    assert.equal(env.audios[1].played, true)
    assert.equal(env.isPlaying(), true)
  })
}

// ===========================================================================
// [7] 等待时长可热改（从 pending.json 跟随）
// ===========================================================================
{
  console.log('\n[7] 等待时长可热改（sound.json 的 idleMs）')
  const env = createEnv()
  env.pending.idleMs = 5000
  await env.tick(1100)      // 推进到下一轮轮询（loop 间隔 1 秒）
  check('CFG.idleMs 跟随配置更新', () => {
    assert.equal(env.debug().cfg.idleMs, 5000)
  })

  env.pending.list = [{ id: 'x1', kind: 'approval' }]
  await env.tick(1100)
  check('已按新时长进入计时', () => assert.equal(env.isArmed(), true))

  await env.tick(5000)
  check('5 秒（而不是 20 秒）后就开始播放', () => {
    assert.equal(env.audios.length, 1)
    assert.equal(env.isPlaying(), true)
  })
}

console.log('\n' + (process.exitCode ? 'FAILED' : 'ALL PASSED') + '  (' + passed + ' 项断言组通过)')
