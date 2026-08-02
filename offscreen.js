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
      targetRms: 0.07,
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
      targetRms: 0.07,
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
      targetRms: 0.084,
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

// rampSeconds=0 (the default, used at capture start) sets params directly —
// there's no prior audio through the node yet, nothing to discontinuity
// against. A sensitivity switch mid-playback needs the ramped path: without
// it, threshold/knee/ratio/attack/release all snap to new values on the
// exact same render quantum, an audible jump in the compression curve
// independent of anything the loudness tracker is doing.
function applyCompressorParams(node, p, audioCtx, rampSeconds = 0) {
  if (rampSeconds > 0) {
    const now = audioCtx.currentTime;
    node.threshold.setTargetAtTime(p.threshold, now, rampSeconds);
    node.knee.setTargetAtTime(p.knee, now, rampSeconds);
    node.ratio.setTargetAtTime(p.ratio, now, rampSeconds);
    node.attack.setTargetAtTime(p.attack, now, rampSeconds);
    node.release.setTargetAtTime(p.release, now, rampSeconds);
  } else {
    node.threshold.value = p.threshold;
    node.knee.value = p.knee;
    node.ratio.value = p.ratio;
    node.attack.value = p.attack;
    node.release.value = p.release;
  }
}

const LOUDNESS_TICK_MS = 100;

// Below this RMS, treat the signal as non-content (background noise, room
// tone, breaths, silence between words) rather than something to level.
// Without a gate here, a quiet pause reads as "even quieter content than
// speech" and the tracker computes an even *larger* desired gain for it
// than for speech (targetRms / tinyRms), boosting the noise floor. 0.02 is
// a heuristic — well below typical speech RMS (targetRms sits at 0.1-0.12)
// but above typical mic/room noise — not a per-source-calibrated noise
// floor, so it may need retuning for unusually noisy/quiet recordings.
const NOISE_GATE_RMS = 0.02;

// Short window for the gate decision ("is there content right now") —
// deliberately much shorter than the sustained-loudness window below. A
// 1-2s window (right for tracking sustained level) blends a 1-1.5s pause
// with the speech on either side of it, so the gate barely dips even
// during an audible pause. This one only needs to be long enough to smooth
// individual analyser frames, not to average out real silence.
const GATE_WINDOW_SECONDS = 0.3;

