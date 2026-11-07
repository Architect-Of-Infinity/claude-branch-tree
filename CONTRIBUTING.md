# Contributing

Thanks for helping. Most changes fall into one of three kinds.

## 1. claude.ai changed its page (the common one)
- Open the panel → ⋯ → **Diagnostics** to see which check fails.
- All page selectors are in `SEL` at the top of **`extension/src/dom.js`**. Update them there, keeping the old ones as fallbacks below the new.
- Branch switching on the new layout lives in **`extension/src/page-hook.js`** (the load-time id swap). If `Last switch: missed` appears, the load format changed.

## 2. Tree / vault logic
- `extension/src/tree.js` and `extension/src/vault.js` are pure functions with unit tests in `tests/`.
- Add a test for every bug you fix.

## 3. UI
- Panel: `extension/src/panel.js` + `extension/src/styles.js` (Shadow DOM, so claude.ai's CSS can't interfere).
- Vault / settings: `extension/vault/`, `extension/options/`.

## Running it
```bash
# load: chrome://extensions → Developer mode → Load unpacked → extension/
cd tests && npm install && npm test        # unit + simulated-page tests
node chrome-newlayout.js                   # real Chrome vs. a fake new-layout claude.ai (needs Chrome for Testing)
```

## Rules
- **Read-only towards claude.ai.** Never send, edit, delete or change server state on the user's behalf.
- **No external servers**, no analytics, no remote code.
- **No real chat data** in tests, fixtures or screenshots.
