/**
 * Nexora OTP + Orders + Merchant API Server
 * Pure Node.js (no npm packages required).
 *
 * Run:  node server.js
 * Then expose with cloudflared / ngrok and paste URL into both apps' Config.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

// Generate once, persist in db — also printed on startup
function randomKey() {
  return crypto.randomBytes(24).toString("base64url");
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      api_key: randomKey(),
      otps: {},          // phone -> { code, expires }
      merchants: {},     // phone -> { pin, shop_id, shop_name, category, location }
      orders: [],
      products: [],      // { id, shop_id, name, price, description, image_uri }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
}

function loadDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
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

function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  const db = loadDb();
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname.replace(/\/+$/, "") || "/";

  try {
    // Public health (no key) — useful to test tunnel
    if (req.method === "GET" && (p === "/" || p === "/health")) {
      return json(res, 200, {
        ok: true,
        service: "nexora-server",
        merchants: Object.keys(db.merchants).length,
        orders: db.orders.length,
        products: db.products.length,
      });
    }

    // Everything else needs API key
    if (!checkApiKey(req, db)) {
      return json(res, 401, { ok: false, error: "Invalid or missing X-API-Key" });
    }

    // ----- OTP (customer app) -----
    if (req.method === "POST" && p === "/send-otp") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      if (phone.length < 10) return json(res, 400, { ok: false, error: "Valid phone required" });
      const code = genOtp();
      db.otps[phone] = { code, expires: Date.now() + 5 * 60 * 1000 };
      saveDb(db);
      // Dev: return otp in response so you can test without SMS provider
      console.log(`[OTP] ${phone} → ${code}`);
      return json(res, 200, { ok: true, message: "OTP sent", otp_dev: code });
    }

    if (req.method === "POST" && p === "/verify-otp") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      const otp = String(body.otp || "").trim();
      const rec = db.otps[phone];
      if (!rec) return json(res, 400, { ok: false, error: "No OTP requested for this phone" });
      if (Date.now() > rec.expires) {
        delete db.otps[phone];
        saveDb(db);
        return json(res, 400, { ok: false, error: "OTP expired" });
      }
      if (rec.code !== otp) return json(res, 400, { ok: false, error: "Wrong OTP" });
      delete db.otps[phone];
      saveDb(db);
      return json(res, 200, { ok: true, message: "Verified" });
    }

    // ----- Merchant auth -----
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
      db.merchants[phone] = { pin, shop_id, shop_name, category, location, created_at: Date.now() };
      saveDb(db);
      console.log(`[MERCHANT] registered ${phone} → ${shop_name}`);
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

    // ----- Orders -----
    if (req.method === "POST" && p === "/orders") {
      const body = await readBody(req);
      const order = {
        order_id: body.order_id || genId("NX"),
        shop_name: body.shop_name || "",
        shop_id: body.shop_id || "",
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
        items: Array.isArray(body.items) ? body.items : [],
        status: 0,
      };
      // Try match shop_id from shop_name if missing
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
      return json(res, 200, { ok: true, order_id: order.order_id });
    }

    if (req.method === "GET" && p === "/orders") {
      let list = db.orders.slice();
      const shopId = u.searchParams.get("shop_id");
      if (shopId) {
        list = list.filter(
          (o) => o.shop_id === shopId || (!o.shop_id && matchShopName(db, shopId, o.shop_name))
        );
      }
      return json(res, 200, { ok: true, orders: list });
    }

    if (req.method === "POST" && p === "/orders/status") {
      const body = await readBody(req);
      const orderId = String(body.order_id || "");
      const status = Number(body.status);
      const o = db.orders.find((x) => x.order_id === orderId);
      if (!o) return json(res, 404, { ok: false, error: "Order not found" });
      o.status = status;
      o.status_label = body.status_label || "";
      saveDb(db);
      return json(res, 200, { ok: true, order_id: orderId, status });
    }

    // ----- Products -----
    if (req.method === "GET" && p === "/products") {
      let list = db.products.slice();
      const shopId = u.searchParams.get("shop_id");
      if (shopId) list = list.filter((p) => p.shop_id === shopId);
      return json(res, 200, { ok: true, products: list });
    }

    if (req.method === "POST" && p === "/products") {
      const body = await readBody(req);
      const id = String(body.id || genId("p"));
      const shop_id = String(body.shop_id || "");
      const name = String(body.name || "").trim();
      const price = Number(body.price) || 0;
      const description = String(body.description || "");
      const image_uri = body.image_uri || body.image_url || "";
      if (!name) return json(res, 400, { ok: false, error: "Product name required" });

      const idx = db.products.findIndex((x) => x.id === id);
      const prod = { id, shop_id, name, price, description, image_uri, updated_at: Date.now() };
      if (idx >= 0) db.products[idx] = prod;
      else db.products.unshift(prod);
      saveDb(db);
      return json(res, 200, { ok: true, product: prod });
    }

    // API key info (authenticated)
    if (req.method === "GET" && p === "/key") {
      return json(res, 200, { ok: true, api_key: db.api_key });
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

ensureDb();
const db0 = loadDb();
server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log("  Nexora Server running");
  console.log("  Local:    http://127.0.0.1:" + PORT);
  console.log("  API KEY:  " + db0.api_key);
  console.log("═══════════════════════════════════════════");
  console.log("  1) Keep this terminal open");
  console.log("  2) Tunnel: cloudflared tunnel --url http://127.0.0.1:" + PORT);
  console.log("  3) Paste tunnel URL + API KEY into both apps Config.java");
  console.log("  Routes: /send-otp /verify-otp /orders /merchant/login");
  console.log("          /merchant/register /products /orders/status");
  console.log("");
});
