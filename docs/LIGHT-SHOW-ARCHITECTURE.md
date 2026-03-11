# Touch? Coordinated Light Show -- Technical Architecture

## Vision

Transform a crowd of phones into a single synchronized display, like Disney drone shows
or the Shenzhen building facades -- but with people's phones in a concert/event.

## The 3 Problems to Solve

### 1. WHERE IS EACH PHONE? (Positioning)
### 2. WHAT TIME IS IT? (Synchronization)
### 3. WHAT COLOR SHOULD I BE? (Choreography)

---

## Problem 1: Positioning

We need each phone to know its (x, y) coordinates relative to the crowd.
These are the viable methods in a browser (no native app):

### Method A: Sound Time-of-Flight (RECOMMENDED -- Phase 1)

How it works:
- DJ speaker emits a known ultrasonic "sync chirp" at a known server time
- Each phone's mic detects when it hears the chirp
- Phone reports detection timestamp to server
- Server computes: distance = (detectionTime - emitTime) * 343 m/s
- This gives DEPTH (distance from stage)

Accuracy: ~1 meter (sound travels 343m/s, timing accuracy ~3ms)
Pros: Automatic, no user input, works with existing mic infrastructure
Cons: Only gives 1D (depth), not left-right position

### Method B: Peer Audio Mesh (Phase 2 -- Ambitious)

How it works:
- Each phone briefly emits a unique short chirp (different frequency slot)
- Nearby phones detect which chirps they can hear
- Report neighbor list to server
- Server builds proximity graph
- Spring-force layout algorithm computes 2D positions

Accuracy: ~2-5 meter clusters
Pros: Full 2D positioning, no GPS needed, works indoors
Cons: Complex, battery-intensive, requires sequential chirp scheduling

### Method C: Device Orientation + Compass (Supplement)

How it works:
- DeviceOrientationEvent gives phone tilt/heading
- If everyone faces the stage, compass heading gives rough left-right info
- Combined with depth, gives pseudo-2D coordinates

Browser API: window.addEventListener('deviceorientation', ...)
Accuracy: ~15-30 degrees
Pros: Free, instant, no mic needed
Cons: Magnetic interference in buildings, needs calibration

### Method D: GPS/Geolocation (Outdoor events only)

How it works:
- navigator.geolocation.getCurrentPosition()
- Server gets all lat/lng, normalizes to local coordinate grid
- DJ sets stage position as origin

Accuracy: ~3-10m outdoors, ~20-50m indoors (useless indoors)
Pros: True 2D, works outdoors
Cons: Indoor events won't work, slow (2-10s for fix), battery drain

### Method E: Manual Section (Simple fallback)

How it works:
- DJ defines venue layout (sections A-F, rows 1-20)
- User picks their section when joining
- Server maps section to grid coordinates

Pros: 100% reliable, works anywhere
Cons: Requires user input, less precise

### RECOMMENDED STRATEGY: Layered Approach

Phase 1: Sound ToF (depth) + join-order zones (left/right) = pseudo-2D
Phase 2: Add peer mesh for true 2D
Phase 3: Add GPS for outdoor events

---

## Problem 2: Time Synchronization

All phones must agree on "what time it is" within ~20ms for smooth visuals.

### NTP-style sync over Socket.IO:

```
Client sends:    { t0: Date.now() }
Server responds: { t0, t1: Date.now(), t2: Date.now() }
Client receives: { t0, t1, t2, t3: Date.now() }

Round-trip time = (t3 - t0) - (t2 - t1)
One-way latency = RTT / 2
Clock offset    = ((t1 - t0) + (t2 - t3)) / 2
Server time     = Date.now() + offset
```

Do 5 rounds, take median offset. Accuracy: ~10-30ms over WiFi.
Re-sync every 30 seconds to handle clock drift.

### Beat Clock

Instead of wall-clock time, use a "beat clock":
- Server defines: beatOrigin (timestamp), BPM
- Any device can compute: currentBeat = (serverTime - beatOrigin) * BPM / 60000
- All animations reference currentBeat instead of local time
- Perfectly synchronized across all devices

---

## Problem 3: Choreography Engine

This is where the magic happens. A choreography is a timeline of visual patterns.

### Data Model:

```javascript
choreography = {
  name: "Closing Set",
  bpm: 128,
  beatOrigin: 1679000000000,  // server timestamp
  totalBeats: 512,             // ~4 min at 128 BPM
  steps: [
    {
      startBeat: 0,
      endBeat: 32,
      pattern: "wave-lr",       // wave traveling left to right
      color: "#ff0000",
      speed: 1.0,               // pattern-specific speed
      intensity: 1.0
    },
    {
      startBeat: 32,
      endBeat: 64,
      pattern: "ripple-center", // expanding ring from center
      color: "#00ff00",
      speed: 0.5
    },
    {
      startBeat: 64,
      endBeat: 96,
      pattern: "heart-shape",   // heart silhouette
      color: "#ff69b4"
    },
    // ... more steps
  ]
}
```

### Pattern Functions

Each pattern is a pure function:
`(x, y, beat, params) => { r, g, b, a }`

Where x, y are normalized coordinates (0-1) representing position in crowd.

#### Core Pattern Library:

SPATIAL WAVES:
- wave-lr: wave traveling left to right (x - beat * speed)
- wave-rl: wave traveling right to left
- wave-tb: wave top to bottom (rain falling)
- wave-bt: wave bottom to top (energy rising)
- wave-diagonal: diagonal wave

