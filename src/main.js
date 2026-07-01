const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, dialog, Notification, session } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, execFileSync } = require('child_process')
const mqtt = require('mqtt')
const { readConfig, saveConfig } = require('./config')
const { readPrefs, writePrefs } = require('./prefs')
const updater = require('./updater')
const frigateAuth = require('./frigate-auth')

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => openSetup())
  if (process.platform === 'darwin') app.on('activate', () => openSetup())
}

const activeWindows = new Map()
let indicatorWin = null
const pendingEvents = new Map()
const closedEvents = new Set()
const eventGroupMap = new Map()

function markEventClosed(id) {
  closedEvents.add(id)
  if (closedEvents.size > 500) {
    const first = closedEvents.keys().next().value
    closedEvents.delete(first)
  }
}
let setupWin = null
let updateWin = null
let tray = null
let config = null
let prefs = null
let pendingUpdate = null
let appStarted = false
let frigatePin = null
let frigateToken = null
let tokenRefreshTimer = null
let mqttClient = null
let cameraStreamMap = {}
let cameraDetectMap = {}
let certProcSet = false
// currentDynamicWidth removed
const knownCameras = new Set()
const eventAliases = new Map()
const recentEvents = new Map()

const DISMISS_OPTIONS = [
  { label: '3 seconds', value: 3 },
  { label: '5 seconds', value: 5 },
  { label: '8 seconds', value: 8 },
  { label: '15 seconds', value: 15 },
  { label: '30 seconds', value: 30 },
  { label: 'Until dismissed', value: 0 }
]

function httpToWs(url) {
  return url.replace(/^http/, 'ws')
}

function streamUrl(camera) {
  const streamName = prefs.highResStream ? camera : (cameraStreamMap[camera] || camera)
  return `${httpToWs(config.frigateUrl)}/live/webrtc/api/ws?src=${encodeURIComponent(streamName)}`
}

function buildStreamMap(frigateConfig) {
  const cameras = (frigateConfig && frigateConfig.cameras) || {}
  for (const [name, cam] of Object.entries(cameras)) {
    const streams = cam && cam.live && cam.live.streams
    if (streams && typeof streams === 'object') {
      const first = Object.values(streams)[0]
      if (first) cameraStreamMap[name] = first
    }
    const detect = cam && cam.detect
    if (detect && detect.width && detect.height) {
      cameraDetectMap[name] = { width: detect.width, height: detect.height }
    }
  }
}

function normalizeBox(box, camera) {
  if (!Array.isArray(box) || box.length < 4) return null
  const dims = cameraDetectMap[camera]
  if (!dims) return null
  return [box[0] / dims.width, box[1] / dims.height, box[2] / dims.width, box[3] / dims.height]
}

async function fetchFrigateConfig(token) {
  try {
    const frigateConfig = await frigateAuth.fetchConfig(config.frigateUrl, token || null)
    buildStreamMap(frigateConfig)
  } catch (err) {
    console.error('[peek] could not fetch Frigate config: ' + err.message)
  }
}

function snapshotUrl(camera) {
  return `${config.frigateUrl}/api/${encodeURIComponent(camera)}/latest.jpg`
}

function clickUrlForEvent(camera, eventId) {
  const action = prefs.clickAction || 'event'
  if (action === 'disabled') return null
  if (action === 'live') return `${config.frigateUrl}/#${camera}`
  return `${config.frigateUrl}/explore?event_id=${encodeURIComponent(eventId)}`
}

function prettyName(camera) {
  if (config.cameras && config.cameras[camera]) return config.cameras[camera]
  return camera.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function overlaySize(dynamicWidth = null) {
  const height = config.height || 300
  let width
  if (prefs.cropToObject) {
    const ratioStr = prefs.cropRatio || '16:9'
    const parts = ratioStr.split(':')
    const ratio = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : (16/9)
    width = Math.round(height * ratio)
  } else {
    width = dynamicWidth || config.width || Math.round(height * (16 / 9))
  }
  return { width, height }
}

function getViewportForBox(boxRelative, camera) {
  const detect = cameraDetectMap[camera] || { width: 1280, height: 720 }
  const VW = detect.width
  const VH = detect.height
  const { width: winW, height: winH } = overlaySize()
  
  if (!boxRelative || !prefs.cropToObject) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  }

  const minX = boxRelative[0]
  const minY = boxRelative[1]
  const maxX = boxRelative[2]
  const maxY = boxRelative[3]

  const boxW = maxX - minX
  const boxH = maxY - minY
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2

  const objCx = cx * VW
  const objCy = cy * VH

  const winCx = winW / 2
  const winCy = winH / 2

  const objW = boxW * VW
  const objH = boxH * VH

  const idealScale = Math.min(winW / (objW * 2), winH / (objH * 2))
  const minScaleToCover = Math.max(winW / VW, winH / VH)

  const S = Math.max(minScaleToCover, Math.min(minScaleToCover * 4, idealScale))

  let tx = winCx - (objCx * S)
  let ty = winCy - (objCy * S)

  const minTx = winW - (VW * S)
  const minTy = winH - (VH * S)

  tx = Math.min(0, Math.max(minTx, tx))
  ty = Math.min(0, Math.max(minTy, ty))

  return {
    minX: -tx / (VW * S),
    maxX: (winW - tx) / (VW * S),
    minY: -ty / (VH * S),
    maxY: (winH - ty) / (VH * S)
  }
}

