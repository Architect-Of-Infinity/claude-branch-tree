# Changelog

## 2.2.0
- Redesigned panel: the tree is drawn as a metro map (git-graph style), with the on-screen branch as a bold line.
- "Yours / All" switch, search with hit count, starred filter, visible row actions (star, label, go), first-run guide, loading skeleton.
- In-chat `‹ 2/3 ›` arrows show a preview of the neighbouring version on hover; "Switching…" indicator; calmer older-branch bar with *Show map* and *Back to latest*.
- New vault and settings page design (Fraunces + IBM Plex, bundled under the SIL OFL).
- Extension icon opens the vault when you're not on claude.ai.

## 2.1.0
- Works with claude.ai's new layout (no native version arrows): adds its own arrows and switches branches by reloading the chat and swapping the branch id while it loads (this tab only).
- Exact page ↔ tree matching via `data-turn-key`.
- Document vault: every document, shared file, upload and reply from every branch, saved locally, downloadable as .zip.
- Export of every branch as one Markdown file.

## 2.0.0
- Rewrite of the Tampermonkey userscript as a Manifest V3 extension: on-screen branch detection, branch switching, search, labels, stars, export, keyboard navigation, settings, diagnostics.
