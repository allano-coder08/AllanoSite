// =====================================================
// AllanoSite - Deriv bot (app.js) - NEW Deriv API (OAuth 2.0 + PKCE)
// =====================================================

// >>> PASTE YOUR DERIV APP ID (client_id) HERE <<<
const APP_ID = "350cqOOeGCMWqrKgybWnf";

// >>> Must match EXACTLY the redirect URL registered in your Deriv app (including the trailing slash) <<<
const REDIRECT_URI = "https://allanosite.vercel.app/";

// >>> OPTIONAL: your Deriv partner/affiliate tracking token for Register sign-ups (leave "" if none) <<<
const AFFILIATE_TOKEN = "";

// ---------- Settings ----------
const SCOPE = "trade";            // must be a scope enabled for your app in the Deriv dashboard
const SYMBOL = "1HZ100V";         // Volatility 100 (1s). Use "R_100" for Volatility 100 (2s)
const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const API_BASE = "https://api.derivws.com";

const SESSION_KEY = "allano_session";
const ACTIVE_KEY = "allano_active_acct";

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);

const loginBtn = $("login-btn");
const heroLoginBtn = $("hero-login-btn");
const logoutBtn = $("logout-btn");
const connectionBadge = $("connection-badge");
const landingSection = $("landing-section");
const dashboardSection = $("dashboard-section");

const accountIdEl = $("account-id");
const accountTypeEl = $("account-type");
const accountSwitcher = $("account-switcher");
const accountBalanceEl = $("account-balance");
const liveTickEl = $("live-tick");
const lastDigitEl = $("last-digit");

const startBotBtn = $("start-bot-btn");
const stopBotBtn = $("stop-bot-btn");
const clearLogsBtn = $("clear-logs-btn");
const botStatusPill = $("bot-status-pill");
const botLogsEl = $("bot-logs");
const sessionPnlEl = $("session-pnl");

const show = (el) => el && el.classList.remove("hidden");
const hide = (el) => el && el.classList.add("hidden");
const setText = (el, text) => { if (el) el.textContent = text; };

// ---------- State ----------
let session = null;          // { token, expires_at }
let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let manualClose = false;

let accounts = [];           // [{ id, type, currency, balance }]
let activeAccount = null;
let botRunning = false;
let currentStake = 1.0;
let sessionProfit = 0.0;
let waitingForContract = false;
let activeContractId = null;

// ---------- Logging / UI ----------
function addLog(message, colorClass = "") {
  if (!botLogsEl) return;
  const line = document.createElement("div");
  if (colorClass) line.className = colorClass;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  botLogsEl.appendChild(line);
  botLogsEl.scrollTop = botLogsEl.scrollHeight;
}

function setBadge(text, cls) {
  if (!connectionBadge) return;
  connectionBadge.textContent = text;
  connectionBadge.className = `badge ${cls}`;
}

function updatePnlDisplay() {
  if (!sessionPnlEl) return;
  sessionPnlEl.textContent =
    sessionProfit >= 0
      ? `+$${sessionProfit.toFixed(2)}`
      : `-$${Math.abs(sessionProfit).toFixed(2)}`;
  sessionPnlEl.className = sessionProfit >= 0 ? "highlight-green" : "highlight-red";
}

function readNumber(id, fallback) {
  const el = $(id);
  const v = el ? parseFloat(el.value) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ---------- 1. OAuth 2.0 + PKCE ----------
function makeVerifier() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return Array.from(bytes).map((v) => chars[v % chars.length]).join("");
}

async function makeChallenge(verifier) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeState() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function startOAuth(signup = false) {
  if (!APP_ID || APP_ID === "YOUR_APP_ID") {
    alert("Please set your Deriv App ID in app.js first.");
    return;
  }
  const verifier = makeVerifier();
  const challenge = await makeChallenge(verifier);
  const state = makeState();

  sessionStorage.setItem("pkce_code_verifier", verifier);
  sessionStorage.setItem("oauth_state", state);

  const url = new URL(AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", APP_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  if (signup) {
    url.searchParams.set("prompt", "registration");
    if (AFFILIATE_TOKEN) url.searchParams.set("t", AFFILIATE_TOKEN);
  }

  window.location.href = url.toString();
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: APP_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const attempt = async (url) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      throw new Error(j.error_description || j.error || `Token exchange failed (${r.status})`);
    }
    return j;
  };

  try {
    return await attempt(TOKEN_URL);
  } catch (e) {
    // A TypeError means the browser blocked the request (CORS/network): use the Vercel proxy instead
    if (e instanceof TypeError) return await attempt("/api/token");
    throw e;
  }
}

