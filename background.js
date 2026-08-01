// Service worker: owns tabCapture lifecycle + per-tab state.
// Holds no audio itself — the offscreen document does that (service workers
// can't keep a MediaStream/AudioContext alive).

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });
  return contexts.length > 0;
}

let creatingOffscreenDocument = null;

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }
  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Hold the tabCapture MediaStream and run the Web Audio leveling graph'
  });
  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function getSensitivity() {
  const { sensitivity } = await chrome.storage.sync.get({ sensitivity: 'light' });
  return sensitivity;
}

async function getActiveTabs() {
  const { activeTabs = {} } = await chrome.storage.session.get('activeTabs');
  return activeTabs;
}

async function setTabActive(tabId, active) {
  const activeTabs = await getActiveTabs();
  if (active) {
    activeTabs[tabId] = true;
  } else {
    delete activeTabs[tabId];
  }
  await chrome.storage.session.set({ activeTabs });
  updateBadge(tabId, active);
}

function updateBadge(tabId, active) {
  chrome.action.setBadgeText({ tabId, text: active ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2e7d32' });
}

async function startLeveling(tabId) {
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    console.error(`[one-sound] failed to create offscreen document (tab ${tabId})`, err);
    return { ok: false, error: `Couldn't set up audio processing: ${err.message}` };
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    console.error(`[one-sound] tabCapture.getMediaStreamId failed (tab ${tabId})`, err);
    return { ok: false, error: `Couldn't capture this tab: ${err.message}` };
  }

  const sensitivity = await getSensitivity();

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start-capture',
      tabId,
      streamId,
      sensitivity
    });
  } catch (err) {
    console.error(`[one-sound] failed to message offscreen document (tab ${tabId})`, err);
    return { ok: false, error: `Couldn't reach the audio processor: ${err.message}` };
  }

  if (!response?.ok) {
    const error = response?.error || 'Offscreen document failed to start capture';
    console.error(`[one-sound] offscreen start-capture failed (tab ${tabId})`, error);
    return { ok: false, error };
  }

  await setTabActive(tabId, true);
  return { ok: true };
}

async function stopLeveling(tabId) {
  if (await hasOffscreenDocument()) {
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-capture', tabId });
    } catch (err) {
      console.error(`[one-sound] failed to message offscreen document to stop (tab ${tabId})`, err);
    }
  }
  await setTabActive(tabId, false);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'background') return false;

  (async () => {
    try {
      switch (message.type) {
        case 'start-capture':
          sendResponse(await startLeveling(message.tabId));
          break;
        case 'stop-capture':
          sendResponse(await stopLeveling(message.tabId));
          break;
        case 'update-sensitivity': {
          await chrome.storage.sync.set({ sensitivity: message.sensitivity });
          if (await hasOffscreenDocument()) {
            await chrome.runtime
              .sendMessage({
                target: 'offscreen',
                type: 'update-sensitivity',
                sensitivity: message.sensitivity
              })
              .catch((err) => {
                console.error('[one-sound] failed to push sensitivity update to offscreen document', err);
              });
          }
          sendResponse({ ok: true });
          break;
        }
        case 'get-status': {
          const activeTabs = await getActiveTabs();
          sendResponse({ active: !!activeTabs[message.tabId] });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error(`[one-sound] unhandled error processing "${message.type}"`, err);
      sendResponse({ ok: false, error: err.message || 'Unexpected error in background service worker' });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});

// Tab-level cleanup: capture stopped/errored (e.g. tab navigated, DRM kicked
// capture off) or the tab itself was closed.
chrome.tabCapture.onStatusChanged.addListener((info) => {
  if (info.status === 'error') {
    console.error(`[one-sound] tabCapture reported an error (tab ${info.tabId})`, info);
  }
  if (info.status === 'stopped' || info.status === 'error') {
    stopLeveling(info.tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const activeTabs = await getActiveTabs();
  if (activeTabs[tabId]) {
    await stopLeveling(tabId);
  }
});
