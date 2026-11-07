# Privacy

Claude Branch Tree runs entirely in your browser.

- **No servers, no analytics, no tracking.** The extension never sends data anywhere except back to `claude.ai`, using your existing login.
- **What it reads from claude.ai:** the conversation you have open (its full message tree), and — for the document vault — files attached to messages in that conversation. These are read-only requests.
- **What it changes on claude.ai:** nothing. It never sends messages, edits, deletes, or moves your conversation's branch on the server. Branch switching only changes what *your tab* displays after a reload.
- **What it stores, and where:** labels, stars, folded rows, settings and the document vault, in Chrome's extension storage on **this computer only** (`chrome.storage.local`, settings in `chrome.storage.sync`). Uninstalling the extension deletes it.
- **Permissions:** `storage` and `unlimitedStorage` (for the vault), and access to `https://claude.ai/*` only.