async function handleOAuthCallback() {
  const p = new URLSearchParams(window.location.search);
  if (!p.has("code") && !p.has("error")) return;

  window.history.replaceState({}, document.title, window.location.pathname);

  if (p.has("error")) {
    alert(`Deriv login failed: ${p.get("error_description") || p.get("error")}`);
    return;
  }

  const savedState = sessionStorage.getItem("oauth_state");
  const verifier = sessionStorage.getItem("pkce_code_verifier");
  sessionStorage.removeItem("oauth_state");
  sessionStorage.removeItem("pkce_code_verifier");

  if (!savedState || p.get("state") !== savedState || !verifier) {
    alert("Login failed: security check (state) did not match. Please try again.");
    return;
  }

  try {
    const t = await exchangeCode(p.get("code"), verifier);
    saveSession(t);
  } catch (e) {
    alert(`Login failed: ${e.message}`);
  }
}

// ---------- 2. Session storage ----------
function saveSession(t) {
  const lifetime = (Number(t.expires_in) || 3600) * 1000;
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ token: t.access_token, expires_at: Date.now() + lifetime })
  );
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (s && s.token && s.expires_at > Date.now()) return s;
  } catch {
    /* ignore */
  }
  localStorage.removeItem(SESSION_KEY);
  return null;
}

function sessionExpired(message = "Your Deriv session expired. Please log in again.") {
  manualClose = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (ws) { try { ws.onclose = null; ws.close(); } catch { /* ignore */ } }
  stopBot(true);
  localStorage.removeItem(SESSION_KEY);
  session = null;
  show(loginBtn);
  hide(logoutBtn);
  hide(dashboardSection);
  show(landingSection);
  setBadge("Disconnected", "badge-offline");
  alert(message);
}