// Sustained-loudness tracker (deliberately NOT a fast/transient AGC).
//
// Both target scenarios — a lecturer drifting off-mic and a loud ad block —
// are level changes that hold for seconds to minutes, not instantaneous
// spikes. Reacting per-analysis-frame (the old 50ms-tick design) ended up
// chasing ordinary word-to-word and pause-to-pause loudness variance within
// a sentence, which is audible as pumping/breathing.
//
// This is feed-forward: the AnalyserNode taps the same (pre-gain) node the
// GainNode is fed from, in parallel — so the measurement is independent of
// the gain being computed. An earlier version measured downstream of the
// limiter/trim instead (closed-loop) to compensate for the limiter's own
// attenuation on loud/peaky content. That was reverted after real
// telemetry showed it oscillating — gain swinging between ~0.7x and ~5.3x
// within 10-20s of ordinary speech — because the windowed measurement and
// the gain's own attack/release constants operate on overlapping
// timescales, so the reading always lags the actual current gain and the
// correction overshoots every tick. Feed-forward has no such loop: the
// measurement can't be influenced by a gain decision it's used to compute,
// so it can't oscillate. (The limiter-compensation problem this was
// solving is real but smaller than a gain that never settles down; a
// non-feedback fix — e.g. reading the limiter's own `.reduction` value
// directly instead of inferring it — is a better route if that's revisited.)
//
// Instead of driving gain off a single reading, it keeps a rolling
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
    this._buf = new Float32Array(this.analyser.fftSize);

    this.gainNode = audioCtx.createGain();
    this.gainNode.gain.value = 1;

    // Short window: gate decision.
    this._gateHistoryLength = Math.max(1, Math.round((GATE_WINDOW_SECONDS * 1000) / LOUDNESS_TICK_MS));
    this._gateHistory = [];
    this._gateHistorySum = 0;

    // Long window: sustained-loudness correction target.
    this._history = [];
    this._historySum = 0;
    this._historyLength = 1;

    this._tickCount = 0;
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

  static _rms(analyser, buf) {
    analyser.getFloatTimeDomainData(buf);
    let sumSquares = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sumSquares += v * v;
    }
    return Math.sqrt(sumSquares / buf.length);
  }

  _tick() {
    const instantRms = LoudnessTracker._rms(this.analyser, this._buf);

    this._gateHistory.push(instantRms);
    this._gateHistorySum += instantRms;
    if (this._gateHistory.length > this._gateHistoryLength) {
      this._gateHistorySum -= this._gateHistory.shift();
    }
    const gateRms = this._gateHistorySum / this._gateHistory.length;

    // Below the noise gate: not real content (silence, room tone, breath).
    // Hold the last gain instead of chasing it toward maxGain. This also
    // means the correction-target window below only ever accumulates
    // actual-content samples, not diluted by gaps.
    if (gateRms < NOISE_GATE_RMS) {
      this._tickCount++;
      if (this._tickCount % 10 === 0) {
        console.debug(
          `[one-sound] gate=${gateRms.toFixed(4)} (below ${NOISE_GATE_RMS}, holding) gain=${this.gainNode.gain.value.toFixed(2)}`
        );
      }
      return;
    }

    this._history.push(instantRms);
    this._historySum += instantRms;
    if (this._history.length > this._historyLength) {
      this._historySum -= this._history.shift();
    }
    const windowedRms = this._historySum / this._history.length;

    const { targetRms, attackTime, releaseTime, minGain, maxGain } = this.params;
    const currentGain = this.gainNode.gain.value;
    const desired = Math.min(maxGain, Math.max(minGain, targetRms / windowedRms));
    const now = this.audioCtx.currentTime;
    const timeConstant = desired < currentGain ? attackTime : releaseTime;
    this.gainNode.gain.setTargetAtTime(desired, now, timeConstant);

    // Throttled diagnostic log (~1x/sec) — open this offscreen document's
    // devtools console to read real numbers instead of guessing at them.
    this._tickCount++;
    if (this._tickCount % 10 === 0) {
      console.debug(
        `[one-sound] gate=${gateRms.toFixed(4)} measured=${windowedRms.toFixed(4)} ` +
          `target=${targetRms} gain=${currentGain.toFixed(2)}->${desired.toFixed(2)}`
      );
    }
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

  // Kept deliberately: this does a different job than the loudness tracker
  // below, not a redundant one. Its attack/release (10-20ms / 250-300ms)
  // operate on word/syllable-level micro-dynamics — the second-scale
  // loudness tracker doesn't touch those at all, it only corrects
  // sustained level. Reducing crest factor here also means the tracker's
  // gain correction (applied right after this node) has less peaky
  // material to push through the limiter in the first place.
  const compressor = audioCtx.createDynamicsCompressor();
  applyCompressorParams(compressor, preset.compressor, audioCtx);

  const loudnessTracker = new LoudnessTracker(audioCtx, preset.loudness);

  // Fast safety-net limiter only — catches a true instantaneous spike (mic
  // bump, feedback) before the multi-second loudness tracker could ever
  // react. Not a scenario-specific "ad detector."
  const limiter = audioCtx.createDynamicsCompressor();
  applyCompressorParams(limiter, preset.limiter, audioCtx);

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

// Ramp time for a live sensitivity switch's compressor/limiter/trim params.
// Fast enough to feel responsive when picking from the dropdown, slow
// enough that the compression curve doesn't visibly snap mid-render-quantum.
const SENSITIVITY_RAMP_SECONDS = 0.3;

function updateSensitivity(tabId, sensitivity) {
  const entry = activeCaptures.get(tabId);
  if (!entry) return;

  const preset = presetFor(sensitivity);
  applyCompressorParams(entry.nodes.compressor, preset.compressor, entry.audioCtx, SENSITIVITY_RAMP_SECONDS);
  entry.nodes.loudnessTracker.setParams(preset.loudness);
  applyCompressorParams(entry.nodes.limiter, preset.limiter, entry.audioCtx, SENSITIVITY_RAMP_SECONDS);
  entry.nodes.outputGain.gain.setTargetAtTime(preset.outputGain, entry.audioCtx.currentTime, SENSITIVITY_RAMP_SECONDS);
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
