// 狐译（划词翻译）后台 Service Worker：
//  - 注册右键菜单（划词翻译 / 翻译整个网页 / 切换原文译文 / 翻译这张图片）
//  - 快捷键命令分发（划词 Alt+T / 整页 Alt+P / 切换原文译文 Alt+R / 悬停开关 Alt+H，可在浏览器快捷键设置改）
//  - 统一代理所有对本机狐译后端的 HTTP 请求（带 Bearer token，绕开页面 CSP/CORS）
//  - 代理抓取网页图片字节（host_permissions <all_urls>，内容脚本自己 fetch 会被跨域拦）
//  - 保存配对信息与偏好（悬浮球/悬停翻译/划词展示方式/输入框翻译）
//  - 连接守护（2026-08 需求改版）：alarms 定时 ping 本机客户端，掉线→恢复时广播给所有网页，
//    已打开的页面无需刷新即可继续用划词翻译

const MENU_SEL = 'lingyi-translate-selection'
const MENU_PAGE = 'lingyi-translate-page'
const MENU_TOGGLE = 'lingyi-toggle-view'
const MENU_IMG = 'lingyi-translate-image'
const DEFAULT_BACKEND = 'http://localhost:8080'
const DEFAULT_LANG = '中文'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 与后端上限一致
const HEALTH_ALARM = 'lingyi-health'
/** 客户端在线巡检周期（分钟）。Chrome 对 alarms 的下限就是 0.5min，再小也会被夹到 30s。 */
const HEALTH_PERIOD_MIN = 0.5

function createMenus () {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SEL, title: '狐译（划词翻译）', contexts: ['selection'] })
    chrome.contextMenus.create({ id: MENU_IMG, title: '狐译（翻译这张图片）', contexts: ['image'] })
    chrome.contextMenus.create({ id: MENU_PAGE, title: '狐译（翻译整个网页）', contexts: ['page', 'frame'] })
    chrome.contextMenus.create({ id: MENU_TOGGLE, title: '狐译（切换原文 / 译文）', contexts: ['page', 'frame'] })
  })
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus()
  checkHealth()
})

// 浏览器启动时后台会被拉起一次：顺手探一次客户端，省得用户第一次用才发现没连上
chrome.runtime.onStartup.addListener(() => {
  createMenus()
  checkHealth()
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null || tab.id < 0) return
  const frame = { frameId: info.frameId == null ? 0 : info.frameId }
  if (info.menuItemId === MENU_SEL) {
    // 精确送到发生选择的 frame；fallbackText 兜底个别站点右键瞬间清空选区的情况
    chrome.tabs
      .sendMessage(tab.id, { type: 'LINGYI_TRANSLATE_SELECTION', fallbackText: info.selectionText || '' }, frame)
      .catch(() => {})
  } else if (info.menuItemId === MENU_IMG) {
    chrome.tabs
      .sendMessage(tab.id, { type: 'LINGYI_TRANSLATE_IMAGE', srcUrl: info.srcUrl || '' }, frame)
      .catch(() => {})
  } else if (info.menuItemId === MENU_PAGE) {
    // 广播到所有 frame，各自翻译自己的文档（内容脚本 all_frames 注入）
    chrome.tabs.sendMessage(tab.id, { type: 'LINGYI_TRANSLATE_PAGE' }).catch(() => {})
  } else if (info.menuItemId === MENU_TOGGLE) {
    chrome.tabs.sendMessage(tab.id, { type: 'LINGYI_TOGGLE_VIEW' }).catch(() => {})
  }
})

// 快捷键：悬停开关改的是全局存储（各页内容脚本经 storage.onChanged 即时生效），
// 其余三个发给当前标签页（内容脚本自己读选区，不依赖菜单的 selectionText）
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-hover') {
    const st = await chrome.storage.local.get(['hoverMode'])
    await chrome.storage.local.set({ hoverMode: !st.hoverMode })
    return
  }
  let t = tab
  if (!t || t.id == null) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    t = tabs && tabs[0]
  }
  if (!t || t.id == null || t.id < 0) return
  const map = {
    'translate-selection': { type: 'LINGYI_TRANSLATE_SELECTION', fallbackText: '' },
    'translate-page': { type: 'LINGYI_TRANSLATE_PAGE' },
    // 老命令名保留（改名会重置用户自定义的按键），语义升级为原文/译文切换
    'restore-page': { type: 'LINGYI_TOGGLE_VIEW' }
  }
  const msg = map[command]
  if (!msg) return
  // 划词只发顶层会漏掉 iframe 里的选区，广播由各 frame 自查选区（无选区的 frame 静默忽略）
  chrome.tabs.sendMessage(t.id, msg).catch(() => {})
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  dispatch(msg)
    .then(sendResponse)
    .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }))
  return true // 异步应答
})