// ---------- 3. Deriv REST API ----------
async function api(path, method = "GET") {
  const r = await fetch(API_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.errors && j.errors[0] && j.errors[0].message) || `Request failed (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return j;
}

function normalizeAccounts(json) {
  let list = json && (json.data !== undefined ? json.data : json.accounts !== undefined ? json.accounts : json);
  if (list && !Array.isArray(list)) list = list.accounts || list.items || Object.values(list);
  if (!Array.isArray(list)) return [];
  return list
    .map((a) => ({
      id: a.account_id || a.loginid || a.id,
      type: String(a.account_type || a.type || (a.is_virtual ? "demo" : "real")).toLowerCase(),
      currency: a.currency || "USD",
      balance: a.balance,
    }))
    .filter((a) => a.id);
}

const isDemo = (acc) => acc.type.includes("demo") || /^VR/i.test(acc.id);

// ---------- 4. Dashboard setup ----------
function setAccountInfo() {
  if (!activeAccount) return;
  setText(accountIdEl, activeAccount.id);
  const demo = isDemo(activeAccount);
  setText(accountTypeEl, demo ? "DEMO" : "REAL");
  if (accountTypeEl) accountTypeEl.className = demo ? "badge badge-demo" : "badge badge-real";
  if (activeAccount.balance !== undefined && activeAccount.balance !== null) {
    setText(accountBalanceEl, `${Number(activeAccount.balance).toFixed(2)} ${activeAccount.currency}`);
  }
}

function showDashboard() {
  hide(loginBtn);
  show(logoutBtn);
  hide(landingSection);
  show(dashboardSection);
}

function populateAccountSwitcher() {
  if (!accountSwitcher || accounts.length <= 1) return;
  accountSwitcher.innerHTML = "";
  accounts.forEach((acc) => {
    const opt = document.createElement("option");
    opt.value = acc.id;
    opt.textContent = `${acc.id} (${isDemo(acc) ? "Demo" : "Real"} - ${acc.currency})`;
    if (activeAccount && acc.id === activeAccount.id) opt.selected = true;
    accountSwitcher.appendChild(opt);
  });
  show(accountSwitcher);
}

if (accountSwitcher) {
  accountSwitcher.addEventListener("change", (e) => {
    const selected = accounts.find((a) => a.id === e.target.value);
    if (!selected) return;
    stopBot(true);
    activeAccount = selected;
    localStorage.setItem(ACTIVE_KEY, selected.id);
    sessionProfit = 0;
    updatePnlDisplay();
    setAccountInfo();
    connectWebSocket();
  });
}

async function bootstrap() {
  setBadge("Connecting...", "badge-offline");
  try {
    const json = await api("/trading/v1/options/accounts");
    accounts = normalizeAccounts(json);
    if (accounts.length === 0) {
      console.log("Unexpected accounts response:", json);
      throw new Error("No trading accounts found on this Deriv profile.");
    }
    const savedId = localStorage.getItem(ACTIVE_KEY);
    activeAccount =
      accounts.find((a) => a.id === savedId) ||
      accounts.find((a) => isDemo(a)) ||   // default to a demo account for safety
      accounts[0];

    showDashboard();
    setAccountInfo();
    populateAccountSwitcher();
    await connectWebSocket();
  } catch (e) {
    if (e.status === 401) return sessionExpired();
    setBadge("Disconnected", "badge-offline");
    alert(`Could not load your Deriv accounts: ${e.message}`);
  }
}

// ---------- 5. WebSocket ----------
function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function scheduleReconnect() {
  if (manualClose || !session) return;
  reconnectAttempts++;
  const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts);
  addLog(`[System] Reconnecting in ${Math.round(delay / 1000)}s...`);
  reconnectTimer = setTimeout(connectWebSocket, delay);
}

async function connectWebSocket() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  manualClose = false;

  if (ws) {
    try { ws.onclose = null; ws.close(); } catch { /* ignore */ }
    ws = null;
  }

  setBadge("Connecting...", "badge-offline");

  // The OTP URL is valid for 120 seconds and works once, so request a fresh one every time
  let url;
  try {
    const json = await api(
      `/trading/v1/options/accounts/${encodeURIComponent(activeAccount.id)}/otp`,
      "POST"
    );
    url = json.data && json.data.url;
    if (!url) throw new Error("No WebSocket URL was returned.");
  } catch (e) {
    if (e.status === 401) return sessionExpired();
    addLog(`[Error] ${e.message}`, "highlight-red");
    setBadge("Disconnected", "badge-offline");
    scheduleReconnect();
    return;
  }

  ws = new WebSocket(url);

  ws.onopen = () => {
    reconnectAttempts = 0;
    setBadge("Connected", "badge-online");
    addLog(`[System] Connected to ${activeAccount.id} (${isDemo(activeAccount) ? "DEMO" : "REAL"}).`);

    send({ balance: 1, subscribe: 1 });
    send({ ticks: SYMBOL, subscribe: 1 });
    send({ proposal_open_contract: 1, subscribe: 1 });

    pingTimer = setInterval(() => send({ ping: 1 }), 30000);
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(data);
  };

  ws.onerror = () => {
    addLog("[Error] WebSocket error. Check your connection.", "highlight-red");
  };

  ws.onclose = () => {
    clearInterval(pingTimer);
    setBadge("Disconnected", "badge-offline");
    if (botRunning) stopBot();
    scheduleReconnect();
  };
}

function handleMessage(data) {
  if (data.error) {
    addLog(`[Error] ${data.error.message}`, "highlight-red");
    if (data.msg_type === "buy") waitingForContract = false;
    if (botRunning) stopBot();
    return;
  }

  switch (data.msg_type) {
    case "balance":
      setText(accountBalanceEl, `${Number(data.balance.balance).toFixed(2)} ${data.balance.currency}`);
      break;

    case "tick": {
      const quote = Number(data.tick.quote).toFixed(data.tick.pip_size || 2);
      setText(liveTickEl, quote);
      setText(lastDigitEl, quote.slice(-1));
      break;
    }

    case "buy":
      activeContractId = data.buy.contract_id;
      addLog(`[Trade] Contract #${data.buy.contract_id} opened | Stake: $${currentStake.toFixed(2)}`);
      break;

    case "proposal_open_contract":
      handleContractUpdate(data.proposal_open_contract);
      break;
  }
}

