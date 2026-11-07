// options.js — settings page logic. MV3 forbids inline scripts, hence this file.
'use strict';
(async function () {
  const CBT = globalThis.CBT;
  const msg = document.getElementById('msg');
  const say = (t) => { msg.textContent = t; setTimeout(() => { if (msg.textContent === t) msg.textContent = ''; }, 4000); };

  const s = await CBT.loadSettings();
  for (const [key, def] of Object.entries(CBT.DEFAULT_SETTINGS)) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (typeof def === 'boolean') el.checked = !!s[key];
    else el.value = s[key];
    el.addEventListener('change', async () => {
      let v;
      if (typeof def === 'boolean') v = el.checked;
      else if (typeof def === 'number') {
        v = Math.max(+el.min || 0, Math.min(+el.max || 1e9, Math.round(+el.value || 0)));
        el.value = v;
      } else v = el.value;
      await CBT.saveSettings({ [key]: v });
      say('Saved');
    });
  }

  document.getElementById('openVault').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('vault/vault.html') }));

  document.getElementById('export').addEventListener('click', async () => {
    const data = await CBT.storage.exportAll();
    const n = Object.keys(data.conversations).length;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `branch-tree-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    say(`Exported ${n} conversation${n === 1 ? '' : 's'}`);
  });

  const file = document.getElementById('importFile');
  document.getElementById('importBtn').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const n = await CBT.storage.importAll(JSON.parse(await f.text()), document.getElementById('merge').checked);
      say(`Imported ${n} conversation${n === 1 ? '' : 's'}`);
    } catch (e) {
      say('Import failed: ' + e.message);
    }
    file.value = '';
  });
})();
