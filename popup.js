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
  const resp = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'get-status',
    tabId: currentTabId
  });
  setToggleUI(!!resp?.active);
}

async function handleToggleChange() {
  const wantsOn = toggleEl.checked;
  toggleEl.disabled = true;
  showError(null);

  const resp = await chrome.runtime.sendMessage({
    target: 'background',
    type: wantsOn ? 'start-capture' : 'stop-capture',
    tabId: currentTabId
  });

  if (!resp?.ok) {
    showError(resp?.error || 'Something went wrong.');
  }

  toggleEl.disabled = false;
  await refreshStatus();
}

async function handleSensitivityChange() {
  await chrome.runtime.sendMessage({
    target: 'background',
    type: 'update-sensitivity',
    sensitivity: sensitivityEl.value
  });
}

async function init() {
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
}

toggleEl.addEventListener('change', handleToggleChange);
sensitivityEl.addEventListener('change', handleSensitivityChange);

init();
