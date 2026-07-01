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

async function simulateSequence(client, prefix, camera, label, startBox, endBox, durationMs, steps, delayBeforeStart = 0) {
  await sleep(delayBeforeStart);
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

  // Send updates to simulate movement
  for (let i = 1; i <= steps; i++) {
    await sleep(durationMs / steps);
    const progress = i / steps;
    const currentBox = [
      Math.round(startBox[0] + (endBox[0] - startBox[0]) * progress),
      Math.round(startBox[1] + (endBox[1] - startBox[1]) * progress),
      Math.round(startBox[2] + (endBox[2] - startBox[2]) * progress),
      Math.round(startBox[3] + (endBox[3] - startBox[3]) * progress)
    ];
    sendEvent('update', currentBox);
  }

  // Send end event
  await sleep(durationMs / steps);
  sendEvent('end', endBox);
  console.log(`[${camera}] Ended event (${label})`);
}

client.on('connect', async () => {
  console.log('Connected to MQTT. Starting dynamic sequences...');
  const prefix = config.topicPrefix || 'frigate';
  
  // 1. Person on the doorbell, stationary
  const s1 = simulateSequence(
    client, prefix, 
    'doorbell', 'person', 
    [100, 100, 300, 300],  // stationary box
    [100, 100, 300, 300], 
    15000, // 15 seconds total
    150,   // updates
    0      // start immediately
  );

  // 2. Dog on the doorbell, starts overlapping with the person, then moves far away
  const s2 = simulateSequence(
    client, prefix, 
    'doorbell', 'dog', 
    [150, 150, 250, 250], // starts inside/overlapping the person's box
    [2200, 1500, 2400, 1700], // moves far away, should trigger a split
    15000, 
    150,   
    0      // start immediately
  );

  await Promise.all([s1, s2]);
  console.log('✅ All dynamic mock sequences completed!');
  client.end();
});

client.on('error', (err) => {
  console.error('MQTT connection error:', err.message);
  client.end();
});
