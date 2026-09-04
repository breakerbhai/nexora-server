/**
 * Nexora API Server
 * Storage: MongoDB when MONGODB_URI / MONGO_URI is set, else data/db.json
 *
 * Run:  npm install && node server.js
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
// Platform delivery fee (₹). Override with env DELIVERY_FEE

// Admin kill-switch + money (platform control — only with ADMIN_SECRET)
const ADMIN_SECRET = (process.env.ADMIN_SECRET || process.env.ADMIN_PIN || "258000").trim();
const COMMISSION_RATE = Math.min(0.5, Math.max(0, Number(process.env.COMMISSION_RATE || 0.05)));

const DELIVERY_FEE = Math.max(0, Number(process.env.DELIVERY_FEE || 35));
const FREE_DELIVERY_ABOVE = Math.max(0, Number(process.env.FREE_DELIVERY_ABOVE || 499));
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const DB_TMP = path.join(DATA_DIR, "db.json.tmp");

// Fixed key so apps Config.java keep working
const DEFAULT_API_KEY = (
  process.env.API_KEY ||
  process.env.X_API_KEY ||
  "TTRHsRQivU8HkpF2X5wHdqKw8-10TSpQ"
).trim();

// ----- Firebase Cloud Messaging (optional Hybrid push) -----
// Env on Render:
//   FIREBASE_SERVICE_ACCOUNT_JSON = full JSON string of service account
//   OR FIREBASE_PROJECT_ID + path not needed if JSON set
// Without these, server runs normally; push is skipped (no crash).
let firebaseAdmin = null;
let fcmReady = false;

function initFirebaseAdmin() {
  if (fcmReady || firebaseAdmin) return fcmReady;
  try {
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
    if (!raw) {
      console.log("[FCM] not configured — set FIREBASE_SERVICE_ACCOUNT_JSON for push");
      return false;
    }
    const sa = JSON.parse(raw);
    firebaseAdmin = require("firebase-admin");
    if (!firebaseAdmin.apps.length) {
      firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(sa) });
    }
    fcmReady = true;
    console.log("[FCM] firebase-admin ready project=" + (sa.project_id || ""));
    return true;
  } catch (e) {
    console.error("[FCM] init failed:", e.message);
    fcmReady = false;
    return false;
  }
}

function isMerchantDisabled(m) {
  if (!m || typeof m !== "object") return false;
  return m.disabled === true || m.terminated === true || m.active === false;
}

function findMerchantByShopId(db, shopId) {
  if (!shopId) return null;
  for (const phone of Object.keys(db.merchants || {})) {
    const m = db.merchants[phone];
    if (m && String(m.shop_id) === String(shopId)) return { phone, merchant: m };
  }
  return null;
}

function ensurePlatform(db) {
  if (!db.platform || typeof db.platform !== "object") {
    db.platform = { customer: true, merchant: true, delivery: true };
  }
  for (const k of ["customer", "merchant", "delivery"]) {
    if (typeof db.platform[k] !== "boolean") db.platform[k] = true;
  }
  return db.platform;
}

function ensureFcmStore(db) {
  if (!db.fcm_tokens || typeof db.fcm_tokens !== "object") db.fcm_tokens = {};
  if (!db.platform || typeof db.platform !== "object") {
    db.platform = { customer: true, merchant: true, delivery: true };
  }
  for (const k of ["customer", "merchant", "delivery"]) {
    if (typeof db.platform[k] !== "boolean") db.platform[k] = true;
  }
  return db;
}

/** role: customer | merchant | delivery ; key: phone last10 or shop_id */
function registerFcmToken(db, role, key, token, meta) {
  ensureFcmStore(db);
  let id = String(key || "");
  if (role !== "merchant" || !id.startsWith("shop") && id.replace(/\D/g, "").length >= 10) {
    const digits = id.replace(/\D/g, "");
    if (digits.length >= 10) id = digits.slice(-10);
  }
  const k = String(role || "customer") + ":" + id;
  if (!token || token.length < 20) return false;
  if (!db.fcm_tokens[k]) db.fcm_tokens[k] = [];
  const list = db.fcm_tokens[k].filter((t) => t !== token);
  list.unshift(token);
  db.fcm_tokens[k] = list.slice(0, 5);
  if (meta && meta.shop_id) {
    const sk = "merchant_shop:" + meta.shop_id;
    if (!db.fcm_tokens[sk]) db.fcm_tokens[sk] = [];
    const sl = db.fcm_tokens[sk].filter((t) => t !== token);
    sl.unshift(token);
    db.fcm_tokens[sk] = sl.slice(0, 5);
  }
  return true;
}

async function sendFcmToKeys(db, keys, title, body, data) {
  if (!initFirebaseAdmin()) return { ok: false, skipped: true };
  ensureFcmStore(db);
  const tokens = [];
  for (const key of keys) {
    const list = db.fcm_tokens[key] || [];
    for (const t of list) if (t && !tokens.includes(t)) tokens.push(t);
  }
  if (!tokens.length) return { ok: false, empty: true };
  const payload = {
    tokens,
    notification: { title: String(title || "Nexora"), body: String(body || "") },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [String(k), String(v)])
    ),
    android: { priority: "high" },
  };
  try {
    const resp = await firebaseAdmin.messaging().sendEachForMulticast(payload);
    console.log("[FCM] sent success=" + resp.successCount + " fail=" + resp.failureCount);
    return { ok: true, success: resp.successCount, failure: resp.failureCount };
  } catch (e) {
    console.error("[FCM] send error:", e.message);
    return { ok: false, error: e.message };
  }
}

function notifyOrderParties(db, order, title, body) {
  const keys = [];
  const phone = String(order.customer_phone || "").replace(/\D/g, "");
  if (phone) keys.push("customer:" + phone.slice(-10));
  if (order.shop_id) keys.push("merchant_shop:" + order.shop_id);
  // fire and forget
  Promise.resolve(sendFcmToKeys(db, keys, title, body, {
    order_id: order.order_id || "",
    status: String(order.status_step != null ? order.status_step : order.status || ""),
  })).catch(() => {});
}


// ----- MongoDB (Render Environment) -----
// Set ONE of: MONGODB_URI | MONGO_URI | MONGO_URL
// Optional: MONGO_DB_NAME (default: nexora)
const MONGODB_URI = (
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.MONGO_URL ||
  process.env.DATABASE_URL ||
  ""
).trim();
const MONGO_DB_NAME = (process.env.MONGO_DB_NAME || process.env.MONGODB_DB || "nexora").trim();
const MONGO_COLLECTION = (process.env.MONGO_COLLECTION || "app_state").trim();

let mongoClient = null;
let mongoCol = null;
let memDb = null;
let saveChain = Promise.resolve();

function mongoEnabled() {
  return MONGODB_URI.length > 10;
}

