const APP_ID = "350cqOOeGCMWqrKgybWnf"; // <-- REPLACE WITH YOUR NUMERIC DERIV APP ID
const WS_URL = `wss://://derivws.com{APP_ID}`;

// DOM Elements
const loginBtn = document.getElementById("login-btn");
const heroLoginBtn = document.getElementById("hero-login-btn");
const logoutBtn = document.getElementById("logout-btn");
const connectionBadge = document.getElementById("connection-badge");
const landingSection = document.getElementById("landing-section");
const dashboardSection = document.getElementById("dashboard-section");

const accountIdEl = document.getElementById("account-id");
const accountTypeEl = document.getElementById("account-type");
const accountSwitcher = document.getElementById("account-switcher");
const accountBalanceEl = document.getElementById("account-balance");
const liveTickEl = document.getElementById("live-tick");
const lastDigitEl = document.getElementById("last-digit");

const startBotBtn = document.getElementById("start-bot-btn");
const stopBotBtn = document.getElementById("stop-bot-btn");
const clearLogsBtn = document.getElementById("clear-logs-btn");
const botStatusPill = document.getElementById("bot-status-pill");
const botLogsEl = document.getElementById("bot-logs");
const sessionPnlEl = document.getElementById("session-pnl");

// State Variables
let ws = null;
let accounts = [];
let activeAccount = null;
let botRunning = false;
let currentStake = 1.0;
let sessionProfit = 0.0;
let waitingForContract = false;

// 1. Capture All OAuth Accounts Returned by Deriv
function parseOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const parsedAccounts = [];
  let i = 1;

  while (params.has(`acct${i}`) && params.has(`token${i}`)) {
    parsedAccounts.push({
      acct: params.get(`acct${i}`),
      token: params.get(`token${i}`),
      cur: params.get(`cur${i}`) || "USD"
    });
    i++;
  }

  if (parsedAccounts.length > 0) {
    localStorage.setItem("allano_accounts", JSON.stringify(parsedAccounts));
    localStorage.setItem("allano_active_acct", parsedAccounts[0].acct);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// 2. OAuth Login & Logout Handlers
function redirectToDerivLogin() {
  if (APP_ID === "350cqOOeGCMWqrKgybWnf") {
    alert("Please replace YOUR_APP_ID in app.js with your Deriv App ID first.");
    return;
  }
  window.location.href = `https://deriv.com{APP_ID}`;
}

loginBtn.addEventListener("click", redirectToDerivLogin);
heroLoginBtn.addEventListener("click", redirectToDerivLogin);

logoutBtn.addEventListener("click", () => {
  localStorage.removeItem("allano_accounts");
  localStorage.removeItem("allano_active_acct");
  window.location.reload();
});

// 3. Account Switcher Setup
function populateAccountSwitcher() {
  if (accounts.length <= 1) return;
  accountSwitcher.innerHTML = "";
  accounts.forEach((acc) => {
    const opt = document.createElement("option");
    opt.value = acc.acct;
    const label = acc.acct.startsWith("VRTC") ? "Demo" : "Real";
    opt.textContent = `${acc.acct} (${label} - ${acc.cur})`;
    if (acc.acct === activeAccount.acct) opt.selected = true;
    accountSwitcher.appendChild(opt);
  });
  accountSwitcher.classList.remove("hidden");
}

accountSwitcher.addEventListener("change", (e) => {
  const selected = accounts.find((a) => a.acct === e.target.value);
  if (selected) {
    stopBot();
    activeAccount = selected;
    localStorage.setItem("allano_active_acct", selected.acct);
    ws.send(JSON.stringify({ authorize: activeAccount.token }));
  }
});

// 4. WebSocket Connection & Message Router
function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    connectionBadge.textContent = "Connected";
    connectionBadge.className = "badge badge-online";
    ws.send(JSON.stringify({ authorize: activeAccount.token }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.error) {
      addLog(`[Error] ${data.error.message}`, "highlight-red");
      if (botRunning) stopBot();
      return;
    }

    // Handle Authorization
    if (data.msg_type === "authorize") {
      const { loginid, balance, currency, is_virtual } = data.authorize;
      accountIdEl.textContent = loginid;
      accountBalanceEl.textContent = `${Number(balance).toFixed(2)} ${currency}`;

      accountTypeEl.textContent = is_virtual ? "DEMO" : "REAL";
      accountTypeEl.className = is_virtual ? "badge badge-demo" : "badge badge-real";

      loginBtn.classList.add("hidden");
      logoutBtn.classList.remove("hidden");
      landingSection.classList.add("hidden");
      dashboardSection.classList.remove("hidden");

      // Subscribe to Balance, Live Ticks, and Open Contracts
      ws.send(JSON.stringify({ forget_all: ["ticks", "balance", "proposal_open_contract"] }));
      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      ws.send(JSON.stringify({ ticks: "R_100", subscribe: 1 }));
      ws.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1 }));
    }

    // Handle Live Balance Updates
    if (data.msg_type === "balance") {
      accountBalanceEl.textContent = `${Number(data.balance.balance).toFixed(2)} ${data.balance.currency}`;
    }

    // Handle Live Volatility 100 Ticks
    if (data.msg_type === "tick") {
      const quote = Number(data.tick.quote).toFixed(2);
      liveTickEl.textContent = quote;
      lastDigitEl.textContent = quote.slice(-1);
    }

    // Handle Buy Confirmation
    if (data.msg_type === "buy") {
      addLog(`[Trade] Contract #${data.buy.contract_id} opened | Stake: $${currentStake.toFixed(2)}`);
    }

    // Handle Contract Settlement (Win / Loss)
    if (data.msg_type === "proposal_open_contract") {
      const contract = data.proposal_open_contract;
      if (contract.is_sold && waitingForContract) {
        waitingForContract = false;
        const profit = Number(contract.profit);
        sessionProfit += profit;
        updatePnlDisplay();

        const baseStake = parseFloat(document.getElementById("bot-stake").value) || 1.0;
        const martingale = parseFloat(document.getElementById("bot-martingale").value) || 2.1;
        const takeProfit = parseFloat(document.getElementById("bot-tp").value) || 10.0;
        const stopLoss = parseFloat(document.getElementById("bot-sl").value) || 15.0;

        if (profit > 0) {
          addLog(`[WIN] +$${profit.toFixed(2)} | Resetting stake to $${baseStake.toFixed(2)}`, "highlight-green");
          currentStake = baseStake;
        } else {
          addLog(`[LOSS] -$${Math.abs(profit).toFixed(2)} | Applying Martingale...`, "highlight-red");
          currentStake = Number((currentStake * martingale).toFixed(2));
        }

        // Check Take Profit & Stop Loss Limits
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

        if (botRunning) {
          setTimeout(placeDigitOverTrade, 1200);
        }
      }
    }
  };

  ws.onclose = () => {
    connectionBadge.textContent = "Disconnected";
    connectionBadge.className = "badge badge-offline";
    if (botRunning) stopBot();
  };
}