function viewportsOverlap(vp1, vp2) {
  return !(vp1.maxX < vp2.minX || vp1.minX > vp2.maxX || vp1.maxY < vp2.minY || vp1.minY > vp2.maxY)
}

function positionWindows() {
  const area = screen.getPrimaryDisplay().workArea
  const margin = config.margin != null ? config.margin : 24
  const corner = config.corner || 'top-right'
  
  let currentY = margin
  if (corner.includes('bottom')) currentY = area.height - margin

  const windows = Array.from(activeWindows.values())
  windows.forEach((w, i) => {
    if (w.isDestroyed()) return
    const { width, height } = overlaySize(w.dynamicWidth)
    let x = area.x + area.width - width - margin
    if (corner.includes('left')) x = area.x + margin
    
    let y = area.y + currentY
    if (corner.includes('bottom')) {
      y = area.y + currentY - height
      currentY -= (height + margin)
    } else {
      currentY += (height + margin)
    }
    w.setBounds({ x, y, width, height })
  })

  // Position indicatorWin
  if (indicatorWin && !indicatorWin.isDestroyed()) {
    if (pendingEvents.size > 0) {
      const { width } = overlaySize() // default approx width
      const indHeight = 32
      let x = area.x + area.width - width - margin
      if (corner.includes('left')) x = area.x + margin
      
      let y = area.y + currentY
      if (corner.includes('bottom')) {
        y = area.y + currentY - indHeight
      }
      indicatorWin.setBounds({ x, y, width, height: indHeight })
      indicatorWin.webContents.send('set-count', pendingEvents.size)
      indicatorWin.showInactive()
    } else {
      indicatorWin.hide()
    }
  }
}

function updateAudio() {
  const windows = Array.from(activeWindows.values())
  windows.forEach((w, i) => {
    if (!w.isDestroyed()) {
      w.webContents.send('set-muted', !prefs.sound || i !== 0)
    }
  })
}