async function connectMongo() {
  if (!mongoEnabled()) return false;
  if (mongoCol) return true;
  const { MongoClient } = require("mongodb");
  mongoClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 15000,
  });
  await mongoClient.connect();
  const db = mongoClient.db(MONGO_DB_NAME);
  mongoCol = db.collection(MONGO_COLLECTION);
  console.log("[MONGO] connected db=" + MONGO_DB_NAME + " col=" + MONGO_COLLECTION);
  return true;
}

// ----- MessageCentral VerifyNow OTP (Render Environment) -----
// MC_CUSTOMER_ID   = customerId from MessageCentral dashboard
// MC_BASE64_KEY    = base64 encrypted key / password from dashboard
// MC_SHOW_DEV_OTP  = "1" only while testing
const MC_CUSTOMER_ID = (process.env.MC_CUSTOMER_ID || "").trim();
const MC_BASE64_KEY = (process.env.MC_BASE64_KEY || "").trim();
const MC_SHOW_DEV_OTP =
  process.env.MC_SHOW_DEV_OTP === "1" ||
  process.env.MC_SHOW_DEV_OTP === "true" ||
  process.env.SURVEY_MODE === "1" ||
  process.env.SURVEY_MODE === "true";

function mcEnabled() {
  return MC_CUSTOMER_ID.length > 2 && MC_BASE64_KEY.length > 5;
}

let mcAuthToken = null;
let mcTokenAt = 0;
const MC_TOKEN_TTL_MS = 50 * 60 * 1000; // refresh ~50 min

function httpsJson(method, hostname, path, headers, bodyStr) {
  return new Promise((resolve) => {
    const opts = {
      hostname,
      path,
      method,
      headers: headers || {},
      timeout: 25000,
    };
    if (bodyStr != null) {
      opts.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, error: "timeout" });
    });
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

/** Step 1: auth token */
async function mcGetToken() {
  if (mcAuthToken && Date.now() - mcTokenAt < MC_TOKEN_TTL_MS) return mcAuthToken;
  const path =
    "/auth/v1/authentication/token?customerId=" +
    encodeURIComponent(MC_CUSTOMER_ID) +
    "&key=" +
    encodeURIComponent(MC_BASE64_KEY) +
    "&scope=NEW&country=91";
  const r = await httpsJson("GET", "cpaas.messagecentral.com", path, { accept: "*/*" }, null);
  const token = r.body && (r.body.token || (r.body.data && r.body.data.token));
  if (!token) {
    console.log("[MC] token fail", r.status, r.error || r.raw || r.body);
    return null;
  }
  mcAuthToken = token;
  mcTokenAt = Date.now();
  console.log("[MC] token OK");
  return token;
}

/** Step 2: send OTP — returns { ok, verificationId, error } */
async function mcSendOtp(mobile10) {
  const token = await mcGetToken();
  if (!token) return { ok: false, error: "MessageCentral token failed — check MC_CUSTOMER_ID / MC_BASE64_KEY" };
  const path =
    "/verification/v3/send?countryCode=91&flowType=SMS&mobileNumber=" +
    encodeURIComponent(mobile10) +
    "&otpLength=6";
  const r = await httpsJson(
    "POST",
    "cpaas.messagecentral.com",
    path,
    { authToken: token, accept: "*/*" },
    ""
  );
  const data = r.body && r.body.data;
  const verificationId = data && data.verificationId;
  if (verificationId) {
    return { ok: true, verificationId: String(verificationId) };
  }
  const msg =
    (r.body && (r.body.message || r.body.responseMessage || r.body.errorMessage)) ||
    r.error ||
    r.raw ||
    "send failed";
  // 800 = MAXIMUM_LIMIT_REACHED
  return { ok: false, error: String(msg), status: r.status, body: r.body };
}

/** Step 3: validate OTP */
async function mcValidateOtp(verificationId, otpCode) {
  const token = await mcGetToken();
  if (!token) return { ok: false, error: "token failed" };
  const path =
    "/verification/v3/validateOtp?verificationId=" +
    encodeURIComponent(verificationId) +
    "&code=" +
    encodeURIComponent(otpCode);
  const r = await httpsJson(
    "GET",
    "cpaas.messagecentral.com",
    path,
    { authToken: token, accept: "*/*" },
    null
  );
  const data = r.body && r.body.data;
  const status = data && data.verificationStatus;
  if (status === "VERIFICATION_COMPLETED") return { ok: true };
  const msg =
    (r.body && (r.body.message || r.body.responseMessage)) ||
    status ||
    r.error ||
    "invalid otp";
  return { ok: false, error: String(msg), status: r.status };
}

function randomKey() {
  return crypto.randomBytes(24).toString("base64url");
}


function emptyDb() {
  return {
    api_key: DEFAULT_API_KEY,
    otps: {},
    merchants: {},
    orders: [],
    products: [],
    shop_meta: {},
    fcm_tokens: {},
    platform: { customer: true, merchant: true, delivery: true },
  };
}

function normalizeDb(db) {
  if (!db || typeof db !== "object") db = emptyDb();
  if (!db.api_key) db.api_key = DEFAULT_API_KEY;
  if (!db.otps) db.otps = {};
  if (!db.merchants) db.merchants = {};
  if (!Array.isArray(db.orders)) db.orders = [];
  if (!Array.isArray(db.products)) db.products = [];
  if (!db.shop_meta) db.shop_meta = {};
  if (!db.fcm_tokens || typeof db.fcm_tokens !== "object") db.fcm_tokens = {};
  if (!db.platform || typeof db.platform !== "object") {
    db.platform = { customer: true, merchant: true, delivery: true };
  }
  for (const k of ["customer", "merchant", "delivery"]) {
    if (typeof db.platform[k] !== "boolean") db.platform[k] = true;
  }
  return db;
}

async function loadDb() {
  if (memDb) return memDb;

  if (mongoEnabled()) {
    try {
      await connectMongo();
      const doc = await mongoCol.findOne({ _id: "main" });
      if (doc && doc.data) {
        memDb = normalizeDb(doc.data);
        console.log("[MONGO] loaded merchants=" + Object.keys(memDb.merchants).length +
          " products=" + memDb.products.length + " orders=" + memDb.orders.length);
        return memDb;
      }
      memDb = emptyDb();
      await mongoCol.updateOne(
        { _id: "main" },
        { $set: { data: memDb, updated_at: new Date() } },
        { upsert: true }
      );
      console.log("[MONGO] initialized empty state");
      return memDb;
    } catch (e) {
      console.error("[MONGO] load failed, fallback empty:", e.message);
      memDb = emptyDb();
      return memDb;
    }
  }

  // File fallback (local dev / no Mongo)
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(emptyDb(), null, 2), "utf8");
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    memDb = normalizeDb(JSON.parse(raw));
    return memDb;
  } catch (e) {
    console.error("[DB] file load failed:", e.message);
    memDb = emptyDb();
    return memDb;
  }
}

