const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('setup', {
  load: () => ipcRenderer.invoke('setup-load'),
  loadPrefs: () => ipcRenderer.invoke('setup-load-prefs'),
  test: (config) => ipcRenderer.invoke('setup-test', config),
  save: (config, opts) => ipcRenderer.invoke('setup-save', config, opts),
  cancel: () => ipcRenderer.send('setup-cancel'),
  checkHotkey: (accelerator) => ipcRenderer.invoke('setup-check-hotkey', accelerator),
  captureHotkey: (capturing) => ipcRenderer.send('setup-hotkey-capture', capturing)
})