function createEventWindow(eventId) {
  const { width, height } = overlaySize()
  const w = new BrowserWindow({
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  w.setAlwaysOnTop(true, 'screen-saver')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  w.eventId = eventId
  w.dynamicWidth = null
  w.isLoading = true
  w.eventQueue = []
  
  w.webContents.on('did-finish-load', () => {
    w.isLoading = false
    for (const ev of w.eventQueue) {
      w.webContents.send('frigate-event', ev)
    }
    w.eventQueue = []
  })
  
  w.on('closed', () => {
    activeWindows.delete(eventId)
    
    if (pendingEvents.size > 0 && activeWindows.size < 4) {
      const firstPending = pendingEvents.keys().next().value
      const pendingEvent = pendingEvents.get(firstPending)
      pendingEvents.delete(firstPending)
      
      const newWin = createEventWindow(firstPending)
      activeWindows.set(firstPending, newWin)
      newWin.showInactive()
      pendingEvent.sound = prefs.sound
      pendingEvent.type = 'new'
      newWin.eventQueue.push(pendingEvent)
      newWin.webContents.on('did-finish-load', () => {
        updateAudio()
      })
    }
    
    positionWindows()
    updateAudio()
  })
  
  return w
}

function initIndicatorWin() {
  if (indicatorWin) return
  indicatorWin = new BrowserWindow({
    width: 300,
    height: 32,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  indicatorWin.setAlwaysOnTop(true, 'screen-saver')
  indicatorWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  indicatorWin.loadFile(path.join(__dirname, 'renderer', 'indicator.html'))
}

function defaultPrefs() {
  const cameras = {}
  Object.keys(config.cameras || {}).forEach(c => {
    cameras[c] = true
  })
  return {
    cameras,
    sound: false,
    snapshot: true,
    dismissSeconds: config.dismissSeconds != null ? config.dismissSeconds : 8,
    clickAction: 'event',
    cropToObject: false,
    cropRatio: '16:9',
    highResStream: false,
    showAllObjectsInFrame: true,
    showBoundingBoxes: true,
    autoUpdate: false,
    updateRepo: '',
    showDock: false,
    openAtLogin: false,
    skipVersion: '',
    lastNotify: { version: '', at: 0 }
  }
}

function loadPrefs() {
  const base = defaultPrefs()
  const saved = readPrefs()
  prefs = {
    cameras: Object.assign({}, base.cameras, saved.cameras),
    sound: saved.sound != null ? saved.sound : base.sound,
    snapshot: saved.snapshot != null ? saved.snapshot : base.snapshot,
    dismissSeconds: saved.dismissSeconds != null ? saved.dismissSeconds : base.dismissSeconds,
    clickAction: saved.clickAction != null ? saved.clickAction : base.clickAction,
    cropToObject: saved.cropToObject != null ? saved.cropToObject : base.cropToObject,
    cropRatio: saved.cropRatio != null ? saved.cropRatio : base.cropRatio,
    highResStream: saved.highResStream != null ? saved.highResStream : base.highResStream,
    showAllObjectsInFrame: saved.showAllObjectsInFrame != null ? saved.showAllObjectsInFrame : base.showAllObjectsInFrame,
    showBoundingBoxes: saved.showBoundingBoxes != null ? saved.showBoundingBoxes : base.showBoundingBoxes,
    autoUpdate: saved.autoUpdate != null ? saved.autoUpdate : base.autoUpdate,
    updateRepo: saved.updateRepo != null ? saved.updateRepo : base.updateRepo,
    showDock: saved.showDock != null ? saved.showDock : base.showDock,
    openAtLogin: saved.openAtLogin != null ? saved.openAtLogin : base.openAtLogin,
    skipVersion: saved.skipVersion != null ? saved.skipVersion : base.skipVersion,
    lastNotify: saved.lastNotify != null ? saved.lastNotify : base.lastNotify
  }
  Object.keys(prefs.cameras).forEach(c => knownCameras.add(c))
}

function savePrefs() {
  writePrefs(prefs)
}

function supportsOpenAtLogin() {
  return process.platform === 'darwin' || process.platform === 'win32'
}

function applyOpenAtLogin(enabled) {
  if (!supportsOpenAtLogin() || !app.isPackaged) return
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true })
  } catch (err) {
    console.error('[peek] could not set open on startup: ' + err.message)
  }
}

function applyRuntimePrefs(opts) {
  if (!opts) return
  if (typeof opts.sound === 'boolean') prefs.sound = opts.sound
  if (typeof opts.snapshot === 'boolean') prefs.snapshot = opts.snapshot
  if (typeof opts.cropToObject === 'boolean') prefs.cropToObject = opts.cropToObject
  if (opts.cropRatio) prefs.cropRatio = opts.cropRatio
  if (typeof opts.highResStream === 'boolean') prefs.highResStream = opts.highResStream
  if (opts.dismissSeconds != null) prefs.dismissSeconds = opts.dismissSeconds
  if (opts.clickAction) prefs.clickAction = opts.clickAction
  if (typeof opts.showAllObjectsInFrame === 'boolean') prefs.showAllObjectsInFrame = opts.showAllObjectsInFrame
  if (typeof opts.showBoundingBoxes === 'boolean') prefs.showBoundingBoxes = opts.showBoundingBoxes
  if (opts.cameras && typeof opts.cameras === 'object') {
    for (const [name, on] of Object.entries(opts.cameras)) {
      prefs.cameras[name] = !!on
    }
  }
}

function cameraEnabled(camera) {
  return prefs.cameras[camera] !== false
}

function learnCamera(camera) {
  if (knownCameras.has(camera)) return
  knownCameras.add(camera)
  if (prefs.cameras[camera] == null) prefs.cameras[camera] = true
  buildMenu()
}

function buildMenu() {
  const cameraItems = [...knownCameras].sort().map(camera => ({
    label: prettyName(camera),
    type: 'checkbox',
    checked: cameraEnabled(camera),
    click: (item) => {
      prefs.cameras[camera] = item.checked
      savePrefs()
    }
  }))
  if (cameraItems.length === 0) {
    cameraItems.push({ label: 'Waiting for events…', enabled: false })
  }

  const dismissItems = DISMISS_OPTIONS.map(opt => ({
    label: opt.label,
    type: 'radio',
    checked: prefs.dismissSeconds === opt.value,
    click: () => {
      prefs.dismissSeconds = opt.value
      savePrefs()
    }
  }))

  const menu = Menu.buildFromTemplate([
    { label: 'Cameras', submenu: cameraItems },
    {
      label: 'Sound',
      type: 'checkbox',
      checked: prefs.sound,
      click: (item) => {
        prefs.sound = item.checked
        savePrefs()
      }
    },
    {
      label: 'Instant snapshot',
      type: 'checkbox',
      checked: prefs.snapshot,
      click: (item) => {
        prefs.snapshot = item.checked
        savePrefs()
      }
    },
    {
      label: 'Show all objects in frame',
      type: 'checkbox',
      checked: prefs.showAllObjectsInFrame !== false,
      click: (item) => {
        prefs.showAllObjectsInFrame = item.checked
        savePrefs()
      }
    },
    {
      label: 'Show bounding boxes',
      type: 'checkbox',
      checked: prefs.showBoundingBoxes !== false,
      click: (item) => {
        prefs.showBoundingBoxes = item.checked
        savePrefs()
      }
    },
    { label: 'Dismiss after', submenu: dismissItems },
    { type: 'separator' },
    { label: 'Check for updates…', click: () => checkForUpdates(true) },
    {
      label: 'Check on launch',
      type: 'checkbox',
      checked: prefs.autoUpdate,
      click: (item) => {
        prefs.autoUpdate = item.checked
        savePrefs()
      }
    },
    { label: 'Settings…', click: () => openSetup() },
    { label: 'Open config folder', click: () => shell.openPath(app.getPath('userData')) },
    { label: 'Quit', role: 'quit' }
  ])

  if (tray) tray.setContextMenu(menu)
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Peek')
  buildMenu()
}

function handleEvent(data) {
  const after = data.after || data.before
  if (!after || !after.label) return

  learnCamera(after.camera)
  if (!cameraEnabled(after.camera)) return

  const labels = config.labels || []
  if (labels.length && !labels.includes(after.label)) return

  const score = Math.max(after.score || 0, after.top_score || 0)
  const minScore = config.minScore != null ? config.minScore : 0.6
  if (data.type === 'new' && score < minScore) return

  const subLabel = Array.isArray(after.sub_label) ? after.sub_label[0] : after.sub_label
  const detect = cameraDetectMap[after.camera]
  let boxRelative = null
  if (detect && after.box && after.box.length === 4) {
    boxRelative = [
      after.box[0] / detect.width,
      after.box[1] / detect.height,
      after.box[2] / detect.width,
      after.box[3] / detect.height
    ]
  }

  let streamUrlPath = streamUrl(after.camera)
  if (after.camera === '__MOCK_CAMERA__') {
    streamUrlPath = '__MOCK_IMAGE__'
    boxRelative = [500/1280, 150/720, 750/1280, 650/720] // Static math for Big Buck Bunny
  }

  let realId = after.id
  while (eventAliases.has(realId)) {
    realId = eventAliases.get(realId)
  }
  after.id = realId

  if (data.type === 'new') {
    const now = Date.now()
    let bestMatch = null
    let minDistance = 0.2

    for (const [id, hist] of recentEvents.entries()) {
      if (hist.camera !== after.camera || hist.label !== after.label) continue
      if (now - hist.time > 15000) continue

      if (hist.box && boxRelative) {
        const cx1 = (hist.box[0] + hist.box[2]) / 2
        const cy1 = (hist.box[1] + hist.box[3]) / 2
        const cx2 = (boxRelative[0] + boxRelative[2]) / 2
        const cy2 = (boxRelative[1] + boxRelative[3]) / 2
        
        const dist = Math.sqrt((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2)
        if (dist < minDistance) {
          minDistance = dist
          bestMatch = id
        }
      }
    }

    if (bestMatch) {
      eventAliases.set(after.id, bestMatch)
      after.id = bestMatch
      data.type = 'update'
    }
  }

  const event = {
    id: after.id,
    type: data.type,
    name: prettyName(after.camera),
    label: after.label,
    score,
    subLabel: subLabel || null,
    plate: after.recognized_license_plate || null,
    zones: after.entered_zones || [],
    box: prefs.showBoundingBoxes !== false ? normalizeBox(after.box, after.camera) : null,
    streamUrl: streamUrlPath,
    poster: prefs.snapshot ? snapshotUrl(after.camera) : null,
    sound: prefs.sound,
    dismiss: prefs.dismissSeconds,
    clickUrl: clickUrlForEvent(after.camera, after.id),
    boxRelative,
    cropToObject: prefs.cropToObject,
    cropRatio: prefs.cropRatio || '16:9',
    showAllObjectsInFrame: true
  }

  let targetId = prefs.showAllObjectsInFrame !== false ? after.camera : after.id

  if (prefs.showAllObjectsInFrame === false) {
    if (data.type === 'end') {
      if (eventGroupMap.has(after.id)) {
        targetId = eventGroupMap.get(after.id)
        eventGroupMap.delete(after.id)
      }
    } else {
      let currentGroup = eventGroupMap.get(after.id)
      let needsNewGroup = false

      if (currentGroup && (activeWindows.has(currentGroup) || pendingEvents.has(currentGroup))) {
        const primaryHist = recentEvents.get(currentGroup)
        if (primaryHist && primaryHist.box && event.boxRelative) {
          const vpA = getViewportForBox(primaryHist.box, after.camera)
          const vpB = getViewportForBox(event.boxRelative, after.camera)
          if (!viewportsOverlap(vpA, vpB)) {
            const wOld = activeWindows.get(currentGroup)
            if (wOld && !wOld.isDestroyed()) {
              wOld.webContents.send('frigate-event', { ...event, type: 'end' })
            }
            currentGroup = null
            needsNewGroup = true
            data.type = 'new'
            event.type = 'new'
          }
        }
      }

      if (!currentGroup) {
        let bestGroup = null
        if (event.boxRelative) {
          const vpB = getViewportForBox(event.boxRelative, after.camera)
          const candidates = [...activeWindows.keys(), ...pendingEvents.keys()]
          for (const winId of candidates) {
            if (activeWindows.has(winId) && activeWindows.get(winId).isDestroyed()) continue
            const hist = recentEvents.get(winId)
            if (hist && hist.camera === after.camera && hist.box) {
              const vpA = getViewportForBox(hist.box, after.camera)
              if (viewportsOverlap(vpA, vpB)) {
                bestGroup = winId
                break
              }
            }
          }
        }
        
        if (bestGroup) {
          targetId = bestGroup
          eventGroupMap.set(after.id, targetId)
        } else {
          targetId = after.id
          eventGroupMap.set(after.id, targetId)
        }
      } else {
        targetId = currentGroup
      }
    }
  }

  if (closedEvents.has(after.id)) return

  if (data.type === 'update' && !activeWindows.has(targetId) && !pendingEvents.has(targetId)) {
    data.type = 'new'
    event.type = 'new'
  }

  if (data.type === 'new') {
    if (activeWindows.has(targetId)) {
      const w = activeWindows.get(targetId)
      if (w && !w.isDestroyed()) {
        if (w.isLoading) {
          w.eventQueue.push(event)
        } else {
          w.webContents.send('frigate-event', event)
        }
      }
    } else if (activeWindows.size >= 4) {
      pendingEvents.set(targetId, event)
      positionWindows()
    } else {
      const w = createEventWindow(targetId)
      activeWindows.set(targetId, w)
      positionWindows()
      w.showInactive()
      w.eventQueue.push(event)
      w.webContents.on('did-finish-load', () => {
        updateAudio()
      })
    }
  } else {
    if (pendingEvents.has(targetId)) {
      if (data.type === 'end') {
        pendingEvents.delete(targetId)
        markEventClosed(targetId)
      } else {
        pendingEvents.set(targetId, event)
      }
      positionWindows()
    } else {
      const w = activeWindows.get(targetId)
      if (w && !w.isDestroyed()) {
        if (w.isLoading) {
          w.eventQueue.push(event)
        } else {
          w.webContents.send('frigate-event', event)
        }
      }
    }
  }

  recentEvents.set(after.id, {
    camera: after.camera,
    label: after.label,
    box: boxRelative,
    time: Date.now()
  })

  if (Math.random() < 0.05) {
    const now = Date.now()
    for (const [id, hist] of recentEvents.entries()) {
      if (now - hist.time > 60000) recentEvents.delete(id)
    }
  }
}

function startMqtt() {
  const prefix = config.topicPrefix || 'frigate'
  mqttClient = mqtt.connect(config.mqtt, { reconnectPeriod: 3000 })
  mqttClient.on('connect', () => mqttClient.subscribe(`${prefix}/events`))
  mqttClient.on('message', (topic, payload) => {
    let data
    try {
      data = JSON.parse(payload.toString())
    } catch (err) {
      return
    }
    handleEvent(data)
  })
}

function applyCertPin() {
  if (certProcSet) return
  certProcSet = true
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (frigatePin && request.hostname === frigatePin.host) {
      const sha = frigateAuth.pemToDerSha256(request.certificate && request.certificate.data)
      if (sha && sha === frigatePin.certSha256) {
        callback(0)
        return
      }
    }
    callback(-3)
  })
}