RADIAL:
- ripple-center: concentric rings expanding from center
- ripple-stage: rings expanding from stage (y=0)
- spotlight: bright circle following a path
- spiral: rotating spiral arms

SHAPES:
- heart-shape: heart silhouette that pulses
- text-scroll: scrolling text across the crowd
- logo: custom image mapped to crowd grid
- split-halves: left half vs right half different colors

REACTIVE:
- proximity-pulse: phones near each other flash together
- mexican-wave: the classic stadium wave
- random-sparkle: random phones flash like stars
- cascade-rain: top-to-bottom cascade with random timing

ADVANCED:
- pixel-art: treat each phone as a pixel, display low-res image
- countdown: 3...2...1 numbers formed by the crowd
- flag: national flag waving animation
- fireworks: explosion from a point, expanding ring of light

### On-Device Rendering:

Each phone runs this every frame:
```javascript
function renderFrame() {
  var serverNow = Date.now() + clockOffset;
  var currentBeat = (serverNow - choreography.beatOrigin) * choreography.bpm / 60000;

  // Find current step
  var step = choreography.steps.find(s => currentBeat >= s.startBeat && currentBeat < s.endBeat);
  if (!step) return;

  var localBeat = (currentBeat - step.startBeat) / (step.endBeat - step.startBeat);

  // My normalized position (0-1)
  var myX = myPosition.x;  // 0 = leftmost, 1 = rightmost
  var myY = myPosition.y;  // 0 = closest to stage, 1 = farthest

  // Compute my color from pattern function
  var color = patterns[step.pattern](myX, myY, localBeat, step);

  // Fill screen
  fillScreen(color);
}
```

---

## Architecture Diagram

```
DJ Panel (dj.html)
    |
    | 1. Creates/edits choreography
    | 2. Sets BPM, triggers sync pulse
    | 3. Starts/stops show
    |
    v
Server (Socket.IO)
    |
    |--- Time sync (NTP-style ping/pong)
    |--- Position data collection + computation
    |--- Choreography broadcast
    |--- Device registry (id, position, zone)
    |
    v
Audience Phones (index.html)
    |
    |--- Receive choreography JSON
    |--- Run local beat clock
    |--- Compute own color per frame
    |--- Report position data back to server
```

---

## Implementation Phases

### Phase 1: Coordinated Patterns (CURRENT SPRINT)

What: Add beat-synced patterns that use deviceIndex and totalDevices
Position: Simple -- each device knows its index (0 to N-1)
Sync: Server broadcasts beatOrigin + BPM
Patterns: wave, ripple, mexican-wave, split-halves, countdown

This alone creates impressive coordinated effects with ZERO hardware changes.
Example: wave-lr with 500 phones = visible wave traveling across the venue.

### Phase 2: Sound-Based Depth

What: Measure distance from stage using ultrasonic time-of-flight
Position: 1D depth (close to stage vs far from stage)
New: DJ panel triggers "sync pulse", phones report detection time
Patterns: ripple-stage, rain, energy-rise (depth-based effects)

### Phase 3: Peer Mesh (True 2D)

What: Phones discover neighbors via short chirp exchange
Position: Full 2D coordinates computed by server
New: Chirp scheduler, neighbor detection, graph layout algorithm
Patterns: heart-shape, text-scroll, pixel-art, logo display

### Phase 4: Choreography Editor

What: Visual timeline editor for the DJ to build shows
New: Drag-and-drop timeline in DJ panel
Preview: Mini grid showing simulated crowd animation
Export: Save/load choreography presets

---

## Server State Additions

```javascript
djSession = {
  // ... existing fields ...

  // Choreography
  choreography: null,         // Current choreography object
  beatOrigin: null,           // Server timestamp of beat 0
  showActive: false,          // Is a choreography running?

  // Positioning
  devicePositions: {},        // { deviceId: { x, y, depth, zone } }
  positioningMode: 'index',   // 'index' | 'depth' | 'mesh' | 'gps'
  venueWidth: 1,              // Normalized venue dimensions
  venueDepth: 1,

  // Time sync
  syncData: {},               // { deviceId: { offset, rtt, lastSync } }
}
```

## Client State Additions

```javascript
DJL = {
  // ... existing fields ...

  // Positioning
  position: { x: 0.5, y: 0.5 },  // Normalized (0-1) coordinates
  depth: 0,                         // Distance from stage in meters
  neighbors: [],                    // Peer mesh neighbor list

  // Choreography
  choreography: null,               // Received from server
  beatOrigin: 0,                    // Server beat origin timestamp
  clockOffset: 0,                   // Local-to-server time offset

  // Time sync
  syncRounds: [],                   // NTP measurement history
}
```

---

## Quick Win: Phase 1 Implementation Plan

No positioning hardware needed. Just use deviceIndex / totalDevices.

1. Add time sync (NTP over Socket.IO) -- ~50 lines
2. Add choreography data model -- ~30 lines
3. Add pattern functions using normalized device position -- ~200 lines
4. Add "Show Mode" button to DJ panel -- ~50 lines
5. Add choreography receiver on audience side -- ~80 lines

Total: ~400 lines of code for Disney-level coordinated effects.

The trick: even with just deviceIndex, you can create impressive waves.
Device 0 is "leftmost", device N is "rightmost".
A wave-lr pattern: brightness = sin(2*PI * (deviceIndex/totalDevices - beat * speed))
With 200+ phones, this looks INCREDIBLE from the DJ booth/drone cam.
