const test = require('node:test')
const assert = require('node:assert')
const {
  getOverlaySize,
  getViewportForBox,
  viewportsOverlap,
  getCombinedBoxForWindow,
  getCombinedBoxForWindowExcluding,
  getGroupForNewEvent,
  checkSplitForEvent
} = require('../src/grouping')

test('getOverlaySize calculates correct dimensions', () => {
  const config = { width: 500, height: 300 }
  const prefs = { cropToObject: true, cropRatio: '16:9' }
  
  // Crop to object = true, 16:9 ratio
  const size1 = getOverlaySize(config, prefs)
  assert.strictEqual(size1.height, 300)
  assert.strictEqual(size1.width, 533) // 300 * 16 / 9 = 533.33 -> 533

  // Crop to object = false, fallback to dynamic width
  const prefs2 = { cropToObject: false }
  const size2 = getOverlaySize(config, prefs2, 600)
  assert.strictEqual(size2.width, 600)

  // Crop to object = false, no dynamic width, fallback to config.width
  const size3 = getOverlaySize(config, prefs2)
  assert.strictEqual(size3.width, 500)
})

test('getViewportForBox and viewportsOverlap work with overlapping/non-overlapping coordinates', () => {
  const config = { height: 300 }
  const prefs = { cropToObject: true, cropRatio: '16:9' }
  const cameraDetectMap = { doorbell: { width: 1280, height: 720 } }

  const box1 = [100/1280, 100/720, 300/1280, 300/720] // Object 1 (top-left)
  const box2 = [150/1280, 150/720, 250/1280, 250/720] // Object 2 (inside Object 1)
  const box3 = [800/1280, 500/720, 900/1280, 600/720] // Object 3 (bottom-right)

  const vp1 = getViewportForBox(box1, 'doorbell', cameraDetectMap, config, prefs)
  const vp2 = getViewportForBox(box2, 'doorbell', cameraDetectMap, config, prefs)
  const vp3 = getViewportForBox(box3, 'doorbell', cameraDetectMap, config, prefs)

  // vp1 and vp2 should overlap
  assert.ok(viewportsOverlap(vp1, vp2), 'vp1 and vp2 should overlap')
  // vp1 and vp3 should not overlap
  assert.ok(!viewportsOverlap(vp1, vp3), 'vp1 and vp3 should not overlap')
})

test('getCombinedBoxForWindow calculates union of boxes correctly', () => {
  const eventGroupMap = new Map([
    ['eventA', 'win1'],
    ['eventB', 'win1'],
    ['eventC', 'win2']
  ])

  const recentEvents = new Map([
    ['eventA', { box: [0.1, 0.1, 0.3, 0.3] }],
    ['eventB', { box: [0.2, 0.2, 0.4, 0.4] }],
    ['eventC', { box: [0.5, 0.5, 0.6, 0.6] }]
  ])

  const combined = getCombinedBoxForWindow('win1', eventGroupMap, recentEvents)
  assert.deepStrictEqual(combined, [0.1, 0.1, 0.4, 0.4])

  const combinedExcluding = getCombinedBoxForWindowExcluding('win1', 'eventA', eventGroupMap, recentEvents)
  assert.deepStrictEqual(combinedExcluding, [0.2, 0.2, 0.4, 0.4])

  const combinedExcludingAll = getCombinedBoxForWindowExcluding('win1', 'eventB', eventGroupMap, recentEvents)
  assert.deepStrictEqual(combinedExcludingAll, [0.1, 0.1, 0.3, 0.3])
})

test('getGroupForNewEvent handles grouping decisions correctly', () => {
  const config = { height: 300 }
  const prefs = { showAllObjectsInFrame: false, cropToObject: true, cropRatio: '16:9' }
  const cameraDetectMap = { doorbell: { width: 1280, height: 720 } }

  const activeWindows = new Map([
    ['winA', { isDestroyed: () => false }]
  ])
  const pendingEvents = new Map()
  const eventGroupMap = new Map([
    ['eventA', 'winA']
  ])
  const recentEvents = new Map([
    ['eventA', { box: [100/1280, 100/720, 300/1280, 300/720] }]
  ])

  // New event close to eventA
  const eventB = {
    id: 'eventB',
    camera: 'doorbell',
    boxRelative: [150/1280, 150/720, 250/1280, 250/720]
  }

  const groupB = getGroupForNewEvent(eventB, cameraDetectMap, config, prefs, activeWindows, pendingEvents, eventGroupMap, recentEvents)
  assert.strictEqual(groupB, 'winA', 'eventB should be grouped with eventA in winA')

  // New event far from eventA
  const eventC = {
    id: 'eventC',
    camera: 'doorbell',
    boxRelative: [800/1280, 500/720, 900/1280, 600/720]
  }

  const groupC = getGroupForNewEvent(eventC, cameraDetectMap, config, prefs, activeWindows, pendingEvents, eventGroupMap, recentEvents)
  assert.strictEqual(groupC, 'eventC', 'eventC should get its own group/window ID')
})

test('checkSplitForEvent detects splitting correctly', () => {
  const config = { height: 300 }
  const prefs = { showAllObjectsInFrame: false, cropToObject: true, cropRatio: '16:9' }
  const cameraDetectMap = { doorbell: { width: 1280, height: 720 } }

  const activeWindows = new Map([
    ['eventA', { isDestroyed: () => false }]
  ])
  const pendingEvents = new Map()

  // Scenario 1: Non-leader B splits from leader A
  {
    const eventGroupMap = new Map([
      ['eventA', 'eventA'],
      ['eventB', 'eventA']
    ])
    const recentEvents = new Map([
      ['eventA', { box: [100/1280, 100/720, 300/1280, 300/720] }],
      ['eventB', { box: [800/1280, 500/720, 900/1280, 600/720] }] // already far away in history
    ])

    const eventB_update = {
      id: 'eventB',
      camera: 'doorbell',
      boxRelative: [800/1280, 500/720, 900/1280, 600/720]
    }

    const splitResult = checkSplitForEvent(eventB_update, cameraDetectMap, config, prefs, activeWindows, pendingEvents, eventGroupMap, recentEvents)
    assert.deepStrictEqual(splitResult, {
      shouldSplit: true,
      action: 'split_self',
      splitEventIds: ['eventB']
    }, 'Non-leader B should split itself')
  }

  // Scenario 2: Leader A splits (moves away) from B
  {
    const eventGroupMap = new Map([
      ['eventA', 'eventA'],
      ['eventB', 'eventA']
    ])
    const recentEvents = new Map([
      ['eventA', { box: [100/1280, 100/720, 300/1280, 300/720] }], // old A box
      ['eventB', { box: [100/1280, 100/720, 300/1280, 300/720] }] // stationary B box
    ])

    const eventA_update = {
      id: 'eventA',
      camera: 'doorbell',
      boxRelative: [800/1280, 500/720, 900/1280, 600/720] // A moved far away
    }

    const splitResult = checkSplitForEvent(eventA_update, cameraDetectMap, config, prefs, activeWindows, pendingEvents, eventGroupMap, recentEvents)
    assert.deepStrictEqual(splitResult, {
      shouldSplit: true,
      action: 'split_others',
      splitEventIds: ['eventB']
    }, 'Leader A should split others (eventB) out')
  }
})
