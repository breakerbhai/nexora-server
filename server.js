/**
 * Nexora API Server — persistent JSON database
 * Data file: data/db.json (atomic write)
 *
 * Run:  node server.js
 * Or:   npm start
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const DB_TMP = path.join(DATA_DIR, "db.json.tmp");

// Fixed key so apps Config.java keep working (change later if needed)
const DEFAULT_API_KEY = "TTRHsRQivU8HkpF2X5wHdqKw8-10TSpQ";

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
    // shop_id -> { logo_uri, banner_uri, rating, rating_count }
    shop_meta: {},
  };
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(emptyDb(), null, 2), "utf8");
  }
}

function loadDb() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const db = JSON.parse(raw);
    if (!db.api_key) db.api_key = DEFAULT_API_KEY;
    if (!db.otps) db.otps = {};
    if (!db.merchants) db.merchants = {};
    if (!Array.isArray(db.orders)) db.orders = [];
    if (!Array.isArray(db.products)) db.products = [];
    if (!db.shop_meta) db.shop_meta = {};
    return db;
  } catch (e) {
    console.error("[DB] load failed, using empty:", e.message);
    return emptyDb();
  }
}

/** Atomic write — avoids corrupt db.json on crash mid-write */
function saveDb(db) {
  ensureDb();
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

  const db = loadDb();
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname.replace(/\/+$/, "") || "/";

  try {
    if (req.method === "GET" && (p === "/" || p === "/health")) {
      return json(res, 200, {
        ok: true,
        service: "nexora-server",
        storage: "data/db.json",
        merchants: Object.keys(db.merchants).length,
        orders: db.orders.length,
        products: db.products.length,
      });
    }

    if (!checkApiKey(req, db)) {
      return json(res, 401, { ok: false, error: "Invalid or missing X-API-Key" });
    }

    // ----- OTP (real SMS via phone poller — no tunnel needed) -----
    if (req.method === "POST" && p === "/send-otp") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      if (phone.length < 10) return json(res, 400, { ok: false, error: "Valid phone required" });

      const code = genOtp();
      const reqId = "otp_" + ++otpReqCounter + "_" + Date.now();
      otpQueue.set(reqId, { phone, code, status: "pending", reason: "", createdAt: Date.now() });
      console.log(`[OTP] queued ${reqId} for ${phone}`);

      // Wait up to 15s for the phone poller to pick this up and confirm real SMS delivery
      const timeoutMs = 45000;
      const start = Date.now();
      let job = otpQueue.get(reqId);
      while (Date.now() - start < timeoutMs) {
        job = otpQueue.get(reqId);
        if (!job || job.status === "sent" || job.status === "failed") break;
        await sleep(400);
      }
      otpQueue.delete(reqId);

      if (!job || job.status !== "sent") {
        const reason = job && job.reason ? job.reason : "Phone did not confirm delivery in time (is the poller app running?)";
        console.log(`[OTP] ${reqId} FAILED — ${reason}`);
        return json(res, 502, { ok: false, error: "OTP send failed: " + reason });
      }

      db.otps[phone] = { code, expires: Date.now() + 5 * 60 * 1000 };
      saveDb(db);
      console.log(`[OTP] ${reqId} sent to ${phone}`);
      return json(res, 200, { ok: true, message: "OTP sent" });
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

    if (req.method === "POST" && p === "/orders/status") {
      const body = await readBody(req);
      const orderId = String(body.order_id || "");
      const status = Number(body.status);
      const o = db.orders.find((x) => x.order_id === orderId);
      if (!o) return json(res, 404, { ok: false, error: "Order not found" });

      // Out for delivery → generate 4-digit delivery OTP
      if (status === 2) {
        o.delivery_otp = String(Math.floor(1000 + Math.random() * 9000));
        o.status = 2;
        o.status_label = "Out for delivery";
        saveDb(db);
        console.log(`[ORDER] ${orderId} OUT otp=${o.delivery_otp}`);
        return json(res, 200, { ok: true, order_id: orderId, status: 2, delivery_otp: o.delivery_otp });
      }

      // Mark Delivered → require OTP if one was issued
      if (status === 3) {
        const got = String(body.otp || body.delivery_otp || "").trim();
        if (o.delivery_otp && got !== String(o.delivery_otp)) {
          return json(res, 400, { ok: false, error: "Invalid delivery OTP", need_otp: true });
        }
        o.status = 3;
        o.status_label = "Delivered";
        o.delivered_at = Date.now();
        saveDb(db);
        return json(res, 200, { ok: true, order_id: orderId, status: 3 });
      }

      // Customer received
      if (status === 5) {
        o.status = 5;
        o.status_label = "Received";
        o.received_at = Date.now();
        saveDb(db);
        return json(res, 200, { ok: true, order_id: orderId, status: 5 });
      }

      o.status = status;
      o.status_label = body.status_label || "";
      if (status === 4) o.status_label = "Cancelled";
      saveDb(db);
      return json(res, 200, { ok: true, order_id: orderId, status, delivery_otp: o.delivery_otp || null });
    }

    // ----- Shops (from merchants + meta) -----
    if (req.method === "GET" && p === "/shops") {
      const shops = Object.keys(db.merchants).map((phone) => {
        const m = db.merchants[phone];
        const meta = getShopMeta(db, m.shop_id);
        return {
          id: m.shop_id,
          name: m.shop_name,
          category: m.category || "General",
          location: m.location || "",
          // Real rating only — 0 = New (no fake 4.0)
          rating: meta.rating_count > 0 ? meta.rating : 0,
          logo_uri: meta.logo_uri || "",
          banner_uri: meta.banner_uri || "",
        };
      });
      return json(res, 200, { ok: true, shops });
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
      const id = String(body.id || genId("p"));
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

    if (req.method === "GET" && p === "/key") {
      return json(res, 200, { ok: true, api_key: db.api_key });
    }

    // Debug snapshot (authenticated)
    if (req.method === "GET" && p === "/admin/stats") {
      return json(res, 200, {
        ok: true,
        merchants: Object.keys(db.merchants).length,
        products: db.products.length,
        orders: db.orders.length,
        db_file: DB_FILE,
      });
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
// Keep API key stable for apps
if (db0.api_key !== DEFAULT_API_KEY) {
  console.log("[WARN] db api_key differs from DEFAULT — apps use Config.API_KEY");
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("═══════════════════════════════════════════");
  console.log("  Nexora Server — persistent storage");
  console.log("  Local:    http://127.0.0.1:" + PORT);
  console.log("  DB file:  " + DB_FILE);
  console.log("  API KEY:  " + db0.api_key);
  console.log("═══════════════════════════════════════════");
  console.log("  Merchants:", Object.keys(db0.merchants).length);
  console.log("  Products: ", db0.products.length);
  console.log("  Orders:   ", db0.orders.length);
  console.log("");
});


