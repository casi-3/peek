const el = (id) => document.getElementById(id)
const fields = {
  frigateHost: el('frigateHost'),
  frigatePort: el('frigatePort'),
  frigateUser: el('frigateUser'),
  frigatePass: el('frigatePass'),
  corner: el('corner'),
  mqttHost: el('mqttHost'),
  mqttPort: el('mqttPort'),
  mqttUser: el('mqttUser'),
  mqttPass: el('mqttPass'),
  autoUpdate: el('autoUpdate'),
  updateRepo: el('updateRepo'),
  openAtLogin: el('openAtLogin'),
  showDock: el('showDock'),
  sound: el('sound'),
  snapshot: el('snapshot'),
  cropToObject: el('cropToObject'),
  cropRatio: el('cropRatio'),
  highResStream: el('highResStream'),
  showAllObjectsInFrame: el('showAllObjectsInFrame'),
  showBoundingBoxes: el('showBoundingBoxes'),
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
    return { host: u.hostname, port: u.port || '5000' }
  } catch (err) {
    return { host: '', port: '5000' }
  }
}

function buildConfig() {
  const frigateHost = fields.frigateHost.value.trim().replace(/^\w+:\/\//, '')
  const frigatePort = fields.frigatePort.value.trim() || '5000'
  const mqttHost = (fields.mqttHost.value.trim() || frigateHost).replace(/^\w+:\/\//, '')
  const mqttPort = fields.mqttPort.value.trim() || '1883'
  const user = fields.mqttUser.value.trim()
  const pass = fields.mqttPass.value

  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : ''

  const frigateUser = fields.frigateUser.value.trim()
  const frigatePass = fields.frigatePass.value
  const scheme = frigateUser ? 'https' : 'http'

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

  return cfg
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

function buildCameraList(cameras) {
  const container = el('cameraList')
  container.innerHTML = ''
  if (!cameras.length) {
    const span = document.createElement('span')
    span.className = 'empty'
    span.textContent = 'Waiting for events…'
    container.appendChild(span)
    return
  }
  for (const cam of cameras) {
    const label = document.createElement('label')
    label.className = 'check'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = cam.enabled !== false
    input.dataset.camera = cam.name
    const text = document.createElement('span')
    text.className = 'check-text'
    text.textContent = cam.label || cam.name
    label.appendChild(input)
    label.appendChild(text)
    container.appendChild(label)
  }
}

function runtimeOpts() {
  if (!started) return {}
  const cameras = {}
  el('cameraList').querySelectorAll('input[data-camera]').forEach(input => {
    cameras[input.dataset.camera] = input.checked
  })
  return {
    sound: fields.sound.checked,
    snapshot: fields.snapshot.checked,
    cropToObject: fields.cropToObject.checked,
    cropRatio: fields.cropRatio.value,
    highResStream: fields.highResStream.checked,
    showAllObjectsInFrame: fields.showAllObjectsInFrame.checked,
    showBoundingBoxes: fields.showBoundingBoxes.checked,
    dismissSeconds: Number(fields.dismiss.value),
    clickAction: fields.clickAction.value,
    cameras
  }
}

async function init() {
  const p = await window.setup.loadPrefs()
  fields.autoUpdate.checked = !!(p && p.autoUpdate)
  fields.updateRepo.value = (p && p.updateRepo) || ''
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
    fields.cropToObject.checked = !!p.cropToObject
    fields.cropRatio.value = p.cropRatio || '16:9'
    fields.highResStream.checked = !!p.highResStream
    fields.showAllObjectsInFrame.checked = p.showAllObjectsInFrame !== false
    fields.showBoundingBoxes.checked = p.showBoundingBoxes !== false
    fields.dismiss.value = String(p.dismissSeconds != null ? p.dismissSeconds : 8)
    fields.clickAction.value = (p && p.clickAction) || 'event'
    buildCameraList(p.cameras || [])
  }
  const existing = await window.setup.load()
  if (existing) {
    base = existing
    const f = parseFrigate(existing.frigateUrl || '')
    const m = parseMqtt(existing.mqtt || '')
    fields.frigateHost.value = f.host
    fields.frigatePort.value = f.port
    fields.frigateUser.value = existing.frigateUser || ''
    fields.frigatePass.value = existing.frigatePassword || ''
    fields.mqttHost.value = m.host
    fields.mqttPort.value = m.port
    fields.mqttUser.value = m.user
    fields.mqttPass.value = m.pass
    fields.corner.value = existing.corner || 'top-right'
  }
  
  const toggleCropRatio = () => {
    el('cropRatioRow').style.display = fields.cropToObject.checked ? 'flex' : 'none'
  }
  fields.cropToObject.addEventListener('change', toggleCropRatio)
  toggleCropRatio()
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
  await window.setup.save(buildConfig(), Object.assign({ autoUpdate: fields.autoUpdate.checked, updateRepo: fields.updateRepo.value.trim(), openAtLogin: fields.openAtLogin.checked, showDock: fields.showDock.checked }, runtimeOpts()))
})

cancelBtn.addEventListener('click', () => window.setup.cancel())

init()
