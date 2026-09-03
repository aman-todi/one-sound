# One Sound — Audio Leveler

A Chrome (MV3) extension that automatically smooths out wild loudness
swings in tab audio — the classic "quiet lecture, deafening ad" problem —
so you can set your volume once per tab and not have to touch it again.

It works by capturing a tab's mixed audio output (`chrome.tabCapture`),
running it through a Web Audio processing graph, and playing the
processed result back out. No servers, no accounts, no build step —
everything runs locally in the browser.

## Install (load unpacked)

There's no Chrome Web Store listing yet, so install it as an unpacked
extension:

1. Clone or download this repo.
   ```
   git clone https://github.com/aman-todi/one-sound.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `one-sound` folder.
5. Pin the extension (puzzle-piece icon in the toolbar → pin "One Sound")
   so it's easy to reach.

**Requirements:** Chrome 116+ (the `chrome.offscreen` API this relies on
shipped in 116). No npm install, no build — it's plain HTML/CSS/JS.

## Use it

1. Open a tab with audio playing — a regular `http(s)://` page (`chrome://`
   pages, the Chrome Web Store, and similar internal pages can't be
   captured; the popup will tell you if the current tab isn't eligible).
2. Click the extension icon and flip the toggle on.
3. Pick a sensitivity: **Off** (true passthrough — useful for confirming
   the pipeline isn't altering anything), **Light**, or **Strong**.
   Sensitivity is a global setting (applies to whichever tab(s) currently
   have leveling on) and switching it while audio is playing takes effect
   live, no need to re-toggle.
4. Leveling stays on for that tab until you toggle it off or close the
   tab — closing the tab (or the tab's capture otherwise stopping)
   cleans up automatically.

A green "ON" badge on the toolbar icon shows which tab is currently being
leveled.

## How it works

### Capture pipeline (MV3 constraints)

Manifest V3 service workers can't hold a live `MediaStream` or run a
persistent `AudioContext`, so the capture and all audio processing happen
in an **offscreen document** instead — the pattern Chrome has supported
since v116:

```
popup click
  → background.js (service worker)
      chrome.tabCapture.getMediaStreamId({ targetTabId })
  → offscreen.js (offscreen document)
      navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } }
      })
  → Web Audio graph → AudioContext.destination
```

Capturing a tab's audio stops its normal output by default, which is why
the graph has to explicitly reconnect processed audio back out through
`AudioContext.destination` — otherwise the tab would just go silent.

Audio-only capture (`video: false`) is used deliberately: requesting
video alongside audio has been observed to mute audio entirely on some
DRM-protected content.

### The audio graph

Per captured tab, one persistent chain:

```
MediaStreamSource
  → DynamicsCompressorNode         (micro-dynamics)
  → LoudnessTracker's GainNode     (sustained-loudness correction)
  → DynamicsCompressorNode         (fast safety-net limiter)
  → AudioContext.destination
```

#### 1. Front compressor — micro-dynamics

A standard `DynamicsCompressorNode` with fast attack (10–20ms) and quick
release (250–300ms). This tames word/syllable-level peaks (typical
"crest factor" of speech) — a *much* faster timescale than the loudness
correction below, and a genuinely different job: it doesn't touch
sustained level at all, just the moment-to-moment spikiness of the
signal.

#### 2. Loudness tracker — sustained-level correction (the core of this extension)

The actual "leveling" happens here, and it's deliberately **not** a fast
AGC. The two target scenarios — a lecturer drifting off-mic, a loud ad
block — are both level changes that hold for *seconds to minutes*, not
instantaneous transients. Reacting per-audio-frame just chases ordinary
word-to-word and pause-to-pause loudness variance within a sentence,
which is audible as pumping/breathing.

**RMS measurement.** Every 100ms, an `AnalyserNode` reads 2048 time-domain
samples and computes root-mean-square loudness:

```
rms = sqrt( (1/N) · Σ sample[i]² )
```

**Two independent rolling windows** are kept over these per-tick RMS
readings (simple moving averages, not exponential smoothing):

- a **short gate window** (0.3s) — "is there real content right now?"
- a **long sustained window** (1.2–2s, depending on sensitivity) — "what's
  the general loudness of what's currently playing?"

They're deliberately different lengths. A single ~1–2s window (right for
tracking sustained level) blends a 1–1.5s pause with the speech around
it, so a gate built on that window barely dips even during an audible
pause — hence the separate, much shorter window just for the gate
decision.

**Noise gate.** If the short-window RMS is below `NOISE_GATE_RMS` (0.02),
the tick is treated as non-content — background noise, room tone, a
breath, silence between words — and the tracker holds its current gain
rather than computing a new one. This matters because, without it, a
quiet pause reads as "even quieter content than speech," and the
correction formula below computes an *even larger* boost for it than for
actual speech — audibly amplifying the noise floor. Content-only ticks
are also the only ones that feed the long sustained-loudness window, so
pauses don't dilute that average either.

**Gain correction.** For ticks that pass the gate:

```
desired_gain = clamp(targetRms / windowedRms, minGain, maxGain)
```

This is **feed-forward**, not closed-loop: the `AnalyserNode` taps the
same pre-gain signal the correction is applied to, in parallel, so the
measurement is never influenced by the gain decision it's used to
compute. (An earlier version measured downstream of the limiter instead,
to compensate for the limiter's own attenuation on loud/peaky content —
that was reverted after live testing showed it oscillating, gain
swinging between roughly 0.7x and 5.3x within 10–20 seconds of ordinary
speech, because the windowed measurement and the gain's own smoothing
constants operate on overlapping timescales and the correction
perpetually overshoots. Feed-forward can't do that: the measurement
structurally can't depend on a gain value it's used to derive.)

**Asymmetric smoothing.** The move from current gain to `desired_gain`
isn't instant — it's smoothed via the Web Audio `setTargetAtTime` API,
which follows an exponential curve:

```
gain(t) = desired + (current − desired) · e^(−t / τ)
```

with a different time constant `τ` depending on direction:
- **attack** (τ = 0.5–0.7s) when gain needs to come *down* — settles
  within a couple of seconds of a genuine sustained loud change starting.
- **release** (τ = 2.3–2.5s) when gain needs to go *up* — deliberately
  slower, so a half-second pause in speech doesn't read as "it's quiet
  now" and yank the gain up.

#### 3. Safety-net limiter

A second `DynamicsCompressorNode`, downstream of the loudness tracker,
with a much shorter time constant (3ms attack, 80–100ms release) and a
high ratio (20:1). This is a pure safety net — it exists to catch a true
instantaneous spike (mic bump, feedback) the multi-second loudness
tracker could never react to in time. It is **not** a scenario-specific
"ad detector"; the loudness tracker owns that job.

### Sensitivity presets

All three settings run the exact same graph topology — only the
numbers change. "Off" uses neutral values (compressor/limiter ratio 1:1,
gain clamped to exactly 1) rather than actually bypassing the nodes, so
switching sensitivity live never requires tearing down and restarting
capture, and "Off" doubles as a passthrough sanity check.

| | **Off** | **Light** | **Strong** |
|---|---|---|---|
| Front compressor threshold / ratio | 0 dB / 1:1 (no-op) | −24 dB / 3:1 | −30 dB / 6:1 |
| Loudness target RMS | 0.06 *(inert — see below)* | 0.06 | 0.066 |
| Sustained window | 2s | 2s | 1.2s |
| Attack / release (τ) | 0.7s / 2.5s | 0.7s / 2.5s | 0.5s / 2.3s |
| Gain range | 1x–1x (locked) | 0.25x–4x | 0.15x–8x |
| Limiter threshold / ratio | 0 dB / 1:1 (no-op) | −3 dB / 20:1 | −1 dB / 20:1 |

*Off's `targetRms`/window/attack/release values are present for
structural consistency but never actually affect output — `minGain` and
`maxGain` are both locked to 1, so `clamp(anything, 1, 1)` is always 1.*

Switching sensitivity mid-playback ramps the compressor and limiter
params over 0.3s rather than snapping them, so there's no audible jump in
the compression curve at the exact moment you change the dropdown.

The `targetRms`/gain-range numbers above were arrived at empirically —
tuned by ear against real lecture-style content, not derived from a
formal loudness standard (see **Known limitations**).

### State & persistence

- **Sensitivity** is global and persisted via `chrome.storage.sync`.
- **Which tabs currently have leveling on** is tracked in
  `chrome.storage.session` (survives the service worker being killed
  and restarted by Chrome, but not a full browser restart — which is
  correct, since a stopped browser has no live capture to resume anyway).

## Project layout

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — permissions, service worker, popup registration |
| `background.js` | Service worker — tabCapture lifecycle, per-tab state, cleanup |
| `offscreen.html` / `offscreen.js` | Offscreen document — holds the `MediaStream`(s) and the Web Audio graph described above |
| `popup.html` / `popup.js` / `popup.css` | Toggle + sensitivity UI |

No `node_modules`, no bundler — every file is loaded by Chrome as-is.

## Debugging

`offscreen.js` has a `DEBUG` flag (`false` by default) near the top of
the file. Flip it to `true` to get throttled (~1x/sec) `console.debug`
output from the loudness tracker — gate RMS, measured RMS, target, and
the gain transition on every tick:

```
[one-sound] gate=0.0770 measured=0.1519 target=0.06 gain=1.98->1.57
```

To see it: go to `chrome://extensions`, find "One Sound," and open the
**offscreen.html** inspector (listed under "Inspect views" — only appears
while capture is active). That's a separate devtools context from the
popup or the service worker.

## Known limitations

- **Tuned against limited content.** The sensitivity presets were dialed
  in by ear against a small number of test videos, primarily
  lecture-style speech. They're a reasonable starting point, not a
  calibrated standard — content with very different noise floors or
  dynamics (music, multi-speaker audio, heavily produced ads) may need
  different numbers.
- **RMS-based noise gate, not real noise reduction.** The gate can't
  distinguish a very soft breath from very soft speech — both look
  identical to an amplitude-only measurement. It reduces noise
  amplification a lot, but isn't a substitute for real denoising.
- **No true loudness (LUFS) measurement.** This uses simple RMS, not
  perceptual/integrated loudness — closer, cheaper, but less accurate
  than a proper loudness standard.
- **One capture stream per tab, but multiple tabs work independently.**
  Each captured tab gets its own `AudioContext`, so leveling multiple
  tabs at once is supported and each runs its own independent loudness
  tracker.
- **Browser-only.** No system-wide/OS-level audio leveling (a native app
  like a desktop Coursera or Spotify client is out of scope), and no
  mobile support (Chrome extensions don't run on Android/iOS Chrome).
- **Not yet published.** No Chrome Web Store listing — this repo is the
  only distribution channel today, and there's no icon set or privacy
  policy prepared yet (both required for a Web Store submission, neither
  required to use it locally via "Load unpacked").

## License

No license file yet — treat this as "all rights reserved" by default
until one is added.
