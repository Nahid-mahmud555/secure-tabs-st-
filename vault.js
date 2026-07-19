/**
 * vault.js
 *
 * The single source of truth for Session Vault's data model and lifecycle.
 * Imported directly (as an ES module) by background.js, popup.js, and
 * options.js — every context talks to the same storage keys, so there is
 * no message-passing plumbing to keep in sync.
 *
 * Storage layout:
 *
 *   chrome.storage.local (persisted to disk, always encrypted-at-rest by us):
 *     sv_meta      -> { initialized, salt, iterations, verifier:{iv,data}, verifierSecret }
 *     sv_vault     -> { iv, data }  (encrypted array of Session objects)
 *     sv_settings  -> { autoLockMinutes, lockOnIdle, lockOnScreenLock }
 *     sv_failedAttempts -> { count, lastAttemptAt }
 *
 *   chrome.storage.session (RAM-only; wiped on browser restart; never on disk):
 *     sv_key          -> base64 raw AES-256 key (only while unlocked)
 *     sv_unlockedAt   -> epoch ms
 *     sv_expiresAt    -> epoch ms (touched on every vault operation)
 *
 * Nothing here ever transmits data off-device. There are no fetch() or
 * XMLHttpRequest calls anywhere in this codebase.
 */

import api from "./browser-polyfill.js";
import * as sv from "./crypto.js";

const KEYS = {
  META: "sv_meta",
  VAULT: "sv_vault",
  SETTINGS: "sv_settings",
  FAILED_ATTEMPTS: "sv_failedAttempts",
};

const SESSION_KEYS = {
  KEY: "sv_key",
  UNLOCKED_AT: "sv_unlockedAt",
  EXPIRES_AT: "sv_expiresAt",
};

const DEFAULT_SETTINGS = {
  autoLockMinutes: 15,
  lockOnIdle: true,
  lockOnScreenLock: true,
};

const EXTENSION_ORIGIN_PATTERN = /^(chrome|moz)-extension:\/\//;

// Internal browser/dev-tooling pages that aren't meaningful to save/restore
// as part of a browsing session (e.g. the Firefox "Load Temporary Add-on"
// debugging page, which is easy to have open while testing this very
// extension).
const INTERNAL_PAGE_PATTERNS = [
  /^about:debugging/i,
  /^about:addons/i,
  /^about:config/i,
  /^chrome:\/\/extensions/i,
  /^edge:\/\/extensions/i,
];

// ---------------------------------------------------------------------------
// Low-level storage helpers
// ---------------------------------------------------------------------------

async function localGet(key) {
  const result = await api.storage.local.get(key);
  return result[key];
}

async function localSet(key, value) {
  return api.storage.local.set({ [key]: value });
}

async function sessionGet(key) {
  const result = await api.storage.session.get(key);
  return result[key];
}

async function sessionSet(obj) {
  return api.storage.session.set(obj);
}

