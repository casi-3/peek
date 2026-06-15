const el = (id) => document.getElementById(id)

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderNotes(md) {
  const lines = escapeHtml(md || '').split('\n')
  const out = []
  let inList = false
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false } }
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { closeList(); continue }
    if (/^#{1,6}\s+/.test(line)) {
      closeList()
      out.push('<h3>' + inline(line.replace(/^#{1,6}\s+/, '')) + '</h3>')
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push('<li>' + inline(line.replace(/^[-*]\s+/, '')) + '</li>')
    } else if (/^\|/.test(line)) {
      continue
    } else {
      closeList()
      out.push('<p>' + inline(line) + '</p>')
    }
  }
  closeList()
  return out.join('')
}

function setBusy(busy) {
  el('install').disabled = busy
  el('silent').disabled = busy
  el('later').disabled = busy
  el('skip').disabled = busy
}

async function start(mode) {
  el('error').className = 'hidden'
  el('progress').className = ''
  setBusy(true)
  const res = await window.peekUpdate.install(mode)
  if (res && res.error) {
    el('error').textContent = res.error
    el('error').className = ''
    el('progress').className = 'hidden'
    setBusy(false)
  }
}

window.peekUpdate.onProgress((p) => {
  const pct = Math.round(p * 100)
  el('fill').style.width = pct + '%'
  el('pct').textContent = pct < 100 ? 'Downloading… ' + pct + '%' : 'Starting installer…'
})

window.peekUpdate.onError((msg) => {
  el('error').textContent = msg
  el('error').className = ''
  el('progress').className = 'hidden'
  setBusy(false)
})

el('install').addEventListener('click', () => start('normal'))
el('silent').addEventListener('click', () => start('silent'))
el('later').addEventListener('click', () => window.peekUpdate.later())
el('skip').addEventListener('click', () => window.peekUpdate.skip())

;(async () => {
  const data = await window.peekUpdate.load()
  if (!data) return
  el('cur').textContent = data.current
  el('next').textContent = data.version
  el('notes').innerHTML = renderNotes(data.notes)
  if (data.platform === 'darwin') {
    el('silent').classList.add('hidden')
    el('sub').textContent = 'A new version of Peek is ready. It will open the installer.'
  }
})()
