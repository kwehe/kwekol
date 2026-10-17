require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const APP_DIR = process.env.APP_DIR || path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const HTML_FILE = path.join(APP_DIR, "kwekol.html");
app.get(["/", "/kwekol.html"], (req, res) => res.sendFile(HTML_FILE));
app.get("/kwekol.png", (req, res) => res.sendFile(path.join(APP_DIR, "kwekol.png")));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const CALLS_FILE = path.join(DATA_DIR, "calls.json");

// Внешнее хранилище (Upstash Redis REST) — чтобы данные не терялись на хостингах
// с временной файловой системой (например, Render free). Необязательно.
const REMOTE_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const REMOTE_ENABLED = !!(REMOTE_URL && REMOTE_TOKEN);

// Отправка почты через HTTP-API Brevo (работает там, где SMTP-порты закрыты).
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
// Отправка почты через HTTP-API Resend (альтернатива Brevo).
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

let transporter = null;
let fallbackTransporter = null;
const codes = new Map(); // email -> { code, expires, login, salt, passwordHash }

const lastSeen = new Map(); // login -> timestamp (ms)

function touch(login) {
  if (!login) return;
  lastSeen.set(String(login).toLowerCase(), Date.now());
}

function isOnline(login) {
  const t = lastSeen.get(String(login).toLowerCase());
  return !!t && Date.now() - t < 60000;
}

function lastSeenAt(login) {
  const t = lastSeen.get(String(login).toLowerCase());
  return t || null;
}

function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveAccounts(accounts) {
  const json = JSON.stringify(accounts, null, 2);
  fs.writeFileSync(ACCOUNTS_FILE, json);
  schedulePush("accounts", json);
}

