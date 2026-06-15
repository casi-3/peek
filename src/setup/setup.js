const el = (id) => document.getElementById(id)
const fields = {
  frigateHost: el('frigateHost'),
  frigatePort: el('frigatePort'),
  corner: el('corner'),
  mqttHost: el('mqttHost'),
  mqttPort: el('mqttPort'),
  mqttUser: el('mqttUser'),
  mqttPass: el('mqttPass')
}
const statusEl = el('status')
const testBtn = el('test')
const saveBtn = el('save')
const cancelBtn = el('cancel')

let base = {}

function parseMqtt(url) {
  if (url) {
    url = url.replace(/^(mqtt:\/\/)+/i, 'mqtt://');
  }
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
  if (url) {
    url = url.replace(/^(https?:\/\/)+/i, 'http://');
  }
  try {
    const u = new URL(url)
    // If the host parsed is still "http", it means the url was malformed (like http://http://...)
    // Let's fallback or clean it up.
    if (u.hostname === 'http' && u.pathname.startsWith('//')) {
      const parts = u.pathname.substring(2).split('/');
      const hostPart = parts[0];
      const hostAndPort = hostPart.split(':');
      return { host: hostAndPort[0], port: hostAndPort[1] || '5000' }
    }
    return { host: u.hostname, port: u.port || '5000' }
  } catch (err) {
    return { host: '', port: '5000' }
  }
}

function buildConfig() {
  let frigateHost = fields.frigateHost.value.trim()
  // Strip any leading protocol prefixes (http://, https://)
  frigateHost = frigateHost.replace(/^https?:\/\//i, '')

  const frigatePort = fields.frigatePort.value.trim() || '5000'

  let mqttHost = fields.mqttHost.value.trim() || frigateHost
  // Strip leading mqtt:// protocol prefix if present
  mqttHost = mqttHost.replace(/^mqtt:\/\//i, '')

  const mqttPort = fields.mqttPort.value.trim() || '1883'
  const user = fields.mqttUser.value.trim()
  const pass = fields.mqttPass.value

  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : ''

  return Object.assign({}, base, {
    mqtt: `mqtt://${auth}${mqttHost}:${mqttPort}`,
    frigateUrl: `http://${frigateHost}:${frigatePort}`,
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

async function init() {
  const existing = await window.setup.load()
  if (existing) {
    base = existing
    const f = parseFrigate(existing.frigateUrl || '')
    const m = parseMqtt(existing.mqtt || '')
    fields.frigateHost.value = f.host
    fields.frigatePort.value = f.port
    fields.mqttHost.value = m.host
    fields.mqttPort.value = m.port
    fields.mqttUser.value = m.user
    fields.mqttPass.value = m.pass
    fields.corner.value = existing.corner || 'top-right'
  }
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
    setStatus('ok', 'Connected to the MQTT broker.')
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
  await window.setup.save(buildConfig())
})

cancelBtn.addEventListener('click', () => window.setup.cancel())

init()