async function dispatch (msg) {
  switch (msg && msg.type) {
    case 'LINGYI_TRANSLATE': return handleTranslate(msg.texts, msg.kind)
    case 'LINGYI_TRANSLATE_IMAGE_DATA': return handleTranslateImage(msg)
    case 'LINGYI_PAIR': return handlePair(msg.payload)
    case 'LINGYI_STATE': return handleState()
    case 'LINGYI_PING': return { ok: true } // 内容脚本用它确认后台已被唤醒
    case 'LINGYI_RECHECK': return { ok: true, online: await checkHealth() }
    case 'LINGYI_SET_LANG':
      await chrome.storage.local.set({ targetLang: msg.targetLang || DEFAULT_LANG })
      return { ok: true }
    case 'LINGYI_SET_FLAGS': return handleSetFlags(msg)
    default: return { ok: false, error: '未知消息类型' }
  }
}

/** 偏好开关：悬浮球（默认开）/ 悬停翻译（默认关）/ 划词展示方式 / 输入框翻译（默认开）。只写调用方给出的键。 */
async function handleSetFlags (msg) {
  const patch = {}
  if (typeof msg.floatBall === 'boolean') patch.floatBall = msg.floatBall
  if (typeof msg.hoverMode === 'boolean') patch.hoverMode = msg.hoverMode
  if (typeof msg.inputTrans === 'boolean') patch.inputTrans = msg.inputTrans
  if (['replace', 'below', 'popup'].includes(msg.selMode)) patch.selMode = msg.selMode
  if (Object.keys(patch).length) await chrome.storage.local.set(patch)
  return { ok: true }
}

/** 内容脚本批量翻译入口：texts 数组 → 等长同序的译文数组。kind 标记来源供后端写划词历史。 */
async function handleTranslate (texts, kind) {
  if (!Array.isArray(texts) || !texts.length) return { ok: false, error: '没有要翻译的文本' }
  const st = await chrome.storage.local.get(['targetLang'])
  const r = await api('/api/ext/translate', {
    method: 'POST',
    body: { texts, targetLang: st.targetLang || DEFAULT_LANG, kind: kind || null }
  })
  if (!r.ok) return r
  return { ok: true, translations: r.data.translations, model: r.data.model, elapsedMs: r.data.elapsedMs }
}

/**
 * 图片翻译：srcUrl 由后台代理抓取（http/https/data 均可）；
 * blob: 是页面私有 URL 后台拿不到，内容脚本自己转好 base64 经 dataBase64 传入。
 */
async function handleTranslateImage (msg) {
  let base64 = msg.dataBase64 || ''
  let mime = msg.mime || ''
  if (!base64) {
    const src = String(msg.srcUrl || '')
    if (!/^(https?|data):/i.test(src)) return { ok: false, error: '不支持的图片地址类型' }
    let resp
    try {
      resp = await fetch(src, { credentials: 'include' })
    } catch (e) {
      return { ok: false, error: '无法抓取这张图片（' + ((e && e.message) || e) + '）' }
    }
    if (!resp.ok) return { ok: false, error: '抓取图片失败（HTTP ' + resp.status + '）' }
    const blob = await resp.blob()
    if (blob.size > MAX_IMAGE_BYTES) {
      return { ok: false, error: '图片过大（' + Math.round(blob.size / 1024 / 1024) + 'MB，上限 8MB）' }
    }
    mime = mime || blob.type
    base64 = arrayBufferToBase64(await blob.arrayBuffer())
  }
  if (!base64) return { ok: false, error: '没有拿到图片数据' }
  if (!/^image\//.test(mime)) mime = 'image/png'
  const st = await chrome.storage.local.get(['targetLang'])
  const r = await api('/api/ext/image', {
    method: 'POST',
    body: { imageBase64: base64, mime, targetLang: st.targetLang || DEFAULT_LANG }
  })
  if (!r.ok) return r
  return {
    ok: true,
    translation: r.data.translation,
    ocrText: r.data.ocrText || '',
    // 行级明细（含每行在原图上的 [x,y,w,h] 包围盒），内容脚本据此把译文绘回原位
    lines: r.data.lines || [],
    // 图片数据一并回传：content 用它建 <img> 绘 canvas，绕开跨域画布污染
    imageDataUrl: 'data:' + mime + ';base64,' + base64,
    model: r.data.model,
    elapsedMs: r.data.elapsedMs
  }
}

function arrayBufferToBase64 (buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const STEP = 0x8000 // 分块拼，避免 String.fromCharCode 参数过多爆栈
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP))
  }
  return btoa(bin)
}

/** 狐译网页版页面上的内容脚本送来配对信息：先 ping 验证 token 可用再落存储。 */
async function handlePair (payload) {
  const { token, backendUrl, username, expiresAt } = payload || {}
  if (!token || !backendUrl) return { ok: false, error: '配对信息不完整' }
  let data
  try {
    const resp = await fetch(backendUrl + '/api/ext/ping', { headers: { Authorization: 'Bearer ' + token } })
    data = await resp.json()
  } catch (e) {
    return { ok: false, error: '无法访问狐译服务 ' + backendUrl }
  }
  if (!data || data.code !== 0) return { ok: false, error: (data && data.msg) || '连接验证失败' }
  await chrome.storage.local.set({
    token,
    backendUrl,
    username: (data.data && data.data.username) || username || '',
    expiresAt: expiresAt || 0
  })
  await setOnline(true)
  return { ok: true, username: (data.data && data.data.username) || username || '' }
}