function parseJwtExp(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch (err) {
    return null
  }
}

function scheduleTokenRefresh(token) {
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer)
  const exp = parseJwtExp(token)
  if (!exp) return
  const msUntilExpiry = exp * 1000 - Date.now()
  const delay = Math.min(Math.max(msUntilExpiry - 60 * 1000, 60 * 1000), 55 * 60 * 1000)
  tokenRefreshTimer = setTimeout(() => initFrigateAuth(), delay)
}

async function initFrigateAuth() {
  if (!config || !config.frigateUser || !frigateAuth.isHttps(config.frigateUrl)) return
  try {
    const { token, certSha256 } = await frigateAuth.login(config.frigateUrl, config.frigateUser, config.frigatePassword)
    frigateToken = token
    frigatePin = { host: new URL(config.frigateUrl).hostname, certSha256 }
    applyCertPin()
    await session.defaultSession.cookies.set({
      url: config.frigateUrl,
      name: 'frigate_token',
      value: token,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction'
    })
    scheduleTokenRefresh(token)
  } catch (err) {
    console.error('[frigate-auth] ' + err.message)
  }
}

function startApp() {
  appStarted = true
  loadPrefs()
  applyOpenAtLogin(prefs.openAtLogin)
  initIndicatorWin()
  createTray()
  initFrigateAuth().then(() => fetchFrigateConfig(frigateToken))
  startMqtt()
}

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.focus()
    return
  }
  setupWin = new BrowserWindow({
    width: 460,
    height: appStarted ? 1020 : 796,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: 'Peek Setup',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  setupWin.loadFile(path.join(__dirname, 'setup', 'setup.html'))
  setupWin.once('ready-to-show', () => setupWin.show())
  setupWin.on('closed', () => {
    const wasStarted = appStarted
    setupWin = null
    if (!wasStarted) app.quit()
  })
}

function testMqtt(cfg) {
  return new Promise((resolve) => {
    let done = false
    let client = null
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { if (client) client.end(true) } catch (err) {}
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: 'Timed out. Check the host, port and credentials.' }),
      7000
    )
    try {
      client = mqtt.connect(cfg.mqtt, { reconnectPeriod: 0, connectTimeout: 6000 })
    } catch (err) {
      finish({ ok: false, error: 'Invalid MQTT address.' })
      return
    }
    client.on('connect', () => finish({ ok: true }))
    client.on('error', (err) => finish({ ok: false, error: (err && err.message) || 'Connection failed.' }))
  })
}