function saveDb(db) {
  memDb = normalizeDb(db);
  // Serialize writes so concurrent requests don't clobber
  saveChain = saveChain.then(() => persistDb(memDb)).catch((e) => {
    console.error("[DB] save error:", e.message);
  });
  return saveChain;
}

async function persistDb(db) {
  if (mongoEnabled() && mongoCol) {
    await mongoCol.updateOne(
      { _id: "main" },
      { $set: { data: db, updated_at: new Date() } },
      { upsert: true }
    );
    return;
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const json = JSON.stringify(db, null, 2);
  fs.writeFileSync(DB_TMP, json, "utf8");
  fs.renameSync(DB_TMP, DB_FILE);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 15 * 1024 * 1024; // 15MB for base64 images
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function checkApiKey(req, db) {
  const key = req.headers["x-api-key"] || "";
  return key && key === db.api_key;
}

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ----- OTP delivery queue (phone poller sends the real SMS) -----
const otpQueue = new Map(); // req_id -> { phone, code, status, reason, createdAt }
let otpReqCounter = 0;
const otpLastSend = new Map(); // phone -> timestamp
const OTP_COOLDOWN_MS = 60000; // 1 min per phone

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getShopMeta(db, shopId) {
  if (!db.shop_meta[shopId]) {
    db.shop_meta[shopId] = { logo_uri: "", banner_uri: "", rating: 0, rating_count: 0 };
  }
  return db.shop_meta[shopId];
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    });
    return res.end();
  }

  const db = await loadDb();
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname.replace(/\/+$/, "") || "/";

  try {
    if (req.method === "GET" && (p === "/" || p === "/health")) {
      return json(res, 200, {
        ok: true,
        service: "nexora-server",
        storage: mongoEnabled() ? ("mongodb:" + MONGO_DB_NAME) : "data/db.json",
        merchants: Object.keys(db.merchants).length,
        orders: db.orders.length,
        products: db.products.length,
      });
    }

    if (!checkApiKey(req, db)) {
      return json(res, 401, { ok: false, error: "Invalid or missing X-API-Key" });
    }

    // ----- OTP: MSG91 (preferred) or poller fallback -----
    
    // ----- FCM device token register (Hybrid push) -----
    if (req.method === "GET" && p === "/config/fees") {
      return json(res, 200, {
        ok: true,
        delivery_fee: DELIVERY_FEE,
        free_delivery_above: FREE_DELIVERY_ABOVE,
        currency: "INR",
      });
    }

    if (req.method === "POST" && p === "/fcm/register") {
      const body = await readBody(req);
      const role = String(body.role || "customer").toLowerCase();
      const phone = String(body.phone || body.customer_phone || "").replace(/\D/g, "");
      const shopId = String(body.shop_id || "");
      const token = String(body.token || body.fcm_token || "").trim();
      const key = role === "merchant" ? (shopId || phone) : phone;
      if (!token) return json(res, 400, { ok: false, error: "token required" });
      if (!key) return json(res, 400, { ok: false, error: "phone or shop_id required" });
      ensureFcmStore(db);
      registerFcmToken(db, role, key, token, { shop_id: shopId });
      saveDb(db);
      return json(res, 200, { ok: true, fcm_configured: initFirebaseAdmin() });
    }

    if (req.method === "POST" && p === "/send-otp") {
      const body = await readBody(req);
      let phone = String(body.phone || "").trim().replace(/\D/g, "");
      if (phone.length > 10) phone = phone.slice(-10);
      if (phone.length < 10) return json(res, 400, { ok: false, error: "Valid phone required" });

      const last = otpLastSend.get(phone) || 0;
      if (Date.now() - last < OTP_COOLDOWN_MS) {
        const wait = Math.ceil((OTP_COOLDOWN_MS - (Date.now() - last)) / 1000);
        const existing = db.otps[phone];
        if (existing && Date.now() < existing.expires) {
          const resp = {
            ok: true,
            message: "OTP already sent — wait " + wait + "s before resend",
            cooldown: wait,
          };
          if (existing.code && (MC_SHOW_DEV_OTP || !mcEnabled())) resp.otp_dev = existing.code;
          return json(res, 200, resp);
        }
        return json(res, 429, { ok: false, error: "Wait " + wait + "s before requesting another OTP" });
      }
      otpLastSend.set(phone, Date.now());

      for (const [id, job] of otpQueue) {
        if (job.phone === phone && job.status === "pending") otpQueue.delete(id);
      }

      // --- MessageCentral path (preferred) ---
      if (mcEnabled()) {
        console.log(`[OTP] MessageCentral send → ${phone}`);
        const result = await mcSendOtp(phone);
        if (result.ok && result.verificationId) {
          db.otps[phone] = {
            provider: "messagecentral",
            verificationId: result.verificationId,
            expires: Date.now() + 5 * 60 * 1000,
          };
          saveDb(db);
          console.log(`[OTP] MC OK ${phone} vid=${result.verificationId}`);
          return json(res, 200, {
            ok: true,
            message: "OTP sent via SMS",
            provider: "messagecentral",
          });
        }
        console.log(`[OTP] MC FAIL ${phone}:`, result.error || result.body);
        // Keep OTP in DB; return otp_dev so survey/demo register still works if SMS fails
        db.otps[phone] = { code: genOtp(), expires: Date.now() + 5 * 60 * 1000, provider: "local_fallback" };
        // reuse code already generated above if present in closure — regenerate linked below
        const resp = {
          ok: true,
          message: "OTP ready",
          provider: "local_fallback",
        };
        if (MC_SHOW_DEV_OTP) resp.otp_dev = db.otps[phone].code;
        return json(res, 200, resp);
      }

      // --- Fallback: local OTP + poller queue ---
      const code = genOtp();
      db.otps[phone] = { code, expires: Date.now() + 5 * 60 * 1000, provider: "poller" };
      saveDb(db);
      const reqId = "otp_" + ++otpReqCounter + "_" + Date.now();
      otpQueue.set(reqId, { phone, code, status: "pending", reason: "", createdAt: Date.now() });
      console.log(`[OTP] ${phone} → ${code} (poller — set MC_CUSTOMER_ID + MC_BASE64_KEY for MessageCentral)`);
      const pollerResp = {
        ok: true,
        message: "OTP generated",
        provider: "poller",
      };
      if (MC_SHOW_DEV_OTP) pollerResp.otp_dev = code;
      return json(res, 200, pollerResp);
    }

    // Phone poller: "do you have an OTP for me to send?"
    if (req.method === "GET" && p === "/otp-queue/next") {
      for (const [reqId, job] of otpQueue) {
        if (job.status === "pending") {
          job.status = "dispatched";
          job.dispatchedAt = Date.now();
          return json(res, 200, { ok: true, job: { req_id: reqId, phone: job.phone, otp: job.code } });
        }
      }
      return json(res, 200, { ok: true, job: null });
    }

    // Phone poller: "here's what actually happened when I tried to send it"
    if (req.method === "POST" && p === "/otp-queue/result") {
      const body = await readBody(req);
      const reqId = String(body.req_id || "");
      const success = !!body.success;
      const reason = String(body.reason || "");
      const job = otpQueue.get(reqId);
      if (!job) return json(res, 404, { ok: false, error: "Unknown or expired req_id" });
      job.status = success ? "sent" : "failed";
      job.reason = reason;
      console.log(`[OTP] result ${reqId} -> ${job.status} ${reason}`);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && p === "/verify-otp") {
      const body = await readBody(req);
      let phone = String(body.phone || "").trim().replace(/\D/g, "");
      if (phone.length > 10) phone = phone.slice(-10);
      const otp = String(body.otp || "").trim();
      const rec = db.otps[phone];
      if (!rec) return json(res, 400, { ok: false, error: "No OTP requested for this phone" });
      if (Date.now() > rec.expires) {
        delete db.otps[phone];
        saveDb(db);
        return json(res, 400, { ok: false, error: "OTP expired" });
      }

      // MessageCentral: validate on their API
      if (rec.provider === "messagecentral" && rec.verificationId) {
        const v = await mcValidateOtp(rec.verificationId, otp);
        if (!v.ok) {
          return json(res, 400, { ok: false, error: v.error || "Wrong OTP" });
        }
        delete db.otps[phone];
        saveDb(db);
        return json(res, 200, { ok: true, message: "Verified", provider: "messagecentral" });
      }

      // Local / poller OTP
      if (!rec.code || rec.code !== otp) {
        return json(res, 400, { ok: false, error: "Wrong OTP" });
      }
      delete db.otps[phone];
      saveDb(db);
      return json(res, 200, { ok: true, message: "Verified" });
    }

    // ----- Merchant register / login -----
    if (req.method === "POST" && p === "/merchant/register") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      const pin = String(body.pin || "").trim();
      const shop_name = String(body.shop_name || "").trim();
      const category = String(body.category || "").trim();
      const location = String(body.location || "").trim();
      if (phone.length < 10) return json(res, 400, { ok: false, error: "Valid phone required" });
      if (pin.length < 4) return json(res, 400, { ok: false, error: "PIN at least 4 digits" });
      if (!shop_name) return json(res, 400, { ok: false, error: "Shop name required" });
      if (db.merchants[phone]) {
        return json(res, 400, { ok: false, error: "This phone is already registered. Sign in instead." });
      }
      const shop_id = genId("shop_");
      db.merchants[phone] = {
        pin,
        shop_id,
        shop_name,
        category,
        location,
        created_at: Date.now(),
      };
      getShopMeta(db, shop_id);
      saveDb(db);
      console.log(`[MERCHANT] registered ${phone} → ${shop_name} (${shop_id})`);
      return json(res, 200, { ok: true, shop_id, shop_name, category, location });
    }

    if (req.method === "POST" && p === "/merchant/login") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      const pin = String(body.pin || "").trim();
      const m = db.merchants[phone];
      if (!m || m.pin !== pin) {
        return json(res, 401, { ok: false, error: "Invalid phone or PIN" });
      }
      return json(res, 200, {
        ok: true,
        shop_id: m.shop_id,
        shop_name: m.shop_name,
        category: m.category || "",
        location: m.location || "",
      });
    }

    // Update shop profile (name/category/location/logo/banner)
    if (req.method === "POST" && p === "/merchant/shop") {
      const body = await readBody(req);
      const shop_id = String(body.shop_id || "").trim();
      if (!shop_id) return json(res, 400, { ok: false, error: "shop_id required" });

      let found = null;
      for (const phone of Object.keys(db.merchants)) {
        if (db.merchants[phone].shop_id === shop_id) {
          found = db.merchants[phone];
          break;
        }
      }
      if (!found) return json(res, 404, { ok: false, error: "Shop not found" });

      if (body.shop_name != null) found.shop_name = String(body.shop_name).trim();
      if (body.category != null) found.category = String(body.category).trim();
      if (body.location != null) found.location = String(body.location).trim();

      const meta = getShopMeta(db, shop_id);
      if (body.logo_uri != null) meta.logo_uri = String(body.logo_uri);
      if (body.banner_uri != null) meta.banner_uri = String(body.banner_uri);

      saveDb(db);
      return json(res, 200, {
        ok: true,
        shop_id,
        shop_name: found.shop_name,
        category: found.category,
        location: found.location,
        logo_uri: meta.logo_uri || "",
        banner_uri: meta.banner_uri || "",
      });
    }

    // ----- Orders -----
    if (req.method === "POST" && p === "/orders") {
      const body = await readBody(req);
      const order = {
        order_id: body.order_id || genId("NX"),
        shop_name: body.shop_name || "",
        shop_id: body.shop_id || "",
        shop_category: body.shop_category || body.category || "",
        total: Number(body.total) || 0,
        source: body.source || "",
        placed_at: body.placed_at || Date.now(),
        customer_name: body.customer_name || "",
        customer_phone: body.customer_phone || "",
        address_line1: body.address_line1 || "",
        address_line2: body.address_line2 || "",
        landmark: body.landmark || "",
        city: body.city || "",
        pincode: body.pincode || "",
        full_address: body.full_address || "",
        lat: Number(body.lat) || 0,
        lng: Number(body.lng) || 0,
        items: Array.isArray(body.items) ? body.items : [],
        status: 0,
        status_step: 0,
        subtotal: 0,
        delivery_fee: 0,
        discount: Number(body.discount) || 0,
        mrp_total: Number(body.mrp_total) || 0,
      };
      // Server-side fee (do not trust client-only total long-term)
      {
        let sub = 0;
        for (const it of order.items) {
          const price = Number(it.price || 0);
          const qty = Number(it.quantity || it.qty || 1);
          sub += price * qty;
        }
        if (!sub) sub = Number(body.subtotal || body.total) || 0;
        order.subtotal = Math.round(sub * 100) / 100;
        const fee = order.subtotal >= FREE_DELIVERY_ABOVE ? 0 : DELIVERY_FEE;
        order.delivery_fee = fee;
        order.total = Math.round((order.subtotal + fee - (order.discount || 0)) * 100) / 100;
        if (order.total < 0) order.total = 0;
      }
      if (!order.full_address) {
        order.full_address = [order.address_line1, order.address_line2, order.landmark, order.city, order.pincode]
          .filter(Boolean).join(", ");
      }
      if (!order.shop_id && order.shop_name) {
        for (const phone of Object.keys(db.merchants)) {
          if (db.merchants[phone].shop_name === order.shop_name) {
            order.shop_id = db.merchants[phone].shop_id;
            break;
          }
        }
      }
      db.orders.unshift(order);
      saveDb(db);
      console.log(`[ORDER] ${order.order_id} ${order.customer_name} ₹${order.total}`);
      notifyOrderParties(db, order, "New order", "Order " + order.order_id + " — ₹" + order.total);
      return json(res, 200, { ok: true, order_id: order.order_id });
    }

    if (req.method === "GET" && p === "/orders") {
      let list = db.orders.slice();
      const shopId = u.searchParams.get("shop_id");
      const phone = String(u.searchParams.get("customer_phone") || u.searchParams.get("phone") || "").replace(/\D/g, "");
      if (shopId) {
        list = list.filter(
          (o) => o.shop_id === shopId || (!o.shop_id && matchShopName(db, shopId, o.shop_name))
        );
      }
      if (phone) {
        const last10 = phone.length > 10 ? phone.slice(-10) : phone;
        list = list.filter((o) => {
          const op = String(o.customer_phone || "").replace(/\D/g, "");
          const ol = op.length > 10 ? op.slice(-10) : op;
          return ol === last10 || op.endsWith(last10) || last10.endsWith(ol);
        });
      }
      return json(res, 200, { ok: true, orders: list });
    }

    // Customer return request (post-delivery). Grocery-like shops blocked client-side too.
    if (req.method === "POST" && p === "/orders/return") {
      const body = await readBody(req);
      const orderId = String(body.order_id || "");
      const reason = String(body.reason || "").trim();
      const o = db.orders.find((x) => x.order_id === orderId);
      if (!o) return json(res, 404, { ok: false, error: "Order not found" });
      if (Number(o.status) !== 4 && Number(o.status_step) !== 4) {
        return json(res, 400, { ok: false, error: "Only delivered orders can be returned" });
      }
      const cat = String(body.shop_category || o.shop_category || o.category || "").toLowerCase();
      const groceryHints = ["grocery", "kirana", "food", "fresh", "dairy", "vegetable", "fruit", "meat", "bakery"];
      if (groceryHints.some((g) => cat.includes(g))) {
        return json(res, 400, { ok: false, error: "Grocery / food orders are not eligible for return. Contact shop for damaged/wrong item refund." });
      }
      if (o.return_status === "requested" || o.return_status === "approved") {
        return json(res, 400, { ok: false, error: "Return already requested" });
      }
      // 7-day window from delivered_at
      const deliveredAt = Number(o.delivered_at || o.placed_at || 0);
      const week = 7 * 24 * 60 * 60 * 1000;
      if (deliveredAt && Date.now() - deliveredAt > week) {
        return json(res, 400, { ok: false, error: "Return window (7 days) expired" });
      }
      o.return_status = "requested";
      o.return_reason = reason || "Not specified";
      o.return_requested_at = Date.now();
      saveDb(db);
      console.log("[RETURN] requested", orderId, reason);
      return json(res, 200, { ok: true, order_id: orderId, return_status: "requested" });
    }

    if (req.method === "POST" && p === "/orders/status") {
      const body = await readBody(req);
      const orderId = String(body.order_id || "");
      const status = Number(body.status);
      const o = db.orders.find((x) => x.order_id === orderId);
      if (!o) return json(res, 404, { ok: false, error: "Order not found" });

      // Status map (must match merchant app):
      // 0 Pending, 1 Confirmed, 2 Packed, 3 Out for delivery, 4 Delivered, 5 Rejected

      // Out for delivery → OTP + QR token for delivery boy app
      if (status === 3) {
        o.delivery_otp = String(Math.floor(1000 + Math.random() * 9000));
        o.delivery_token = o.delivery_token || ("NXD" + crypto.randomBytes(8).toString("hex").toUpperCase());
        o.status = 3;
        o.status_label = "Out for delivery";
        o.status_step = 3;
        saveDb(db);
        console.log(`[ORDER] ${orderId} OUT otp=${o.delivery_otp} token=${o.delivery_token}`);
        notifyOrderParties(db, o, "Out for delivery", "Order " + orderId + " is on the way");
        return json(res, 200, {
          ok: true,
          order_id: orderId,
          status: 3,
          status_step: 3,
          delivery_otp: o.delivery_otp,
          delivery_token: o.delivery_token,
          qr_payload: "NEXORA|" + o.delivery_token,
        });
      }

      // Mark Delivered (merchant-side) → require OTP if issued
      if (status === 4) {
        const got = String(body.otp || body.delivery_otp || "").trim();
        if (o.delivery_otp && got && got !== String(o.delivery_otp)) {
          return json(res, 400, { ok: false, error: "Invalid delivery OTP", need_otp: true });
        }
        o.status = 4;
        o.status_step = 4;
        o.status_label = "Delivered";
        o.delivered_at = Date.now();
        saveDb(db);
        notifyOrderParties(db, o, "Delivered", "Order " + orderId + " delivered");
        return json(res, 200, { ok: true, order_id: orderId, status: 4, status_step: 4 });
      }

      // Rejected
      if (status === 5) {
        o.status = 5;
        o.status_step = 5;
        o.status_label = "Rejected";
        o.reject_reason = body.reject_reason || body.reason || "";
        o.rejected_at = Date.now();
        saveDb(db);
        notifyOrderParties(db, o, "Order rejected", o.reject_reason || "Shop rejected order");
        return json(res, 200, { ok: true, order_id: orderId, status: 5 });
      }

      // Customer cancelled (before out-for-delivery ideally)
      if (status === 6) {
        if (Number(o.status) >= 3) {
          return json(res, 400, { ok: false, error: "Cannot cancel — already out for delivery or delivered" });
        }
        o.status = 6;
        o.status_step = 6;
        o.status_label = "Cancelled";
        o.cancel_reason = body.reason || body.cancel_reason || "Cancelled by customer";
        o.cancelled_at = Date.now();
        saveDb(db);
        return json(res, 200, { ok: true, order_id: orderId, status: 6 });
      }

      o.status = status;
      o.status_step = status;
      o.status_label = body.status_label || ({
        0: "Pending", 1: "Confirmed", 2: "Packed", 3: "Out for delivery", 4: "Delivered", 5: "Rejected"
      })[status] || String(status);
      saveDb(db);
      return json(res, 200, { ok: true, order_id: orderId, status, delivery_otp: o.delivery_otp || null });
    }

    // ----- Shops (from merchants + meta; also recover shop_ids seen on products) -----
    if (req.method === "GET" && p === "/shops") {
      const byId = {};
      for (const phone of Object.keys(db.merchants)) {
        const m = db.merchants[phone];
        if (isMerchantDisabled(m)) continue;
        if (!m || !m.shop_id) continue;
        const meta = getShopMeta(db, m.shop_id);
        byId[m.shop_id] = {
          id: m.shop_id,
          name: m.shop_name || "Shop",
          category: m.category || "General",
          location: m.location || "",
          rating: meta.rating_count > 0 ? meta.rating : 0,
          logo_uri: meta.logo_uri || "",
          banner_uri: meta.banner_uri || "",
        };
      }
      // If merchant row was lost (disk reset) but products remain, still expose shop
      for (const pr of db.products) {
        const sid = pr && pr.shop_id;
        if (!sid || byId[sid]) continue;
        byId[sid] = {
          id: sid,
          name: pr.shop_name || "Shop",
          category: "General",
          location: "",
          rating: 0,
          logo_uri: "",
          banner_uri: "",
        };
      }
      return json(res, 200, { ok: true, shops: Object.values(byId) });
    }

    // ----- Products -----
    if (req.method === "GET" && p === "/products") {
      let list = db.products.slice();
      const shopId = u.searchParams.get("shop_id");
      if (shopId) list = list.filter((pr) => pr.shop_id === shopId);
      return json(res, 200, { ok: true, products: list });
    }

    if (req.method === "POST" && p === "/products") {
      const body = await readBody(req);
      let id = String(body.id || "").trim() || genId("p");
      // If client sent an id that collides and body says it's a new product, mint unique
      if (db.products.some((x) => x.id === id) && body.as_new === true) {
        id = genId("p");
      }
      if (!id || id === "null" || id === "undefined") id = genId("p");
      const shop_id = String(body.shop_id || "").trim();
      const name = String(body.name || "").trim();
      const price = Number(body.price) || 0;
      const description = String(body.description || "");
      const image_uri = body.image_uri || body.image_url || "";
      const sold_out = !!body.sold_out;
      let image_uris = [];
      if (Array.isArray(body.image_uris)) {
        image_uris = body.image_uris.filter((x) => typeof x === "string" && x.length > 0);
      } else if (image_uri) {
        image_uris = [image_uri];
      }
      if (!name) return json(res, 400, { ok: false, error: "Product name required" });
      if (!shop_id) return json(res, 400, { ok: false, error: "shop_id required" });

      // Keep a merchant/shop row alive so customer /shops does not go empty after restarts
      let hasMerchant = false;
      for (const phone of Object.keys(db.merchants)) {
        if (db.merchants[phone].shop_id === shop_id) {
          hasMerchant = true;
          break;
        }
      }
      if (!hasMerchant) {
        const stubPhone = "shopstub_" + shop_id;
        db.merchants[stubPhone] = {
          pin: "",
          shop_id,
          shop_name: String(body.shop_name || "Shop").trim() || "Shop",
          category: String(body.category || "General").trim() || "General",
          location: String(body.location || "").trim(),
          created_at: Date.now(),
          stub: true,
        };
        getShopMeta(db, shop_id);
      }

      const prod = {
        id,
        shop_id,
        name,
        price,
        description,
        image_uri: image_uris[0] || image_uri || "",
        image_uris,
        sold_out,
        updated_at: Date.now(),
      };
      const idx = db.products.findIndex((x) => x.id === id);
      if (idx >= 0) db.products[idx] = prod;
      else db.products.unshift(prod);
      saveDb(db);
      console.log(`[PRODUCT] save ${id} shop=${shop_id} "${name}"`);
      return json(res, 200, { ok: true, product: prod });
    }

    // Delete product: POST /products/delete  or  DELETE /products/:id
    if (
      (req.method === "POST" && p === "/products/delete") ||
      (req.method === "DELETE" && p.startsWith("/products/"))
    ) {
      let id = "";
      let shop_id = "";
      if (req.method === "DELETE") {
        id = p.replace("/products/", "").split("?")[0];
        shop_id = u.searchParams.get("shop_id") || "";
      } else {
        const body = await readBody(req);
        id = String(body.id || "");
        shop_id = String(body.shop_id || "");
      }
      const before = db.products.length;
      db.products = db.products.filter((pr) => {
        if (pr.id !== id) return true;
        if (shop_id && pr.shop_id !== shop_id) return true;
        return false;
      });
      if (db.products.length === before) {
        return json(res, 404, { ok: false, error: "Product not found" });
      }
      saveDb(db);
      console.log(`[PRODUCT] deleted ${id}`);
      return json(res, 200, { ok: true, deleted: id });
    }

    if (req.method === "POST" && p === "/otp-queue/clear") {
      const n = otpQueue.size || (Array.isArray(otpQueue) ? otpQueue.length : 0);
      if (otpQueue.clear) otpQueue.clear();
      else if (Array.isArray(otpQueue)) otpQueue.length = 0;
      console.log("[OTP] queue cleared", n);
      return json(res, 200, { ok: true, cleared: n });
    }

    if (req.method === "GET" && p === "/key") {
      return json(res, 200, { ok: true, api_key: db.api_key });
    }

    // Debug snapshot (authenticated)
    
    // ----- Platform kill-switch (apps check this on open) -----
    if (req.method === "GET" && p === "/platform/status") {
      ensurePlatform(db);
      return json(res, 200, {
        ok: true,
        platform: db.platform,
        customer: !!db.platform.customer,
        merchant: !!db.platform.merchant,
        delivery: !!db.platform.delivery,
        message: "Apps must stop if their flag is false",
      });
    }

    // Admin: enable/disable any app (requires ADMIN_SECRET)
    if (req.method === "POST" && p === "/admin/platform") {
      const body = await readBody(req);
      const secret = String(body.admin_secret || body.secret || req.headers["x-admin-secret"] || "").trim();
      if (!secret || secret !== ADMIN_SECRET) {
        return json(res, 403, { ok: false, error: "Invalid admin secret" });
      }
      ensurePlatform(db);
      const app = String(body.app || body.target || "").toLowerCase();
      if (!["customer", "merchant", "delivery"].includes(app)) {
        return json(res, 400, { ok: false, error: "app must be customer|merchant|delivery" });
      }
      const enabled = body.enabled === true || body.enabled === 1 || body.enabled === "1" || body.enabled === "true";
      db.platform[app] = enabled;
      saveDb(db);
      console.log("[PLATFORM]", app, "=", enabled);
      return json(res, 200, { ok: true, platform: db.platform });
    }

    // Admin money overview
    if (req.method === "GET" && p === "/admin/money") {
      const secret = String(u.searchParams.get("admin_secret") || req.headers["x-admin-secret"] || "").trim();
      if (secret && secret !== ADMIN_SECRET) {
        return json(res, 403, { ok: false, error: "Invalid admin secret" });
      }
      const orders = db.orders || [];
      let gmv = 0, deliveryFees = 0, delivered = 0, active = 0, rejected = 0;
      for (const o of orders) {
        const tot = Number(o.total) || 0;
        gmv += tot;
        deliveryFees += Number(o.delivery_fee) || 0;
        const st = Number(o.status_step != null ? o.status_step : o.status);
        if (st === 4) delivered++;
        else if (st === 5 || st === 6) rejected++;
        else active++;
      }
      const commission = Math.round(gmv * COMMISSION_RATE * 100) / 100;
      return json(res, 200, {
        ok: true,
        gmv: Math.round(gmv * 100) / 100,
        delivery_fees: Math.round(deliveryFees * 100) / 100,
        commission_rate: COMMISSION_RATE,
        estimated_commission: commission,
        order_count: orders.length,
        delivered,
        active,
        rejected,
        merchants: Object.keys(db.merchants || {}).length,
        products: (db.products || []).length,
        platform: (db.platform || {}),
      });
    }


    
    // List all merchants (admin)
    if (req.method === "GET" && p === "/admin/merchants") {
      const secret = String(u.searchParams.get("admin_secret") || req.headers["x-admin-secret"] || "").trim();
      if (secret && secret !== ADMIN_SECRET) {
        return json(res, 403, { ok: false, error: "Invalid admin secret" });
      }
      const list = [];
      for (const phone of Object.keys(db.merchants || {})) {
        const m = db.merchants[phone];
        if (!m) continue;
        list.push({
          phone,
          shop_id: m.shop_id || "",
          shop_name: m.shop_name || m.name || "Shop",
          category: m.category || "",
          location: m.location || "",
          disabled: isMerchantDisabled(m),
          created_at: m.created_at || 0,
        });
      }
      list.sort((a, b) => String(a.shop_name).localeCompare(String(b.shop_name)));
      return json(res, 200, { ok: true, count: list.length, merchants: list });
    }

    // Terminate / restore one merchant shop
    if (req.method === "POST" && p === "/admin/merchant") {
      const body = await readBody(req);
      const secret = String(body.admin_secret || body.secret || req.headers["x-admin-secret"] || "").trim();
      if (!secret || secret !== ADMIN_SECRET) {
        return json(res, 403, { ok: false, error: "Invalid admin secret" });
      }
      const shopId = String(body.shop_id || "").trim();
      const phone = String(body.phone || "").replace(/\D/g, "");
      let found = null;
      if (shopId) found = findMerchantByShopId(db, shopId);
      if (!found && phone) {
        const m = db.merchants[phone] || db.merchants[phone.slice(-10)];
        if (m) found = { phone: db.merchants[phone] ? phone : phone.slice(-10), merchant: m };
      }
      if (!found) return json(res, 404, { ok: false, error: "Merchant not found" });
      const action = String(body.action || "").toLowerCase();
      // action: terminate | disable | restore | enable | delete
      if (action === "delete") {
        delete db.merchants[found.phone];
        // hide products of this shop
        db.products = (db.products || []).filter((x) => String(x.shop_id) !== String(found.merchant.shop_id));
        saveDb(db);
        console.log("[ADMIN] deleted merchant", found.phone, found.merchant.shop_id);
        return json(res, 200, { ok: true, deleted: true, phone: found.phone });
      }
      const disable = action === "terminate" || action === "disable" || body.disabled === true;
      const enable = action === "restore" || action === "enable" || body.disabled === false;
      if (disable) {
        found.merchant.disabled = true;
        found.merchant.terminated = true;
        found.merchant.terminated_at = Date.now();
      } else if (enable) {
        found.merchant.disabled = false;
        found.merchant.terminated = false;
        found.merchant.restored_at = Date.now();
      } else {
        return json(res, 400, { ok: false, error: "action terminate|restore|delete required" });
      }
      saveDb(db);
      console.log("[ADMIN] merchant", found.phone, "disabled=", !!found.merchant.disabled);
      return json(res, 200, {
        ok: true,
        phone: found.phone,
        shop_id: found.merchant.shop_id,
        disabled: isMerchantDisabled(found.merchant),
      });
    }


    if (req.method === "GET" && p === "/admin/orders") {
      const list = (db.orders || []).map((o) => ({
        order_id: o.order_id,
        shop_id: o.shop_id || "",
        shop_name: o.shop_name || "",
        customer_name: o.customer_name || "",
        customer_phone: o.customer_phone || "",
        total: o.total,
        subtotal: o.subtotal,
        delivery_fee: o.delivery_fee,
        status: o.status_step != null ? o.status_step : o.status,
        status_label: o.status_label || "",
        placed_at: o.placed_at,
        item_count: Array.isArray(o.items) ? o.items.length : 0,
      }));
      return json(res, 200, { ok: true, count: list.length, orders: list });
    }

    if (req.method === "GET" && p === "/admin/stats") {
      return json(res, 200, {
        ok: true,
        merchants: Object.keys(db.merchants).length,
        products: db.products.length,
        orders: db.orders.length,
        db_file: DB_FILE,
      });
    }


    // ----- Delivery boy: scan QR / enter token → customer contact + address -----
    if (req.method === "GET" && p === "/delivery/lookup") {
      let code = String(u.searchParams.get("code") || u.searchParams.get("token") || "").trim().toUpperCase();
      // Accept payload form NEXORA|TOKEN or bare token
      if (code.includes("|")) code = code.split("|").pop().trim();
      code = code.replace(/[^A-Z0-9]/g, "");
      if (code.length < 6) return json(res, 400, { ok: false, error: "Invalid delivery code" });
      const o = db.orders.find((x) => String(x.delivery_token || "").toUpperCase() === code);
      if (!o) return json(res, 404, { ok: false, error: "Code not found or order not out for delivery" });
      // Only Delivered(4) / Rejected(5) are closed. Status 3 = Out for delivery (active).
      if (Number(o.status) === 4 || Number(o.status) === 5) {
        return json(res, 400, { ok: false, error: "Order already closed", status: o.status });
      }
      if (Number(o.status) !== 3) {
        return json(res, 400, { ok: false, error: "Order not out for delivery yet", status: o.status });
      }
      return json(res, 200, {
        ok: true,
        order_id: o.order_id,
        shop_name: o.shop_name || "",
        customer_name: o.customer_name || "",
        customer_phone: o.customer_phone || "",
        full_address: o.full_address || [o.address_line1, o.address_line2, o.landmark, o.city, o.pincode].filter(Boolean).join(", "),
        address_line1: o.address_line1 || "",
        address_line2: o.address_line2 || "",
        landmark: o.landmark || "",
        city: o.city || "",
        pincode: o.pincode || "",
        total: o.total || 0,
        items: Array.isArray(o.items) ? o.items : [],
        status: o.status,
        lat: Number(o.lat) || 0,
        lng: Number(o.lng) || 0,
        maps_url: (Number(o.lat) || Number(o.lng))
          ? ("https://www.google.com/maps?q=" + o.lat + "," + o.lng)
          : ("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(
              o.full_address || [o.address_line1, o.address_line2, o.landmark, o.city, o.pincode].filter(Boolean).join(", ")
            )),
        delivery_otp_hint: o.delivery_otp ? "Ask customer for 4-digit delivery OTP" : null,
      });
    }

    // Delivery boy at door: send OTP SMS to customer (MessageCentral)
    if (req.method === "POST" && p === "/delivery/send-otp") {
      const body = await readBody(req);
      let code = String(body.code || body.token || "").trim().toUpperCase();
      if (code.includes("|")) code = code.split("|").pop().trim();
      code = code.replace(/[^A-Z0-9]/g, "");
      const o = db.orders.find((x) => String(x.delivery_token || "").toUpperCase() === code);
      if (!o) return json(res, 404, { ok: false, error: "Code not found" });
      if (Number(o.status) === 4 || Number(o.status) === 5) {
        return json(res, 400, { ok: false, error: "Order already closed" });
      }
      if (Number(o.status) !== 3) {
        return json(res, 400, { ok: false, error: "Order not out for delivery" });
      }

      const phone = String(o.customer_phone || "").replace(/\D/g, "");
      const last10 = phone.length > 10 ? phone.slice(-10) : phone;
      if (last10.length !== 10) {
        return json(res, 400, { ok: false, error: "No valid customer phone on order" });
      }

      // Always keep a local 4-digit backup OTP
      o.delivery_otp = String(Math.floor(1000 + Math.random() * 9000));
      o.delivery_otp_sent_at = Date.now();

      let smsOk = false;
      let smsError = "";
      if (mcEnabled()) {
        const r = await mcSendOtp(last10);
        if (r.ok && r.verificationId) {
          o.delivery_mc_verification_id = String(r.verificationId);
          smsOk = true;
          console.log("[DELIVERY-OTP] MC sent order=" + o.order_id + " phone=" + last10 + " vid=" + r.verificationId);
        } else {
          smsError = (r && r.error) || "MessageCentral send failed";
          console.log("[DELIVERY-OTP] MC fail", smsError, "local_otp=" + o.delivery_otp);
        }
      } else {
        smsError = "MessageCentral not configured";
        console.log("[DELIVERY-OTP] no MC local_otp=" + o.delivery_otp + " phone=" + last10);
      }
      saveDb(db);

      return json(res, 200, {
        ok: true,
        sent: smsOk,
        message: smsOk
          ? "OTP SMS sent to customer"
          : ("OTP ready. SMS not sent (" + smsError + "). Local OTP: " + o.delivery_otp),
        delivery_otp_dev: smsOk ? undefined : o.delivery_otp,
        customer_phone_masked: last10.slice(0, 2) + "******" + last10.slice(-2),
      });
    }

    if (req.method === "POST" && p === "/delivery/complete") {
      const body = await readBody(req);
      let code = String(body.code || body.token || "").trim().toUpperCase();
      if (code.includes("|")) code = code.split("|").pop().trim();
      code = code.replace(/[^A-Z0-9]/g, "");
      const otp = String(body.otp || body.delivery_otp || "").trim();
      const o = db.orders.find((x) => String(x.delivery_token || "").toUpperCase() === code);
      if (!o) return json(res, 404, { ok: false, error: "Code not found" });
      if (!otp) {
        return json(res, 400, { ok: false, error: "Enter customer OTP", need_otp: true });
      }
      let otpOk = false;
      if (o.delivery_mc_verification_id && mcEnabled()) {
        const v = await mcValidateOtp(String(o.delivery_mc_verification_id), otp);
        otpOk = !!v.ok;
        if (!otpOk && o.delivery_otp && otp === String(o.delivery_otp)) otpOk = true;
        if (!otpOk) {
          return json(res, 400, { ok: false, error: (v && v.error) || "Invalid delivery OTP", need_otp: true });
        }
      } else if (o.delivery_otp) {
        if (otp !== String(o.delivery_otp)) {
          return json(res, 400, { ok: false, error: "Invalid delivery OTP", need_otp: true });
        }
        otpOk = true;
      } else {
        return json(res, 400, { ok: false, error: "Tap Send OTP first", need_otp: true });
      }
      o.status = 4;
      o.status_step = 4;
      o.status_label = "Delivered";
      o.delivered_at = Date.now();
      o.courier_name = body.courier_name || body.delivery_name || o.courier_name || "";
      o.courier_phone = body.courier_phone || body.delivery_phone || o.courier_phone || "";
      saveDb(db);
      return json(res, 200, { ok: true, order_id: o.order_id, status: 4, status_step: 4 });
    }

    return json(res, 404, { ok: false, error: "Not found: " + p });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e.message || "Server error" });
  }
});

