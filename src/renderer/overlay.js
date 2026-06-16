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

const card = document.getElementById('card')
const timerBar = document.getElementById('timer-bar')
const camEl = document.getElementById('cam')
const badgeEl = document.getElementById('badge')
const scoreEl = document.getElementById('score')
const infoEl = document.getElementById('info')
const videoBox = document.getElementById('video')
const poster = document.getElementById('poster')
const closeBtn = document.getElementById('close')

let activeId = null
let activeStreamUrl = null
let stream = null
let dismissTimer = null
let timerAnimation = null

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
  timerAnimation.onfinish = () => { timerAnimation = null }
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

function applyVideoSettings(muted) {
  if (!stream) return
  if (stream.video) {
    stream.video.muted = muted
    stream.video.controls = false
    stream.video.disableRemotePlayback = true
    stream.video.addEventListener('playing', () => {
      poster.style.opacity = '0'
    }, { once: true })
  } else {
    requestAnimationFrame(() => applyVideoSettings(muted))
  }
}

function startStream(url, muted) {
  stopStream()
  stream = document.createElement('video-stream')
  stream.background = true
  stream.mode = 'webrtc,mse'
  stream.src = url
  videoBox.appendChild(stream)
  applyVideoSettings(muted)
}

function stopStream() {
  if (stream) {
    stream.ondisconnect()
    stream.remove()
    stream = null
  }
}

function render(event) {
  camEl.textContent = event.name
  badgeEl.textContent = labelText(event.label)
  scoreEl.textContent = Math.round(event.score * 100) + '%'

  const extras = []
  if (event.subLabel) extras.push('👤 ' + event.subLabel)
  if (event.plate) extras.push('🔢 ' + event.plate)
  if (event.zones && event.zones.length) extras.push('📍 ' + event.zones.join(', '))
  infoEl.textContent = extras.join('   ')
  infoEl.style.display = extras.length ? 'block' : 'none'
}

function show(event) {
  clearTimeout(dismissTimer)
  activeId = event.id
  render(event)
  showTimerBarActive()
  if (stream && event.streamUrl === activeStreamUrl && card.classList.contains('show')) return
  if (event.poster) {
    poster.style.opacity = '1'
    poster.src = event.poster + (event.poster.includes('?') ? '&' : '?') + 't=' + Date.now()
  } else {
    poster.style.opacity = '0'
    poster.removeAttribute('src')
  }
  activeStreamUrl = event.streamUrl
  startStream(event.streamUrl, !event.sound)
  card.classList.remove('hidden')
  requestAnimationFrame(() => card.classList.add('show'))
}

function hide() {
  clearTimeout(dismissTimer)
  resetTimerBar()
  activeId = null
  activeStreamUrl = null
  card.classList.remove('show')
  setTimeout(() => {
    stopStream()
    card.classList.add('hidden')
    window.overlay.hide()
  }, 320)
}

window.overlay.onEvent((event) => {
  if (event.type === 'new') {
    show(event)
  } else if (event.type === 'update' && event.id === activeId) {
    render(event)
  } else if (event.type === 'end' && event.id === activeId) {
    render(event)
    if (event.dismiss > 0) {
      dismissTimer = setTimeout(hide, event.dismiss * 1000)
      startTimerBar(event.dismiss)
    }
  }
})

closeBtn.addEventListener('click', hide)
