const el = (id) => document.getElementById(id)
const fields = {
  frigateHost: el('frigateHost'),
  frigatePort: el('frigatePort'),
  frigateHttps: el('frigateHttps'),
  frigateSelfSigned: el('frigateSelfSigned'),
  frigateUser: el('frigateUser'),
  frigatePass: el('frigatePass'),
  corner: el('corner'),
  mqttHost: el('mqttHost'),
  mqttPort: el('mqttPort'),
  mqttUser: el('mqttUser'),
  mqttPass: el('mqttPass'),
  autoUpdate: el('autoUpdate'),
  openAtLogin: el('openAtLogin'),
  showDock: el('showDock'),
  sound: el('sound'),
  snapshot: el('snapshot'),
  showAllObjectsInFrame: el('showAllObjectsInFrame'),
  showBoundingBoxes: el('showBoundingBoxes'),
  dynamicSize: el('dynamicSize'),
  dismissOnStationary: el('dismissOnStationary'),
  dismiss: el('dismiss'),
  clickAction: el('clickAction')
}
const statusEl = el('status')
const testBtn = el('test')
const saveBtn = el('save')
const cancelBtn = el('cancel')

let base = {}
let started = false

function parseMqtt(url) {
  try {
    const u = new URL(url)
    return {
      host: u.hostname,
      port: u.port || '1883',
      user: decodeURIComponent(u.username || ''),
      pass: decodeURIComponent(u.password || '')
    }
  } catch (err) {
    return { host: '', port: '1883', user: '', pass: '' }
  }
}

function parseFrigate(url) {
  try {
    const u = new URL(url)
    const https = u.protocol === 'https:'
    return { host: u.hostname, port: u.port || (https ? '443' : '5000'), https }
  } catch (err) {
    return { host: '', port: '5000', https: false }
  }
}