async function testConnection(cfg) {
  const mqttRes = await testMqtt(cfg)
  if (!mqttRes.ok) return mqttRes
  if (cfg.frigateUser && frigateAuth.isHttps(cfg.frigateUrl)) {
    try {
      await frigateAuth.login(cfg.frigateUrl, cfg.frigateUser, cfg.frigatePassword)
      return { ok: true, detail: 'MQTT broker and Frigate login OK.' }
    } catch (err) {
      return { ok: false, error: 'MQTT OK, but Frigate: ' + err.message }
    }
  }
  return mqttRes
}

function openUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.focus()
    return
  }
  updateWin = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: 'Update Peek',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'update-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  updateWin.loadFile(path.join(__dirname, 'update', 'update.html'))
  updateWin.once('ready-to-show', () => updateWin.show())
  updateWin.on('closed', () => { updateWin = null })
}

const NOTIFY_THROTTLE_MS = 24 * 60 * 60 * 1000

async function checkForUpdates(manual) {
  let latest
  try {
    latest = await updater.getLatest(prefs.updateRepo || undefined)
  } catch (err) {
    if (manual) {
      dialog.showMessageBox({ type: 'error', title: 'Peek', message: 'Could not check for updates.', detail: err.message })
    }
    return
  }
  const current = app.getVersion()
  if (!updater.isNewer(latest.version, current)) {
    if (manual) {
      dialog.showMessageBox({ type: 'info', title: 'Peek', message: 'You are up to date.', detail: 'Peek ' + current + ' is the latest version.' })
    }
    return
  }
  const asset = updater.pickAsset(latest.assets, process.platform)
  pendingUpdate = {
    current,
    version: latest.version,
    notes: latest.notes,
    platform: process.platform,
    asset: asset
  }
  if (manual) {
    openUpdateWindow()
    return
  }
  const now = Date.now()
  if (!updater.shouldNotify(prefs, latest.version, now, NOTIFY_THROTTLE_MS)) {
    return
  }
  prefs.lastNotify = { version: latest.version, at: now }
  savePrefs()
  notifyUpdate(latest.version)
}

