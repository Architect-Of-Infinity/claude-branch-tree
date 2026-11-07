// background.js — service worker. Only job: turn the keyboard shortcut and the
// toolbar-icon click into a "toggle" message for the claude.ai tab.
'use strict';

async function toggleIn(tab) {
  if (!tab || !tab.id) return;
  // Anywhere other than claude.ai, the icon opens the document vault.
  if (!/^https:\/\/claude\.ai\//.test(tab.url || '')) {
    chrome.tabs.create({ url: chrome.runtime.getURL('vault/vault.html') });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'cbt-toggle' });
  } catch (_) {
    // Content script not there yet (tab opened before the extension was installed/reloaded).
    // A reload fixes it; we don't force one on you.
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /^https:\/\/claude\.ai\//.test(tab.url || '')) toggleIn(tab); // shortcut only acts on claude.ai
});

chrome.action.onClicked.addListener((tab) => toggleIn(tab));

// Content scripts can't open the options page themselves.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'cbt-open-options') chrome.runtime.openOptionsPage();
  if (msg && msg.type === 'cbt-open-vault') {
    const q = msg.conv && /^[0-9a-f-]{36}$/.test(msg.conv) ? `?conv=${msg.conv}` : '';
    chrome.tabs.create({ url: chrome.runtime.getURL('vault/vault.html' + q) });
  }
});