function buildConfig() {
  const frigateHost = fields.frigateHost.value.trim().replace(/^\w+:\/\//, '')
  const useHttps = fields.frigateHttps.checked
  const frigatePort = fields.frigatePort.value.trim() || (useHttps ? '443' : '5000')
  const mqttHost = (fields.mqttHost.value.trim() || frigateHost).replace(/^\w+:\/\//, '')
  const mqttPort = fields.mqttPort.value.trim() || '1883'
  const user = fields.mqttUser.value.trim()
  const pass = fields.mqttPass.value

  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : ''

  const frigateUser = fields.frigateUser.value.trim()
  const frigatePass = fields.frigatePass.value
  const scheme = useHttps ? 'https' : 'http'

  const cfg = Object.assign({}, base, {
    mqtt: `mqtt://${auth}${mqttHost}:${mqttPort}`,
    frigateUrl: `${scheme}://${frigateHost}:${frigatePort}`,
    topicPrefix: base.topicPrefix || 'frigate',
    cameras: base.cameras || {},
    labels: base.labels || [],
    minScore: base.minScore != null ? base.minScore : 0.6,
    corner: fields.corner.value,
    margin: base.margin != null ? base.margin : 24,
    width: base.width || 380,
    height: base.height || 300,
    dismissSeconds: base.dismissSeconds != null ? base.dismissSeconds : 8
  })

  if (frigateUser) {
    cfg.frigateUser = frigateUser
    cfg.frigatePassword = frigatePass
  } else {
    delete cfg.frigateUser
    delete cfg.frigatePassword
  }

  if (useHttps && fields.frigateSelfSigned.checked) {
    cfg.frigateAllowSelfSigned = true
  } else {
    delete cfg.frigateAllowSelfSigned
  }

  return cfg
}

function updateSelfSignedRow() {
  const row = el('selfSignedRow')
  if (row) row.style.display = fields.frigateHttps.checked ? '' : 'none'
}

function setStatus(kind, text) {
  if (!kind) {
    statusEl.className = 'hidden'
    statusEl.textContent = ''
    return
  }
  statusEl.className = kind
  statusEl.textContent = text
}

function valid() {
  return fields.frigateHost.value.trim().length > 0
}

function buildCameraList(container, cameras, emptyText) {
  container.innerHTML = ''
  if (!cameras.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = emptyText || 'Waiting for events…'
    container.appendChild(empty)
    return
  }
  for (const cam of cameras) {
    const opt = document.createElement('div')
    opt.setAttribute('role', 'option')
    opt.tabIndex = 0
    opt.dataset.value = cam.name
    opt.textContent = cam.label || cam.name
    opt.setAttribute('aria-selected', String(cam.enabled !== false))
    container.appendChild(opt)
  }
}

// A plain div list, not a native multi-select: Chromium scrolls a multi-select
// back to its first selected option after every toggle.
function toggleOption(opt) {
  opt.setAttribute('aria-selected', String(opt.getAttribute('aria-selected') !== 'true'))
}

for (const id of ['cameraList', 'liveCameraList', 'zoneList']) {
  const list = el(id)
  list.addEventListener('click', e => {
    const opt = e.target.closest('[role="option"]')
    if (opt) toggleOption(opt)
  })
  list.addEventListener('keydown', e => {
    if (e.key !== ' ' && e.key !== 'Enter') return
    const opt = e.target.closest('[role="option"]')
    if (!opt) return
    e.preventDefault()
    toggleOption(opt)
  })
}

function selectedCameras(container) {
  const cameras = {}
  container.querySelectorAll('[role="option"]').forEach(opt => {
    cameras[opt.dataset.value] = opt.getAttribute('aria-selected') === 'true'
  })
  return cameras
}

const hotkeyInput = el('liveHotkey')
const hotkeyHint = el('liveHotkeyHint')
const hotkeyHintText = hotkeyHint.textContent
let platform = ''
let liveHotkey = ''

const NAMED_KEYS = {
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert'
}

function acceleratorKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return NAMED_KEYS[code] || null
}

function formatHotkey(accelerator) {
  if (!accelerator) return ''
  const mac = platform === 'darwin'
  const names = {
    CommandOrControl: mac ? 'Cmd' : 'Ctrl',
    CmdOrCtrl: mac ? 'Cmd' : 'Ctrl',
    Command: 'Cmd',
    Control: 'Ctrl',
    Super: 'Win'
  }
  return accelerator.split('+').map(part => names[part] || part).join(' + ')
}

function setHotkeyHint(text, isError) {
  hotkeyHint.textContent = text
  hotkeyHint.classList.toggle('err', !!isError)
}

function setHotkey(accelerator) {
  liveHotkey = accelerator
  hotkeyInput.value = formatHotkey(accelerator)
}

hotkeyInput.addEventListener('focus', () => {
  window.setup.captureHotkey(true)
  setHotkeyHint('Press the new key combination. Esc keeps the current one.')
})

hotkeyInput.addEventListener('blur', () => {
  window.setup.captureHotkey(false)
  if (!hotkeyHint.classList.contains('err')) setHotkeyHint(hotkeyHintText)
})

hotkeyInput.addEventListener('keydown', async (e) => {
  e.preventDefault()
  if (e.key === 'Escape') {
    hotkeyInput.blur()
    return
  }
  if (e.key === 'Tab') return
  const key = acceleratorKey(e.code)
  const parts = []
  if (platform === 'darwin') {
    if (e.metaKey) parts.push('Command')
    if (e.ctrlKey) parts.push('Control')
  } else {
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.metaKey) parts.push('Super')
  }
  if (e.altKey) parts.push('Alt')
  const hasModifier = parts.length > 0
  if (e.shiftKey) parts.push('Shift')
  if (!key) return
  // Shift alone would swallow normal typing system-wide, so require Ctrl, Alt or the OS key unless it is an F key.
  if (!hasModifier && !/^F\d+$/.test(key)) {
    setHotkeyHint('Add Ctrl, Alt or ' + (platform === 'darwin' ? 'Cmd' : 'Win') + ' to the key.', true)
    return
  }
  const accelerator = [...parts, key].join('+')
  const ok = await window.setup.checkHotkey(accelerator)
  if (!ok) {
    setHotkeyHint(formatHotkey(accelerator) + ' is taken by another app. Try another one.', true)
    return
  }
  setHotkey(accelerator)
  setHotkeyHint('Saved when you click Save.')
})

el('liveHotkeyClear').addEventListener('click', () => {
  setHotkey('')
  setHotkeyHint('No shortcut. Use Show live view in the tray menu instead.')
})