function notifyUpdate(version) {
  if (!Notification.isSupported()) {
    openUpdateWindow()
    return
  }
  const note = new Notification({
    title: 'Update available',
    body: 'Peek ' + version + ' is ready. Click to see what’s new.'
  })
  note.on('click', () => openUpdateWindow())
  note.show()
}

function runInstaller(file, mode) {
  if (process.platform === 'win32') {
    const child = spawn(file, mode === 'silent' ? ['/S'] : [], { detached: true, stdio: 'ignore' })
    child.unref()
    setTimeout(() => app.quit(), 800)
  } else {
    shell.openPath(file)
  }
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function installMacUpdate(zipPath) {
  const appBundle = path.resolve(app.getPath('exe'), '..', '..', '..')
  if (!/\.app$/.test(appBundle)) {
    return { error: 'Could not locate the app bundle.' }
  }
  const parent = path.dirname(appBundle)
  try {
    fs.accessSync(parent, fs.constants.W_OK)
  } catch (err) {
    shell.showItemInFolder(zipPath)
    return { error: 'Cannot update in place here. The download was revealed in Finder so you can replace Peek manually.' }
  }
  const work = path.join(app.getPath('temp'), 'peek-update-' + process.pid)
  let newApp
  try {
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(work, { recursive: true })
    execFileSync('ditto', ['-x', '-k', zipPath, work])
    newApp = path.join(work, path.basename(appBundle))
    if (!fs.existsSync(newApp)) {
      return { error: 'Update package did not contain the app.' }
    }
    execFileSync('xattr', ['-cr', newApp])
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', newApp])
  } catch (err) {
    return { error: 'Could not prepare the update: ' + err.message }
  }
  const script = [
    '#!/bin/bash',
    'PID=' + process.pid,
    'APP=' + shellQuote(appBundle),
    'NEW=' + shellQuote(newApp),
    'STAGE="$APP.update"',
    'BACKUP="$APP.old"',
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done',
    'rm -rf "$STAGE" "$BACKUP"',
    'if ! ditto "$NEW" "$STAGE"; then exit 1; fi',
    'mv "$APP" "$BACKUP"',
    'if ! mv "$STAGE" "$APP"; then mv "$BACKUP" "$APP"; exit 1; fi',
    'xattr -cr "$APP" || true',
    'rm -rf "$BACKUP" ' + shellQuote(work),
    'open "$APP"',
    ''
  ].join('\n')
  const scriptPath = path.join(app.getPath('temp'), 'peek-update-' + process.pid + '.sh')
  try {
    fs.writeFileSync(scriptPath, script, { mode: 0o755 })
  } catch (err) {
    return { error: 'Could not stage the update: ' + err.message }
  }
  const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()
  setTimeout(() => app.quit(), 400)
  return { ok: true }
}

async function installUpdate(mode) {
  if (!pendingUpdate || !pendingUpdate.asset) {
    return { error: 'No matching download for this platform.' }
  }
  const dest = path.join(app.getPath('temp'), pendingUpdate.asset.name)
  try {
    await updater.download(pendingUpdate.asset.url, dest, (p) => {
      if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('update-progress', p)
    })
  } catch (err) {
    return { error: 'Download failed: ' + err.message }
  }
  if (process.platform === 'darwin' && app.isPackaged && /\.zip$/i.test(dest)) {
    return installMacUpdate(dest)
  }
  runInstaller(dest, mode)
  return { ok: true }
}

app.whenReady().then(() => {
  if (!gotInstanceLock) return
  if (process.platform === 'darwin' && app.dock && !readPrefs().showDock) app.dock.hide()

  const { powerMonitor } = require('electron')
  powerMonitor.on('resume', () => {
    if (mqttClient) mqttClient.reconnect()
    initFrigateAuth()
  })

  ipcMain.on('overlay-hide', (e, eventIds) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w && !w.isDestroyed()) {
      if (Array.isArray(eventIds)) {
        eventIds.forEach(id => markEventClosed(id))
      }
      w.close()
    }
  })
  ipcMain.on('overlay-resize', (e, { width, height }) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w && !w.isDestroyed()) {
      w.dynamicWidth = width
      positionWindows()
    }
  })
  ipcMain.on('overlay-open-url', (e, url) => {
    if (typeof url === 'string' && config && config.frigateUrl && url.startsWith(config.frigateUrl)) {
      shell.openExternal(url)
    }
  })
  ipcMain.handle('setup-load', () => readConfig())
  ipcMain.handle('setup-test', (e, cfg) => testConnection(cfg))
  ipcMain.handle('setup-load-prefs', () => {
    const p = prefs || readPrefs()
    const cameras = appStarted
      ? [...knownCameras].sort().map(name => ({ name, label: prettyName(name), enabled: cameraEnabled(name) }))
      : []
    return {
      autoUpdate: !!(p && p.autoUpdate),
      updateRepo: (p && p.updateRepo) || '',
      showDock: !!(p && p.showDock),
      openAtLogin: !!(p && p.openAtLogin),
      clickAction: (p && p.clickAction) || 'event',
      platform: process.platform,
      started: appStarted,
      sound: !!(p && p.sound),
      snapshot: !!(p && p.snapshot),
      cropToObject: !!(p && p.cropToObject),
      cropRatio: (p && p.cropRatio) || '16:9',
      highResStream: !!(p && p.highResStream),
      dismissSeconds: p && p.dismissSeconds != null ? p.dismissSeconds : 8,
      showAllObjectsInFrame: p && p.showAllObjectsInFrame !== false,
      showBoundingBoxes: p && p.showBoundingBoxes !== false,
      cameras
    }
  })
  ipcMain.handle('setup-save', (e, cfg, opts) => {
    saveConfig(cfg)
    const wantUpdates = !!(opts && opts.autoUpdate)
    const wantDock = !!(opts && opts.showDock)
    const wantOpenAtLogin = !!(opts && opts.openAtLogin)
    if (!appStarted) {
      config = cfg
      startApp()
      prefs.autoUpdate = wantUpdates
      if (opts && opts.updateRepo !== undefined) prefs.updateRepo = opts.updateRepo
      prefs.showDock = wantDock
      prefs.openAtLogin = wantOpenAtLogin
      savePrefs()
      applyOpenAtLogin(wantOpenAtLogin)
      if (process.platform === 'darwin' && app.dock) {
        if (wantDock) app.dock.show()
        else app.dock.hide()
      }
      if (setupWin && !setupWin.isDestroyed()) setupWin.close()
      if (wantUpdates) setTimeout(() => checkForUpdates(false), 4000)
    } else {
      const needsReconnect = !config ||
        config.frigateUrl !== cfg.frigateUrl ||
        config.mqtt !== cfg.mqtt ||
        config.frigateUser !== cfg.frigateUser ||
        config.frigatePassword !== cfg.frigatePassword
      const wasUpdates = !!prefs.autoUpdate
      prefs.autoUpdate = wantUpdates
      if (opts && opts.updateRepo !== undefined) prefs.updateRepo = opts.updateRepo
      prefs.showDock = wantDock
      prefs.openAtLogin = wantOpenAtLogin
      applyRuntimePrefs(opts)
      savePrefs()
      applyOpenAtLogin(wantOpenAtLogin)
      if (needsReconnect) {
        app.relaunch()
        app.exit(0)
        return { ok: true }
      }
      config = cfg
      if (process.platform === 'darwin' && app.dock) {
        if (wantDock) app.dock.show()
        else app.dock.hide()
      }
      buildMenu()
      if (setupWin && !setupWin.isDestroyed()) setupWin.close()
      if (wantUpdates && !wasUpdates) setTimeout(() => checkForUpdates(false), 1000)
    }
    return { ok: true }
  })
  ipcMain.on('setup-cancel', () => {
    if (setupWin && !setupWin.isDestroyed()) setupWin.close()
  })

  ipcMain.handle('update-data', () => pendingUpdate)
  ipcMain.handle('update-install', (e, mode) => installUpdate(mode))
  ipcMain.on('update-later', () => {
    if (updateWin && !updateWin.isDestroyed()) updateWin.close()
  })
  ipcMain.on('update-skip', () => {
    if (pendingUpdate && pendingUpdate.version) {
      prefs.skipVersion = pendingUpdate.version
      savePrefs()
    }
    if (updateWin && !updateWin.isDestroyed()) updateWin.close()
  })

  config = readConfig()
  if (config) {
    startApp()
    if (prefs.autoUpdate) setTimeout(() => checkForUpdates(false), 4000)
  } else {
    openSetup()
  }
})

app.on('window-all-closed', () => {})
