// settings.js — default settings + load/save helpers.
// Shared by the content script and the options page (both load this file).
(function (root) {
  'use strict';
  const CBT = (root.CBT = root.CBT || {});

  CBT.DEFAULT_SETTINGS = Object.freeze({
    viewMode: 'human',        // 'human' = your messages only, 'full' = your messages + Claude's replies
    previewLength: 80,        // characters of message text shown per row
    launcher: 'auto',         // 'auto' = toolbar button, floating button if the toolbar isn't found
                              // 'toolbar' | 'floating' | 'none'
    showTimestamps: false,    // show message time on each row
    autoRefresh: true,        // refetch the tree after you send / edit / retry
    fallbackPollSec: 30,      // slow safety refetch while the panel is open (0 = off)
    confirmSwitch: false,     // ask before switching branch
    inlineArrows: true,       // add ‹ k/n › under messages that have other versions
    vaultAuto: true,          // keep every document/file/upload from every branch (this computer only)
    vaultReplies: true,       // …and the full text of every Claude reply
    openOnLoad: false,        // open the panel automatically on chat pages
  });

  function hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
  }

  CBT.loadSettings = async function loadSettings() {
    if (!hasChromeStorage()) return { ...CBT.DEFAULT_SETTINGS };
    try {
      const got = await chrome.storage.sync.get('settings');
      return { ...CBT.DEFAULT_SETTINGS, ...(got.settings || {}) };
    } catch (_) {
      return { ...CBT.DEFAULT_SETTINGS };
    }
  };

  CBT.saveSettings = async function saveSettings(patch) {
    if (!hasChromeStorage()) return;
    const current = await CBT.loadSettings();
    const next = { ...current, ...patch };
    await chrome.storage.sync.set({ settings: next });
    return next;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
