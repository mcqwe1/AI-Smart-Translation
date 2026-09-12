// 狐译（划词翻译）内容脚本：
//  - 划词翻译：右键菜单 / 悬浮球 / 快捷键触发，译文有三种展示方式（替换原文 / 原文下方 / 弹窗），弹窗里可选
//  - 悬浮球：选中文字后在选区旁弹出小球，点一下即翻（可在扩展弹窗关闭）
//  - 输入框翻译：在输入框/文本框/富文本里连按三下空格，把已输入内容就地翻成目标语言
//  - 悬停翻译：开启后鼠标在段落上停留约半秒自动翻译该段（Alt+H 开关）
//  - 图片翻译：右键图片，后台送本机狐译做 OCR+翻译，译文绘回图片原位；结果浮层可拖动且记住位置
//  - 整页翻译：增量式——已翻译的文本节点会登记状态并跳过，动态加载出来的新内容由
//    MutationObserver 追译，不会重复调用大模型
//  - 原文/译文切换：译文缓存在本地（node → {orig, trans}），来回切换零调用（Alt+R）
//  - 连接恢复：后台探到客户端重新在线会广播过来，已打开的网页不需要刷新
//  - 配对桥：在狐译网页版页面上（<meta name="lingyi-app">）读取页面写入的长效 token 交给后台保存
(() => {
  if (window.__lingyiContentLoaded) return
  window.__lingyiContentLoaded = true

  const TOAST_ID = 'lingyi-toast'
  const BALL_ID = 'lingyi-ball'
  const PANEL_ID = 'lingyi-img-panel'
  const SEL_PANEL_ID = 'lingyi-sel-panel'
  const UI_IDS = [TOAST_ID, BALL_ID, PANEL_ID, SEL_PANEL_ID]
  const UI_MARK = 'data-lingyi-ui' // 自家插入的 DOM（含「原文下方」的译文块）统一带这个标记
  const DONE_MARK = 'data-lingyi-t' // 已回填译文的元素标记，方便肉眼/脚本核查增量翻译
  const PAIR_KEY = 'lingyi_ext_token'
  const MAX_PAGE_CHARS = 60000 // 整页翻译送翻字符上限（含后续增量），超出部分保持原文
  const CHUNK_MAX_CHARS = 2500 // 单请求字符量（后端按平均段长再动态分批给 LLM）
  const CHUNK_MAX_ITEMS = 40
  const CONCURRENCY = 4
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  const HOVER_DWELL_MS = 500 // 悬停多久触发翻译
  const HOVER_MAX_CHARS = 3000 // 悬停单块字符上限（防止命中巨大容器）
  const HOVER_BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,dt,dd,td,th,caption,figcaption,blockquote,summary'
  const DYNAMIC_DEBOUNCE_MS = 1200 // 动态内容追译的防抖：等这一波 DOM 变动落定再扫
  const MAX_SCAN_DELAY_MS = 20000 // 空转退避的上限
  const INPUT_TRIGGER_SPACES = 3 // 输入框翻译：连按几下空格触发
  const INPUT_MAX_CHARS = 5000
  const INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', ''])
  const SEND_RETRIES = 3 // 给 MV3 后台的消息重试次数（休眠中的 SW 第一条消息可能落空）
  const CONNECT_RETRIES = 3 // 客户端连不上时的退避重试次数（覆盖客户端重启的空窗）
  const RETRY_DELAYS = [700, 1500]
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'SVG', 'MATH', 'CANVAS', 'OBJECT', 'EMBED', 'TITLE'
  ])

  /**
   * 被改写过的文本节点 → {orig, trans}。
   * 三个作用合一：① 「显示原文/显示译文」的数据源（译文不删除，来回切换不调大模型）；
   * ② 「已翻译」标记，整页扫描时跳过；③ 页面把同一节点文字换掉时能识别出是新内容。
   */
  const nodeState = new Map()
  /** 划词「译文放在原文下方」插入的元素，跟着原文/译文视图一起显示隐藏 */
  const insertedEls = []
  /** 浮层位置记忆：panelId → {left, top}（后台存储是权威，这里是本地镜像） */
  const panelPos = {}
  let pageBusy = false
  let pageTranslated = false
  let pageChars = 0
  /** 当前视图：target=显示译文 source=显示原文 */
  let pageView = 'target'
  let toastTimer = null
  /** 偏好（后台存储是权威，这里是本地镜像） */
  const prefs = { floatBall: true, hoverMode: false, inputTrans: true, selMode: 'replace' }
  /** 悬停翻译已处理过的块（译文已缓存，切回原文也不重复翻） */
  const hoverDone = new WeakSet()

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = msg && msg.type
    if (type === 'LINGYI_TRANSLATE_SELECTION') translateSelection(msg.fallbackText || '')
    else if (type === 'LINGYI_TRANSLATE_PAGE') translatePage()
    else if (type === 'LINGYI_TOGGLE_VIEW') togglePageView()
    else if (type === 'LINGYI_SHOW_SOURCE' || type === 'LINGYI_RESTORE_PAGE') showSource()
    else if (type === 'LINGYI_SHOW_TARGET') showTarget()
    else if (type === 'LINGYI_TRANSLATE_IMAGE') translateImage(msg.srcUrl || '')
    else if (type === 'LINGYI_BACKEND_ONLINE') onBackendRecovered()
    sendResponse({ ok: true }) // 同步应答，动作本身异步执行
  })

  // ---------------- 偏好同步（弹窗开关 / Alt+H 快捷键都改 storage，这里即时生效） ----------------

  function initPrefs () {
    try {
      chrome.storage.local.get(['floatBall', 'hoverMode', 'inputTrans', 'selMode', 'panelPos']).then(st => {
        prefs.floatBall = st.floatBall !== false
        prefs.hoverMode = !!st.hoverMode
        prefs.inputTrans = st.inputTrans !== false
        if (['replace', 'below', 'popup'].includes(st.selMode)) prefs.selMode = st.selMode
        Object.assign(panelPos, st.panelPos || {})
      }).catch(() => {})
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return
        if ('floatBall' in changes) {
          prefs.floatBall = changes.floatBall.newValue !== false
          if (!prefs.floatBall) hideBall()
        }
        if ('inputTrans' in changes) prefs.inputTrans = changes.inputTrans.newValue !== false
        if ('selMode' in changes && ['replace', 'below', 'popup'].includes(changes.selMode.newValue)) {
          prefs.selMode = changes.selMode.newValue
        }
        if ('panelPos' in changes) Object.assign(panelPos, changes.panelPos.newValue || {})
        if ('hoverMode' in changes) {
          prefs.hoverMode = !!changes.hoverMode.newValue
          hoverAbort()
          toast(prefs.hoverMode
            ? '狐译：悬停翻译已开启，鼠标停在段落上即可翻译（Alt+H 关闭）'
            : '狐译：悬停翻译已关闭', 'info', 2600)
        }
      })
    } catch (e) { /* 扩展上下文失效时静默 */ }
  }

  /** 目标元素是否属于狐译自己的界面（悬浮球/浮层/提示/下方译文块），自家 UI 不参与任何翻译逻辑。 */
  function isOwnUi (el) {
    if (!el || el.nodeType !== 1) return false
    for (let e = el; e; e = e.parentElement) {
      if (e.id && UI_IDS.includes(e.id)) return true
      if (e.hasAttribute && e.hasAttribute(UI_MARK)) return true
    }
    return false
  }

  // ---------------- 划词翻译（替换原文 / 原文下方 / 弹窗，三选一） ----------------

  async function translateSelection (fallbackText) {
    hideBall()
    const mode = prefs.selMode
    const segs = []
    let rect = null
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      for (let i = 0; i < sel.rangeCount; i++) collectRangeSegs(sel.getRangeAt(i), segs)
      rect = sel.getRangeAt(sel.rangeCount - 1).getBoundingClientRect()
    }
    if (!segs.length) {
      // 个别站点在右键瞬间清空了选区：拿不到落点没法原位替换，一律退化为弹窗展示译文
      const t = (fallbackText || '').trim()
      if (!t) return toast('狐译：没有找到可翻译的选中文字', 'warn', 2600)
      showSelPanel('正在翻译…', 'loading', rect)
      const r = await requestTranslate([t], 'selection')
      if (!r.ok) return showSelPanel('翻译失败：' + r.error, 'error', rect)
      return showSelPanel(r.translations[0], 'ok', rect, t)
    }

    if (mode === 'popup') showSelPanel('正在翻译…', 'loading', rect)
    else toast('狐译翻译中…', 'info', 0)
    const r = await requestTranslate(segs.map(s => s.core), 'selection')
    if (!r.ok) {
      return mode === 'popup'
        ? showSelPanel('翻译失败：' + r.error, 'error', rect)
        : toast('狐译失败：' + r.error, 'error', 5000)
    }

    if (mode === 'popup') {
      // 原文一个字都不动，译文只在浮层里看
      return showSelPanel(joinParts(r.translations), 'ok', rect, joinParts(segs.map(s => s.core)))
    }
    if (mode === 'below') {
      const n = withSuppressed(() => insertBelow(segs, r.translations))
      return toast(n ? '狐译：译文已插入原文下方（' + n + ' 处）' : '狐译：没有可插入译文的位置', n ? 'ok' : 'warn', 2200)
    }
    // 替换原文：同一文本节点上多个片段按 start 倒序替换，避免前面的替换挪动后面的偏移
    const order = segs.map((s, i) => i).sort((a, b) =>
      segs[a].node === segs[b].node ? segs[b].start - segs[a].start : 0)
    withSuppressed(() => {
      for (const i of order) applySeg(segs[i], r.translations[i])
    })
    toast('狐译：翻译完成（' + segs.length + ' 处）', 'ok', 1800)
  }

  /** 把一个选区拆成若干文本节点片段（跨 <b>/<a>/多段落的选区逐节点处理，保住页面结构）。 */
  function collectRangeSegs (range, out) {
    let root = range.commonAncestorContainer
    if (root.nodeType === Node.TEXT_NODE) root = root.parentNode
    if (!root) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let hit = false
      try { hit = range.intersectsNode(n) } catch (e) { hit = false }
      if (!hit || !isTranslatable(n)) continue
      const start = n === range.startContainer ? range.startOffset : 0
      const end = n === range.endContainer ? range.endOffset : n.nodeValue.length
      if (end <= start) continue
      pushSeg(out, n, start, end)
    }
  }

  /** 多个片段拼成一段可读文本：句子之间补空格，中文等无缝。 */
  function joinParts (parts) {
    let s = ''
    for (const p of parts) {
      const t = String(p == null ? '' : p)
      if (!t) continue
      if (s && needSpace(s[s.length - 1], t[0])) s += ' '
      s += t
    }
    return s
  }

  function needSpace (prev, next) {
    return /[A-Za-z0-9,.;:!?)\]]/.test(prev) && /[A-Za-z0-9(\[]/.test(next)
  }

  /**
   * 「译文放在原文下方」：按最近的块级祖先分组，每个块后面插一条译文。
   * 原文一个字不动，插入的块带 UI 标记，之后的整页扫描/划词都不会再碰它。
   */
  function insertBelow (segs, translations) {
    const groups = []
    for (let i = 0; i < segs.length; i++) {
      const block = nearestBlock(segs[i].node)
      const last = groups.length ? groups[groups.length - 1] : null
      if (last && last.block === block) last.parts.push(translations[i])
      else groups.push({ block, parts: [translations[i]] })
    }
    let n = 0
    for (const g of groups) {
      if (!g.block || !g.block.isConnected) continue
      const text = joinParts(g.parts).trim()
      if (!text) continue
      const div = document.createElement('div')
      div.setAttribute(UI_MARK, '1')
      div.setAttribute('data-lingyi-below', '1')
      div.textContent = text
      div.style.cssText = 'margin:6px 0;padding:6px 10px;border-left:3px solid #6366f1;' +
        'background:rgba(99,102,241,.07);border-radius:0 6px 6px 0;color:inherit;' +
        'font:inherit;line-height:1.7;white-space:pre-wrap;word-break:break-word'
      // td/li 之类不能有兄弟块，把译文放进它内部末尾；body 同理（afterend 会被浏览器挪走）
      const tag = String(g.block.tagName || '').toUpperCase()
      if (INSIDE_TAGS.has(tag) || g.block === document.body || g.block === document.documentElement) {
        g.block.appendChild(div)
      } else {
        g.block.insertAdjacentElement('afterend', div)
      }
      if (pageView === 'source') div.style.display = 'none'
      insertedEls.push(div)
      n++
    }
    return n
  }

  const INSIDE_TAGS = new Set(['TD', 'TH', 'LI', 'DT', 'DD', 'CAPTION', 'FIGCAPTION', 'SUMMARY'])

  /** 从文本节点向上找第一个块级元素，作为插入译文的落点。 */
  function nearestBlock (node) {
    for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
      let d = ''
      try { d = window.getComputedStyle(el).display } catch (e) { d = '' }
      if (d && d !== 'inline' && d !== 'contents' && d !== 'none') return el
    }
    return node.parentElement
  }

  // ---------------- 悬浮球（选中文字后就近弹出，点击即翻） ----------------

  let ballEl = null

  function initBall () {
    document.addEventListener('mouseup', e => {
      if (!prefs.floatBall || isOwnUi(e.target)) return
      setTimeout(maybeShowBall, 30) // 等浏览器把选区定稿再读
    }, true)
    document.addEventListener('mousedown', e => {
      if (!isOwnUi(e.target)) hideBall()
    }, true)
    document.addEventListener('scroll', () => hideBall(), true)
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') hideBall()
    }, true)
  }

  function maybeShowBall () {
    if (!prefs.floatBall) return
    const ae = document.activeElement
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return // 输入框用三下空格翻译
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
    if (!/\p{L}/u.test(String(sel))) return // 纯数字/符号不值得弹球
    const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)
    if (anchorEl && (anchorEl.isContentEditable || isOwnUi(anchorEl))) return
    const rect = sel.getRangeAt(sel.rangeCount - 1).getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) return
    showBall(rect)
  }

  function showBall (rect) {
    if (!ballEl || !ballEl.isConnected) {
      ballEl = document.createElement('div')
      ballEl.id = BALL_ID
      ballEl.setAttribute(UI_MARK, '1')
      ballEl.textContent = '译'
      ballEl.title = '狐译：翻译选中文字'
      ballEl.style.cssText = 'position:fixed;z-index:2147483647;width:28px;height:28px;border-radius:50%;' +
        'background:linear-gradient(135deg,#60a5fa,#6366f1);color:#fff;font:600 13px/28px system-ui,"Microsoft YaHei",sans-serif;' +
        'text-align:center;cursor:pointer;box-shadow:0 3px 12px rgba(59,73,223,.45);user-select:none;' +
        'transition:transform .12s ease'
      ballEl.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation() }) // 别把选区点没了
      ballEl.addEventListener('mouseenter', () => { ballEl.style.transform = 'scale(1.15)' })
      ballEl.addEventListener('mouseleave', () => { ballEl.style.transform = 'scale(1)' })
      ballEl.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation()
        translateSelection('')
      })
      ;(document.body || document.documentElement).appendChild(ballEl)
    }
    // 默认贴在选区尾部右下方，越界就往回收
    const left = Math.max(8, Math.min(rect.right + 6, window.innerWidth - 40))
    const top = rect.bottom + 8 <= window.innerHeight - 40
      ? rect.bottom + 8
      : Math.max(8, rect.top - 36)
    ballEl.style.left = left + 'px'
    ballEl.style.top = top + 'px'
    ballEl.style.display = 'block'
  }

  function hideBall () {
    if (ballEl && ballEl.isConnected) ballEl.style.display = 'none'
  }

  // ---------------- 输入框翻译（连按三下空格，把已输入内容翻成目标语言） ----------------

  let spaceRun = 0
  let spaceField = null
  let inputBusy = false

  function initInputTranslate () {
    document.addEventListener('keydown', e => {
      const el = e.target
      if (!prefs.inputTrans || !isEditableField(el)) { spaceRun = 0; spaceField = null; return }
      if (el !== spaceField) { spaceRun = 0; spaceField = el } // 换了个框重新计数
      const isSpace = e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space'
      if (!isSpace || e.ctrlKey || e.altKey || e.metaKey) { spaceRun = 0; return }
      spaceRun++
      if (spaceRun < INPUT_TRIGGER_SPACES) return
      spaceRun = 0
      e.preventDefault() // 第三下空格不打进输入框
      e.stopPropagation()
      translateField(el)
    }, true)
    document.addEventListener('mousedown', () => { spaceRun = 0 }, true)
  }

  function isEditableField (el) {
    if (!el || el.nodeType !== 1 || isOwnUi(el)) return false
    const tag = String(el.tagName || '').toUpperCase()
    if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled
    if (tag === 'INPUT') {
      return !el.readOnly && !el.disabled && INPUT_TYPES.has(String(el.type || 'text').toLowerCase())
    }
    return !!el.isContentEditable
  }

  async function translateField (el) {
    if (inputBusy) return
    // 去掉前两下已经敲进去的空格
    const text = readField(el).replace(/\s+$/, '')
    if (!text.trim()) return toast('狐译：输入框还是空的，打完字再连按三下空格', 'warn', 2600)
    if (!/\p{L}/u.test(text)) return toast('狐译：这段内容没有可翻译的文字', 'warn', 2600)
    if (text.length > INPUT_MAX_CHARS) {
      return toast('狐译：输入内容过长（' + text.length + ' 字，上限 ' + INPUT_MAX_CHARS + '）', 'warn', 3200)
    }
    inputBusy = true
    const prevOutline = el.style.outline
    el.style.outline = '2px solid rgba(99,102,241,.75)'
    toast('狐译：正在翻译输入框内容…', 'info', 0)
    try {
      const r = await requestTranslate([text], 'input')
      if (!r.ok) return toast('狐译失败：' + r.error, 'error', 5000)
      const out = r.translations[0]
      if (typeof out !== 'string' || !out.trim()) return toast('狐译：没有拿到译文', 'warn', 2600)
      writeField(el, out)
      toast('狐译：输入内容已翻译', 'ok', 1800)
    } finally {
      el.style.outline = prevOutline
      inputBusy = false
    }
  }

  function readField (el) {
    return el.isContentEditable ? (el.innerText || '') : String(el.value == null ? '' : el.value)
  }

  /**
   * 回填译文。input/textarea 走原型上的原生 setter + input 事件——
   * 直接赋 value 的话 React/Vue 这类受控组件收不到通知，下一次渲染就把译文冲掉了。
   */
  function writeField (el, text) {
    if (el.isContentEditable) {
      el.focus()
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
      let ok = false
      try { ok = document.execCommand('insertText', false, text) } catch (e) { ok = false }
      if (!ok) el.textContent = text
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
      return
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (desc && desc.set) desc.set.call(el, text)
    else el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    try { el.setSelectionRange(text.length, text.length) } catch (e) { /* email/url 类型不支持 */ }
  }

  // ---------------- 悬停翻译（鼠标停在段落上约半秒自动翻译该段） ----------------

  let hoverTimer = null
  let hoverBlock = null

  function initHover () {
    document.addEventListener('mousemove', e => {
      if (!prefs.hoverMode || pageBusy) return
      const t = e.target
      if (!t || t.nodeType !== 1) return
      const block = findHoverBlock(t)
      if (block === hoverBlock) return // 同块内移动不重置计时
      hoverAbort()
      if (!block) return
      hoverBlock = block
      hoverTimer = setTimeout(() => { translateHoverBlock(block) }, HOVER_DWELL_MS)
    }, true)
    document.addEventListener('mouseleave', () => hoverAbort(), true)
  }

  function hoverAbort () {
    if (hoverTimer) clearTimeout(hoverTimer)
    hoverTimer = null
    hoverBlock = null
  }

  /** 从鼠标落点找可翻译的文本块：先认常见块级标签，退而找带直属文字的最近祖先。 */
  function findHoverBlock (target) {
    if (isOwnUi(target)) return null
    let el = target.closest ? target.closest(HOVER_BLOCK_SELECTOR) : null
    if (!el) {
      // <div>裸文字</div> 之类：向上最多 4 层找第一个有直属文字的元素
      for (let e = target, hops = 0; e && e !== document.body && hops < 4; e = e.parentElement, hops++) {
        if (hasDirectText(e)) { el = e; break }
      }
    }
    if (!el || el === document.body || el === document.documentElement) return null
    if (hoverDone.has(el)) return null
    const text = el.textContent || ''
    if (!/\p{L}/u.test(text) || text.length > HOVER_MAX_CHARS) return null
    // 块自身或祖先命中跳过名单（代码块/编辑器等）就不碰
    for (let e = el; e; e = e.parentElement) {
      if (e.isContentEditable) return null
      const tag = e.tagName ? String(e.tagName).toUpperCase() : ''
      if (SKIP_TAGS.has(tag)) return null
    }
    return el
  }

  function hasDirectText (el) {
    for (const c of el.childNodes) {
      if (c.nodeType === Node.TEXT_NODE && /\p{L}/u.test(c.nodeValue)) return true
    }
    return false
  }

  async function translateHoverBlock (block) {
    if (!prefs.hoverMode || hoverDone.has(block) || !block.isConnected) return
    const segs = []
    const cached = []
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!isTranslatable(n)) continue
      if (isAlreadyTranslated(n)) cached.push(n) // 翻过的直接用本地缓存，不再送大模型
      else pushSeg(segs, n, 0, n.nodeValue.length)
    }
    if (cached.length) {
      withSuppressed(() => {
        for (const n of cached) {
          const st = nodeState.get(n)
          if (st && n.nodeValue !== st.trans) n.nodeValue = st.trans
        }
      })
    }
    if (!segs.length) { hoverDone.add(block); return }
    hoverDone.add(block) // 先占坑：网络往返期间再悬停不重复发
    const prevOutline = block.style.outline
    const prevOffset = block.style.outlineOffset
    block.style.outline = '1px dashed rgba(99,102,241,.75)'
    block.style.outlineOffset = '2px'
    try {
      const r = await requestTranslate(segs.map(s => s.core), 'hover')
      if (!r.ok) {
        hoverDone.delete(block) // 失败让路，之后还能再试
        return toast('狐译失败：' + r.error, 'error', 4000)
      }
      withSuppressed(() => {
        for (let i = 0; i < segs.length; i++) applySeg(segs[i], r.translations[i])
      })
    } finally {
      block.style.outline = prevOutline
      block.style.outlineOffset = prevOffset
    }
  }

  // ---------------- 可拖动浮层（图片翻译 / 划词弹窗共用，位置记忆到 storage） ----------------

  /**
   * 建（或取回）一个浮层。标题栏可拖动，拖完的位置按 panelId 存进 chrome.storage，
   * 下次打开直接沿用——图片翻译最烦的就是每次弹在图上还得重新拖。
   */
  function ensurePanel (id, titleText) {
    let panel = document.getElementById(id)
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = id
    panel.setAttribute(UI_MARK, '1')
    panel.style.cssText = 'position:fixed;z-index:2147483647;max-width:440px;min-width:240px;' +
      'background:#fff;color:#1f2937;border:1px solid #dbe1ea;border-radius:12px;' +
      'box-shadow:0 10px 36px rgba(15,23,42,.28);font:13px/1.7 system-ui,"Microsoft YaHei",sans-serif;' +
      'overflow:hidden'
    const head = document.createElement('div')
    head.className = 'lingyi-p-head'
    head.title = '按住拖动，位置会被记住'
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:move;' +
      'background:linear-gradient(135deg,#60a5fa,#6366f1);color:#fff;font-weight:600;font-size:13px;user-select:none'
    const title = document.createElement('span')
    title.textContent = titleText
    title.style.cssText = 'flex:1 1 auto;pointer-events:none'
    const toggle = document.createElement('span')
    toggle.className = 'lingyi-p-toggle'
    toggle.dataset.noDrag = '1'
    toggle.textContent = '看原文'
    toggle.style.cssText = 'cursor:pointer;font-size:11.5px;font-weight:400;opacity:.9;' +
      'border:1px solid rgba(255,255,255,.55);border-radius:5px;padding:1px 6px;user-select:none'
    const close = document.createElement('span')
    close.dataset.noDrag = '1'
    close.textContent = '×'
    close.title = '关闭'
    close.style.cssText = 'cursor:pointer;font-size:18px;line-height:1;padding:0 2px;user-select:none'
    close.addEventListener('click', () => panel.remove())
    head.appendChild(title)
    head.appendChild(toggle)
    head.appendChild(close)
    const body = document.createElement('div')
    body.className = 'lingyi-p-body'
    body.style.cssText = 'padding:10px 12px;max-height:46vh;overflow:auto;white-space:pre-wrap;' +
      'word-break:break-word;user-select:text;cursor:text'
    toggle.addEventListener('click', () => {
      const st = panel.__lingyi
      if (!st || !st.ocr) return
      st.showingOcr = !st.showingOcr
      body.textContent = st.showingOcr ? st.ocr : st.main
      toggle.textContent = st.showingOcr ? '看译文' : '看原文'
    })
    const foot = document.createElement('div')
    foot.className = 'lingyi-p-foot'
    foot.style.cssText = 'display:none;flex-wrap:wrap;gap:8px;padding:8px 12px;border-top:1px solid #eef1f6'
    panel.appendChild(head)
    panel.appendChild(body)
    panel.appendChild(foot)
    ;(document.body || document.documentElement).appendChild(panel)
    makeDraggable(panel, head)
    return panel
  }

  function makeDraggable (panel, handle) {
    let sx = 0
    let sy = 0
    let ox = 0
    let oy = 0
    let dragging = false
    const onMove = e => {
      if (!dragging) return
      e.preventDefault()
      moveTo(panel, ox + e.clientX - sx, oy + e.clientY - sy)
    }
    const onUp = () => {
      if (!dragging) return
      dragging = false
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      savePanelPos(panel.id, parseFloat(panel.style.left) || 0, parseFloat(panel.style.top) || 0)
    }
    handle.addEventListener('mousedown', e => {
      if (e.button !== 0) return
      if (e.target && e.target.dataset && e.target.dataset.noDrag) return // 关闭/切换按钮不当拖柄
      const rect = panel.getBoundingClientRect()
      sx = e.clientX
      sy = e.clientY
      ox = rect.left
      oy = rect.top
      dragging = true
      moveTo(panel, rect.left, rect.top) // 先把 transform 居中落成实际坐标，拖起来才不跳
      e.preventDefault()
      e.stopPropagation()
      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('mouseup', onUp, true)
    }, true)
  }

  function moveTo (panel, left, top) {
    const w = panel.offsetWidth || 320
    const h = panel.offsetHeight || 160
    panel.style.transform = 'none'
    panel.style.left = Math.max(4, Math.min(left, window.innerWidth - w - 4)) + 'px'
    panel.style.top = Math.max(4, Math.min(top, window.innerHeight - h - 4)) + 'px'
  }

  function savePanelPos (id, left, top) {
    panelPos[id] = { left, top }
    try { chrome.storage.local.set({ panelPos }) } catch (e) { /* 上下文失效时只在本页生效 */ }
  }

  function resetPanelPos (panel, anchorRect) {
    delete panelPos[panel.id]
    try { chrome.storage.local.set({ panelPos }) } catch (e) { /* 同上 */ }
    placePanel(panel, anchorRect, true)
  }

  /**
   * 摆放浮层：记过位置就用记的；否则挨着锚点（图片/选区）放——右、左、下、上依次找空位，
   * 实在没空位才贴右上角。核心诉求是别糊在原图上。
   */
  function placePanel (panel, anchorRect, force) {
    if (!force && panel.__lingyiPlaced) return
    panel.__lingyiPlaced = true
    const saved = panelPos[panel.id]
    const w = panel.offsetWidth || 320
    const h = panel.offsetHeight || 160
    if (saved) return moveTo(panel, saved.left, saved.top)
    const r = anchorRect
    if (!r || (!r.width && !r.height) || r.bottom < 0 || r.top > window.innerHeight) {
      return moveTo(panel, (window.innerWidth - w) / 2, 18)
    }
    if (window.innerWidth - r.right >= w + 16) return moveTo(panel, r.right + 12, r.top)
    if (r.left >= w + 16) return moveTo(panel, r.left - w - 12, r.top)
    if (window.innerHeight - r.bottom >= h + 16) return moveTo(panel, r.left, r.bottom + 12)
    if (r.top >= h + 16) return moveTo(panel, r.left, r.top - h - 12)
    moveTo(panel, window.innerWidth - w - 12, 12)
  }

  /** 往浮层里填内容：正文、可切换的第二份文本（OCR 原文/划词原文）、底部操作按钮。 */
  function renderPanel (panel, opts) {
    const body = panel.querySelector('.lingyi-p-body')
    const toggle = panel.querySelector('.lingyi-p-toggle')
    const foot = panel.querySelector('.lingyi-p-foot')
    const kind = opts.kind || 'ok'
    panel.__lingyi = { main: opts.text, ocr: (kind === 'ok' && opts.secondary) || '', showingOcr: false }
    body.textContent = opts.text
    body.style.color = kind === 'error' ? '#b91c1c' : (kind === 'loading' ? '#64748b' : '#1f2937')
    toggle.style.display = panel.__lingyi.ocr ? 'inline' : 'none'
    toggle.textContent = '看原文'
    foot.textContent = ''
    const actions = (opts.actions || []).slice()
    if (kind === 'ok' && opts.text) {
      actions.push({ label: '复制译文', onClick: () => copyToClipboard(panel.__lingyi.main) })
    }
    actions.push({ label: '重置位置', onClick: () => resetPanelPos(panel, opts.anchorRect) })
    foot.style.display = 'flex'
    for (const a of actions) {
      const btn = document.createElement('span')
      btn.textContent = a.label
      btn.style.cssText = 'cursor:pointer;font-size:12px;color:#4c66d6;border:1px solid #cdd8f5;' +
        'border-radius:6px;padding:2px 10px;user-select:none;background:#f5f8ff'
      btn.addEventListener('click', a.onClick)
      foot.appendChild(btn)
    }
  }

  async function copyToClipboard (text) {
    try {
      await navigator.clipboard.writeText(text)
      toast('狐译：译文已复制', 'ok', 1400)
    } catch (e) {
      toast('狐译：复制失败，请手动选中复制', 'warn', 2400)
    }
  }

  /** 划词弹窗：原文一个字不动，译文只在这个可拖动浮层里看。 */
  function showSelPanel (text, kind, anchorRect, sourceText) {
    const panel = ensurePanel(SEL_PANEL_ID, '狐译 · 划词翻译')
    renderPanel(panel, { text, kind, secondary: sourceText || '', anchorRect })
    placePanel(panel, anchorRect, panel.__lingyiAnchorKey !== anchorKey(anchorRect))
    panel.__lingyiAnchorKey = anchorKey(anchorRect)
  }

  function anchorKey (rect) {
    return rect ? Math.round(rect.left) + ',' + Math.round(rect.top) : 'none'
  }

  // ---------------- 图片翻译（右键图片 → 本地OCR+翻译 → 译文绘回图片原位） ----------------

  async function translateImage (srcUrl) {
    if (!srcUrl) return showImagePanel(null, '没有拿到图片地址', 'error')
    const img = findImage(srcUrl)
    showImagePanel(img, '正在翻译图片，请稍候…', 'loading')
    let req
    if (/^blob:/i.test(srcUrl)) {
      // blob: 是页面私有地址，后台拿不到，这里读成 base64 再传
      try {
        const resp = await fetch(srcUrl)
        const blob = await resp.blob()
        if (blob.size > MAX_IMAGE_BYTES) {
          return showImagePanel(img, '图片过大（' + Math.round(blob.size / 1024 / 1024) + 'MB，上限 8MB）', 'error')
        }
        req = { type: 'LINGYI_TRANSLATE_IMAGE_DATA', dataBase64: await blobToBase64(blob), mime: blob.type || 'image/png' }
      } catch (e) {
        return showImagePanel(img, '无法读取这张图片：' + ((e && e.message) || e), 'error')
      }
    } else {
      req = { type: 'LINGYI_TRANSLATE_IMAGE_DATA', srcUrl }
    }
    const r = await requestBackend(req)
    if (!r.ok) return showImagePanel(img, '翻译失败：' + r.error, 'error')

    // 有行级坐标且能找到页面上的 <img> → 把译文直接绘回图片原位
    const boxedLines = (r.lines || []).filter(ln => ln && ln.box && ln.box.length === 4)
    if (img && r.imageDataUrl && boxedLines.length) {
      try {
        const drawn = await paintTranslationOntoImage(img, r.imageDataUrl, r.lines)
        return showImagePanel(img, '已把译文写回图片（' + drawn + ' 处）。', 'ok', r.ocrText, {
          full: r.translation,
          actions: [{ label: '恢复原图', onClick: () => { restoreImage(img); removeImagePanel() } }]
        })
      } catch (e) {
        // 画布失败（内存不足等）退回浮层文本，不让功能挂掉
      }
    }
    showImagePanel(img, r.translation, 'ok', r.ocrText)
  }

  /**
   * 把逐行译文绘回图片原位：以后台回传的 dataURL 建同源画布（不受跨域污染），
   * 每行先用周边采样的底色盖住原文，再在原包围盒内写译文（超宽自动缩字号/横向压缩）。
   * 返回实际绘制的行数。
   */
  async function paintTranslationOntoImage (imgEl, dataUrl, lines) {
    const src = await loadImg(dataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = src.naturalWidth || src.width
    canvas.height = src.naturalHeight || src.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(src, 0, 0)
    let drawn = 0
    for (const ln of lines) {
      if (!ln || !ln.box || ln.box.length !== 4) continue
      const t = String(ln.translation || '').trim()
      if (!t) continue
      drawLineOnCanvas(ctx, ln.box, t)
      drawn++
    }
    if (!drawn) throw new Error('没有可绘制的行')
    if (!imgEl.dataset.lingyiOrigSrc) {
      imgEl.dataset.lingyiOrigSrc = imgEl.src || ''
      imgEl.dataset.lingyiOrigSrcset = imgEl.srcset || ''
    }
    imgEl.srcset = '' // 防浏览器按 srcset 换回原图
    imgEl.src = canvas.toDataURL('image/png')
    return drawn
  }

  function restoreImage (imgEl) {
    if (!imgEl || !imgEl.dataset.lingyiOrigSrc) return
    imgEl.src = imgEl.dataset.lingyiOrigSrc
    if (imgEl.dataset.lingyiOrigSrcset) imgEl.srcset = imgEl.dataset.lingyiOrigSrcset
    delete imgEl.dataset.lingyiOrigSrc
    delete imgEl.dataset.lingyiOrigSrcset
  }

  function loadImg (url) {
    return new Promise((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error('图片解码失败'))
      im.src = url
    })
  }

  /** 单行回填：底色取行框上下外沿像素均值（避开文字本身），文字黑白按底色亮度定。 */
  function drawLineOnCanvas (ctx, box, text) {
    const x = box[0]; const y = box[1]; const w = Math.max(2, box[2]); const h = Math.max(4, box[3])
    const bg = sampleBackground(ctx, x, y, w, h)
    const pad = Math.max(1.5, h * 0.10)
    ctx.fillStyle = bg.css
    roundRectPath(ctx, x - pad, y - pad, w + pad * 2, h + pad * 2, Math.min(4, h * 0.2))
    ctx.fill()
    ctx.fillStyle = bg.luma > 150 ? '#111111' : '#ffffff'
    ctx.textBaseline = 'middle'
    let size = h * 0.85
    for (; size > 6; size *= 0.92) {
      ctx.font = size + 'px "Microsoft YaHei","PingFang SC",sans-serif'
      if (ctx.measureText(text).width <= w) break
    }
    ctx.font = size + 'px "Microsoft YaHei","PingFang SC",sans-serif'
    const tw = ctx.measureText(text).width
    if (tw > w) {
      // 最小字号仍超宽：横向压扁塞进原框（可读性优先于字形比例）
      ctx.save()
      ctx.translate(x, y + h / 2)
      ctx.scale(w / tw, 1)
      ctx.fillText(text, 0, 0)
      ctx.restore()
    } else {
      ctx.fillText(text, x, y + h / 2)
    }
  }

  /** 采样行框上外沿 + 下外沿两条像素带的均值当底色；越界/异常回退白色。 */
  function sampleBackground (ctx, x, y, w, h) {
    let r = 255; let g = 255; let b = 255
    try {
      const cw = ctx.canvas.width; const ch = ctx.canvas.height
      const sx = Math.max(0, Math.min(cw - 1, Math.round(x)))
      const sw = Math.max(1, Math.min(Math.round(w), cw - sx))
      let rr = 0; let gg = 0; let bb = 0; let n = 0
      for (const sy of [Math.round(y) - 3, Math.round(y + h) + 3]) {
        if (sy < 0 || sy >= ch) continue
        const data = ctx.getImageData(sx, sy, sw, 1).data
        for (let i = 0; i < data.length; i += 4) {
          rr += data[i]; gg += data[i + 1]; bb += data[i + 2]; n++
        }
      }
      if (n) { r = rr / n; g = gg / n; b = bb / n }
    } catch (e) { /* 保底白色 */ }
    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    return { css: 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')', luma }
  }

  function roundRectPath (ctx, x, y, w, h, r) {
    const rad = Math.max(0, Math.min(r, w / 2, h / 2))
    ctx.beginPath()
    ctx.moveTo(x + rad, y)
    ctx.arcTo(x + w, y, x + w, y + h, rad)
    ctx.arcTo(x + w, y + h, x, y + h, rad)
    ctx.arcTo(x, y + h, x, y, rad)
    ctx.arcTo(x, y, x + w, y, rad)
    ctx.closePath()
  }

  function removeImagePanel () {
    const panel = document.getElementById(PANEL_ID)
    if (panel) panel.remove()
  }

  function findImage (srcUrl) {
    for (const im of document.images) {
      if (im.currentSrc === srcUrl || im.src === srcUrl) return im
    }
    return null
  }

  function blobToBase64 (blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''))
      fr.onerror = () => reject(new Error('读取图片数据失败'))
      fr.readAsDataURL(blob)
    })
  }

  /**
   * 图片译文浮层：默认放在图片<b>旁边</b>（右→左→下→上找空位）而不是盖在图上；
   * 可拖动，拖过之后位置被记住，之后所有图片都用记住的位置。
   */
  function showImagePanel (imgEl, text, kind, ocrText, opts) {
    const panel = ensurePanel(PANEL_ID, '狐译 · 图片翻译')
    const rect = imgEl && imgEl.isConnected ? imgEl.getBoundingClientRect() : null
    const actions = (opts && opts.actions ? opts.actions.slice() : [])
    const full = (opts && opts.full) || ''
    if (full) {
      actions.push({
        label: '查看译文文本',
        onClick: () => {
          panel.__lingyi.main = full
          panel.__lingyi.showingOcr = false
          panel.querySelector('.lingyi-p-body').textContent = full
          panel.querySelector('.lingyi-p-toggle').textContent = '看原文'
        }
      })
    }
    renderPanel(panel, { text, kind, secondary: ocrText || '', anchorRect: rect, actions })
    // 换了张图（锚点变了）就重新就近摆放；同一张图的 loading→结果 保持用户拖到的位置
    const key = imgEl ? (imgEl.currentSrc || imgEl.src || anchorKey(rect)) : 'none'
    placePanel(panel, rect, panel.__lingyiAnchorKey !== key)
    panel.__lingyiAnchorKey = key
  }

  // ---------------- 整页翻译（增量：已翻跳过，动态内容追译） ----------------

  async function translatePage (opts) {
    const incremental = !!(opts && opts.incremental)
    if (pageBusy) {
      if (incremental) scheduleScan() // 忙的时候排到下一轮，别丢掉这批新内容
      else toast('狐译：整页翻译进行中…', 'info', 2000)
      return
    }
    pageBusy = true
    try {
      pruneState()
      const { segs, truncated } = collectPageSegs()
      if (!segs.length) {
        if (incremental) {
          idleScans++ // 页面在动但没有新文字（时钟、动画…）：逐步拉长下次扫描间隔
          return
        }
        pageView = 'target'
        pageTranslated = true
        startObserver()
        pageToast(nodeState.size
          ? '狐译：本页内容都已翻译过，没有新增内容（Alt+R 可切回原文）'
          : '狐译：页面没有可翻译的文本', 'info', 2600)
        return
      }
      idleScans = 0
      // 相同文案只翻一次（导航、按钮、表格里大量重复短语），译文回填到所有位置
      const uniq = new Map()
      for (const s of segs) {
        let u = uniq.get(s.core)
        if (!u) { u = { core: s.core, segs: [] }; uniq.set(s.core, u) }
        u.segs.push(s)
      }
      const chunks = buildChunks([...uniq.values()])
      let done = 0
      if (!incremental) pageToast('狐译：整页翻译中 0/' + chunks.length + '…', 'info', 0)
      let aborted = null
      await runPool(chunks, CONCURRENCY, async chunk => {
        if (aborted) return
        // 整页翻译只让首次翻译的第一块写历史；增量追译一律不写（否则一页会刷出几十条记录）
        const kind = !incremental && chunk === chunks[0] ? 'page' : null
        const r = await requestTranslate(chunk.map(it => it.core), kind)
        if (!r.ok) { aborted = r.error; return }
        withSuppressed(() => {
          chunk.forEach((it, i) => {
            for (const seg of it.segs) applySeg(seg, r.translations[i])
          })
        })
        done++
        if (!incremental) pageToast('狐译：整页翻译中 ' + done + '/' + chunks.length + '…', 'info', 0)
      })
      pageView = 'target'
      pageTranslated = true
      startObserver()
      if (aborted) return pageToast('狐译失败：' + aborted, 'error', 5000)
      if (incremental) {
        pageToast('狐译：已追译新加载的 ' + segs.length + ' 处内容', 'ok', 1800)
      } else {
        pageToast('狐译：整页翻译完成' + (truncated ? '（页面过长，超出 ' + MAX_PAGE_CHARS + ' 字部分保留原文）' : '') +
          '，Alt+R 可在原文/译文间切换', 'ok', 3200)
      }
    } catch (e) {
      pageToast('狐译失败：' + ((e && e.message) || e), 'error', 5000)
    } finally {
      pageBusy = false
    }
  }

  /** 只收「还没翻过」的文本节点：已翻的在 nodeState 里，直接跳过，不再送大模型。 */
  function collectPageSegs () {
    const segs = []
    let truncated = false
    if (!document.body) return { segs, truncated }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!isTranslatable(n) || isAlreadyTranslated(n)) continue
      const seg = pushSeg(segs, n, 0, n.nodeValue.length)
      if (!seg) continue
      pageChars += seg.core.length
      if (pageChars > MAX_PAGE_CHARS) {
        segs.pop()
        pageChars -= seg.core.length
        truncated = true
        break
      }
    }
    return { segs, truncated }
  }

  /**
   * 这个文本节点是否已经翻过。
   * 当前文字既不是我们写进去的译文、也不是记下的原文 → 说明页面把这个节点的内容换掉了
   * （虚拟 DOM 复用节点很常见），当成新内容重新翻。
   */
  function isAlreadyTranslated (n) {
    const st = nodeState.get(n)
    if (!st) return false
    if (n.nodeValue !== st.trans && n.nodeValue !== st.orig) {
      nodeState.delete(n)
      return false
    }
    return true
  }

  /** 清掉已经脱离文档的节点/插入块，避免长时间停留的单页应用越攒越多。 */
  function pruneState () {
    for (const node of Array.from(nodeState.keys())) {
      if (!node.isConnected) nodeState.delete(node)
    }
    for (let i = insertedEls.length - 1; i >= 0; i--) {
      if (!insertedEls[i].isConnected) insertedEls.splice(i, 1)
    }
  }

  /** 贪心分批：单批 ≤CHUNK_MAX_CHARS 字符且 ≤CHUNK_MAX_ITEMS 段（超长单段独占一批）。 */
  function buildChunks (items) {
    const chunks = []
    let cur = []
    let curChars = 0
    for (const it of items) {
      if (cur.length && (curChars + it.core.length > CHUNK_MAX_CHARS || cur.length >= CHUNK_MAX_ITEMS)) {
        chunks.push(cur); cur = []; curChars = 0
      }
      cur.push(it); curChars += it.core.length
    }
    if (cur.length) chunks.push(cur)
    return chunks
  }

  async function runPool (items, limit, worker) {
    let idx = 0
    const lanes = []
    for (let k = 0; k < Math.min(limit, items.length); k++) {
      lanes.push((async () => {
        while (idx < items.length) {
          const i = idx++
          await worker(items[i])
        }
      })())
    }
    await Promise.all(lanes)
  }

  // ---------------- 动态内容追译（MutationObserver + 防抖） ----------------

  let observer = null
  let scanTimer = null
  let suppress = 0
  /** 连续几轮扫描没发现新文字（页面只是动画/时钟在动），用来指数拉长扫描间隔 */
  let idleScans = 0

  /** 自己改 DOM 期间挂起观察，改完把攒下的记录丢掉，免得自己触发自己。 */
  function withSuppressed (fn) {
    suppress++
    try {
      return fn()
    } finally {
      if (observer) observer.takeRecords()
      suppress--
    }
  }

  function startObserver () {
    if (observer || !document.body) return
    observer = new MutationObserver(muts => {
      if (suppress > 0 || pageView !== 'target' || !pageTranslated) return
      for (const m of muts) {
        const t = m.target
        if (isOwnUi(t && t.nodeType === 1 ? t : t && t.parentElement)) continue
        if (m.type === 'characterData' || (m.addedNodes && m.addedNodes.length)) {
          scheduleScan()
          return
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  function scheduleScan () {
    if (scanTimer) clearTimeout(scanTimer)
    // 空转越多退得越远（1.2s → 3s → 7.5s → 18.75s，封顶 20s），避免高频动画页面被反复扫描
    const delay = Math.min(DYNAMIC_DEBOUNCE_MS * Math.pow(2.5, idleScans), MAX_SCAN_DELAY_MS)
    scanTimer = setTimeout(() => {
      scanTimer = null
      translatePage({ incremental: true })
    }, delay)
  }

  // ---------------- 原文 / 译文切换（译文本地缓存，切换零调用） ----------------

  /** 把所有登记过的节点切到某个视图；返回实际改动的处数。 */
  function applyView (view) {
    let n = 0
    withSuppressed(() => {
      for (const [node, st] of nodeState) {
        if (!node.isConnected) continue
        const v = view === 'source' ? st.orig : st.trans
        if (node.nodeValue !== v) {
          node.nodeValue = v
          n++
        }
      }
      for (const el of insertedEls) {
        if (el.isConnected) el.style.display = view === 'source' ? 'none' : ''
      }
    })
    pageView = view
    return n
  }

  function hasTranslation () {
    return nodeState.size > 0 || insertedEls.length > 0
  }

  function showSource () {
    if (!hasTranslation()) return pageToast('狐译：本页没有已翻译的内容', 'info', 2200)
    const n = applyView('source')
    pageToast('狐译：已显示原文（' + n + ' 处），Alt+R 切回译文（不会重新翻译）', 'info', 2600)
  }

  function showTarget () {
    if (!hasTranslation()) {
      return pageToast('狐译：本页还没有译文，按 Alt+P 或右键「翻译整个网页」', 'warn', 2800)
    }
    const n = applyView('target')
    pageToast('狐译：已显示译文（' + n + ' 处），用的是本地缓存，没有再调用大模型', 'ok', 2600)
    if (pageTranslated) scheduleScan() // 顺手把看原文期间新加载的内容补上
  }

  function togglePageView () {
    if (!hasTranslation()) return pageToast('狐译：本页还没有译文，按 Alt+P 先翻译整页', 'warn', 2800)
    if (pageView === 'target') showSource()
    else showTarget()
  }

  // ---------------- 公共：片段构造 / 替换 / 过滤 ----------------

  /** 切出片段并剥离首尾空白（保住行内排版的空格），无实义文字返回 null。 */
  function pushSeg (out, node, start, end) {
    const text = node.nodeValue.slice(start, end)
    const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/)
    const core = m[2]
    if (!core || !/\p{L}/u.test(core)) return null // 纯空白/数字/符号不送翻
    const seg = { node, start, end, lead: m[1], trail: m[3], core }
    out.push(seg)
    return seg
  }

  /** 写入译文并登记状态：orig 留着切回原文，trans 留着切回译文，两者都在=已翻译标记。 */
  function applySeg (seg, translated) {
    const node = seg.node
    if (!node.isConnected || typeof translated !== 'string') return
    let st = nodeState.get(node)
    if (!st) {
      st = { orig: node.nodeValue, trans: node.nodeValue }
      nodeState.set(node, st)
    }
    const v = node.nodeValue
    node.nodeValue = v.slice(0, seg.start) + seg.lead + translated + seg.trail + v.slice(seg.end)
    st.trans = node.nodeValue
    const p = node.parentElement
    if (p && p.setAttribute) p.setAttribute(DONE_MARK, '1')
  }

  function isTranslatable (n) {
    const p = n.parentElement
    if (!p || p.isContentEditable) return false // 编辑区内容不动
    for (let el = p; el; el = el.parentElement) {
      if (el.id && UI_IDS.includes(el.id)) return false // 自家悬浮球/浮层/提示不翻
      if (el.hasAttribute && el.hasAttribute(UI_MARK)) return false // 自家插入的下方译文块不翻
      const tag = el.tagName ? String(el.tagName).toUpperCase() : ''
      if (SKIP_TAGS.has(tag)) return false
    }
    return true
  }

  // ---------------- 与后台通讯（MV3 后台会休眠，消息要能重试） ----------------

  function sleep (ms) {
    return new Promise(r => setTimeout(r, ms))
  }

  function extAlive () {
    try { return !!(chrome.runtime && chrome.runtime.id) } catch (e) { return false }
  }

  /**
   * 给后台发消息。MV3 的 Service Worker 空闲几十秒就被回收，回收后的第一条消息
   * 偶发拿不到应答（"Could not establish connection"），退避重试一两次就能把它唤醒——
   * 这正是「客户端重启后必须刷新页面」的元凶，重试掉它之后已打开的页面不用再刷新。
   */
  async function sendWithRetry (msg) {
    let last = null
    for (let i = 0; i < SEND_RETRIES; i++) {
      if (!extAlive()) return { ok: false, dead: true, error: '扩展已更新或被停用，请刷新本页后继续使用' }
      try {
        const r = await chrome.runtime.sendMessage(msg)
        if (r) return r
        last = { ok: false, error: '扩展后台无响应' }
      } catch (e) {
        const m = String((e && e.message) || e)
        if (/context invalidated|Extension context/i.test(m)) {
          return { ok: false, dead: true, error: '扩展已更新或被停用，请刷新本页后继续使用' }
        }
        last = { ok: false, error: m }
      }
      await sleep(150 * (i + 1))
    }
    return last || { ok: false, error: '扩展后台无响应，请稍后重试' }
  }

  /** 翻译请求：客户端连不上（retryable）时退避重试，覆盖狐译客户端重启的空窗期。 */
  async function requestTranslate (texts, kind) {
    return requestBackend({ type: 'LINGYI_TRANSLATE', texts, kind: kind || null })
  }

  /** 走后台的后端请求：连不上客户端就退避重试几次，重启期间用户基本无感。 */
  async function requestBackend (msg) {
    let last = null
    for (let i = 0; i < CONNECT_RETRIES; i++) {
      const r = await sendWithRetry(msg)
      if (r.ok || !r.retryable) return r
      last = r
      if (i < CONNECT_RETRIES - 1) await sleep(RETRY_DELAYS[Math.min(i, RETRY_DELAYS.length - 1)])
    }
    return last || { ok: false, error: '狐译客户端未响应' }
  }

  /** 后台探到客户端重新上线：告诉用户可以接着用了，不必刷新页面。 */
  function onBackendRecovered () {
    toast('狐译：已重新连接客户端，可以继续翻译（无需刷新页面）', 'ok', 3000)
  }

  // ---------------- 浮层提示 ----------------

  function isTop () {
    try { return window === window.top } catch (e) { return false }
  }

  /** 整页级别的提示只在顶层窗口显示（内容脚本注入了每个 iframe，否则会刷一屏）。 */
  function pageToast (text, kind, ms) {
    if (isTop()) toast(text, kind, ms)
  }

  function toast (text, kind, ms) {
    let el = document.getElementById(TOAST_ID)
    if (!el) {
      el = document.createElement('div')
      el.id = TOAST_ID
      el.setAttribute(UI_MARK, '1')
      el.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;' +
        'padding:10px 14px;border-radius:10px;font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;' +
        'color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.28);white-space:pre-wrap;word-break:break-word;' +
        'pointer-events:none'
      ;(document.body || document.documentElement).appendChild(el)
    }
    const colors = {
      info: 'rgba(30,41,59,.92)',
      ok: 'rgba(22,101,52,.94)',
      warn: 'rgba(146,64,14,.94)',
      error: 'rgba(153,27,27,.94)'
    }
    el.style.background = colors[kind] || colors.info
    el.textContent = text
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null }
    if (ms > 0) toastTimer = setTimeout(() => el.remove(), ms)
  }

  // ---------------- 与狐译网页版的配对桥 ----------------

  function initAppBridge () {
    if (!document.querySelector('meta[name="lingyi-app"]')) return
    const mark = () => {
      document.documentElement.setAttribute('data-lingyi-ext', chrome.runtime.getManifest().version)
    }
    mark()
    let lastRaw = null
    const sync = () => {
      let raw = null
      try { raw = window.localStorage.getItem(PAIR_KEY) } catch (e) { return }
      mark() // 持续声明存在，供网页版显示「扩展已安装」
      if (!raw || raw === lastRaw) return
      lastRaw = raw
      let p = null
      try { p = JSON.parse(raw) } catch (e) { return }
      if (!p || !p.token) return
      sendWithRetry({
        type: 'LINGYI_PAIR',
        payload: {
          token: p.token,
          backendUrl: p.backend || location.origin,
          username: p.username || '',
          expiresAt: p.expiresAt || 0
        }
      }).then(r => {
        document.documentElement.setAttribute('data-lingyi-ext-paired', r && r.ok ? '1' : '0')
      }).catch(() => {})
    }
    sync()
    setInterval(sync, 2000)
  }

  initPrefs()
  initBall()
  initHover()
  initInputTranslate()
  initAppBridge()
})()
