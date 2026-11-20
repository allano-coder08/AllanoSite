// =====================================================
// Sona Play / Allan Music - Deriv bot (app.js)
// =====================================================

// >>> PASTE YOUR DERIV APP ID HERE (inside the quotes) <<<
const APP_ID = "350cqOOeGCMWqrKgybWnf";

// >>> OPTIONAL (testing only): a Deriv API token with Read + Trade scopes.
// >>> Leave empty to use the normal Deriv login button (recommended).
const MANUAL_API_TOKEN = "";

const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const OAUTH_URL = `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}`;

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
let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let manualClose = false;

let accounts = [];
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

// ---------- 1. OAuth callback ----------
function parseOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const parsed = [];
  let i = 1;
  while (params.has(`acct${i}`) && params.has(`token${i}`)) {
    parsed.push({
      acct: params.get(`acct${i}`),
      token: params.get(`token${i}`),
      cur: params.get(`cur${i}`) || "USD",
    });
    i++;
  }
  if (parsed.length > 0) {
    localStorage.setItem("allano_accounts", JSON.stringify(parsed));
    localStorage.setItem("allano_active_acct", parsed[0].acct);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// ---------- 2. Login / logout ----------
function redirectToDerivLogin() {
  if (!APP_ID || APP_ID === "350cqOOeGCMWqrKgybWnf") {
    alert("Please set your Deriv App ID in app.js first.");
    return;
  }
  const redirectUri = encodeURIComponent(window.location.origin);
  window.location.href = `${OAUTH_URL}&redirect_uri=${redirectUri}`;
}

if (loginBtn) loginBtn.addEventListener("click", redirectToDerivLogin);
if (heroLoginBtn) heroLoginBtn.addEventListener("click", redirectToDerivLogin);

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    manualClose = true;
    stopBot(true);
    localStorage.removeItem("allano_accounts");
    localStorage.removeItem("allano_active_acct");
    if (ws) ws.close();
    window.location.reload();
  });
}

// ---------- 3. Account switcher ----------
function populateAccountSwitcher() {
  if (!accountSwitcher || accounts.length <= 1) return;
  accountSwitcher.innerHTML = "";
  accounts.forEach((acc) => {
    const opt = document.createElement("option");
    opt.value = acc.acct;
    const label = acc.acct.startsWith("VRT") ? "Demo" : "Real";
    opt.textContent = `${acc.acct} (${label} - ${acc.cur})`;
    if (activeAccount && acc.acct === activeAccount.acct) opt.selected = true;
    accountSwitcher.appendChild(opt);
  });
  show(accountSwitcher);
}

if (accountSwitcher) {
  accountSwitcher.addEventListener("change", (e) => {
    const selected = accounts.find((a) => a.acct === e.target.value);
    if (!selected) return;
    stopBot(true);
    activeAccount = selected;
    localStorage.setItem("allano_active_acct", selected.acct);
    sessionProfit = 0;
    updatePnlDisplay();
    if (ws && ws.readyState === WebSocket.OPEN) {
      send({ authorize: activeAccount.token });
    }
  });
}

// ---------- 4. WebSocket ----------
function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function connectWebSocket() {
  clearTimeout(reconnectTimer);
  manualClose = false;
  setBadge("Connecting...", "badge-offline");

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectAttempts = 0;
    setBadge("Connected", "badge-online");
    send({ authorize: activeAccount.token });

    // Keep the connection alive
    clearInterval(pingTimer);
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
    addLog("[Error] WebSocket error. Check your connection and App ID.", "highlight-red");
  };

  ws.onclose = () => {
    clearInterval(pingTimer);
    setBadge("Disconnected", "badge-offline");
    if (botRunning) stopBot();
    if (!manualClose && activeAccount) {
      reconnectAttempts++;
      const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts);
      addLog(`[System] Reconnecting in ${Math.round(delay / 1000)}s...`);
      reconnectTimer = setTimeout(connectWebSocket, delay);
    }
  };
}

function handleMessage(data) {
  if (data.error) {
    addLog(`[Error] ${data.error.message}`, "highlight-red");

    // Invalid/expired token: clear it so the user can log in again
    if (data.error.code === "InvalidToken" || data.error.code === "AuthorizationRequired") {
      localStorage.removeItem("allano_accounts");
      localStorage.removeItem("allano_active_acct");
      addLog("[System] Session expired. Please log in with Deriv again.", "highlight-red");
      manualClose = true;
      show(loginBtn);
      hide(logoutBtn);
      hide(dashboardSection);
      show(landingSection);
    }

    if (data.msg_type === "buy") waitingForContract = false;
    if (botRunning) stopBot();
    return;
  }

  switch (data.msg_type) {
    case "authorize": {
      const { loginid, balance, currency, is_virtual } = data.authorize;
      setText(accountIdEl, loginid);
      setText(accountBalanceEl, `${Number(balance).toFixed(2)} ${currency}`);
      setText(accountTypeEl, is_virtual ? "DEMO" : "REAL");
      if (accountTypeEl) accountTypeEl.className = is_virtual ? "badge badge-demo" : "badge badge-real";

      hide(loginBtn);
      show(logoutBtn);
      hide(landingSection);
      show(dashboardSection);

      send({ forget_all: ["ticks", "balance", "proposal_open_contract"] });
      send({ balance: 1, subscribe: 1 });
      send({ ticks: "R_100", subscribe: 1 });
      send({ proposal_open_contract: 1, subscribe: 1 });
      addLog(`[System] Authorized as ${loginid}.`);
      break;
    }

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

// ---------- 5. Bot ----------
function placeDigitOverTrade() {
  if (!botRunning || !ws || ws.readyState !== WebSocket.OPEN || !activeAccount) return;

  waitingForContract = true;
  activeContractId = null;

  send({
    buy: 1,
    price: currentStake,
    parameters: {
      amount: currentStake,
      basis: "stake",
      contract_type: "DIGITOVER",
      currency: activeAccount.cur || "USD",
      duration: 1,
      duration_unit: "t",
      symbol: "R_100",
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
  addLog("[Bot] Auto-execution started on Volatility 100 (Digit Over 2).");
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

if (startBotBtn) startBotBtn.addEventListener("click", startBot);
if (stopBotBtn) stopBotBtn.addEventListener("click", () => stopBot());
if (clearLogsBtn) {
  clearLogsBtn.addEventListener("click", () => {
    if (botLogsEl) botLogsEl.innerHTML = "<div>[System] Terminal cleared.</div>";
  });
}

// ---------- Init ----------
function init() {
  parseOAuthCallback();

  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem("allano_accounts") || "[]");
  } catch {
    saved = [];
  }

  // Optional manual token fallback (testing only)
  if (saved.length === 0 && MANUAL_API_TOKEN) {
    saved = [{ acct: "MANUAL", token: MANUAL_API_TOKEN, cur: "USD" }];
  }

  if (saved.length > 0) {
    accounts = saved;
    const savedActiveId = localStorage.getItem("allano_active_acct");
    activeAccount = accounts.find((a) => a.acct === savedActiveId) || accounts[0];
    populateAccountSwitcher();
    connectWebSocket();
  }
}

init();