function matchShopName(db, shopId, shopName) {
  for (const phone of Object.keys(db.merchants)) {
    const m = db.merchants[phone];
    if (m.shop_id === shopId && m.shop_name === shopName) return true;
  }
  return false;
}


// ----- Boot -----
(async () => {
  try {
    if (mongoEnabled()) {
      try {
        await connectMongo();
      } catch (e) {
        console.error("[MONGO] connect at boot failed:", e.message);
      }
    }
    const db0 = await loadDb();
    if (db0.api_key !== DEFAULT_API_KEY) {
      console.log("[WARN] db api_key differs from DEFAULT — apps use Config.API_KEY");
    }
    console.log("[ENV] MONGODB_URI=" + (mongoEnabled() ? "set" : "MISSING"));
    console.log("[ENV] MC_CUSTOMER_ID=" + (typeof MC_CUSTOMER_ID !== "undefined" && MC_CUSTOMER_ID ? "set" : "MISSING"));
    console.log("[ENV] MC_BASE64_KEY=" + (typeof MC_BASE64_KEY !== "undefined" && MC_BASE64_KEY ? "set" : "MISSING"));
    console.log("[ENV] API_KEY=" + (DEFAULT_API_KEY ? "set" : "MISSING"));

    server.listen(PORT, "0.0.0.0", () => {
      initFirebaseAdmin();
      console.log("");
      console.log("═══════════════════════════════════════════");
      console.log("  Nexora Server");
      console.log("  Port:     " + PORT);
      console.log("  Storage:  " + (mongoEnabled() ? "MongoDB" : DB_FILE));
      console.log("  Merchants:", Object.keys(db0.merchants || {}).length);
      console.log("  Products: ", (db0.products || []).length);
      console.log("  Orders:   ", (db0.orders || []).length);
      console.log("═══════════════════════════════════════════");
      console.log("");
    });
  } catch (e) {
    console.error("[BOOT] failed:", e);
    process.exit(1);
  }
})();