/** 弹窗状态：是否已配对、后端是否在线、当前目标语言与偏好开关。 */
async function handleState () {
  const st = await chrome.storage.local.get([
    'backendUrl', 'token', 'username', 'targetLang', 'floatBall', 'hoverMode', 'selMode', 'inputTrans'
  ])
  const out = {
    ok: true,
    targetLang: st.targetLang || DEFAULT_LANG,
    backendUrl: st.backendUrl || DEFAULT_BACKEND,
    username: st.username || '',
    floatBall: st.floatBall !== false, // 默认开
    hoverMode: !!st.hoverMode, // 默认关
    inputTrans: st.inputTrans !== false, // 默认开
    selMode: ['replace', 'below', 'popup'].includes(st.selMode) ? st.selMode : 'replace',
    paired: !!st.token,
    online: false,
    error: ''
  }
  if (st.token) {
    const r = await api('/api/ext/ping')
    out.online = !!r.ok
    await setOnline(out.online)
    if (r.ok) {
      out.username = (r.data && r.data.username) || out.username
    } else {
      out.error = r.error || ''
      if (r.needPair) out.paired = false
    }
  }
  return out
}

// ---------------- 连接守护：定时探活 + 恢复广播 ----------------

/** 巡检闹钟只在缺失时建；alarms 本身跨 SW 重启存活，重复 create 反而会把倒计时清零。 */
async function ensureHealthAlarm () {
  try {
    const a = await chrome.alarms.get(HEALTH_ALARM)
    if (!a) await chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: HEALTH_PERIOD_MIN })
  } catch (e) { /* 老浏览器没有 alarms 权限时静默降级为「用时再探」 */ }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm && alarm.name === HEALTH_ALARM) checkHealth()
})

/**
 * 探一次本机客户端是否活着，并把结果落存储。
 * 由 offline → online 的那一刻广播给所有标签页：内容脚本收到后提示「已重新连接」，
 * 用户不必刷新页面就能接着用（客户端重启是最常见的触发场景）。
 */
async function checkHealth () {
  const st = await chrome.storage.local.get(['token', 'backendUrl', 'backendOnline'])
  if (!st.token) return false
  let online = false
  try {
    const resp = await fetch((st.backendUrl || DEFAULT_BACKEND) + '/api/ext/ping', {
      headers: { Authorization: 'Bearer ' + st.token },
      cache: 'no-store'
    })
    const data = await resp.json().catch(() => null)
    online = !!(data && data.code === 0)
  } catch (e) {
    online = false
  }
  const recovered = online && st.backendOnline === false
  await setOnline(online)
  if (recovered) broadcast({ type: 'LINGYI_BACKEND_ONLINE' })
  return online
}

/** 在线状态写存储（SW 随时会被回收，内存变量靠不住）。 */
async function setOnline (online) {
  try {
    await chrome.storage.local.set({ backendOnline: !!online, backendCheckedAt: Date.now() })
  } catch (e) { /* 存储异常不影响翻译本身 */ }
}

async function broadcast (msg) {
  let tabs = []
  try {
    tabs = await chrome.tabs.query({})
  } catch (e) {
    return
  }
  for (const t of tabs) {
    if (t.id == null || t.id < 0) continue
    chrome.tabs.sendMessage(t.id, msg).catch(() => {}) // 没注入内容脚本的页面必然失败，忽略
  }
}

/**
 * 统一请求：读存储里的 backendUrl/token，解包后端 R 包裹（code=0 成功）。
 * 连不上客户端时标记 retryable，内容脚本会退避重试——客户端重启的十几秒空窗期
 * 就这样被吃掉，用户看不到失败。
 */
async function api (path, { method = 'GET', body } = {}) {
  const st = await chrome.storage.local.get(['backendUrl', 'token'])
  if (!st.token) {
    return { ok: false, needPair: true, error: '尚未连接狐译：请打开狐译网页版的「划词翻译」页完成连接' }
  }
  const base = st.backendUrl || DEFAULT_BACKEND
  let resp
  try {
    resp = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (e) {
    await setOnline(false) // 记下掉线，等巡检探到恢复时才好广播
    return {
      ok: false,
      retryable: true,
      error: '无法连接狐译客户端（' + base + '），请确认它已启动'
    }
  }
  if (resp.status === 401) {
    return { ok: false, needPair: true, error: '连接已过期：请打开狐译网页版「划词翻译」页重新连接' }
  }
  let data
  try {
    data = await resp.json()
  } catch (e) {
    return { ok: false, error: '狐译服务响应异常（HTTP ' + resp.status + '）' }
  }
  if (!data || data.code !== 0) {
    return { ok: false, error: (data && data.msg) || ('狐译服务错误 code=' + (data && data.code)) }
  }
  await setOnline(true)
  return { ok: true, data: data.data }
}

// SW 每次被唤醒都会重跑本文件：顺手确认巡检闹钟还在（浏览器升级/扩展重载后会丢）
ensureHealthAlarm()
