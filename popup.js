import api from "./lib/browser-polyfill.js";
import * as vault from "./lib/vault.js";

const screens = {
  loading: document.getElementById("screen-loading"),
  setup: document.getElementById("screen-setup"),
  unlock: document.getElementById("screen-unlock"),
  main: document.getElementById("screen-main"),
};

const lockBtn = document.getElementById("lockBtn");
const optionsBtn = document.getElementById("optionsBtn");

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  lockBtn.hidden = name !== "main";
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 2200);
}

function showError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.hidden = false;
}

function hideError(elId) {
  document.getElementById(elId).hidden = true;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function route() {
  showScreen("loading");
  const initialized = await vault.isInitialized();
  if (!initialized) {
    showScreen("setup");
    return;
  }
  const unlocked = await vault.isUnlocked();
  if (!unlocked) {
    showScreen("unlock");
    return;
  }
  showScreen("main");
  await renderSessions();
}

optionsBtn.addEventListener("click", () => api.runtime.openOptionsPage());
lockBtn.addEventListener("click", async () => {
  await vault.lock();
  await route();
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

document.getElementById("setupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError("setupError");
  const pw = document.getElementById("setupPassword").value;
  const confirm = document.getElementById("setupPasswordConfirm").value;
  if (pw !== confirm) {
    showError("setupError", "Passwords don't match.");
    return;
  }
  try {
    await vault.createVault(pw);
    await route();
  } catch (err) {
    showError("setupError", err.message);
  }
});

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------

document.getElementById("unlockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError("unlockError");
  const pw = document.getElementById("unlockPassword").value;
  try {
    await vault.unlock(pw);
    document.getElementById("unlockPassword").value = "";
    await route();
  } catch (err) {
    showError("unlockError", err.message);
  }
});

// ---------------------------------------------------------------------------
// Main screen: save
// ---------------------------------------------------------------------------

document.getElementById("saveBtn").addEventListener("click", async () => {
  hideError("mainError");
  const nameInput = document.getElementById("sessionNameInput");
  const scope = document.getElementById("saveScope").value;
  try {
    const session = await vault.saveCurrentAsSession(nameInput.value, scope);
    nameInput.value = "";
    showToast(`Saved “${session.name}” (${session.tabCount} tabs)`);
    await renderSessions();
  } catch (err) {
    showError("mainError", err.message);
  }
});

document.getElementById("searchInput").addEventListener("input", () => renderSessions());

// ---------------------------------------------------------------------------
// Session list rendering
// ---------------------------------------------------------------------------

let cachedSessions = [];

async function renderSessions() {
  hideError("mainError");
  try {
    cachedSessions = await vault.getSessions();
  } catch (err) {
    // Key likely expired between screens — bounce back to unlock.
    await route();
    return;
  }

  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const filtered = query
    ? cachedSessions.filter((s) => s.name.toLowerCase().includes(query))
    : cachedSessions;

  const list = document.getElementById("sessionList");
  const empty = document.getElementById("emptyState");
  list.innerHTML = "";

  if (cachedSessions.length === 0) {
    empty.hidden = false;
    empty.textContent = "No saved sessions yet. Save your current tabs to get started.";
    return;
  }
  if (filtered.length === 0) {
    empty.hidden = false;
    empty.textContent = "No sessions match your search.";
    return;
  }
  empty.hidden = true;

  const template = document.getElementById("sessionItemTemplate");
  for (const session of filtered) {
    const node = template.content.cloneNode(true);
    const li = node.querySelector(".session-item");
    const toggle = node.querySelector(".session-toggle");
    const nameEl = node.querySelector(".session-name");
    const metaEl = node.querySelector(".session-meta");
    const body = node.querySelector(".session-item-body");
    const tabPreview = node.querySelector(".tab-preview");

    nameEl.textContent = session.name;
    metaEl.textContent = `${session.tabCount}t · ${session.windowCount}w · ${relativeTime(session.updatedAt)}`;

    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      body.hidden = expanded;
      if (!expanded && tabPreview.childElementCount === 0) {
        populateTabPreview(tabPreview, session);
      }
    });

    node.querySelector(".action-restore").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = "Restoring…";
      try {
        await vault.restoreSession(session.id);
        showToast(`Restored “${session.name}”`);
      } catch (err) {
        showError("mainError", err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Restore";
      }
    });

    node.querySelector(".action-rename").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const next = prompt("Rename session", session.name);
      if (next === null) return;
      try {
        await vault.renameSession(session.id, next);
        await renderSessions();
      } catch (err) {
        showError("mainError", err.message);
      }
    });

    node.querySelector(".action-delete").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete “${session.name}”? This cannot be undone.`)) return;
      try {
        await vault.deleteSession(session.id);
        await renderSessions();
      } catch (err) {
        showError("mainError", err.message);
      }
    });

    list.appendChild(node);
  }
}

function populateTabPreview(container, session) {
  const allTabs = session.windows.flatMap((w) => w.tabs);
  for (const tab of allTabs.slice(0, 25)) {
    const li = document.createElement("li");
    if (tab.favIconUrl) {
      const img = document.createElement("img");
      img.src = tab.favIconUrl;
      img.alt = "";
      img.onerror = () => (img.style.visibility = "hidden");
      li.appendChild(img);
    } else {
      const dot = document.createElement("span");
      dot.className = "favicon-fallback";
      li.appendChild(dot);
    }
    const label = document.createElement("span");
    label.textContent = tab.title || tab.url;
    li.appendChild(label);
    container.appendChild(li);
  }
  if (allTabs.length > 25) {
    const li = document.createElement("li");
    li.textContent = `…and ${allTabs.length - 25} more`;
    container.appendChild(li);
  }
}

function relativeTime(ts) {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

route();