// 5. Auto-Bot Trading Functions
function placeDigitOverTrade() {
  if (!botRunning || !ws || ws.readyState !== WebSocket.OPEN) return;

  waitingForContract = true;
  const payload = {
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
      barrier: "2"
    }
  };

  ws.send(JSON.stringify(payload));
}

function startBot() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert("WebSocket is not connected.");
    return;
  }
  currentStake = parseFloat(document.getElementById("bot-stake").value) || 1.0;
  botRunning = true;
  startBotBtn.classList.add("hidden");
  stopBotBtn.classList.remove("hidden");
  botStatusPill.textContent = "RUNNING";
  botStatusPill.className = "badge badge-running";
  addLog("[Bot] Auto-execution started on Volatility 100 (Digit Over 2).");
  placeDigitOverTrade();
}

function stopBot() {
  botRunning = false;
  waitingForContract = false;
  stopBotBtn.classList.add("hidden");
  startBotBtn.classList.remove("hidden");
  botStatusPill.textContent = "IDLE";
  botStatusPill.className = "badge badge-idle";
  addLog("[Bot] Execution stopped.");
}

function updatePnlDisplay() {
  const formatted = sessionProfit >= 0
    ? `+$${sessionProfit.toFixed(2)}`
    : `-$${Math.abs(sessionProfit).toFixed(2)}`;
  sessionPnlEl.textContent = formatted;
  sessionPnlEl.className = sessionProfit >= 0 ? "highlight-green" : "highlight-red";
}

function addLog(message, colorClass = "") {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  if (colorClass) line.className = colorClass;
  line.textContent = `[${time}] ${message}`;
  botLogsEl.appendChild(line);
  botLogsEl.scrollTop = botLogsEl.scrollHeight;
}

startBotBtn.addEventListener("click", startBot);
stopBotBtn.addEventListener("click", stopBot);
clearLogsBtn.addEventListener("click", () => {
  botLogsEl.innerHTML = "<div>[System] Terminal cleared.</div>";
});

// Initialize App on Load
parseOAuthCallback();
const savedAccounts = JSON.parse(localStorage.getItem("allano_accounts") || "[]");
const savedActiveId = localStorage.getItem("allano_active_acct");

if (savedAccounts.length > 0) {
  accounts = savedAccounts;
  activeAccount = accounts.find((a) => a.acct === savedActiveId) || accounts[0];
  populateAccountSwitcher();
  connectWebSocket();
}
