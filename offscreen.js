// Offscreen document: the only place allowed to hold a MediaStream and run
// a persistent Web Audio graph in MV3. One AudioContext per captured tab,
// keyed by tabId, so leveling is independent per tab.

/** tabId -> { stream, audioCtx, source, sensitivity, nodes } */
const activeCaptures = new Map();

// "off" is a true bypass: ratio 1 on both compressors is a no-op, and
// clamping AGC gain to exactly 1 means the analyser loop never touches the
// signal. Same graph topology as light/strong, just neutral parameters —
// this lets sensitivity be flipped live without tearing down the capture,
// and lets "Off" double as a passthrough test.
const SENSITIVITY_PRESETS = {
  off: {
    compressor: { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 },
    agc: { targetRms: 0.1, attackTime: 0.05, releaseTime: 1, minGain: 1, maxGain: 1 },
    limiter: { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 },
    outputGain: 1
  },
  light: {
    compressor: { threshold: -24, knee: 30, ratio: 3, attack: 0.02, release: 0.3 },
    agc: { targetRms: 0.1, attackTime: 0.05, releaseTime: 1.2, minGain: 0.25, maxGain: 4 },
    limiter: { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.1 },
    outputGain: 1
  },
  strong: {
    compressor: { threshold: -30, knee: 10, ratio: 6, attack: 0.01, release: 0.25 },
    agc: { targetRms: 0.12, attackTime: 0.02, releaseTime: 0.8, minGain: 0.15, maxGain: 8 },
    limiter: { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.08 },
    outputGain: 0.95
  }
};

function presetFor(sensitivity) {
  return SENSITIVITY_PRESETS[sensitivity] || SENSITIVITY_PRESETS.light;
}

function applyCompressorParams(node, p) {
  node.threshold.value = p.threshold;
  node.knee.value = p.knee;
  node.ratio.value = p.ratio;
  node.attack.value = p.attack;
  node.release.value = p.release;
}

// Feed-forward AGC: taps the (pre-gain) signal with an AnalyserNode to
// measure RMS on a rolling window, and drives a parallel GainNode toward a
// target loudness. Fast attack when it needs to pull a spike down, slow
// release when recovering, so it doesn't audibly "pump" during normal
// quiet/loud speech transitions.
class AgcStage {
  constructor(audioCtx, params) {
    this.audioCtx = audioCtx;
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.gainNode = audioCtx.createGain();
    this.gainNode.gain.value = 1;
    this._buf = new Float32Array(this.analyser.fftSize);
    this.setParams(params);
    this._interval = setInterval(() => this._tick(), 50);
  }

  setParams(params) {
    this.params = params;
  }

  connectInput(node) {
    node.connect(this.analyser);
    node.connect(this.gainNode);
  }

  get output() {
    return this.gainNode;
  }

  _tick() {
    this.analyser.getFloatTimeDomainData(this._buf);
    let sumSquares = 0;
    for (let i = 0; i < this._buf.length; i++) {
      const v = this._buf[i];
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / this._buf.length);

    // Near-silence: hold the last gain instead of chasing the noise floor
    // up to maxGain.
    if (rms < 0.0005) return;

    const { targetRms, attackTime, releaseTime, minGain, maxGain } = this.params;
    const desired = Math.min(maxGain, Math.max(minGain, targetRms / rms));
    const now = this.audioCtx.currentTime;
    const timeConstant = desired < this.gainNode.gain.value ? attackTime : releaseTime;
    this.gainNode.gain.setTargetAtTime(desired, now, timeConstant);
  }

  dispose() {
    clearInterval(this._interval);
    this.analyser.disconnect();
    this.gainNode.disconnect();
  }
}

async function startCapture(tabId, streamId, sensitivity) {
  await stopCapture(tabId); // idempotent: replace any prior graph for this tab

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const preset = presetFor(sensitivity);

  const compressor = audioCtx.createDynamicsCompressor();
  applyCompressorParams(compressor, preset.compressor);

  const agc = new AgcStage(audioCtx, preset.agc);

  const limiter = audioCtx.createDynamicsCompressor();
  applyCompressorParams(limiter, preset.limiter);

  const outputGain = audioCtx.createGain();
  outputGain.gain.value = preset.outputGain;

  // source -> compressor -> [agc analyser tap + agc gain] -> limiter -> outputGain -> destination
  source.connect(compressor);
  agc.connectInput(compressor);
  agc.output.connect(limiter);
  limiter.connect(outputGain);
  outputGain.connect(audioCtx.destination);

  activeCaptures.set(tabId, {
    stream,
    audioCtx,
    source,
    sensitivity,
    nodes: { compressor, agc, limiter, outputGain }
  });
}

async function stopCapture(tabId) {
  const entry = activeCaptures.get(tabId);
  if (!entry) return;

  entry.nodes.agc.dispose();
  entry.stream.getTracks().forEach((track) => track.stop());
  try {
    await entry.audioCtx.close();
  } catch (err) {
    // already closed — ignore
  }
  activeCaptures.delete(tabId);
}

function updateSensitivity(tabId, sensitivity) {
  const entry = activeCaptures.get(tabId);
  if (!entry) return;

  const preset = presetFor(sensitivity);
  applyCompressorParams(entry.nodes.compressor, preset.compressor);
  entry.nodes.agc.setParams(preset.agc);
  applyCompressorParams(entry.nodes.limiter, preset.limiter);
  entry.nodes.outputGain.gain.setTargetAtTime(preset.outputGain, entry.audioCtx.currentTime, 0.05);
  entry.sensitivity = sensitivity;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  (async () => {
    try {
      switch (message.type) {
        case 'start-capture':
          await startCapture(message.tabId, message.streamId, message.sensitivity);
          sendResponse({ ok: true });
          break;
        case 'stop-capture':
          await stopCapture(message.tabId);
          sendResponse({ ok: true });
          break;
        case 'update-sensitivity':
          for (const tabId of activeCaptures.keys()) {
            updateSensitivity(tabId, message.sensitivity);
          }
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});
