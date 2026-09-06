// Fetch wrapper for /api/*. JSON in/out, same-origin credentials.
// On 401: shows the full-screen login overlay, waits for a successful login, retries once.

let loginPromise = null;
let wired = false;

function wireLoginForm() {
  if (wired) return;
  wired = true;
  const form = document.getElementById("login-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = document.getElementById("login-pw");
    const err = document.getElementById("login-err");
    const btn = form.querySelector('button[type="submit"]');
    err.hidden = true;
    btn.disabled = true;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw.value }),
      });
      if (!res.ok) {
        err.hidden = false;
        pw.select();
        return;
      }
      hideLogin();
      const resolve = loginPromise && loginPromise._resolve;
      loginPromise = null;
      if (resolve) resolve();
    } catch {
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

export function showLogin() {
  wireLoginForm();
  const overlay = document.getElementById("login");
  if (overlay) {
    overlay.hidden = false;
    const pw = document.getElementById("login-pw");
    if (pw) {
      pw.value = "";
      pw.focus();
    }
  }
  if (!loginPromise) {
    let _resolve;
    loginPromise = new Promise((res) => { _resolve = res; });
    loginPromise._resolve = _resolve;
  }
  return loginPromise;
}

function hideLogin() {
  const overlay = document.getElementById("login");
  if (overlay) overlay.hidden = true;
}

async function request(path, { method = "GET", body } = {}, retried = false) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let url = "/api" + path;
  if (method === "GET" && !/[?&]today=/.test(url)) {
    // Local calendar date, so server-side "day N of the month" math matches the
    // user's clock instead of UTC (which flips to tomorrow at 8pm Eastern).
    const d = new Date();
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    url += (url.includes("?") ? "&" : "?") + "today=" + local;
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error("Network error — are you offline?");
  }
  if (res.status === 401) {
    if (retried) throw new Error("Not signed in");
    await showLogin();
    return request(path, { method, body }, true);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body = {}) => request(path, { method: "POST", body }),
  patch: (path, body) => request(path, { method: "PATCH", body }),
  put: (path, body) => request(path, { method: "PUT", body }),
  del: (path) => request(path, { method: "DELETE" }),
};
