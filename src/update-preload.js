const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('peekUpdate', {
  load: () => ipcRenderer.invoke('update-data'),
  install: (mode) => ipcRenderer.invoke('update-install', mode),
  later: () => ipcRenderer.send('update-later'),
  skip: () => ipcRenderer.send('update-skip'),
  onProgress: (cb) => ipcRenderer.on('update-progress', (e, p) => cb(p)),
  onError: (cb) => ipcRenderer.on('update-error', (e, msg) => cb(msg))
})