function loadMessages() {
  try {
    return JSON.parse(fs.readFileSync(MESSAGES_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveMessages(store) {
  const json = JSON.stringify(store, null, 2);
  fs.writeFileSync(MESSAGES_FILE, json);
  schedulePush("messages", json);
}

function loadCalls() {
  try {
    return JSON.parse(fs.readFileSync(CALLS_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveCalls(store) {
  const json = JSON.stringify(store, null, 2);
  fs.writeFileSync(CALLS_FILE, json);
  schedulePush("calls", json);
}

async function redisGet(key) {
  if (!REMOTE_ENABLED) return null;
  const r = await fetch(REMOTE_URL + "/get/" + encodeURIComponent(key), {
    headers: { Authorization: "Bearer " + REMOTE_TOKEN },
  });
  const j = await r.json();
  return j && j.result != null ? j.result : null;
}

async function redisSet(key, value) {
  if (!REMOTE_ENABLED) return;
  await fetch(REMOTE_URL + "/set/" + encodeURIComponent(key), {
    method: "POST",
    headers: { Authorization: "Bearer " + REMOTE_TOKEN, "Content-Type": "text/plain" },
    body: value,
  });
}

const pushTimers = {};
function schedulePush(key, json) {
  if (!REMOTE_ENABLED) return;
  clearTimeout(pushTimers[key]);
  pushTimers[key] = setTimeout(() => {
    redisSet(key, json).catch((e) => console.error("Ошибка записи в Upstash:", e.message));
  }, 400);
}

async function hydrateFromRemote() {
  if (!REMOTE_ENABLED) return;
  try {
    const acc = await redisGet("accounts");
    if (acc) fs.writeFileSync(ACCOUNTS_FILE, acc);
    const msg = await redisGet("messages");
    if (msg) fs.writeFileSync(MESSAGES_FILE, msg);
    const cls = await redisGet("calls");
    if (cls) fs.writeFileSync(CALLS_FILE, cls);
    console.log("Данные загружены из удалённого хранилища (Upstash).");
  } catch (e) {
    console.error("Не удалось загрузить данные из Upstash:", e.message);
  }
}

function pairKey(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x < y ? x + "::" + y : y + "::" + x;
}

function clearCutoff(acc, key) {
  const c = acc && acc.cleared;
  if (!c || !c[key]) return 0;
  return Date.parse(c[key]) || 0;
}

function afterCutoff(messages, cutoff) {
  if (!cutoff) return messages;
  return messages.filter((m) => (Date.parse(m.at) || 0) > cutoff);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function safeEqual(a, b) {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

const BOT_LOGIN = "kwekol";
const BOT_USERNAME = "kwekol";
const BOT_NAME = "kwekol";
const BOT_PASSWORD = "botnotificationkwekolbot";
const BOT_EMAIL = "bot@kwekol.local";
const BOT_ALIASES = ["kwekol", "notification", "bot"];
const BOT_WELCOME = "Здраствуйте! Спасибо что пользуетесь kwekol!";

// Обеспечивает наличие аккаунта-бота kwekol.
function ensureBotAccount() {
  const accounts = loadAccounts();
  const acc = accounts[BOT_LOGIN];
  const salt = crypto.randomBytes(16).toString("hex");
  if (!acc) {
    accounts[BOT_LOGIN] = {
      login: BOT_LOGIN,
      email: BOT_EMAIL,
      username: BOT_USERNAME,
      name: BOT_NAME,
      bot: true,
      salt: salt,
      passwordHash: hashPassword(BOT_PASSWORD, salt),
      createdAt: new Date().toISOString(),
    };
    saveAccounts(accounts);
    console.log("🤖 Бот создан: " + BOT_LOGIN);
    return;
  }
  let changed = false;
  if (!acc.bot) { acc.bot = true; changed = true; }
  if (acc.username !== BOT_USERNAME) { acc.username = BOT_USERNAME; changed = true; }
  if (!acc.name) { acc.name = BOT_NAME; changed = true; }
  if (!acc.passwordHash || acc.botReset) { acc.salt = salt; acc.passwordHash = hashPassword(BOT_PASSWORD, salt); delete acc.botReset; changed = true; }
  if (changed) saveAccounts(accounts);
}

// Создаёт переписку с ботом и приветственное сообщение.
function ensureBotChat(userLogin, force) {
  const userLc = String(userLogin || "").trim().toLowerCase();
  if (!userLc || userLc === BOT_LOGIN) return false;
  const accounts = loadAccounts();
  if (!accounts[userLc]) return false;
  if (!force && Array.isArray(accounts[userLc].deleted) && accounts[userLc].deleted.indexOf(BOT_LOGIN) >= 0) return false;
  const store = loadMessages();
  const key = pairKey(BOT_LOGIN, userLc);
  if (!store[key]) store[key] = { participants: [BOT_LOGIN, userLc], messages: [] };
  const has = (store[key].messages || []).some((m) => m.from === BOT_LOGIN && m.botWelcome);
  if (!has) {
    store[key].messages.push({
      id: "botwelcome_" + userLc,
      from: BOT_LOGIN,
      text: BOT_WELCOME,
      at: new Date().toISOString(),
      botWelcome: true,
    });
    saveMessages(store);
    return true;
  }
  return false;
}

// Добавляет чат с ботом всем существующим аккаунтам.
function ensureBotChatsForAll() {
  const accounts = loadAccounts();
  let n = 0;
  Object.keys(accounts).forEach((l) => {
    if (l === BOT_LOGIN) return;
    if (ensureBotChat(l, false)) n++;
  });
  if (n) console.log("🤖 Приветственные чаты бота созданы для " + n + " аккаунт(ов)");
}

async function setupMailer() {
  fallbackTransporter = null;
  if (BREVO_API_KEY) {
    transporter = null;
    console.log("Отправка почты через Brevo HTTP API (BREVO_API_KEY).");
    return;
  }
  if (RESEND_API_KEY) {
    transporter = null;
    console.log("Отправка почты через Resend HTTP API (RESEND_API_KEY).");
    return;
  }
  const user = process.env.SMTP_USER || "";
  const isPlaceholder =
    !user ||
    user === "you@gmail.com" ||
    user === "you@yandex.ru" ||
    user.startsWith("you@") ||
    user.includes("example") ||
    user.includes("your_");

  if (!isPlaceholder) {
    const smtpOptions = {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || "true") === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    };
    if (process.env.SMTP_PROXY) {
      smtpOptions.proxy = process.env.SMTP_PROXY;
      const directOptions = Object.assign({}, smtpOptions);
      delete directOptions.proxy;
      fallbackTransporter = nodemailer.createTransport(directOptions);
    }
    transporter = nodemailer.createTransport(smtpOptions);
    console.log("Используется ваш SMTP из .env (" + process.env.SMTP_HOST + ")" + (process.env.SMTP_PROXY ? " через прокси " + process.env.SMTP_PROXY : ""));
  } else {
    transporter = nodemailer.createTransport({ jsonTransport: true });
    console.log("==================================================");
    console.log("Режим симуляции почты активирован (без интернета и СМС).");
    console.log("Код подтверждения будет выводиться в консоль сервера.");
    console.log("==================================================");
  }
}

function parseFrom(s) {
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(s || "");
  if (m) return { name: m[1] || "kwekol", email: m[2] };
  return { name: "kwekol", email: (s || "").trim() };
}

async function sendEmail({ from, to, subject, text, html }) {
  if (BREVO_API_KEY) {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: parseFrom(from), to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    });
    if (!r.ok) throw new Error("brevo_" + r.status + "_" + (await r.text()).slice(0, 200));
    return { via: "brevo", message: JSON.stringify({ subject }) };
  }
  if (RESEND_API_KEY) {
    const pf = parseFrom(from);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: (pf.name ? pf.name + " <" + pf.email + ">" : pf.email), to: to, subject, text, html }),
    });
    if (!r.ok) throw new Error("resend_" + r.status + "_" + (await r.text()).slice(0, 200));
    return { via: "resend", message: JSON.stringify({ subject }) };
  }
  if (transporter) {
    try {
      return await transporter.sendMail({ from, to, subject, text, html });
    } catch (e) {
      if (fallbackTransporter) {
        console.warn("SMTP через прокси не сработал (" + e.message + "), отправляю напрямую...");
        return await fallbackTransporter.sendMail({ from, to, subject, text, html });
      }
      throw e;
    }
  }
  throw new Error("no_mail_transport");
}

app.post("/api/send-code", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const loginRaw = (req.body.login || "").trim();
  const login = loginRaw.toLowerCase();
  const password = (req.body.password || "").toLowerCase();

  if (!email) return res.status(400).json({ ok: false, error: "email_required" });
  if (!login) return res.status(400).json({ ok: false, error: "login_required" });
  if (password.length < 3) return res.status(400).json({ ok: false, error: "password_short" });
  if (!/^[\x20-\x7E]+$/.test(password)) return res.status(400).json({ ok: false, error: "password_latin" });

  const accounts = loadAccounts();
  for (const key in accounts) {
    if (key.toLowerCase() === login || (accounts[key].login || "").toLowerCase() === login) {
      return res.status(409).json({ ok: false, error: "login_taken" });
    }
    if (accounts[key].email === email) {
      return res.status(409).json({ ok: false, error: "email_taken" });
    }
  }

  if (!transporter && !BREVO_API_KEY) {
    return res.status(500).json({ ok: false, error: "mailer_not_ready" });
  }

  const code = generateCode();
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  codes.set(email, {
    code,
    expires: Date.now() + 48 * 60 * 60 * 1000,
    login: loginRaw,
    salt,
    passwordHash,
  });

  try {
    const info = await sendEmail({
      from: process.env.MAIL_FROM || "kwekol <bot@kwekol.local>",
      to: email,
      subject: "Код подтверждения",
      text:
        "Код подтверждения\n" +
        "Для подтверждения аккаунта введите в приложении Kwekol этот код:\n\n" +
        code + "\n\n" +
        "Срок действия кода подтверждения истекает через 48 часов.\n\n" +
        "Если вы не запрашивали этот код, игнорируйте это сообщение.",
      html:
        '<div style="font-family:Arial,sans-serif;color:#000;font-size:14px;line-height:1.6">' +
        '<h2 style="font-size:20px;margin:0 0 16px">Код подтверждения</h2>' +
        '<p style="margin:0 0 12px">Для подтверждения аккаунта в приложении <b>Kwekol</b> введите этот код:</p>' +
        '<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:0 0 16px">' + code + "</p>" +
        '<p style="margin:0 0 12px">Срок действия кода подтверждения истекает через 48 часов.</p>' +
        '<p style="margin:0;color:#666">Если вы не запрашивали этот код, игнорируйте это сообщение.</p>' +
        "</div>",
    });

    console.log("--------------------------------------------------");
    console.log("✉️  ПИСЬМО ДЛЯ: " + email);
    console.log("👤 ЛОГИН: " + login);
    console.log("🔑 КОД ПОДТВЕРЖДЕНИЯ: " + code);
    if (info.message) {
      try {
        const msg = JSON.parse(info.message);
        console.log("📄 Тема:", msg.subject);
      } catch (e) {}
    }
    console.log("--------------------------------------------------");

    res.json({ ok: true });
  } catch (err) {
    console.warn("Почта не отправлена (" + err.message + "). Код остаётся доступным: " + code);
    res.json({ ok: true });
  }
});

// Эндпоинты безопасности и сессий
  app.post("/api/set-password", (req, res) => {
    const { login, password, hint } = req.body;
    if (!login) return res.json({ ok: false, error: "login_required" });
    const accs = loadAccounts();
    const l = String(login).toLowerCase();
    if (!accs[l]) return res.json({ ok: false, error: "no_user" });
    const salt = crypto.randomBytes(16).toString("hex");
    accs[l].salt = salt;
    accs[l].passwordHash = hashPassword(String(password || "").toLowerCase(), salt);
    accs[l].passwordHint = hint || "";
    saveAccounts(accs);
    res.json({ ok: true });
  });

  app.post("/api/check-password", (req, res) => {
    const { login, password } = req.body;
    const accs = loadAccounts();
    const l = String(login || "").toLowerCase();
    const acc = accs[l];
    if (!acc) return res.json({ ok: false, error: "no_user" });
    const hash = hashPassword(String(password || "").toLowerCase(), acc.salt);
    res.json({ ok: safeEqual(hash, acc.passwordHash) });
  });

  app.post("/api/remove-password", (req, res) => {
    const { login } = req.body;
    const accs = loadAccounts();
    const l = String(login || "").toLowerCase();
    const acc = accs[l];
    if (!acc) return res.json({ ok: false, error: "no_user" });
    delete acc.passwordHint;
    acc.passwordHash = hashPassword("", acc.salt);
    saveAccounts(accs);
    res.json({ ok: true });
  });

  app.post("/api/change-email", async (req, res) => {
    const { login, newEmail } = req.body;
    if (!login || !newEmail) return res.json({ ok: false, error: "bad_request" });
    const accs = loadAccounts();
    const l = String(login).toLowerCase();
    if (!accs[l]) return res.json({ ok: false, error: "no_user" });
    const code = generateCode();
    codes.set(newEmail.toLowerCase(), { code, expires: Date.now() + 15*60*1000, login: l, changeEmail: true });
    try {
      await sendEmail({
        from: process.env.MAIL_FROM || "kwekol <bot@kwekol.local>",
        to: newEmail,
        subject: "Код смены почты",
        text: "Ваш код смены почты в Kwekol: " + code,
        html: "<div style='font-family:Arial'><h2>Код смены почты</h2><p style='font-size:28px;font-weight:700'>" + code + "</p></div>"
      });

      res.json({ ok: true });
    } catch (e) {
      console.warn("Почта не отправлена (" + e.message + "). Код: " + code);
      res.json({ ok: true });
    }
  });

  app.post("/api/verify-change-email", (req, res) => {
    const { login, newEmail, code } = req.body;
    const entry = codes.get((newEmail || "").trim().toLowerCase());
    if (!entry || entry.expires < Date.now() || entry.code !== code || entry.login !== String(login).toLowerCase()) {
      return res.json({ ok: false, error: "wrong_code" });
    }
    const accs = loadAccounts();
    const l = String(login).toLowerCase();
    if (accs[l]) {
      accs[l].email = newEmail.trim().toLowerCase();
      saveAccounts(accs);
    }
    codes.delete(newEmail.trim().toLowerCase());
    res.json({ ok: true });
  });

  app.post("/api/forgot-password", async (req, res) => {
    const { login } = req.body;
    const accs = loadAccounts();
    const l = String(login || "").toLowerCase();
    const acc = accs[l];
    if (!acc || !acc.email) return res.json({ ok: false, error: "no_user" });
    const code = generateCode();
    codes.set(acc.email.toLowerCase(), { code, expires: Date.now() + 15*60*1000, login: l, reset: true });
    try {
      await sendEmail({
        from: process.env.MAIL_FROM || "kwekol <bot@kwekol.local>",
        to: acc.email,
        subject: "Восстановление пароля",
        text: "Ваш код восстановления пароля в Kwekol: " + code,
        html: "<div style='font-family:Arial'><h2>Восстановление пароля</h2><p style='font-size:28px;font-weight:700'>" + code + "</p></div>"
      });
      res.json({ ok: true });
    } catch (e) {
      console.warn("Почта не отправлена (" + e.message + "). Код: " + code);
      res.json({ ok: true });
    }
  });

  app.post("/api/verify-reset-code", (req, res) => {
    const { login, code } = req.body;
    const accs = loadAccounts();
    const l = String(login || "").toLowerCase();
    const acc = accs[l];
    if (!acc || !acc.email) return res.json({ ok: false, error: "no_user" });
    const entry = codes.get(acc.email.toLowerCase());
    if (!entry || entry.expires < Date.now() || entry.code !== code || entry.login !== l) {
      return res.json({ ok: false, error: "wrong_code" });
    }
    codes.delete(acc.email.toLowerCase());
    res.json({ ok: true });
  });

  app.get("/api/sessions", (req, res) => {
    const login = (req.query.login || "").toLowerCase();
    const accs = loadAccounts();
    const acc = accs[login];
    if (!acc) return res.json({ ok: false, error: "no_user" });
    if (!acc.sessions) {
      acc.sessions = [{ id: "web_curr", device: "Chrome, Windows", location: "Russia, Saratov", current: true, activeAt: Date.now() }];
      saveAccounts(accs);
    }
    res.json({ ok: true, sessions: acc.sessions });
  });

  app.post("/api/sessions/terminate", (req, res) => {
    const { login } = req.body;
    const accs2 = loadAccounts();
    const l = String(login || "").toLowerCase();
    const acc2 = accs2[l];
    if (!acc2) return res.json({ ok: false, error: "no_user" });
    if (acc2.sessions) {
      acc2.sessions = acc2.sessions.filter((s) => s.current);
      saveAccounts(accs2);
    }
    res.json({ ok: true });
  });

  app.post("/api/verify-code", (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const code = (req.body.code || "").trim();

  const entry = codes.get(email);
  if (!entry || entry.expires < Date.now()) {
    return res.json({ ok: false, error: "expired" });
  }
  if (entry.code !== code) {
    return res.json({ ok: false, error: "wrong" });
  }

  const accounts = loadAccounts();
  if (accounts[entry.login.toLowerCase()]) {
    codes.delete(email);
    return res.json({ ok: false, error: "login_taken" });
  }
  for (const key in accounts) {
    if (accounts[key].email === email) {
      codes.delete(email);
      return res.json({ ok: false, error: "email_taken" });
    }
  }

  accounts[entry.login.toLowerCase()] = {
    login: entry.login,
    email: email,
    salt: entry.salt,
    passwordHash: entry.passwordHash,
    createdAt: new Date().toISOString(),
  };
  saveAccounts(accounts);
  codes.delete(email);

  try { ensureBotChat(entry.login, false); } catch (e) { console.warn("Не удалось создать чат с ботом:", e.message); }

  console.log("✅ Аккаунт создан: " + entry.login + " (" + email + ")");
  res.json({ ok: true, login: entry.login });
});

app.post("/api/login", (req, res) => {
  const login = (req.body.login || "").trim().toLowerCase();
  const password = (req.body.password || "").toLowerCase();

  const accounts = loadAccounts();
  const acc = accounts[login];
  if (!acc) return res.json({ ok: false, error: "no_user" });

  const hash = hashPassword(password, acc.salt);
  if (safeEqual(hash, acc.passwordHash)) {
    console.log("🔓 Вход: " + login);
    touch(login);
    if (!acc.sessions) acc.sessions = [{ id: "web_curr", kind: "WEB", device: "Chrome, Windows", location: "Russia, Saratov", current: true, activeAt: Date.now() }];
    saveAccounts(accounts);
    return res.json({ ok: true, login: acc.login, email: acc.email, username: acc.username || null, birthday: acc.birthday || null });
  }
  return res.json({ ok: false, error: "wrong_password" });
});

app.post("/api/logout", (req, res) => {
  const login = (req.body.login || "").trim().toLowerCase();
  if (login) {
    lastSeen.delete(login);
    console.log("🔒 Выход: " + login);
  }
  res.json({ ok: true });
});

app.get("/api/accounts", (req, res) => {
  const accounts = loadAccounts();
  const list = Object.values(accounts).map((a) => ({ login: a.login, email: a.email, username: a.username || null, usernames: a.bot ? BOT_ALIASES.slice() : null, birthday: a.birthday || null, bio: a.bio || null, name: a.name || null, avatar: a.avatar || null, createdAt: a.createdAt }));
  res.json({ ok: true, accounts: list });
});

app.get("/api/presence", (req, res) => {
  const logins = String(req.query.logins || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const online = {};
  logins.forEach((l) => { online[l] = isOnline(l); });
  res.json({ ok: true, online: online });
});

app.get("/api/find", (req, res) => {
  const q = String(req.query.q || req.query.email || "").trim().toLowerCase();
  if (!q) return res.status(400).json({ ok: false, error: "query_required" });

  const accounts = loadAccounts();
  if (BOT_ALIASES.indexOf(q) >= 0) {
    const b = accounts[BOT_LOGIN];
    if (b) return res.json({ ok: true, found: true, account: { login: b.login, email: b.email, username: b.username || null, usernames: BOT_ALIASES.slice(), birthday: b.birthday || null, bio: b.bio || null, name: b.name || null, avatar: b.avatar || null } });
  }
  for (const key in accounts) {
    const a = accounts[key];
    const uname = String(a.username || "").toLowerCase();
    if (a.email === q || key === q || (uname && uname === q)) {
      return res.json({ ok: true, found: true, account: { login: a.login, email: a.email, username: a.username || null, birthday: a.birthday || null, bio: a.bio || null, name: a.name || null, avatar: a.avatar || null } });
    }
  }
  res.json({ ok: true, found: false });
});

app.post("/api/set-username", (req, res) => {
  const login = String(req.body.login || "").trim().toLowerCase();
  const raw = String(req.body.username == null ? "" : req.body.username).trim();
  if (!login) return res.status(400).json({ ok: false, error: "login_required" });

  const accounts = loadAccounts();
  const acc = accounts[login];
  if (!acc) return res.status(404).json({ ok: false, error: "no_user" });

  if (!raw) {
    delete acc.username;
    saveAccounts(accounts);
    return res.json({ ok: true, username: null });
  }
  if (BOT_ALIASES.indexOf(raw.toLowerCase()) >= 0) return res.status(409).json({ ok: false, error: "reserved" });
  if (!/^[A-Za-z0-9]{5,11}$/.test(raw)) return res.status(400).json({ ok: false, error: "bad_username" });

  const uname = raw.toLowerCase();
  for (const k in accounts) {
    if (k === login) continue;
    if (String(accounts[k].username || "").toLowerCase() === uname) {
      return res.status(409).json({ ok: false, error: "taken" });
    }
  }
  acc.username = raw;
  saveAccounts(accounts);
  console.log("🏷️ Юзернейм " + raw + " → " + login);
  res.json({ ok: true, username: acc.username });
});

app.post("/api/set-birthday", (req, res) => {
  const login = String(req.body.login || "").trim().toLowerCase();
  const raw = String(req.body.birthday == null ? "" : req.body.birthday).trim();
  if (!login) return res.status(400).json({ ok: false, error: "login_required" });

  const accounts = loadAccounts();
  const acc = accounts[login];
  if (!acc) return res.status(404).json({ ok: false, error: "no_user" });

  if (!raw) {
    delete acc.birthday;
    saveAccounts(accounts);
    return res.json({ ok: true, birthday: null });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return res.status(400).json({ ok: false, error: "bad_birthday" });
  const mm = parseInt(raw.slice(5, 7), 10);
  const dd = parseInt(raw.slice(8, 10), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return res.status(400).json({ ok: false, error: "bad_birthday" });

  acc.birthday = raw;
  saveAccounts(accounts);
  res.json({ ok: true, birthday: acc.birthday });
});

app.post("/api/set-bio", (req, res) => {
  const login = String(req.body.login || "").trim().toLowerCase();
  const raw = String(req.body.bio == null ? "" : req.body.bio);
  if (!login) return res.status(400).json({ ok: false, error: "login_required" });

  const accounts = loadAccounts();
  const acc = accounts[login];
  if (!acc) return res.status(404).json({ ok: false, error: "no_user" });

  const bio = raw.slice(0, 500).trim();
  if (!bio) {
    delete acc.bio;
    saveAccounts(accounts);
    return res.json({ ok: true, bio: null });
  }
  acc.bio = bio;
  saveAccounts(accounts);
  res.json({ ok: true, bio: acc.bio });
});

app.post("/api/set-avatar", (req, res) => {
  const login = String(req.body.login || "").trim().toLowerCase();
  const raw = String(req.body.avatar == null ? "" : req.body.avatar);
  if (!login) return res.status(400).json({ ok: false, error: "login_required" });
  const accounts = loadAccounts();
  const acc = accounts[login];
  if (!acc) return res.status(404).json({ ok: false, error: "no_user" });
  if (!raw) {
    delete acc.avatar;
    saveAccounts(accounts);
    return res.json({ ok: true, avatar: null });
  }
  if (!/^data:image\//.test(raw)) return res.status(400).json({ ok: false, error: "bad_avatar" });
  if (raw.length > 4000000) return res.status(413).json({ ok: false, error: "too_big" });
  acc.avatar = raw;
  saveAccounts(accounts);
  res.json({ ok: true });
});

app.post("/api/set-name", (req, res) => {
  const login = String(req.body.login || "").trim().toLowerCase();
  const first = String(req.body.first == null ? "" : req.body.first).trim();
  const last = String(req.body.last == null ? "" : req.body.last).trim();
  if (!login) return res.status(400).json({ ok: false, error: "login_required" });
  const accounts = loadAccounts();
  const acc = accounts[login];
  if (!acc) return res.status(404).json({ ok: false, error: "no_user" });
  const name = [first, last].filter(Boolean).join(" ").slice(0, 80);
  if (!name) {
    delete acc.name;
    saveAccounts(accounts);
    return res.json({ ok: true, name: null });
  }
  acc.name = name;
  saveAccounts(accounts);
  res.json({ ok: true, name: acc.name });
});

app.post("/api/block", (req, res) => {
  const from = (req.body.from || "").trim().toLowerCase();
  const to = (req.body.to || "").trim().toLowerCase();
  if (!from || !to) return res.status(400).json({ ok: false, error: "bad_request" });

  const accounts = loadAccounts();
  if (!accounts[from] || !accounts[to]) return res.status(404).json({ ok: false, error: "no_user" });

  const list = accounts[from].blocked || [];
  if (list.indexOf(to) < 0) list.push(to);
  accounts[from].blocked = list;
  saveAccounts(accounts);

  console.log("🚫 " + from + " заблокировал " + to);
  res.json({ ok: true, blocked: list });
});

app.post("/api/unblock", (req, res) => {
  const from = (req.body.from || "").trim().toLowerCase();
  const to = (req.body.to || "").trim().toLowerCase();
  if (!from || !to) return res.status(400).json({ ok: false, error: "bad_request" });

  const accounts = loadAccounts();
  if (!accounts[from]) return res.status(404).json({ ok: false, error: "no_user" });

  const list = (accounts[from].blocked || []).filter((x) => x !== to);
  accounts[from].blocked = list;
  saveAccounts(accounts);

  console.log("✅ " + from + " разблокировал " + to);
  res.json({ ok: true, blocked: list });
});

app.get("/api/blocks", (req, res) => {
  const me = (req.query.me || "").trim().toLowerCase();
  if (!me) return res.status(400).json({ ok: false, error: "bad_request" });

  const accounts = loadAccounts();
  const acc = accounts[me];
  if (!acc) return res.status(404).json({ ok: false, error: "no_user" });

  res.json({ ok: true, blocked: acc.blocked || [] });
});

app.post("/api/dm/send", (req, res) => {
  const from = (req.body.from || "").trim();
  const to = (req.body.to || "").trim();
  const text = (req.body.text || "").toString();
  const id = String(req.body.id || "").trim();
  const forwarded = !!req.body.forwarded;
  let reply = null;
  if (req.body.reply && typeof req.body.reply === "object") {
    reply = {
      text: String(req.body.reply.text || "").slice(0, 400),
      me: !!req.body.reply.me,
      name: String(req.body.reply.name || "").slice(0, 80),
    };
  }

  if (!from || !to || !text.trim()) {
    return res.status(400).json({ ok: false, error: "bad_request" });
  }

  const fromLc = from.toLowerCase();
  const toLc = to.toLowerCase();

  const accounts = loadAccounts();
  if (!accounts[fromLc] || !accounts[toLc]) {
    return res.status(404).json({ ok: false, error: "no_user" });
  }

  const toAcc = accounts[toLc];
  if ((toAcc.blocked || []).indexOf(fromLc) >= 0) {
    console.log("⛔ " + fromLc + " → " + toLc + " отклонено (получатель заблокировал отправителя)");
    touch(fromLc);
    return res.json({ ok: true, blocked: true });
  }

  const store = loadMessages();
  const key = pairKey(from, to);
  if (!store[key]) {
    store[key] = { participants: [fromLc, toLc], messages: [] };
  }
  const msgId = id || (Date.now().toString(36) + crypto.randomBytes(4).toString("hex"));
  if (!store[key].messages.some((m) => m.id === msgId)) {
    const msg = { id: msgId, from: fromLc, text: text, at: new Date().toISOString() };
    if (reply && (reply.text || reply.name)) msg.reply = reply;
    if (forwarded) msg.forwarded = true;
    store[key].messages.push(msg);
  }
  saveMessages(store);

  // новое сообщение возвращает чат тому, кто его удалил у себя
  let undeleted = false;
  [fromLc, toLc].forEach((owner) => {
    const other = owner === fromLc ? toLc : fromLc;
    const acc = accounts[owner];
    if (acc && Array.isArray(acc.deleted) && acc.deleted.indexOf(other) >= 0) {
      acc.deleted = acc.deleted.filter((x) => x !== other);
      undeleted = true;
    }
  });
  if (undeleted) saveAccounts(accounts);

  touch(fromLc);

  res.json({ ok: true });
});

app.get("/api/dm/messages", (req, res) => {
  const me = (req.query.me || "").trim().toLowerCase();
  const withUser = (req.query.with || "").trim().toLowerCase();
  if (!me || !withUser) return res.status(400).json({ ok: false, error: "bad_request" });

  const store = loadMessages();
  const accounts = loadAccounts();
  const meAcc = accounts[me];
  const otherAcc = accounts[withUser];
  const key = pairKey(me, withUser);
  touch(me);

  if (meAcc && (meAcc.deleted || []).indexOf(withUser) >= 0) {
    return res.json({ ok: true, messages: [], otherReadAt: null });
  }

  const conv = store[key];
  let messages = conv ? conv.messages : [];
  messages = afterCutoff(messages, clearCutoff(meAcc, key));
  messages = messages.filter((m) => !(m.deletedFor || []).includes(me));
  const otherReadAt = otherAcc && otherAcc.readAt ? (otherAcc.readAt[key] || null) : null;
  res.json({ ok: true, messages: messages, otherReadAt: otherReadAt });
});

app.post("/api/dm/read", (req, res) => {
  const me = (req.body.me || "").trim().toLowerCase();
  const to = (req.body.to || "").trim().toLowerCase();
  if (!me || !to) return res.status(400).json({ ok: false, error: "bad_request" });

  const accounts = loadAccounts();
  if (!accounts[me]) return res.status(404).json({ ok: false, error: "no_user" });

  const key = pairKey(me, to);
  const at = req.body.at && !isNaN(Date.parse(req.body.at)) ? new Date(req.body.at).toISOString() : new Date().toISOString();
  accounts[me].readAt = accounts[me].readAt || {};
  accounts[me].readAt[key] = at;
  saveAccounts(accounts);
  touch(me);
  res.json({ ok: true });
});

app.post("/api/dm/react", (req, res) => {
  const me = (req.body.me || "").trim().toLowerCase();
  const to = (req.body.to || "").trim().toLowerCase();
  const id = String(req.body.id || "").trim();
  const emoji = String(req.body.emoji || "").trim();
  if (!me || !to || !id || !emoji) return res.status(400).json({ ok: false, error: "bad_request" });

  const store = loadMessages();
  const key = pairKey(me, to);
  const conv = store[key];
  if (!conv) return res.status(404).json({ ok: false, error: "no_conversation" });
  const msg = (conv.messages || []).find((m) => m.id === id);
  if (!msg) return res.status(404).json({ ok: false, error: "no_message" });

  msg.reactions = msg.reactions || {};
  const list = msg.reactions[emoji] || [];
  const idx = list.indexOf(me);
  if (idx >= 0) {
    list.splice(idx, 1);
    if (list.length) msg.reactions[emoji] = list; else delete msg.reactions[emoji];
  } else {
    for (const e in msg.reactions) msg.reactions[e] = msg.reactions[e].filter((x) => x !== me);
    for (const e in msg.reactions) { if (!msg.reactions[e].length) delete msg.reactions[e]; }
    msg.reactions[emoji] = (msg.reactions[emoji] || []).concat(me);
  }
  if (!Object.keys(msg.reactions).length) delete msg.reactions;
  saveMessages(store);
  touch(me);
  res.json({ ok: true, reactions: msg.reactions || {} });
});

app.post("/api/dm/delete-message", (req, res) => {
  const me = (req.body.me || "").trim().toLowerCase();
  const to = (req.body.to || "").trim().toLowerCase();
  const id = String(req.body.id || "").trim();
  const both = !!req.body.both;
  if (!me || !to || !id) return res.status(400).json({ ok: false, error: "bad_request" });

  const store = loadMessages();
  const key = pairKey(me, to);
  const conv = store[key];
  if (!conv) return res.status(404).json({ ok: false, error: "no_conversation" });
  const list = conv.messages || [];
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: "no_message" });

  if (both) {
    list.splice(idx, 1);
  } else {
    const msg = list[idx];
    msg.deletedFor = msg.deletedFor || [];
    if (!msg.deletedFor.includes(me)) msg.deletedFor.push(me);
  }
  saveMessages(store);
  touch(me);
  res.json({ ok: true });
});

app.get("/api/dm/list", (req, res) => {
  const me = (req.query.me || "").trim().toLowerCase();
  if (!me) return res.status(400).json({ ok: false, error: "bad_request" });
  touch(me);

  const store = loadMessages();
  const accounts = loadAccounts();
  const chats = [];

  for (const key in store) {
    const c = store[key];
    if (!c.participants || !c.participants.includes(me)) continue;
    const other = c.participants.find((p) => p !== me) || "";
    if (!other || other === me) continue;
    const acc = accounts[other];
    const meAcc = accounts[me];
    if (meAcc && (meAcc.deleted || []).indexOf(other) >= 0) continue;
    const blockedByMe = !!meAcc && (meAcc.blocked || []).indexOf(other) >= 0;
    const blockedByThem = !!acc && (acc.blocked || []).indexOf(me) >= 0;
    const msgs = afterCutoff(c.messages || [], clearCutoff(meAcc, key));
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const incoming = msgs.filter((m) => m.from !== me).length;
    chats.push({
      with: other,
      login: acc ? acc.login : other,
      name: acc ? (acc.name || null) : null,
      avatar: acc ? (acc.avatar || null) : null,
      email: acc ? acc.email : null,
      username: acc ? (acc.username || null) : null,
      birthday: acc ? (acc.birthday || null) : null,
      bio: acc ? (acc.bio || null) : null,
      bot: !!(acc && acc.bot),
      usernames: (acc && acc.bot) ? BOT_ALIASES.slice() : null,
      last: last ? last.text : "",
      lastAt: last ? last.at : null,
      lastFrom: last ? last.from : null,
      incoming: incoming,
      online: isOnline(other),
      lastSeen: lastSeenAt(other),
      blockedByMe: blockedByMe,
      blockedByThem: blockedByThem,
    });
  }

  res.json({ ok: true, chats: chats });
});

app.post("/api/dm/clear", (req, res) => {
  const me = (req.body.me || "").trim().toLowerCase();
  const to = (req.body.to || "").trim().toLowerCase();
  const both = !!req.body.both;
  if (!me || !to) return res.status(400).json({ ok: false, error: "bad_request" });

  const store = loadMessages();
  const accounts = loadAccounts();
  const key = pairKey(me, to);

  if (both) {
    if (store[key]) {
      store[key].messages = [];
      saveMessages(store);
    }
    if (accounts[me]) { accounts[me].cleared = accounts[me].cleared || {}; delete accounts[me].cleared[key]; }
    if (accounts[to]) { accounts[to].cleared = accounts[to].cleared || {}; delete accounts[to].cleared[key]; }
    saveAccounts(accounts);
    console.log("🧹 " + me + " очистил историю с " + to + " (для обоих)");
  } else if (accounts[me]) {
    accounts[me].cleared = accounts[me].cleared || {};
    accounts[me].cleared[key] = new Date().toISOString();
    saveAccounts(accounts);
    console.log("🧹 " + me + " очистил историю с " + to + " (только у себя)");
  }

  res.json({ ok: true });
});

app.post("/api/dm/delete", (req, res) => {
  const me = (req.body.me || "").trim().toLowerCase();
  const to = (req.body.to || "").trim().toLowerCase();
  const both = !!req.body.both;
  if (!me || !to) return res.status(400).json({ ok: false, error: "bad_request" });

  const store = loadMessages();
  const accounts = loadAccounts();
  const key = pairKey(me, to);

  if (both) {
    if (store[key]) {
      delete store[key];
      saveMessages(store);
    }
    if (accounts[me]) accounts[me].deleted = (accounts[me].deleted || []).filter((x) => x !== to);
    if (accounts[to]) accounts[to].deleted = (accounts[to].deleted || []).filter((x) => x !== me);
    saveAccounts(accounts);
    console.log("🗑️ " + me + " удалил чат с " + to + " (для обоих)");
  } else if (accounts[me]) {
    const d = accounts[me].deleted || [];
    if (d.indexOf(to) < 0) d.push(to);
    accounts[me].deleted = d;
    saveAccounts(accounts);
    console.log("🗑️ " + me + " удалил чат с " + to + " (только у себя)");
  }

  res.json({ ok: true });
});

// Запись звонка в историю обоих участников (в т.ч. для офлайн-получателя).
app.post("/api/call/log", (req, res) => {
  const from = (req.body.from || "").trim().toLowerCase();
  const to = (req.body.to || "").trim().toLowerCase();
  const status = String(req.body.status || "missed");
  const dur = parseInt(req.body.dur, 10) || 0;
  const id = String(req.body.id || "").trim() || (Date.now().toString(36) + crypto.randomBytes(3).toString("hex"));
  const at = req.body.at && !isNaN(Date.parse(req.body.at)) ? new Date(req.body.at).toISOString() : new Date().toISOString();

  if (!from || !to || from === to) return res.status(400).json({ ok: false, error: "bad_request" });

  const accounts = loadAccounts();
  if (!accounts[from] || !accounts[to]) return res.status(404).json({ ok: false, error: "no_user" });

  const calls = loadCalls();
  if (!Array.isArray(calls[from])) calls[from] = [];
  if (!Array.isArray(calls[to])) calls[to] = [];
  if (!calls[from].some((c) => c.id === id)) calls[from].unshift({ id, peer: to, dir: "out", status, dur, at });
  if (!calls[to].some((c) => c.id === id)) calls[to].unshift({ id, peer: from, dir: "in", status, dur, at });
  calls[from] = calls[from].slice(0, 200);
  calls[to] = calls[to].slice(0, 200);
  saveCalls(calls);

  res.json({ ok: true });
});

app.get("/api/call/list", (req, res) => {
  const me = (req.query.me || "").trim().toLowerCase();
  if (!me) return res.status(400).json({ ok: false, error: "bad_request" });
  const calls = loadCalls();
  const list = Array.isArray(calls[me]) ? calls[me].slice(0, 100) : [];
  res.json({ ok: true, calls: list });
});

// ====== WebSocket-сигнализация для звонков ======
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const sockets = new Map(); // login -> Set<ws>

function sendTo(login, obj) {
  const set = sockets.get(String(login || "").toLowerCase());
  if (!set) return false;
  const data = JSON.stringify(obj);
  let delivered = false;
  set.forEach((ws) => {
    if (ws.readyState === 1) { ws.send(data); delivered = true; }
  });
  return delivered;
}

const SIGNAL_TYPES = ["call-offer", "call-answer", "call-cancel", "call-reject", "call-busy", "ice", "call-end"];

wss.on("connection", (ws) => {
  ws.login = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "register") {
      const login = String(msg.login || "").trim().toLowerCase();
      if (!login) return;
      ws.login = login;
      if (!sockets.has(login)) sockets.set(login, new Set());
      sockets.get(login).add(ws);
      touch(login);
      ws.send(JSON.stringify({ type: "registered", login: login }));
      return;
    }

    if (!ws.login) return;

    if (msg.type === "ping") {
      touch(ws.login);
      try { ws.send(JSON.stringify({ type: "pong" })); } catch (e) {}
      return;
    }

    if (SIGNAL_TYPES.indexOf(msg.type) >= 0) {
      const to = String(msg.to || "").trim().toLowerCase();
      if (!to) return;
      const payload = Object.assign({}, msg, { from: ws.login });
      delete payload.to;
      const delivered = sendTo(to, payload);
      if (!delivered && (msg.type === "call-offer" || msg.type === "call-cancel")) {
        try { ws.send(JSON.stringify({ type: "call-unavailable", to: to })); } catch (e) {}
      }
    }
  });

  ws.on("close", () => {
    if (ws.login && sockets.has(ws.login)) {
      const set = sockets.get(ws.login);
      set.delete(ws);
      if (set.size === 0) sockets.delete(ws.login);
    }
  });

  ws.on("error", () => { try { ws.close(); } catch (e) {} });
});

setupMailer()
  .then(hydrateFromRemote)
  .then(() => {
    ensureBotAccount();
    ensureBotChatsForAll();
    server.listen(PORT, HOST, () => {
      console.log("kwekol сервер запущен: http://" + HOST + ":" + PORT);
    });
  });
