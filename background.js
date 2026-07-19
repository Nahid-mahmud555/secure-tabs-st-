/**
 * background.js
 *
 * Runs as an MV3 service worker (Chrome) / event page (Firefox). It does
 * NOT hold decrypted vault contents in module-level memory, because
 * service workers can be terminated by the browser at any time — instead
 * every read/write goes through vault.js, which caches only the derived
 * AES key in chrome.storage.session (RAM-only, survives worker restarts,
 * wiped on browser close).
 *
 * Responsibilities specific to the background context:
 *   1. Periodic auto-lock enforcement via chrome.alarms
 *   2. Immediate lock on system idle / screen lock via chrome.idle
 *   3. Lock on browser startup (belt-and-suspenders; storage.session is
 *      already cleared by the browser on restart)
 *   4. A context-menu shortcut for one-click session saving
 */

import api from "./lib/browser-polyfill.js";
import * as vault from "./lib/vault.js";

const AUTO_LOCK_ALARM = "sv-autolock-check";
const CONTEXT_MENU_SAVE_ID = "sv-save-session";

// ---- auto-lock alarm ----

api.alarms.create(AUTO_LOCK_ALARM, { periodInMinutes: 1 });

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) {
    vault.checkAutoLock();
  }
});

// ---- idle / screen-lock detection ----

api.idle.setDetectionInterval(60); // seconds

api.idle.onStateChanged.addListener(async (state) => {
  const settings = await vault.getSettings();
  if (state === "locked" && settings.lockOnScreenLock) {
    await vault.lock();
  } else if (state === "idle" && settings.lockOnIdle) {
    await vault.lock();
  }
});

// ---- lock on browser startup ----

api.runtime.onStartup.addListener(() => {
  vault.lock();
});

// ---- install: seed context menu ----

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.create({
    id: CONTEXT_MENU_SAVE_ID,
    title: "Save all windows to Session Vault",
    contexts: ["action"],
  });
});

api.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== CONTEXT_MENU_SAVE_ID) return;
  try {
    if (!(await vault.isInitialized()) || !(await vault.isUnlocked())) {
      // Can't save silently while locked — surface the popup instead.
      if (api.action.openPopup) api.action.openPopup();
      return;
    }
    await vault.saveCurrentAsSession(undefined, "all");
  } catch (err) {
    console.error("Session Vault: quick-save failed", err);
  }
});
