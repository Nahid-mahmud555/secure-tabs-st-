# Session Vault

A privacy-first browser extension for saving and restoring browser sessions
(windows + tabs), encrypted at rest with a master password. Built on
Manifest V3, works in both Chrome and Firefox from a single codebase.

## Install (unpacked / development)

One `manifest.json` works for both browsers — it declares the background
script as `service_worker`, which modern Chrome and modern Firefox
(121+) both understand natively.

**Chrome / Edge / Brave:**
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `session-vault` folder

**Firefox (121+):**
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` inside the `session-vault` folder
4. ⚠️ Firefox's "Load Temporary Add-on" is, as the name says, temporary —
   it's removed when Firefox fully closes. You'll need to repeat step
   1–3 each time you restart Firefox during testing. (Chrome's "Load
   unpacked" does persist across restarts — that's a Chrome-specific
   dev-mode behavior, not something this extension controls.) For a
   permanent Firefox install, the extension needs to be signed via
   `web-ext sign` / AMO.

If you're on an older Firefox that doesn't yet support MV3 service
workers, you'll see a harmless console warning about `service_worker`
being unrecognized, and the extension may not run its background logic
(auto-lock timer, context menu). Updating Firefox resolves this.

## Architecture

```
session-vault/
├── manifest.json          MV3 manifest, works unmodified in Chrome and
│                          Firefox 121+ (background.service_worker)
├── background.js          Service worker: auto-lock alarm, idle/screen-lock
│                          detection, context menu
├── popup.html/js/css      Toolbar popup: setup, unlock, session list, save
├── options.html/js/css    Settings page: auto-lock config, password change,
│                          encrypted backup export/import, vault wipe
└── lib/
    ├── browser-polyfill.js  Normalizes chrome.* / browser.* into one `api`
    ├── crypto.js             WebCrypto only: PBKDF2 + AES-256-GCM
    └── vault.js              Storage schema, unlock lifecycle, session CRUD
```

`lib/vault.js` is imported directly as an ES module by **all three**
contexts (background, popup, options), rather than routed through message
passing. They all read/write the same `chrome.storage.local` /
`chrome.storage.session` keys, so there's a single source of truth and no
background service worker holding state that could vanish on termination.

## Security model

- **Encryption:** AES-256-GCM. Each write gets a fresh random 96-bit IV.
- **Key derivation:** PBKDF2-HMAC-SHA256, 250,000 iterations, random 128-bit
  salt per vault.
- **Password verification:** a random secret is encrypted at vault-creation
  time and re-decrypted on unlock; the password itself is never stored.
- **Key caching while unlocked:** the derived AES key is cached in
  `chrome.storage.session` — an in-memory-only storage area that is never
  written to disk and is cleared automatically when the browser closes.
  This is what lets the vault survive MV3 service-worker restarts without
  falling back to weaker persistence.
- **Auto-lock:** a `chrome.alarms` tick (every 60s) enforces an idle
  timeout (default 15 min, configurable). `chrome.idle` also forces an
  immediate lock on system idle or screen lock, if enabled in Settings.
- **Brute-force throttling:** repeated failed unlock attempts trigger
  client-side exponential backoff. This is defense-in-depth, not a
  substitute for a strong password — anyone with direct filesystem access
  to browser profile storage could still attempt offline brute force
  against the PBKDF2 hash, which is inherent to any local-vault design.
- **No network access whatsoever.** There is no `fetch`, `XMLHttpRequest`,
  or remote script anywhere in this codebase, and the CSP
  (`script-src 'self'`) blocks remote code from ever being loaded, even by
  an injected script.

## What's stored (and what isn't)

Session Vault snapshots **window/tab metadata only**: URL, title, favicon
URL, pinned state. It does **not** capture cookies, form data, browsing
history, or authentication state — restoring a session reopens the same
tabs, it doesn't log you back in. If you need that, that's a materially
different (and riskier) product; see "Possible extensions" below.

## Permissions rationale

| Permission | Why |
|---|---|
| `storage` | Persist the encrypted vault + settings; cache the unlock key in RAM-only session storage |
| `tabs` | Read tab URLs/titles across all windows to build a session snapshot, and open tabs on restore |
| `alarms` | Periodic auto-lock enforcement even while the popup is closed |
| `idle` | Immediate lock on system idle / screen lock |
| `contextMenus` | Optional one-click "save all windows" shortcut from the toolbar icon |

No `host_permissions` are requested — the extension never reads page
content, only tab metadata exposed by the `tabs` API.

## Known limitations

- If the master password is lost, the vault **cannot** be recovered by
  design (there is no backdoor, server-side reset, or recovery key).
- Firefox versions older than 121 don't reliably support MV3 background
  service workers; the manifest's `strict_min_version` is set accordingly.
  On an older Firefox you may see a console warning and the background
  logic (auto-lock alarm, context menu) simply won't run — updating
  Firefox resolves it.
- `chrome.action.openPopup()` (used by the context-menu shortcut when
  locked) requires a recent Chromium version and is a no-op fallback
  elsewhere.

## Possible extensions

- Per-session tags/folders
- Drag-to-reorder tabs before restoring
- Keyboard-driven quick-save (the `Ctrl+Shift+V` command already opens the
  popup; a dedicated no-UI "quick save" command could be added)
- Optional passphrase-derived recovery codes (would need careful design —
  a recovery path is inherently a second way in)
