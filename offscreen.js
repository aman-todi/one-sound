// Offscreen document: the only place allowed to hold a MediaStream and run
// a persistent Web Audio graph in MV3. One AudioContext per captured tab,
// keyed by tabId, so leveling is independent per tab.

/** tabId -> { stream, audioCtx, source, sensitivity, nodes: { compressor, loudnessTracker, limiter, outputGain } } */
const activeCaptures = new Map();

// "off" is a true bypass: ratio 1 on both compressors is a no-op, and
// clamping the loudness tracker's gain to exactly 1 means it never touches
// the signal. Same graph topology as light/strong, just neutral parameters —
// this lets sensitivity be flipped live without tearing down the capture,
// and lets "Off" double as a passthrough test.
//
// `loudness` tracks *sustained* level (lecturer drift, ad blocks that stay
// loud for seconds/minutes) — see LoudnessTracker below. windowSeconds is
// the rolling-average length; attackTime/releaseTime are setTargetAtTime
// time constants applied to the gain move itself, on top of that windowing.
const SENSITIVITY_PRESETS = {
  off: {
    compressor: { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 },
    loudness: {
      targetRms: 0.1,
      windowSeconds: 2,
      attackTime: 0.7,
      releaseTime: 2.5,
      minGain: 1,
      maxGain: 1
    },
    limiter: { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 },
    outputGain: 1
  },
  light: {
    compressor: { threshold: -24, knee: 30, ratio: 3, attack: 0.02, release: 0.3 },
    loudness: {
      targetRms: 0.1,
      windowSeconds: 2,
      attackTime: 0.7,
      releaseTime: 2.5,
      minGain: 0.25,
      maxGain: 4
    },
    limiter: { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.1 },
    outputGain: 1
  },
  strong: {
    compressor: { threshold: -30, knee: 10, ratio: 6, attack: 0.01, release: 0.25 },
    loudness: {
      targetRms: 0.12,
      windowSeconds: 1.2,
      attackTime: 0.5,
      releaseTime: 2.3,
      minGain: 0.15,
      maxGain: 8
    },
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

const LOUDNESS_TICK_MS = 100;

// Sustained-loudness tracker (deliberately NOT a fast/transient AGC).
//
// Both target scenarios — a lecturer drifting off-mic and a loud ad block —
// are level changes that hold for seconds to minutes, not instantaneous
// spikes. Reacting per-analysis-frame (the old 50ms-tick design) ended up
// chasing ordinary word-to-word and pause-to-pause loudness variance within
// a sentence, which is audible as pumping/breathing.
//
// So this taps the (pre-gain) signal with an AnalyserNode every tick, but
// instead of driving gain off that single reading, it keeps a rolling
// average of the last `windowSeconds` of readings — a simple moving
// average, "what's the general loudness right now" rather than "what's the
// loudness of this 100ms slice." The gain move toward the new target is
// then further smoothed with its own asymmetric time constant: fast enough
// to settle within a couple of seconds of a genuine sustained change
// (attackTime), much slower to unwind (releaseTime) so a half-second pause
// in speech doesn't read as "it's quiet now" and yank the gain up.
class LoudnessTracker {
  constructor(audioCtx, params) {
    this.audioCtx = audioCtx;
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.gainNode = audioCtx.createGain();
    this.gainNode.gain.value = 1;
    this._buf = new Float32Array(this.analyser.fftSize);
    this._history = [];
    this._historySum = 0;
    this._historyLength = 1;
    this.setParams(params);
    this._interval = setInterval(() => this._tick(), LOUDNESS_TICK_MS);
  }

  setParams(params) {
    this.params = params;
    this._historyLength = Math.max(1, Math.round((params.windowSeconds * 1000) / LOUDNESS_TICK_MS));

    // Window shrank (e.g. Light -> Strong mid-video): drop the oldest
    // samples that now fall outside the new window instead of wiping the
    // whole buffer, so the average — and the gain it drives — doesn't
    // suddenly reset to a 1-sample reading (audible as a dip/hold at
    // unity). Growing needs no special handling: the average already
    // divides by the buffer's actual current length, so it just keeps
    // accumulating up to the new, larger cap.
    while (this._history.length > this._historyLength) {
      this._historySum -= this._history.shift();
    }
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
    const instantRms = Math.sqrt(sumSquares / this._buf.length);

    this._history.push(instantRms);
    this._historySum += instantRms;
    if (this._history.length > this._historyLength) {
      this._historySum -= this._history.shift();
    }
    const windowedRms = this._historySum / this._history.length;

    // Sustained silence across the whole window: hold the last gain
    // instead of chasing the noise floor up to maxGain.
    if (windowedRms < 0.0005) return;

    const { targetRms, attackTime, releaseTime, minGain, maxGain } = this.params;
    const desired = Math.min(maxGain, Math.max(minGain, targetRms / windowedRms));
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

  // Kept deliberately: this now does a different job than the loudness
  // tracker below, not a redundant one. Its attack/release (10-20ms /
  // 250-300ms) operate on word/syllable-level micro-dynamics — the
  // second-scale loudness tracker doesn't touch those at all, it only
  // corrects sustained level. Smoothing the crest factor here also gives
  // the tracker's RMS measurement a steadier signal to average (less
  // skewed by individual peaks) and leaves the fast limiter downstream
  // less work to do.
  const compressor = audioCtx.createDynamicsCompressor();
  applyCompressorParams(compressor, preset.compressor);

  const loudnessTracker = new LoudnessTracker(audioCtx, preset.loudness);

  // Fast safety-net limiter only — catches a true instantaneous spike (mic
  // bump, feedback) before the multi-second loudness tracker could ever
  // react. Not a scenario-specific "ad detector."
  const limiter = audioCtx.createDynamicsCompressor();
  applyCompressorParams(limiter, preset.limiter);

  const outputGain = audioCtx.createGain();
  outputGain.gain.value = preset.outputGain;

  // source -> compressor -> [loudness tracker analyser tap + gain] -> limiter -> outputGain -> destination
  source.connect(compressor);
  loudnessTracker.connectInput(compressor);
  loudnessTracker.output.connect(limiter);
  limiter.connect(outputGain);
  outputGain.connect(audioCtx.destination);

  activeCaptures.set(tabId, {
    stream,
    audioCtx,
    source,
    sensitivity,
    nodes: { compressor, loudnessTracker, limiter, outputGain }
  });
}

async function stopCapture(tabId) {
  const entry = activeCaptures.get(tabId);
  if (!entry) return;

  entry.nodes.loudnessTracker.dispose();
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
  entry.nodes.loudnessTracker.setParams(preset.loudness);
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
      console.error(`[one-sound] offscreen "${message.type}" failed (tab ${message.tabId})`, err);
      sendResponse({ ok: false, error: err.message || 'Audio capture/processing failed' });
    }
  })();

  return true;
});
