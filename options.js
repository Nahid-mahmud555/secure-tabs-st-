import * as vault from "./lib/vault.js";

const autoLockSelect = document.getElementById("autoLockMinutes");
const lockOnIdleCheckbox = document.getElementById("lockOnIdle");
const lockOnScreenLockCheckbox = document.getElementById("lockOnScreenLock");
const settingsSaved = document.getElementById("settingsSaved");

async function loadSettings() {
  const settings = await vault.getSettings();
  autoLockSelect.value = String(settings.autoLockMinutes);
  lockOnIdleCheckbox.checked = settings.lockOnIdle;
  lockOnScreenLockCheckbox.checked = settings.lockOnScreenLock;
}

async function persistSettings() {
  await vault.updateSettings({
    autoLockMinutes: Number(autoLockSelect.value),
    lockOnIdle: lockOnIdleCheckbox.checked,
    lockOnScreenLock: lockOnScreenLockCheckbox.checked,
  });
  settingsSaved.hidden = false;
  setTimeout(() => (settingsSaved.hidden = true), 1600);
}

[autoLockSelect, lockOnIdleCheckbox, lockOnScreenLockCheckbox].forEach((el) =>
  el.addEventListener("change", persistSettings)
);

// ---------------------------------------------------------------------------
// Change master password
// ---------------------------------------------------------------------------

document.getElementById("passwordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("passwordError");
  const successEl = document.getElementById("passwordSuccess");
  errorEl.hidden = true;
  successEl.hidden = true;

  const current = document.getElementById("currentPassword").value;
  const next = document.getElementById("newPassword").value;
  const confirm = document.getElementById("confirmNewPassword").value;

  if (next !== confirm) {
    errorEl.textContent = "New passwords don't match.";
    errorEl.hidden = false;
    return;
  }

  try {
    await vault.changePassword(current, next);
    successEl.hidden = false;
    document.getElementById("passwordForm").reset();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

// ---------------------------------------------------------------------------
// Backup export / import
// ---------------------------------------------------------------------------

document.getElementById("exportBtn").addEventListener("click", async () => {
  const errorEl = document.getElementById("backupError");
  const successEl = document.getElementById("backupSuccess");
  errorEl.hidden = true;
  successEl.hidden = true;
  try {
    const backup = await vault.exportEncryptedBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `session-vault-backup-${date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    successEl.textContent = "Backup downloaded.";
    successEl.hidden = false;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById("importFile").addEventListener("change", async (e) => {
  const errorEl = document.getElementById("backupError");
  const successEl = document.getElementById("backupSuccess");
  errorEl.hidden = true;
  successEl.hidden = true;

  const file = e.target.files[0];
  if (!file) return;

  if (
    !confirm(
      "Importing will replace the vault currently stored in this browser. Make sure you have " +
        "a backup of anything important. Continue?"
    )
  ) {
    e.target.value = "";
    return;
  }

  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    await vault.importEncryptedBackup(backup);
    successEl.textContent = "Backup imported. Unlock the vault from the toolbar icon with its password.";
    successEl.hidden = false;
  } catch (err) {
    errorEl.textContent = err.message || "Could not read that file.";
    errorEl.hidden = false;
  } finally {
    e.target.value = "";
  }
});

// ---------------------------------------------------------------------------
// Wipe vault
// ---------------------------------------------------------------------------

document.getElementById("wipeBtn").addEventListener("click", async () => {
  const confirmation = prompt('Type DELETE to permanently erase the vault and all saved sessions.');
  if (confirmation !== "DELETE") return;
  await vault.wipeVault();
  alert("Vault deleted. Reopen the extension to set up a new master password.");
  await loadSettings();
});

loadSettings();
