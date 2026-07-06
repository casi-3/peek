function getOverlaySize(config, prefs, dynamicWidth = null) {
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

function getViewportForBox(boxRelative, camera, cameraDetectMap, config, prefs) {
  const detect = cameraDetectMap[camera] || { width: 1280, height: 720 }
  const VW = detect.width
  const VH = detect.height
  const { width: winW, height: winH } = getOverlaySize(config, prefs)
  
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

function getCombinedBoxForWindow(winId, eventGroupMap, recentEvents) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0
  let found = false
  for (const [evtId, targetId] of eventGroupMap.entries()) {
    if (targetId === winId) {
      const hist = recentEvents.get(evtId)
      if (hist && hist.box) {
        minX = Math.min(minX, hist.box[0])
        minY = Math.min(minY, hist.box[1])
        maxX = Math.max(maxX, hist.box[2])
        maxY = Math.max(maxY, hist.box[3])
        found = true
      }
    }
  }
  return found ? [minX, minY, maxX, maxY] : null
}

function getCombinedBoxForWindowExcluding(winId, excludeEvtId, eventGroupMap, recentEvents) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0
  let found = false
  for (const [evtId, targetId] of eventGroupMap.entries()) {
    if (targetId === winId && evtId !== excludeEvtId) {
      const hist = recentEvents.get(evtId)
      if (hist && hist.box) {
        minX = Math.min(minX, hist.box[0])
        minY = Math.min(minY, hist.box[1])
        maxX = Math.max(maxX, hist.box[2])
        maxY = Math.max(maxY, hist.box[3])
        found = true
      }
    }
  }
  return found ? [minX, minY, maxX, maxY] : null
}

function getGroupForNewEvent(event, cameraDetectMap, config, prefs, activeWindows, pendingEvents, eventGroupMap, recentEvents) {
  if (prefs.showAllObjectsInFrame !== false) {
    return event.camera
  }
  
  if (!event.boxRelative) {
    return event.id
  }

  const vpB = getViewportForBox(event.boxRelative, event.camera, cameraDetectMap, config, prefs)
  const candidates = [...activeWindows.keys(), ...pendingEvents.keys()]
  
  for (const winId of candidates) {
    const w = activeWindows.get(winId)
    if (w && typeof w.isDestroyed === 'function' && w.isDestroyed()) continue

    const combinedBox = getCombinedBoxForWindow(winId, eventGroupMap, recentEvents)
    if (combinedBox) {
      const vpA = getViewportForBox(combinedBox, event.camera, cameraDetectMap, config, prefs)
      if (viewportsOverlap(vpA, vpB)) {
        return winId
      }
    }
  }

  return event.id
}

function checkSplitForEvent(event, cameraDetectMap, config, prefs, activeWindows, pendingEvents, eventGroupMap, recentEvents) {
  if (prefs.showAllObjectsInFrame !== false) {
    return { shouldSplit: false, action: null, splitEventIds: [] }
  }

  const currentGroup = eventGroupMap.get(event.id)
  if (!currentGroup) {
    return { shouldSplit: false, action: null, splitEventIds: [] }
  }

  const hasWindow = activeWindows.has(currentGroup) || pendingEvents.has(currentGroup)
  if (!hasWindow) {
    return { shouldSplit: false, action: null, splitEventIds: [] }
  }

  const w = activeWindows.get(currentGroup)
  if (w && typeof w.isDestroyed === 'function' && w.isDestroyed()) {
    return { shouldSplit: false, action: null, splitEventIds: [] }
  }

  if (!event.boxRelative) {
    return { shouldSplit: false, action: null, splitEventIds: [] }
  }

  const combinedBoxOthers = getCombinedBoxForWindowExcluding(currentGroup, event.id, eventGroupMap, recentEvents)
  if (!combinedBoxOthers) {
    // Sole event in group, no need to split
    return { shouldSplit: false, action: null, splitEventIds: [] }
  }

  const vpOthers = getViewportForBox(combinedBoxOthers, event.camera, cameraDetectMap, config, prefs)
  const vpSelf = getViewportForBox(event.boxRelative, event.camera, cameraDetectMap, config, prefs)

  if (!viewportsOverlap(vpOthers, vpSelf)) {
    if (event.id === currentGroup) {
      // Group leader is splitting. Split all other events out instead.
      const otherEventIds = []
      for (const [evtId, targetId] of eventGroupMap.entries()) {
        if (targetId === currentGroup && evtId !== event.id) {
          otherEventIds.push(evtId)
        }
      }
      return { shouldSplit: true, action: 'split_others', splitEventIds: otherEventIds }
    } else {
      // Non-leader event is splitting. Split itself out.
      return { shouldSplit: true, action: 'split_self', splitEventIds: [event.id] }
    }
  }

  return { shouldSplit: false, action: null, splitEventIds: [] }
}

module.exports = {
  getOverlaySize,
  getViewportForBox,
  viewportsOverlap,
  getCombinedBoxForWindow,
  getCombinedBoxForWindowExcluding,
  getGroupForNewEvent,
  checkSplitForEvent
}
