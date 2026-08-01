const toggleEl = document.getElementById('toggle');
const statusTextEl = document.getElementById('status-text');
const sensitivityEl = document.getElementById('sensitivity');
const errorEl = document.getElementById('error');

let currentTabId = null;

function showError(message) {
  if (!message) {
    errorEl.hidden = true;
    errorEl.textContent = '';
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function setToggleUI(active) {
  toggleEl.checked = active;
  statusTextEl.textContent = active ? 'Leveling ON for this tab' : 'Leveling OFF for this tab';
}

async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'get-status',
      tabId: currentTabId
    });
    setToggleUI(!!resp?.active);
  } catch (err) {
    console.error('[one-sound] failed to fetch capture status', err);
    showError(`Couldn't reach the extension background: ${err.message}`);
  }
}

async function handleToggleChange() {
  const wantsOn = toggleEl.checked;
  toggleEl.disabled = true;
  showError(null);

  try {
    const resp = await chrome.runtime.sendMessage({
      target: 'background',
      type: wantsOn ? 'start-capture' : 'stop-capture',
      tabId: currentTabId
    });

    if (!resp?.ok) {
      console.error('[one-sound] tabCapture request failed', resp?.error);
      showError(resp?.error || 'Something went wrong.');
      toggleEl.checked = !wantsOn; // revert — the requested state didn't take effect
    }
  } catch (err) {
    console.error('[one-sound] failed to send capture toggle message', err);
    showError(`Couldn't reach the extension background: ${err.message}`);
    toggleEl.checked = !wantsOn;
  }

  toggleEl.disabled = false;
  await refreshStatus();
}

async function handleSensitivityChange() {
  try {
    const resp = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'update-sensitivity',
      sensitivity: sensitivityEl.value
    });
    if (!resp?.ok) {
      console.error('[one-sound] sensitivity update failed', resp?.error);
      showError(resp?.error || "Couldn't update sensitivity.");
    }
  } catch (err) {
    console.error('[one-sound] failed to send sensitivity update message', err);
    showError(`Couldn't reach the extension background: ${err.message}`);
  }
}

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      showError('No active tab.');
      toggleEl.disabled = true;
      return;
    }

    currentTabId = tab.id;

    const isCapturable = /^https?:\/\//.test(tab.url || '');
    if (!isCapturable) {
      showError('This page can’t be captured (not a regular web page).');
      toggleEl.disabled = true;
    }

    const { sensitivity = 'light' } = await chrome.storage.sync.get('sensitivity');
    sensitivityEl.value = sensitivity;

    await refreshStatus();
  } catch (err) {
    console.error('[one-sound] popup init failed', err);
    showError(`Couldn't initialize: ${err.message}`);
    toggleEl.disabled = true;
  }
}

toggleEl.addEventListener('change', handleToggleChange);
sensitivityEl.addEventListener('change', handleSensitivityChange);

init();
