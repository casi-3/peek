const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

// Read the global Peek config
const candidatePaths = [
  path.join(process.cwd(), 'config.json'),
  path.join(__dirname, 'config.json'),
  process.env.APPDATA ? path.join(process.env.APPDATA, 'Peek', 'config.json') : null,
  process.platform === 'darwin' ? path.join(process.env.HOME, 'Library', 'Application Support', 'peek', 'config.json') : null,
  process.platform === 'linux' ? path.join(process.env.HOME, '.config', 'peek', 'config.json') : null,
].filter(Boolean);

let config;
for (const cp of candidatePaths) {
  if (fs.existsSync(cp)) {
    try {
      config = JSON.parse(fs.readFileSync(cp, 'utf8'));
      break;
    } catch (e) {
      console.error(`Error reading config from ${cp}:`, e);
    }
  }
}

if (!config) {
  console.error("Could not find or read config.json in any of the expected locations.");
  process.exit(1);
}

const client = mqtt.connect(config.mqtt);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function simulateSequence(client, prefix, camera, label, startBox, endBox, movementDurationMs, steps, delayBeforeStart = 0, delayBeforeMovement = 3000, delayAfterMovement = 3000) {
  if (delayBeforeStart > 0) {
    await sleep(delayBeforeStart);
  }
  const eventId = `test-${camera}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  
  const sendEvent = (type, box) => {
    const payload = {
      type: type,
      after: {
        id: eventId,
        camera: camera,
        label: label,
        score: 0.85,
        box: box
      }
    };
    client.publish(`${prefix}/events`, JSON.stringify(payload));
  };

  console.log(`[${camera}] Started new event (${label})`);
  sendEvent('new', startBox);

  // Delay before movement begins (to allow stream load)
  if (delayBeforeMovement > 0) {
    const stepsDelay = Math.ceil(delayBeforeMovement / 500);
    for (let i = 0; i < stepsDelay; i++) {
      await sleep(delayBeforeMovement / stepsDelay);
      sendEvent('update', startBox);
    }
  }

  // Send updates to simulate movement
  if (movementDurationMs > 0 && steps > 0) {
    for (let i = 1; i <= steps; i++) {
      await sleep(movementDurationMs / steps);
      const progress = i / steps;
      const currentBox = [
        Math.round(startBox[0] + (endBox[0] - startBox[0]) * progress),
        Math.round(startBox[1] + (endBox[1] - startBox[1]) * progress),
        Math.round(startBox[2] + (endBox[2] - startBox[2]) * progress),
        Math.round(startBox[3] + (endBox[3] - startBox[3]) * progress)
      ];
      sendEvent('update', currentBox);
    }
  }

  // Delay after movement ends
  if (delayAfterMovement > 0) {
    const stepsDelay = Math.ceil(delayAfterMovement / 500);
    for (let i = 0; i < stepsDelay; i++) {
      await sleep(delayAfterMovement / stepsDelay);
      sendEvent('update', endBox);
    }
  }

  // Send end event
  sendEvent('end', endBox);
  console.log(`[${camera}] Ended event (${label})`);
}

client.on('connect', async () => {
  console.log('Connected to MQTT. Starting dynamic sequences...');
  const prefix = config.topicPrefix || 'frigate';
  
  // 1. Person on the doorbell, moves slowly
  const s1 = simulateSequence(
    client, prefix, 
    'doorbell', 'person', 
    [100, 100, 300, 300],  // starts at [100, 100]
    [400, 400, 600, 600],  // moves slowly to [400, 400]
    8000,                  // moves over 8s
    40,                    // steps
    0,                     // start immediately
    3000,                  // 3s delay before movement
    3000                   // 3s delay after movement
  );

  // 2. Dog on the doorbell, starts overlapping with the person, then moves rapidly away
  const s2 = simulateSequence(
    client, prefix, 
    'doorbell', 'dog', 
    [150, 150, 250, 250], // starts inside/overlapping the person's box
    [2200, 1500, 2400, 1700], // moves rapidly away, should trigger a split
    8000,                 // moves over 8s
    40,                   // steps
    0,                    // start immediately
    3000,                 // 3s delay before movement
    3000                  // 3s delay after movement
  );

  await Promise.all([s1, s2]);
  console.log('✅ All dynamic mock sequences completed!');
  client.end();
});

client.on('error', (err) => {
  console.error('MQTT connection error:', err.message);
  client.end();
});