async function sessionRemove(keys) {
  return api.storage.session.remove(keys);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings() {
  const stored = await localGet(KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

export async function updateSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await localSet(KEYS.SETTINGS, next);
  // Re-touch expiry in case autoLockMinutes changed while unlocked.
  if (await isUnlocked()) await touchActivity();
  return next;
}

// ---------------------------------------------------------------------------
// Vault lifecycle: init / unlock / lock
// ---------------------------------------------------------------------------

export async function isInitialized() {
  const meta = await localGet(KEYS.META);
  return Boolean(meta && meta.initialized);
}

export async function createVault(password) {
  if (await isInitialized()) {
    throw new Error("Vault already initialized.");
  }
  if (!password || password.length < 8) {
    throw new Error("Master password must be at least 8 characters.");
  }

  const salt = sv.generateSaltBase64();
  const iterations = sv.PBKDF2_ITERATIONS;
  const key = await sv.deriveKey(password, salt, iterations);

  const verifierSecret = sv.generateVerifierSecret();
  const verifier = await sv.encryptJSON(key, { check: verifierSecret });

  const meta = { initialized: true, salt, iterations, verifier, verifierSecret, createdAt: Date.now() };
  await localSet(KEYS.META, meta);

  const emptyVault = await sv.encryptJSON(key, { sessions: [] });
  await localSet(KEYS.VAULT, emptyVault);
  await localSet(KEYS.SETTINGS, DEFAULT_SETTINGS);
  await localSet(KEYS.FAILED_ATTEMPTS, { count: 0, lastAttemptAt: 0 });

  await cacheUnlockedKey(key);
}

/**
 * Simple client-side throttle against rapid brute-force guessing.
 * This is a UX/defense-in-depth measure, not a substitute for a strong
 * password — anyone with direct access to storage.local can still attempt
 * offline brute force against the PBKDF2 hash, same as any local vault.
 */
async function checkThrottle() {
  const attempts = (await localGet(KEYS.FAILED_ATTEMPTS)) || { count: 0, lastAttemptAt: 0 };
  if (attempts.count >= 5) {
    const backoffMs = Math.min(30_000, 1000 * 2 ** (attempts.count - 5));
    const elapsed = Date.now() - attempts.lastAttemptAt;
    if (elapsed < backoffMs) {
      const waitSec = Math.ceil((backoffMs - elapsed) / 1000);
      throw new Error(`Too many attempts. Try again in ${waitSec}s.`);
    }
  }
}

async function recordFailedAttempt() {
  const attempts = (await localGet(KEYS.FAILED_ATTEMPTS)) || { count: 0, lastAttemptAt: 0 };
  await localSet(KEYS.FAILED_ATTEMPTS, { count: attempts.count + 1, lastAttemptAt: Date.now() });
}

async function clearFailedAttempts() {
  await localSet(KEYS.FAILED_ATTEMPTS, { count: 0, lastAttemptAt: 0 });
}

export async function unlock(password) {
  await checkThrottle();

  const meta = await localGet(KEYS.META);
  if (!meta || !meta.initialized) throw new Error("Vault not initialized.");

  const key = await sv.deriveKey(password, meta.salt, meta.iterations);

  try {
    const check = await sv.decryptJSON(key, meta.verifier);
    if (check.check !== meta.verifierSecret) throw new Error("mismatch");
  } catch {
    await recordFailedAttempt();
    throw new Error("Incorrect master password.");
  }

  await clearFailedAttempts();
  await cacheUnlockedKey(key);
}

async function cacheUnlockedKey(cryptoKey) {
  const raw = await sv.exportKeyRaw(cryptoKey);
  const settings = await getSettings();
  const now = Date.now();
  await sessionSet({
    [SESSION_KEYS.KEY]: raw,
    [SESSION_KEYS.UNLOCKED_AT]: now,
    [SESSION_KEYS.EXPIRES_AT]: now + settings.autoLockMinutes * 60_000,
  });
}

export async function lock() {
  await sessionRemove([SESSION_KEYS.KEY, SESSION_KEYS.UNLOCKED_AT, SESSION_KEYS.EXPIRES_AT]);
}

export async function isUnlocked() {
  const [rawKey, expiresAt] = await Promise.all([
    sessionGet(SESSION_KEYS.KEY),
    sessionGet(SESSION_KEYS.EXPIRES_AT),
  ]);
  if (!rawKey) return false;
  if (expiresAt && Date.now() > expiresAt) {
    await lock();
    return false;
  }
  return true;
}

/** Extends the auto-lock timer. Call this on any user interaction with the vault. */
export async function touchActivity() {
  if (!(await isUnlocked())) return;
  const settings = await getSettings();
  await sessionSet({ [SESSION_KEYS.EXPIRES_AT]: Date.now() + settings.autoLockMinutes * 60_000 });
}

/** Called periodically (via alarm) to enforce the idle auto-lock timer. */
export async function checkAutoLock() {
  const expiresAt = await sessionGet(SESSION_KEYS.EXPIRES_AT);
  if (expiresAt && Date.now() > expiresAt) {
    await lock();
    return true;
  }
  return false;
}

async function getActiveKey() {
  if (!(await isUnlocked())) throw new Error("Vault is locked.");
  const raw = await sessionGet(SESSION_KEYS.KEY);
  return sv.importKeyRaw(raw);
}

export async function changePassword(oldPassword, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error("New master password must be at least 8 characters.");
  }
  // Re-validate the old password explicitly (independent of current unlock state).
  const meta = await localGet(KEYS.META);
  const oldKey = await sv.deriveKey(oldPassword, meta.salt, meta.iterations);
  const check = await sv.decryptJSON(oldKey, meta.verifier).catch(() => null);
  if (!check || check.check !== meta.verifierSecret) {
    throw new Error("Current master password is incorrect.");
  }

  const sessions = await sv.decryptJSON(oldKey, await localGet(KEYS.VAULT));

  const newSalt = sv.generateSaltBase64();
  const newKey = await sv.deriveKey(newPassword, newSalt, sv.PBKDF2_ITERATIONS);
  const newVerifierSecret = sv.generateVerifierSecret();
  const newVerifier = await sv.encryptJSON(newKey, { check: newVerifierSecret });

  await localSet(KEYS.META, {
    ...meta,
    salt: newSalt,
    iterations: sv.PBKDF2_ITERATIONS,
    verifier: newVerifier,
    verifierSecret: newVerifierSecret,
  });
  await localSet(KEYS.VAULT, await sv.encryptJSON(newKey, sessions));
  await cacheUnlockedKey(newKey);
}

// ---------------------------------------------------------------------------
// Session data CRUD
// ---------------------------------------------------------------------------

async function readSessions() {
  const key = await getActiveKey();
  const vaultBlob = await localGet(KEYS.VAULT);
  const decrypted = await sv.decryptJSON(key, vaultBlob);
  return decrypted.sessions || [];
}

async function writeSessions(sessions) {
  const key = await getActiveKey();
  const encrypted = await sv.encryptJSON(key, { sessions });
  await localSet(KEYS.VAULT, encrypted);
  await touchActivity();
}

export async function getSessions() {
  const sessions = await readSessions();
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

function isRestorableUrl(url) {
  if (!url) return false;
  if (EXTENSION_ORIGIN_PATTERN.test(url)) return false;
  if (url.startsWith("devtools://")) return false;
  if (INTERNAL_PAGE_PATTERNS.some((pattern) => pattern.test(url))) return false;
  return true;
}

/**
 * Snapshots real browser windows/tabs into a plain-data Session object.
 * `scope` is "current" (active window only) or "all" (every window).
 */
export async function captureCurrentBrowserState(scope = "all") {
  const windows = await api.windows.getAll({ populate: true, windowTypes: ["normal"] });

  let targetWindows = windows;
  if (scope === "current") {
    const [activeTab] = await api.tabs.query({ active: true, currentWindow: true });
    targetWindows = windows.filter((w) => w.id === activeTab?.windowId);
  }

  const capturedWindows = targetWindows
    .map((w) => ({
      tabs: (w.tabs || [])
        .filter((t) => isRestorableUrl(t.url))
        .map((t) => ({
          url: t.url,
          title: t.title || t.url,
          pinned: Boolean(t.pinned),
          favIconUrl: t.favIconUrl && t.favIconUrl.startsWith("http") ? t.favIconUrl : null,
        })),
    }))
    .filter((w) => w.tabs.length > 0);

  return capturedWindows;
}

export async function saveCurrentAsSession(name, scope = "all") {
  const windows = await captureCurrentBrowserState(scope);
  if (windows.length === 0) throw new Error("No restorable tabs to save.");

  const tabCount = windows.reduce((sum, w) => sum + w.tabs.length, 0);
  const session = {
    id: crypto.randomUUID(),
    name: name?.trim() || defaultSessionName(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    windowCount: windows.length,
    tabCount,
    windows,
  };

  const sessions = await readSessions();
  sessions.push(session);
  await writeSessions(sessions);
  return session;
}

function defaultSessionName() {
  const d = new Date();
  return `Session — ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export async function renameSession(id, newName) {
  const sessions = await readSessions();
  const target = sessions.find((s) => s.id === id);
  if (!target) throw new Error("Session not found.");
  target.name = newName.trim() || target.name;
  target.updatedAt = Date.now();
  await writeSessions(sessions);
}

export async function deleteSession(id) {
  const sessions = await readSessions();
  const next = sessions.filter((s) => s.id !== id);
  await writeSessions(next);
}

export async function restoreSession(id, { newWindow = true } = {}) {
  const sessions = await readSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) throw new Error("Session not found.");

  for (const win of session.windows) {
    const urls = win.tabs.map((t) => t.url);
    if (urls.length === 0) continue;

    if (newWindow) {
      const created = await api.windows.create({ url: urls });
      const createdTabs = created.tabs || (await api.tabs.query({ windowId: created.id }));
      await Promise.all(
        createdTabs.map((tab, idx) => {
          const source = win.tabs[idx];
          if (source?.pinned) return api.tabs.update(tab.id, { pinned: true });
          return Promise.resolve();
        })
      );
    } else {
      for (const t of win.tabs) {
        // eslint-disable-next-line no-await-in-loop
        const tab = await api.tabs.create({ url: t.url, pinned: t.pinned });
        void tab;
      }
    }
  }

  await touchActivity();
  return session;
}

// ---------------------------------------------------------------------------
// Backup export / import (still encrypted — never leaves plaintext)
// ---------------------------------------------------------------------------

export async function exportEncryptedBackup() {
  const meta = await localGet(KEYS.META);
  const vault = await localGet(KEYS.VAULT);
  return {
    format: "session-vault-backup",
    version: 1,
    exportedAt: Date.now(),
    meta,
    vault,
  };
}

export async function importEncryptedBackup(backup) {
  if (!backup || backup.format !== "session-vault-backup" || !backup.meta || !backup.vault) {
    throw new Error("This file doesn't look like a valid Session Vault backup.");
  }
  await lock();
  await localSet(KEYS.META, backup.meta);
  await localSet(KEYS.VAULT, backup.vault);
  await clearFailedAttempts();
}

export async function wipeVault() {
  await lock();
  await api.storage.local.remove([KEYS.META, KEYS.VAULT, KEYS.SETTINGS, KEYS.FAILED_ATTEMPTS]);
}
