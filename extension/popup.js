// 狐译（划词翻译）弹窗：连接状态与重连 / 目标语言与划词展示方式 / 整页翻译与原文译文切换
// 语言分组与狐译网页版 constants/langs.js 保持一致（自由文本，直接进翻译 prompt）
const LANG_GROUPS = [
  { label: '常用', langs: ['中文', '繁体中文', '英语', '日语', '韩语'] },
  { label: '欧洲', langs: ['法语', '德语', '西班牙语', '葡萄牙语', '意大利语', '荷兰语', '俄语', '乌克兰语', '波兰语', '捷克语', '匈牙利语', '罗马尼亚语', '希腊语', '瑞典语', '挪威语', '丹麦语', '芬兰语', '塞尔维亚语', '克罗地亚语', '保加利亚语'] },
  { label: '中东', langs: ['阿拉伯语', '土耳其语', '波斯语', '希伯来语'] },
  { label: '南亚', langs: ['印地语', '孟加拉语', '乌尔都语', '泰米尔语', '泰卢固语'] },
  { label: '东南亚', langs: ['泰语', '越南语', '印尼语', '马来语', '菲律宾语', '缅甸语', '高棉语', '老挝语'] },
  { label: '其他', langs: ['斯瓦希里语'] }
]

const $ = id => document.getElementById(id)
let backendUrl = 'http://localhost:8080'

function fillLangs (selected) {
  const sel = $('lang')
  sel.innerHTML = ''
  for (const g of LANG_GROUPS) {
    const og = document.createElement('optgroup')
    og.label = g.label
    for (const l of g.langs) {
      const opt = document.createElement('option')
      opt.value = l
      opt.textContent = l
      if (l === selected) opt.selected = true
      og.appendChild(opt)
    }
    sel.appendChild(og)
  }
}

async function refreshState () {
  let st
  try {
    st = await chrome.runtime.sendMessage({ type: 'LINGYI_STATE' })
  } catch (e) {
    st = null
  }
  const dot = $('dot')
  const text = $('statusText')
  if (!st) {
    dot.className = 'dot off'
    text.textContent = '扩展后台异常，请在扩展管理页重新加载'
    fillLangs('中文')
    return
  }
  backendUrl = st.backendUrl || backendUrl
  fillLangs(st.targetLang || '中文')
  $('selMode').value = st.selMode || 'replace'
  $('optBall').checked = st.floatBall !== false
  $('optHover').checked = !!st.hoverMode
  $('optInput').checked = st.inputTrans !== false
  if (st.online) {
    dot.className = 'dot on'
    text.textContent = '已连接狐译客户端' + (st.username ? '（用户 ' + st.username + '）' : '')
  } else if (st.paired) {
    dot.className = 'dot off'
    text.textContent = st.error || '狐译客户端未启动，请先运行 start.bat；启动后会自动重连，页面不用刷新'
  } else {
    dot.className = 'dot off'
    text.textContent = '未连接：请打开狐译网页版的「划词翻译」页完成连接'
  }
}

async function sendToActiveTab (msg) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs && tabs[0]
  if (!tab || tab.id == null) throw new Error('没有活动标签页')
  await chrome.tabs.sendMessage(tab.id, msg)
}

/** 页面动作按钮统一处理：发不到内容脚本就在状态区给出原因。 */
function bindTabAction (id, msg) {
  $(id).addEventListener('click', async () => {
    try {
      await sendToActiveTab(msg)
      window.close()
    } catch (e) {
      $('dot').className = 'dot off'
      $('statusText').textContent = '当前页面不支持（浏览器内置页/商店页），或该页尚未刷新'
    }
  })
}

$('lang').addEventListener('change', e => {
  chrome.runtime.sendMessage({ type: 'LINGYI_SET_LANG', targetLang: e.target.value }).catch(() => {})
})

$('selMode').addEventListener('change', e => {
  chrome.runtime.sendMessage({ type: 'LINGYI_SET_FLAGS', selMode: e.target.value }).catch(() => {})
})

$('optBall').addEventListener('change', e => {
  chrome.runtime.sendMessage({ type: 'LINGYI_SET_FLAGS', floatBall: e.target.checked }).catch(() => {})
})

$('optHover').addEventListener('change', e => {
  chrome.runtime.sendMessage({ type: 'LINGYI_SET_FLAGS', hoverMode: e.target.checked }).catch(() => {})
})

$('optInput').addEventListener('change', e => {
  chrome.runtime.sendMessage({ type: 'LINGYI_SET_FLAGS', inputTrans: e.target.checked }).catch(() => {})
})

// 客户端刚启动时不用等巡检，点一下立刻重探；探到在线后台会广播给所有网页
$('btnRecheck').addEventListener('click', async () => {
  $('statusText').textContent = '正在重新连接狐译客户端…'
  try {
    await chrome.runtime.sendMessage({ type: 'LINGYI_RECHECK' })
  } catch (e) { /* 后台被回收时下面的 refreshState 会照常再探一次 */ }
  refreshState()
})

bindTabAction('btnPage', { type: 'LINGYI_TRANSLATE_PAGE' })
bindTabAction('btnSource', { type: 'LINGYI_SHOW_SOURCE' })
bindTabAction('btnTarget', { type: 'LINGYI_SHOW_TARGET' })
bindTabAction('btnToggle', { type: 'LINGYI_TOGGLE_VIEW' })

$('openApp').addEventListener('click', () => {
  chrome.tabs.create({ url: backendUrl + '/' })
})

$('openShortcuts').addEventListener('click', () => {
  // Edge 用 edge:// 前缀，chrome://extensions/shortcuts 在 Edge 里会 404
  const isEdge = navigator.userAgent.includes('Edg/')
  chrome.tabs.create({ url: (isEdge ? 'edge' : 'chrome') + '://extensions/shortcuts' })
})

refreshState()
