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

// Below this windowed RMS, treat the signal as non-content (background
// noise, room tone, breaths, silence between words) rather than something
// to level. Without a gate here, a quiet pause reads as "even quieter
// content than speech" and the tracker computes an even *larger* desired
// gain for it than for speech (targetRms / tinyRms), boosting the noise
// floor and dragging average gain up across the whole stream even during
// segments that are working fine. 0.02 is a heuristic — well below typical
// speech RMS (targetRms sits at 0.1-0.12) but above typical mic/room noise
// — not a per-source-calibrated noise floor, so it may need retuning for
// unusually noisy or unusually quiet source recordings.
//
// This is checked against the PRE-gain signal, not the same
// output-referenced reading used to compute the correction. If it were
// checked post-gain, a noise floor the tracker had already boosted (say
// 4x) could read as "loud enough to be content" purely because of the
// tracker's own prior correction — the gate would fail to catch exactly
// the case it exists for.
const NOISE_GATE_RMS = 0.02;

// Sustained-loudness tracker (deliberately NOT a fast/transient AGC).
//
// Both target scenarios — a lecturer drifting off-mic and a loud ad block —
// are level changes that hold for seconds to minutes, not instantaneous
// spikes. Reacting per-analysis-frame (the old 50ms-tick design) ended up
// chasing ordinary word-to-word and pause-to-pause loudness variance within
// a sentence, which is audible as pumping/breathing.
//
// This is output-referenced, not feed-forward: the AnalyserNode measures
// the *final* mix (after the downstream limiter and trim), while the
// GainNode it drives sits upstream of those stages. That's deliberate —
// tapping pre-limiter would let the limiter's own attenuation go
// uncompensated. Ad/music content has a higher peak-to-RMS ratio than
// speech, so it trips the fast limiter far more often; measuring before
// the limiter meant the tracker thought it had already hit its target RMS
// while the limiter then quietly pulled loud/peaky content down further,
// leaving quiet speech (which rarely engages the limiter) landing louder
// than "softened" loud segments. Measuring downstream closes the loop
// around that so both converge on the same actual heard loudness.
//
// Because the measurement is downstream of the gain it drives, the update
// has to be multiplicative (currentGain * target/measured), not a direct
// set (target/measured) — see the comment in _tick for why a direct set
// is wrong once measurement and correction are no longer independent.
//
// Instead of driving gain off a single reading, it keeps a rolling
// average of the last `windowSeconds` of readings — a simple moving
// average, "what's the general loudness right now" rather than "what's the
// loudness of this 100ms slice." The gain move toward the new target is
// then further smoothed with its own asymmetric time constant: fast enough
// to settle within a couple of seconds of a genuine sustained change
// (attackTime), much slower to unwind (releaseTime) so a half-second pause
// in speech doesn't read as "it's quiet now" and yank the gain up.
//
// The control loop runs at 10Hz with multi-second time constants, so it's
// far too slow relative to the audio graph's near-zero processing delay to
// self-oscillate — this is a standard slow-feedback design, not a risky one.
class LoudnessTracker {
  constructor(audioCtx, params) {
    this.audioCtx = audioCtx;
    this.gainNode = audioCtx.createGain();
    this.gainNode.gain.value = 1;

    // Post-gain/limiter/trim: measures what's actually about to reach the
    // ear, used to compute how much correction is still needed.
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this._buf = new Float32Array(this.analyser.fftSize);
    this._history = [];
    this._historySum = 0;

    // Pre-gain: measures the signal before this tracker touches it, used
    // only to decide whether there's real content right now (see
    // NOISE_GATE_RMS above for why this can't share the post-gain reading).
    this.gateAnalyser = audioCtx.createAnalyser();
    this.gateAnalyser.fftSize = 2048;
    this._gateBuf = new Float32Array(this.gateAnalyser.fftSize);
    this._gateHistory = [];
    this._gateHistorySum = 0;

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
    while (this._gateHistory.length > this._historyLength) {
      this._gateHistorySum -= this._gateHistory.shift();
    }
  }

