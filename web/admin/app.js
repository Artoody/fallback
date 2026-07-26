const STORAGE_KEY = "gemini_proxy_admin_password";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const logoutBtn = document.getElementById("logout-btn");

const clientForm = document.getElementById("client-form");
const clientName = document.getElementById("client-name");
const clientError = document.getElementById("client-error");
const clientsBody = document.getElementById("clients-body");
const newKeyBanner = document.getElementById("new-key-banner");
const newKeyValue = document.getElementById("new-key-value");
const copyNewKey = document.getElementById("copy-new-key");

const geminiForm = document.getElementById("gemini-form");
const geminiKey = document.getElementById("gemini-key");
const geminiError = document.getElementById("gemini-error");
const geminiList = document.getElementById("gemini-list");
const geminiStatus = document.getElementById("gemini-status");

function getPassword() {
  return sessionStorage.getItem(STORAGE_KEY) || "";
}

function setPassword(value) {
  sessionStorage.setItem(STORAGE_KEY, value);
}

function clearPassword() {
  sessionStorage.removeItem(STORAGE_KEY);
}

function showError(el, message) {
  if (!message) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const password = getPassword();
  if (password) headers["x-admin-password"] = password;

  const res = await fetch(path, { ...options, headers });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(data?.error || `خطا ${res.status}`);
  }
  return data;
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("fa-IR");
  } catch {
    return iso;
  }
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString("fa-IR");
}

async function refreshAll() {
  const [overview, clientsRes, geminiRes] = await Promise.all([
    api("/admin/api/overview"),
    api("/admin/api/clients"),
    api("/admin/api/gemini-keys"),
  ]);

  document.getElementById("stat-gemini").textContent = formatNumber(overview.geminiKeyCount);
  document.getElementById("stat-clients").textContent = formatNumber(overview.clientCount);
  document.getElementById("stat-requests").textContent = formatNumber(overview.totalRequests);

  renderClients(clientsRes.clients || []);
  renderGeminiKeys(geminiRes.keys || [], geminiRes.status || []);
}

function renderClients(clients) {
  if (!clients.length) {
    clientsBody.innerHTML = `<tr><td colspan="9" class="muted">هنوز دانش‌آموزی ثبت نشده.</td></tr>`;
    return;
  }

  clientsBody.innerHTML = clients
    .map((c) => {
      const enabled = c.enabled !== false;
      return `
      <tr data-id="${c.id}">
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td>
          <code title="${escapeHtml(c.key)}">${escapeHtml(c.keyPreview)}</code>
          <button class="ghost small" data-action="copy" data-key="${escapeHtml(c.key)}" type="button">کپی</button>
        </td>
        <td>${formatNumber(c.stats?.requests)}</td>
        <td>${formatNumber(c.stats?.success)}</td>
        <td>${formatNumber(c.stats?.errors)}</td>
        <td>${formatNumber(c.stats?.totalTokens)}</td>
        <td>${formatDate(c.stats?.lastUsedAt)}</td>
        <td><span class="badge ${enabled ? "on" : "off"}">${enabled ? "فعال" : "غیرفعال"}</span></td>
        <td class="actions">
          <button class="ghost small" data-action="toggle" type="button">${enabled ? "قطع" : "فعال"}</button>
          <button class="ghost small" data-action="regen" type="button">کلید جدید</button>
          <button class="danger small" data-action="delete" type="button">حذف</button>
        </td>
      </tr>`;
    })
    .join("");
}

