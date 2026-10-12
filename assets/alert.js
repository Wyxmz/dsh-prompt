/* ============================================================================
 * dsh-idle-alert —— 客户端脚本（普通浏览器 JS，由宿主注入）
 * ============================================================================
 * 行为：
 *   1. 审批 / 提问请求弹出后，若 20 秒内用户**没有移动鼠标** → 播放提醒音（一遍）
 *   2. 播放期间**移动鼠标 → 立刻停止**（先 30ms 淡出，避免咔哒爆音）
 *   3. 20 秒计时期间移动鼠标 → 本轮不提醒，且该请求不再提醒
 *   4. 每个请求只提醒一轮
 *
 * 挂起状态由宿主提供（/dsh-idle-alert/pending.json），本脚本只负责
 * "空闲计时 + 播放 + 打断"，不猜 DOM。
 *
 * 为什么用 Web Audio 而不是 <audio>：
 *   HTMLAudioElement.volume 封顶 1.0（最多等于音效本身），而且没法对正在播放的
 *   声音做平滑停止；GainNode + AudioBufferSourceNode 两样都能做。
 * ========================================================================== */
(function () {
  'use strict'

  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__DSH_IDLE_ALERT__) return
  window.__DSH_IDLE_ALERT__ = true

  var CFG = {
    pendingUrl: '/dsh-idle-alert/pending.json',
    audioUrl: '/dsh-idle-alert/sound',   // 实际音效由宿主按 assets/sound.json 解析
    idleMs: 20000,          // 无鼠标移动多久后开始播放
    gain: 1.0,              // 整体增益倍率（可被 sound.json 的 gain 覆盖）
    maxAmp: 4,              // 增益上限，防止把音效推到削波
    fadeOutSec: 0.03,       // 被打断时的淡出时长（避免咔哒声）
    pollMs: 1000,
  }

  var seen = Object.create(null)   // id -> 已经纳入过跟踪
  var done = Object.create(null)   // id -> 已播放过 / 本轮已作废
  var armed = null                 // { ids: [], timer, onMove } 正在空闲计时的那一批
  var playing = false              // 是否正在播放（避免两段音频重叠）

  // -------------------------------------------------------------------------
  // Web Audio：上下文 + 解码后的音频
  // -------------------------------------------------------------------------
  var audioCtx = null
  var audioBuffer = null
  var bufferPromise = null
  var unlocked = false

  function ensureCtx() {
    if (audioCtx) return audioCtx
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    try {
      audioCtx = new AC()
    } catch (e) {
      audioCtx = null
    }
    return audioCtx
  }

  function resumeCtx(ctx) {
    try {
      if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        var r = ctx.resume()
        if (r && typeof r.catch === 'function') r.catch(function () {})
      }
    } catch (e) {}
  }

  function loadBuffer() {
    if (audioBuffer) return Promise.resolve(audioBuffer)
    if (bufferPromise) return bufferPromise
    var ctx = ensureCtx()
    if (!ctx || typeof fetch !== 'function') return Promise.resolve(null)
    bufferPromise = fetch(CFG.audioUrl, { cache: 'no-store' })
      .then(function (r) { return r.arrayBuffer() })
      .then(function (ab) {
        return new Promise(function (resolve, reject) {
          var settled = false
          var ok = function (buf) { if (!settled) { settled = true; resolve(buf) } }
          var bad = function (err) { if (!settled) { settled = true; reject(err || new Error('decode failed')) } }
          try {
            var ret = ctx.decodeAudioData(ab, ok, bad)
            if (ret && typeof ret.then === 'function') ret.then(ok, bad)
          } catch (e) { bad(e) }
        })
      })
      .then(function (buf) { audioBuffer = buf; return buf })
      .catch(function () { bufferPromise = null; return null })
    return bufferPromise
  }

  // 自动播放策略：首次用户手势时唤醒 AudioContext，并顺手预解码音频
  function unlock() {
    if (unlocked) return
    unlocked = true
    resumeCtx(ensureCtx())
    loadBuffer()
  }
  try {
    document.addEventListener('pointerdown', unlock, true)
    document.addEventListener('keydown', unlock, true)
  } catch (e) {}

  // -------------------------------------------------------------------------
  // 空闲计时
  // -------------------------------------------------------------------------
  function markDone(ids) {
    for (var i = 0; i < ids.length; i++) done[ids[i]] = true
  }

  function disarm(entry, markAsDone) {
    if (!entry) return
    try { document.removeEventListener('mousemove', entry.onMove, true) } catch (e) {}
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    if (armed === entry) armed = null
    if (markAsDone) markDone(entry.ids)
  }

  function arm(ids) {
    var entry = { ids: ids.slice(), timer: null, onMove: null }
    // 计时期间用户动了鼠标 → 本轮不提醒，这些请求就此作废
    entry.onMove = function () { disarm(entry, true) }
    try { document.addEventListener('mousemove', entry.onMove, true) } catch (e) {}
    loadBuffer()   // 趁这 20 秒把音频解码好，播放时零延迟
    entry.timer = setTimeout(function () {
      entry.timer = null
      try { document.removeEventListener('mousemove', entry.onMove, true) } catch (e) {}
      if (armed === entry) armed = null
      markDone(entry.ids)
      playOnce()
    }, CFG.idleMs)
    armed = entry
  }

  // -------------------------------------------------------------------------
  // 播放：一遍；播放期间移动鼠标 → 立刻停止
  // -------------------------------------------------------------------------
  function playOnce() {
    if (playing) return
    var ctx = ensureCtx()
    if (!ctx || !audioBuffer) return
    resumeCtx(ctx)

    var src = null
    var gainNode = null
    try {
      src = ctx.createBufferSource()
      src.buffer = audioBuffer
      gainNode = ctx.createGain()
      gainNode.gain.value = Math.min(CFG.gain, CFG.maxAmp)
      src.connect(gainNode)
      gainNode.connect(ctx.destination)
    } catch (e) {
      return
    }

    playing = true
    var finished = false

    function finish() {
      if (finished) return
      finished = true
      try { document.removeEventListener('mousemove', onMove, true) } catch (e) {}
      try { src.onended = null } catch (e) {}
      playing = false
    }

    function onMove() {
      // 移动鼠标 → 立刻停：先快速淡出再 stop，避免咔哒爆音
      try {
        var now = ctx.currentTime
        gainNode.gain.cancelScheduledValues(now)
        gainNode.gain.setValueAtTime(gainNode.gain.value, now)
        gainNode.gain.linearRampToValueAtTime(0, now + CFG.fadeOutSec)
        setTimeout(function () { try { src.stop() } catch (e) {} }, CFG.fadeOutSec * 1000 + 10)
      } catch (e) {
        try { src.stop() } catch (e2) {}
      }
      finish()
    }

    src.onended = function () { finish() }   // 自然播完
    try { document.addEventListener('mousemove', onMove, true) } catch (e) {}
    try { src.start(0) } catch (e) { finish(); return }
  }

  // -------------------------------------------------------------------------
  // 轮询宿主的挂起状态
  // -------------------------------------------------------------------------
  function fetchPending() {
    if (typeof fetch !== 'function') return Promise.resolve(null)
    return fetch(CFG.pendingUrl, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .catch(function () { return null })
  }

  function handle(list) {
    var live = Object.create(null)
    var fresh = []
    var i, id

    for (i = 0; i < list.length; i++) {
      var p = list[i]
      if (!p || p.id === undefined || p.id === null) continue
      id = String(p.id)
      live[id] = true
      if (seen[id] || done[id]) continue
      seen[id] = true
      fresh.push(id)
    }

    if (armed) {
      // 正在计时：若它盯着的请求全都已经被处理掉了 → 取消，不再提醒
      var stillLive = false
      for (i = 0; i < armed.ids.length; i++) {
        if (live[armed.ids[i]]) { stillLive = true; break }
      }
      if (!stillLive) { disarm(armed, true); return }
      // 计时期间又冒出新的挂起请求 → 并入同一批，共享这次计时
      for (i = 0; i < fresh.length; i++) {
        if (armed.ids.indexOf(fresh[i]) < 0) armed.ids.push(fresh[i])
      }
      return
    }

    if (fresh.length) arm(fresh)
  }

  function loop() {
    fetchPending().then(function (j) {
      try {
        if (j) {
          // sound.json 里的这几项优先 → 改完刷新页面就能调，不用重启。
          // 注意：正在计时的那一轮不受影响，下一轮挂起才用新值。
          if (typeof j.gain === 'number' && j.gain > 0) CFG.gain = j.gain
          if (typeof j.idleMs === 'number' && j.idleMs >= 0) CFG.idleMs = j.idleMs
          handle(Array.isArray(j.pending) ? j.pending : [])
        }
      } catch (e) {}
      setTimeout(loop, CFG.pollMs)
    })
  }

  loop()

  // 调试用只读句柄
  try {
    window.__DSH_IDLE_ALERT_DEBUG__ = {
      cfg: CFG,
      seen: seen,
      done: done,
      armed: function () { return armed },
      playing: function () { return playing },
      buffer: function () { return audioBuffer },
      duration: function () { return audioBuffer ? audioBuffer.duration : null },
      ctxState: function () { return audioCtx ? audioCtx.state : null },
    }
  } catch (e) {}
})()