  // The node this tracker's gain correction actually applies to (upstream
  // of the limiter/trim — the real audio path). Also feeds the gate
  // analyser, since the gate needs a pre-correction reading.
  connectSignal(node) {
    node.connect(this.gainNode);
    node.connect(this.gateAnalyser);
  }

  // The node whose loudness is measured to drive the gain correction —
  // downstream of the limiter/trim, i.e. as close to "what you'll actually
  // hear" as the graph gets. See the class comment above for why this is
  // not the same node as connectSignal.
  connectMeasurement(node) {
    node.connect(this.analyser);
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
    const gateInstantRms = LoudnessTracker._rms(this.gateAnalyser, this._gateBuf);
    this._gateHistory.push(gateInstantRms);
    this._gateHistorySum += gateInstantRms;
    if (this._gateHistory.length > this._historyLength) {
      this._gateHistorySum -= this._gateHistory.shift();
    }
    const gateWindowedRms = this._gateHistorySum / this._gateHistory.length;

    // Below the noise gate: not real content (silence, room tone, breath).
    // Hold the last gain instead of chasing it toward maxGain. This also
    // means the correction-target window below only ever accumulates
    // actual-content samples, not diluted by gaps.
    if (gateWindowedRms < NOISE_GATE_RMS) return;

    const instantRms = LoudnessTracker._rms(this.analyser, this._buf);
    this._history.push(instantRms);
    this._historySum += instantRms;
    if (this._history.length > this._historyLength) {
      this._historySum -= this._history.shift();
    }
    const windowedRms = this._historySum / this._history.length;

    const { targetRms, attackTime, releaseTime, minGain, maxGain } = this.params;
    const currentGain = this.gainNode.gain.value;

    // Closed-loop (multiplicative) update, not a direct set. windowedRms is
    // measured downstream of currentGain, i.e. windowedRms ~= currentGain *
    // (true pre-gain level). Setting gain directly to targetRms/windowedRms
    // would divide the correct answer by currentGain a second time and
    // never converge to the right value. Scaling currentGain by the
    // target/measured ratio cancels that out: currentGain * (targetRms /
    // (currentGain * x)) = targetRms / x, the actual correct gain,
    // independent of whatever currentGain already was.
    const desired = Math.min(maxGain, Math.max(minGain, currentGain * (targetRms / windowedRms)));
    const now = this.audioCtx.currentTime;
    const timeConstant = desired < currentGain ? attackTime : releaseTime;
    this.gainNode.gain.setTargetAtTime(desired, now, timeConstant);
  }

  dispose() {
    clearInterval(this._interval);
    this.analyser.disconnect();
    this.gateAnalyser.disconnect();
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
  applyCompressorParams(compressor, preset.compressor);

  const loudnessTracker = new LoudnessTracker(audioCtx, preset.loudness);

  // Fast safety-net limiter only — catches a true instantaneous spike (mic
  // bump, feedback) before the multi-second loudness tracker could ever
  // react. Not a scenario-specific "ad detector."
  const limiter = audioCtx.createDynamicsCompressor();
  applyCompressorParams(limiter, preset.limiter);

  const outputGain = audioCtx.createGain();
  outputGain.gain.value = preset.outputGain;

  // Signal path: source -> compressor -> loudness tracker's gain -> limiter -> outputGain -> destination
  source.connect(compressor);
  loudnessTracker.connectSignal(compressor);
  loudnessTracker.output.connect(limiter);
  limiter.connect(outputGain);
  outputGain.connect(audioCtx.destination);

  // Measurement tap: fed from the final output (post-limiter, post-trim),
  // not from `compressor` — see the LoudnessTracker class comment.
  loudnessTracker.connectMeasurement(outputGain);

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