function renderGeminiKeys(keys, statusList) {
  if (!keys.length) {
    geminiList.innerHTML = `<li class="muted">کلیدی ثبت نشده.</li>`;
  } else {
    geminiList.innerHTML = keys
      .map(
        (k) => `
      <li>
        <div>
          <code>${escapeHtml(k.preview)}</code>
          <div class="meta">#${k.index + 1} · طول ${k.length}</div>
        </div>
        <button class="danger small" data-gemini-index="${k.index}" type="button">حذف</button>
      </li>`
      )
      .join("");
  }

  if (!statusList.length) {
    geminiStatus.innerHTML = `<li class="muted">وضعیتی نیست.</li>`;
    return;
  }

  geminiStatus.innerHTML = statusList
    .map((s) => {
      const blocked = s.blocked;
      const cool = blocked ? ` · ${Math.ceil((s.blockedForMs || 0) / 1000)}ثانیه cooldown` : "";
      return `
      <li>
        <div>
          <code>${escapeHtml(s.keyPreview)}</code>
          <div class="meta">خطا: ${formatNumber(s.failCount)}${cool}</div>
        </div>
        <span class="badge ${blocked ? "blocked" : "on"}">${blocked ? "بلاک موقت" : "آماده"}</span>
      </li>`;
    })
    .join("");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function enterApp() {
  loginView.classList.add("hidden");
  appView.classList.remove("hidden");
  await refreshAll();
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(loginError, "");
  const password = document.getElementById("admin-password").value;
  try {
    await fetch("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "ورود ناموفق");
    });
    setPassword(password);
    await enterApp();
  } catch (err) {
    showError(loginError, err.message);
  }
});

logoutBtn.addEventListener("click", () => {
  clearPassword();
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
});

clientForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(clientError, "");
  try {
    const data = await api("/admin/api/clients", {
      method: "POST",
      body: JSON.stringify({ name: clientName.value }),
    });
    clientName.value = "";
    newKeyValue.textContent = data.client.key;
    newKeyBanner.classList.remove("hidden");
    await refreshAll();
  } catch (err) {
    showError(clientError, err.message);
  }
});

copyNewKey.addEventListener("click", async () => {
  const value = newKeyValue.textContent;
  if (!value) return;
  await navigator.clipboard.writeText(value);
  copyNewKey.textContent = "کپی شد";
  setTimeout(() => (copyNewKey.textContent = "کپی"), 1200);
});

clientsBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const row = btn.closest("tr[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  const action = btn.dataset.action;

  try {
    if (action === "copy") {
      await navigator.clipboard.writeText(btn.dataset.key);
      btn.textContent = "شد";
      setTimeout(() => (btn.textContent = "کپی"), 900);
      return;
    }
    if (action === "toggle") {
      const currentlyOn = btn.textContent.includes("قطع");
      await api(`/admin/api/clients/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !currentlyOn }),
      });
    }
    if (action === "regen") {
      if (!confirm("کلید جدید ساخته شود؟ کلید قبلی دیگر کار نمی‌کند.")) return;
      const data = await api(`/admin/api/clients/${id}/regenerate`, { method: "POST" });
      newKeyValue.textContent = data.client.key;
      newKeyBanner.classList.remove("hidden");
    }
    if (action === "delete") {
      if (!confirm("این دانش‌آموز حذف شود؟")) return;
      await api(`/admin/api/clients/${id}`, { method: "DELETE" });
    }
    await refreshAll();
  } catch (err) {
    alert(err.message);
  }
});

geminiForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(geminiError, "");
  try {
    await api("/admin/api/gemini-keys", {
      method: "POST",
      body: JSON.stringify({ key: geminiKey.value.trim() }),
    });
    geminiKey.value = "";
    await refreshAll();
  } catch (err) {
    showError(geminiError, err.message);
  }
});

geminiList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-gemini-index]");
  if (!btn) return;
  const index = btn.dataset.geminiIndex;
  if (!confirm("این کلید Gemini حذف شود؟")) return;
  try {
    await api(`/admin/api/gemini-keys/${index}`, { method: "DELETE" });
    await refreshAll();
  } catch (err) {
    showError(geminiError, err.message);
  }
});

(async function boot() {
  if (!getPassword()) return;
  try {
    await api("/admin/api/overview");
    await enterApp();
  } catch {
    clearPassword();
  }
})();
