import { VideoRTC } from './vendor/video-rtc.js'

customElements.define('video-stream', VideoRTC)

const LABELS = {
  person: ['🧍', 'Person'],
  car: ['🚗', 'Car'],
  motorcycle: ['🏍️', 'Motorcycle'],
  bicycle: ['🚲', 'Bicycle'],
  dog: ['🐕', 'Dog'],
  cat: ['🐈', 'Cat'],
  bird: ['🐦', 'Bird'],
  package: ['📦', 'Package']
}

const COLORS = ['#ff6b6b', '#51cf66', '#339af0', '#fcc419', '#cc5de8', '#ff922b']

const card = document.getElementById('card')
const timerBar = document.getElementById('timer-bar')
const camEl = document.getElementById('cam')
const detectionsEl = document.getElementById('detections')
const infoEl = document.getElementById('info')
const videoBox = document.getElementById('video')
const bboxCanvas = document.getElementById('bbox-canvas')
const bboxCtx = bboxCanvas.getContext('2d')
const poster = document.getElementById('poster')
const closeBtn = document.getElementById('close')

const activeEvents = new Map()
const colorMap = new Map()
let colorIndex = 0
let activeStreamUrl = null
let activeClickUrl = null
let stream = null
let dismissTimer = null
let timerAnimation = null

function assignColor(id) {
  if (!colorMap.has(id)) {
    colorMap.set(id, COLORS[colorIndex % COLORS.length])
    colorIndex++
  }
  return colorMap.get(id)
}

function showTimerBarActive() {
  if (timerAnimation) { timerAnimation.cancel(); timerAnimation = null }
  timerBar.style.transform = 'scaleX(1)'
  timerBar.style.background = 'rgba(220, 60, 60, 0.85)'
  timerBar.style.opacity = '1'
}

