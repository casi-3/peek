const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlay', {
  onEvent: (callback) => ipcRenderer.on('frigate-event', (event, data) => callback(data)),
  hide: () => ipcRenderer.send('overlay-hide'),
  openUrl: (url) => ipcRenderer.send('overlay-open-url', url)
})