function handleContractUpdate(contract) {
  if (!contract || !waitingForContract) return;
  if (activeContractId && contract.contract_id !== activeContractId) return;
  if (!contract.is_sold) return;

  waitingForContract = false;
  activeContractId = null;

  const profit = Number(contract.profit);
  sessionProfit += profit;
  updatePnlDisplay();

  const baseStake = readNumber("bot-stake", 1.0);
  const martingale = readNumber("bot-martingale", 2.1);
  const takeProfit = readNumber("bot-tp", 10.0);
  const stopLoss = readNumber("bot-sl", 15.0);

  if (profit > 0) {
    addLog(`[WIN] +$${profit.toFixed(2)} | Resetting stake to $${baseStake.toFixed(2)}`, "highlight-green");
    currentStake = baseStake;
  } else {
    addLog(`[LOSS] -$${Math.abs(profit).toFixed(2)} | Applying Martingale...`, "highlight-red");
    currentStake = Number((currentStake * martingale).toFixed(2));
  }

  if (sessionProfit >= takeProfit) {
    addLog(`[Target Reached] Take Profit of $${takeProfit.toFixed(2)} hit! Stopping bot.`, "highlight-green");
    stopBot();
    return;
  }
  if (sessionProfit <= -Math.abs(stopLoss)) {
    addLog(`[Risk Limit] Stop Loss of $${stopLoss.toFixed(2)} hit! Stopping bot.`, "highlight-red");
    stopBot();
    return;
  }

  if (botRunning) setTimeout(placeDigitOverTrade, 1200);
}

// ---------- 6. Bot ----------
function placeDigitOverTrade() {
  if (!botRunning || !ws || ws.readyState !== WebSocket.OPEN || !activeAccount) return;

  waitingForContract = true;
  activeContractId = null;

  send({
    buy: "1",
    price: currentStake,
    parameters: {
      amount: currentStake,
      basis: "stake",
      contract_type: "DIGITOVER",
      currency: activeAccount.currency || "USD",
      duration: 1,
      duration_unit: "t",
      underlying_symbol: SYMBOL,
      barrier: "2",
    },
  });
}

function startBot() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert("WebSocket is not connected.");
    return;
  }
  currentStake = readNumber("bot-stake", 1.0);
  botRunning = true;
  hide(startBotBtn);
  show(stopBotBtn);
  setText(botStatusPill, "RUNNING");
  if (botStatusPill) botStatusPill.className = "badge badge-running";
  addLog(`[Bot] Auto-execution started on ${SYMBOL} (Digit Over 2).`);
  placeDigitOverTrade();
}

function stopBot(silent = false) {
  const wasRunning = botRunning;
  botRunning = false;
  waitingForContract = false;
  activeContractId = null;
  hide(stopBotBtn);
  show(startBotBtn);
  setText(botStatusPill, "IDLE");
  if (botStatusPill) botStatusPill.className = "badge badge-idle";
  if (wasRunning && !silent) addLog("[Bot] Execution stopped.");
}

// ---------- 7. Buttons ----------
if (loginBtn) loginBtn.addEventListener("click", () => startOAuth(false));
if (heroLoginBtn) heroLoginBtn.addEventListener("click", () => startOAuth(false));

// Register links: open Deriv's sign-up form, then return to this site already logged in
document.querySelectorAll('a[href*="deriv.com/signup"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    startOAuth(true);
  });
});

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    manualClose = true;
    stopBot(true);
    if (ws) { try { ws.onclose = null; ws.close(); } catch { /* ignore */ } }
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ACTIVE_KEY);
    window.location.reload();
  });
}

if (startBotBtn) startBotBtn.addEventListener("click", startBot);
if (stopBotBtn) stopBotBtn.addEventListener("click", () => stopBot());
if (clearLogsBtn) {
  clearLogsBtn.addEventListener("click", () => {
    if (botLogsEl) botLogsEl.innerHTML = "<div>[System] Terminal cleared.</div>";
  });
}

// ---------- Init ----------
(async function init() {
  await handleOAuthCallback();
  session = loadSession();
  if (session) bootstrap();
})();