function runtimeOpts() {
  if (!started) return {}
  const cameras = selectedCameras(el('cameraList'))
  return {
    liveHotkey,
    liveCameras: selectedCameras(el('liveCameraList')),
    zoneFilter: Object.entries(selectedCameras(el('zoneList'))).filter(([, on]) => on).map(([name]) => name),
    sound: fields.sound.checked,
    snapshot: fields.snapshot.checked,
    showAllObjectsInFrame: fields.showAllObjectsInFrame.checked,
    showBoundingBoxes: fields.showBoundingBoxes.checked,
    dynamicSize: fields.dynamicSize.checked,
    dismissOnStationary: fields.dismissOnStationary.checked,
    dismissSeconds: Number(fields.dismiss.value),
    clickAction: fields.clickAction.value,
    cameras
  }
}

async function init() {
  const p = await window.setup.loadPrefs()
  platform = (p && p.platform) || ''
  fields.autoUpdate.checked = !!(p && p.autoUpdate)
  fields.openAtLogin.checked = !!(p && p.openAtLogin)
  fields.showDock.checked = !!(p && p.showDock)
  if (p && p.platform !== 'darwin' && p.platform !== 'win32') {
    const startupRow = el('startupRow')
    if (startupRow) startupRow.style.display = 'none'
  }
  if (p && p.platform !== 'darwin') {
    const dockRow = el('dockRow')
    if (dockRow) dockRow.style.display = 'none'
  }
  if (p && p.started) {
    started = true
    saveBtn.textContent = 'Save'
    el('runtime').classList.remove('hidden')
    fields.sound.checked = !!p.sound
    fields.snapshot.checked = !!p.snapshot
    fields.showAllObjectsInFrame.checked = p.showAllObjectsInFrame !== false
    fields.showBoundingBoxes.checked = p.showBoundingBoxes !== false
    fields.dynamicSize.checked = p.dynamicSize !== false
    fields.dismissOnStationary.checked = p.dismissOnStationary !== false
    fields.dismiss.value = String(p.dismissSeconds != null ? p.dismissSeconds : 8)
    fields.clickAction.value = (p && p.clickAction) || 'event'
    buildCameraList(el('cameraList'), p.cameras || [])
    buildCameraList(el('zoneList'), p.zones || [], 'No zones found in Frigate')
    el('liveSection').classList.remove('hidden')
    buildCameraList(el('liveCameraList'), p.liveCameras || [])
    setHotkey(p.liveHotkey || '')
  }
  const existing = await window.setup.load()
  if (existing) {
    base = existing
    const f = parseFrigate(existing.frigateUrl || '')
    const m = parseMqtt(existing.mqtt || '')
    fields.frigateHost.value = f.host
    fields.frigatePort.value = f.port
    fields.frigateHttps.checked = !!f.https
    fields.frigateSelfSigned.checked = !!existing.frigateAllowSelfSigned
    fields.frigateUser.value = existing.frigateUser || ''
    fields.frigatePass.value = existing.frigatePassword || ''
    fields.mqttHost.value = m.host
    fields.mqttPort.value = m.port
    fields.mqttUser.value = m.user
    fields.mqttPass.value = m.pass
    fields.corner.value = existing.corner || 'top-right'
  }
  updateSelfSignedRow()
}

testBtn.addEventListener('click', async () => {
  if (!valid()) {
    setStatus('err', 'Enter the Frigate host first.')
    return
  }
  setStatus('busy', 'Connecting…')
  testBtn.disabled = true
  const result = await window.setup.test(buildConfig())
  testBtn.disabled = false
  if (result.ok) {
    setStatus('ok', result.detail || 'Connected to the MQTT broker.')
  } else {
    setStatus('err', result.error || 'Could not connect.')
  }
})

saveBtn.addEventListener('click', async () => {
  if (!valid()) {
    setStatus('err', 'Enter the Frigate host first.')
    return
  }
  saveBtn.disabled = true
  await window.setup.save(buildConfig(), Object.assign({ autoUpdate: fields.autoUpdate.checked, openAtLogin: fields.openAtLogin.checked, showDock: fields.showDock.checked }, runtimeOpts()))
})

cancelBtn.addEventListener('click', () => window.setup.cancel())

fields.frigateHttps.addEventListener('change', updateSelfSignedRow)

init()