function startTimerBar(seconds) {
  if (timerAnimation) timerAnimation.cancel()
  timerBar.style.background = 'rgba(255, 255, 255, 0.75)'
  timerBar.style.opacity = '1'
  timerAnimation = timerBar.animate(
    [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
    { duration: seconds * 1000, easing: 'linear', fill: 'forwards' }
  )
}

function resetTimerBar() {
  if (timerAnimation) { timerAnimation.cancel(); timerAnimation = null }
  timerBar.style.opacity = '0'
  timerBar.style.transform = ''
  timerBar.style.background = ''
}

function labelText(label) {
  const entry = LABELS[label]
  return entry ? `${entry[0]} ${entry[1]}` : label
}

function updateCrop() {
  if (!stream || activeEvents.size === 0) return
  
  const firstEvent = activeEvents.values().next().value
  if (!firstEvent.cropToObject) {
    if (stream) {
      stream.style.transition = 'transform 0.1s ease-out'
      stream.style.transform = ''
      stream.style.transformOrigin = '50% 50%'
      bboxCanvas.style.transition = 'transform 0.1s ease-out'
      bboxCanvas.style.transform = ''
      bboxCanvas.style.transformOrigin = '50% 50%'
    }
    return
  }
  
  const videoWidth = stream.video.videoWidth
  const videoHeight = stream.video.videoHeight
  if (!videoWidth || !videoHeight) return

  let minX = 1, minY = 1, maxX = 0, maxY = 0
  for (const ev of activeEvents.values()) {
    if (ev.boxRelative) {
      minX = Math.min(minX, ev.boxRelative[0])
      minY = Math.min(minY, ev.boxRelative[1])
      maxX = Math.max(maxX, ev.boxRelative[2])
      maxY = Math.max(maxY, ev.boxRelative[3])
    }
  }
  
  if (maxX <= minX || maxY <= minY) return

  const boxW = maxX - minX
  const boxH = maxY - minY
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2

  const VW = videoWidth
  const VH = videoHeight
  
  const objCx = cx * VW
  const objCy = cy * VH
  
  const winW = window.innerWidth
  const winH = window.innerHeight
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
  
  stream.style.transition = 'transform 0.1s ease-out'
  stream.style.transformOrigin = '0 0'
  stream.style.transform = `translate(${tx}px, ${ty}px) scale(${S})`
  
  bboxCanvas.style.transition = 'transform 0.1s ease-out'
  bboxCanvas.style.transformOrigin = '0 0'
  bboxCanvas.style.transform = `translate(${tx}px, ${ty}px) scale(${S})`
}

function syncCanvasSize() {
  const w = bboxCanvas.offsetWidth
  const h = bboxCanvas.offsetHeight
  if (!w || !h) return false
  if (bboxCanvas.width !== w || bboxCanvas.height !== h) {
    bboxCanvas.width = w
    bboxCanvas.height = h
  }
  return true
}

function getVideoTransform() {
  if (!stream || !stream.video) return null
  const vw = stream.video.videoWidth
  const vh = stream.video.videoHeight
  if (!vw || !vh) return null

  const cw = bboxCanvas.width
  const ch = bboxCanvas.height
  const videoAspect = vw / vh
  const containerAspect = cw / ch

  let scale, offsetX, offsetY
  if (videoAspect > containerAspect) {
    scale = ch / vh
    offsetX = (cw - vw * scale) / 2
    offsetY = 0
  } else {
    scale = cw / vw
    offsetX = 0
    offsetY = (ch - vh * scale) / 2
  }
  return { scale, offsetX, offsetY, vw, vh }
}

function drawBoxes() {
  if (!syncCanvasSize()) return
  bboxCtx.clearRect(0, 0, bboxCanvas.width, bboxCanvas.height)

  const t = getVideoTransform()
  if (!t) return

  for (const [id, ev] of activeEvents) {
    if (!ev.box) continue
    const color = colorMap.get(id) || '#ffffff'
    const [x1, y1, x2, y2] = ev.box

    const cx = x1 * t.vw * t.scale + t.offsetX
    const cy = y1 * t.vh * t.scale + t.offsetY
    const bw = (x2 - x1) * t.vw * t.scale
    const bh = (y2 - y1) * t.vh * t.scale
    const r = Math.min(6, bw / 4, bh / 4)

    bboxCtx.beginPath()
    bboxCtx.roundRect(cx, cy, bw, bh, r)
    bboxCtx.shadowColor = 'rgba(0,0,0,0.75)'
    bboxCtx.shadowBlur = 4
    bboxCtx.strokeStyle = color
    bboxCtx.lineWidth = 2
    bboxCtx.stroke()
    bboxCtx.shadowBlur = 0
  }
}

function clearBoxes() {
  bboxCtx.clearRect(0, 0, bboxCanvas.width, bboxCanvas.height)
}

function renderDetections() {
  const events = [...activeEvents.values()]
  if (events.length > 0) camEl.textContent = events[0].name

  detectionsEl.innerHTML = ''
  for (const ev of events) {
    const color = colorMap.get(ev.id) || 'rgba(255, 255, 255, 0.45)'
    const chip = document.createElement('div')
    chip.className = 'chip'
    chip.style.borderColor = color
    const name = document.createElement('span')
    name.textContent = labelText(ev.label)
    const score = document.createElement('span')
    score.className = 'chip-score'
    score.textContent = Math.round(ev.score * 100) + '%'
    chip.appendChild(name)
    chip.appendChild(score)
    detectionsEl.appendChild(chip)
  }

  const extras = []
  const subLabels = [...new Set(events.flatMap(e => e.subLabel ? [e.subLabel] : []))]
  const plates = [...new Set(events.flatMap(e => e.plate ? [e.plate] : []))]
  const zones = [...new Set(events.flatMap(e => e.zones || []))]
  if (subLabels.length) extras.push('👤 ' + subLabels.join(', '))
  if (plates.length) extras.push('🔢 ' + plates.join(', '))
  if (zones.length) extras.push('📍 ' + zones.join(', '))
  infoEl.textContent = extras.join('   ')
  infoEl.style.display = extras.length ? 'block' : 'none'
}

function applyVideoSettings(event, muted) {
  if (!stream) return
  if (stream.video) {
    stream.video.muted = muted
    stream.video.controls = false
    stream.video.disableRemotePlayback = true
    stream.video.addEventListener('playing', () => {
      poster.style.opacity = '0'
      const videoWidth = stream.video.videoWidth
      const videoHeight = stream.video.videoHeight
      if (videoWidth && videoHeight) {
        if (!event.cropToObject) {
          const ratio = videoWidth / videoHeight
          const newWidth = Math.round(window.innerHeight * ratio)
          window.overlay.resize(newWidth, window.innerHeight)
          stream.style.width = '100%'
          stream.style.height = '100%'
          bboxCanvas.style.width = '100%'
          bboxCanvas.style.height = '100%'
        } else {
          stream.style.width = videoWidth + 'px'
          stream.style.height = videoHeight + 'px'
          bboxCanvas.style.width = videoWidth + 'px'
          bboxCanvas.style.height = videoHeight + 'px'
        }
        
        stream.style.maxWidth = 'none'
        stream.style.position = 'absolute'
        stream.style.left = '0'
        stream.style.top = '0'
        
        drawBoxes()
        updateCrop()
      }
    }, { once: true })
  } else {
    requestAnimationFrame(() => applyVideoSettings(event, muted))
  }
}

function startStream(event, muted) {
  stopStream()
  if (event.streamUrl === '__MOCK_IMAGE__') {
    stream = document.createElement('div')
    stream.style.backgroundImage = 'url("https://picsum.photos/id/237/1280/720")'
    stream.style.backgroundSize = '100% 100%'
    stream.style.zIndex = '1'
    
    stream.video = document.createElement('div')
    stream.video.videoWidth = 1280
    stream.video.videoHeight = 720
    stream.video.style = {}
    stream.video.addEventListener = (evt, cb) => {
      if (evt === 'playing') setTimeout(() => cb(), 100)
    }
  } else {
    stream = document.createElement('video-stream')
    stream.background = true
    stream.mode = 'webrtc,mse'
    stream.src = event.streamUrl
  }
  videoBox.appendChild(stream)
  applyVideoSettings(event, muted)
}

function stopStream() {
  if (stream) {
    if (stream.ondisconnect) stream.ondisconnect()
    stream.remove()
    stream = null
  }
}
function show(event) {
  clearTimeout(dismissTimer)

  const reuseCard = activeStreamUrl && event.streamUrl === activeStreamUrl

  if (!reuseCard || !event.showAllObjectsInFrame) {
    activeEvents.clear()
    activeStreamUrl = event.streamUrl
  }

  activeClickUrl = event.clickUrl || null
  card.classList.toggle('clickable', !!activeClickUrl)

  assignColor(event.id)
  activeEvents.set(event.id, event)
  renderDetections()
  drawBoxes()
  showTimerBarActive()

  if (reuseCard) return

  if (event.poster) {
    poster.style.opacity = '1'
    poster.src = event.poster + (event.poster.includes('?') ? '&' : '?') + 't=' + Date.now()
  } else {
    poster.style.opacity = '0'
    poster.removeAttribute('src')
  }
  startStream(event, !event.sound)
  card.classList.remove('hidden')
  requestAnimationFrame(() => card.classList.add('show'))
}

function hide() {
  clearTimeout(dismissTimer)
  resetTimerBar()
  
  const eventIds = Array.from(activeEvents.keys())
  
  clearBoxes()
  activeEvents.clear()
  colorMap.clear()
  colorIndex = 0
  activeStreamUrl = null
  activeClickUrl = null
  card.classList.remove('clickable')
  card.classList.remove('show')
  setTimeout(() => {
    stopStream()
    card.classList.add('hidden')
    window.overlay.hide(eventIds)
  }, 320)
}

window.overlay.onEvent((event) => {
  if (event.type === 'new') {
    show(event)
  } else if (event.type === 'update' && activeEvents.has(event.id)) {
    activeEvents.set(event.id, event)
    renderDetections()
    drawBoxes()
    updateCrop()
  } else if (event.type === 'end' && activeEvents.has(event.id)) {
    activeEvents.delete(event.id)
    colorMap.delete(event.id)
    if (activeEvents.size > 0) {
      renderDetections()
      drawBoxes()
      updateCrop()
    } else {
      clearBoxes()
      if (event.dismiss > 0) {
        dismissTimer = setTimeout(hide, event.dismiss * 1000)
        startTimerBar(event.dismiss)
      }
    }
  }
})

window.overlay.onSetMuted && window.overlay.onSetMuted((muted) => {
  if (stream && stream.video) {
    stream.video.muted = muted
  }
})

closeBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  hide()
})

card.addEventListener('click', () => {
  if (activeClickUrl) window.overlay.openUrl(activeClickUrl)
})
