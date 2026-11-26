const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlay', {
  onEvent: (callback) => ipcRenderer.on('frigate-event', (event, data) => callback(data)),
  hide: () => ipcRenderer.send('overlay-hide'),
  streamFailed: () => ipcRenderer.send('overlay-stream-failed'),
  onReauth: (callback) => ipcRenderer.on('frigate-reauthed', () => callback()),
  openUrl: (url) => ipcRenderer.send('overlay-open-url', url),
  showMenu: () => ipcRenderer.send('overlay-menu'),
  onMenuClosed: (callback) => ipcRenderer.on('overlay-menu-closed', () => callback()),
  onMode: (callback) => ipcRenderer.on('overlay-mode', (event, mode) => callback(mode)),
  lockPlacement: () => ipcRenderer.send('placement-save'),
  cancelPlacement: () => ipcRenderer.send('placement-cancel'),
  resize: (aspect) => ipcRenderer.send('overlay-resize', aspect),
  scaleBy: (factor) => ipcRenderer.send('overlay-scale', factor),
  onLiveOpen: (callback) => ipcRenderer.on('live-open', (event, data) => callback(data)),
  onDismiss: (callback) => ipcRenderer.on('overlay-dismiss', () => callback()),
  onLiveClose: (callback) => ipcRenderer.on('live-close', (event, opts) => callback(opts || {}))
})
