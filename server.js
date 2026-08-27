/**
 * Nexora API Server — MongoDB Atlas persistent storage
 * Same routes/behavior as the old db.json version, but data survives restarts/deploys.
 *
 * ENV required:
 *   MONGODB_URI = mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/nexora?retryWrites=true&w=majority
 *   PORT        = (optional, Render sets this automatically)
 *
 * Run:  node server.js
 * Or:   npm start
 */

const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const { MongoClient } = require("mongodb");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const MONGODB_URI = process.env.MONGODB_URI || "";

// Fixed key so apps' Config.java keep working (change later if needed)
const DEFAULT_API_KEY = process.env.API_KEY || "TTRHsRQivU8HkpF2X5wHdqKw8-10TSpQ";

if (!MONGODB_URI) {
  console.error("[FATAL] MONGODB_URI env var is not set. Set it on Render → Environment.");
  process.exit(1);
}

let client;
let db; // mongo database handle
let merchants, products, orders, otps, shopMeta;

async function connectDb() {
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(); // uses db name from URI (nexora)
  merchants = db.collection("merchants"); // _id = phone
  products = db.collection("products");   // _id = product id (string)
  orders = db.collection("orders");       // _id = order_id (string)
  otps = db.collection("otps");           // _id = phone
  shopMeta = db.collection("shop_meta");  // _id = shop_id

  // Helpful indexes (safe to call every boot — no-ops if they already exist)
  await products.createIndex({ shop_id: 1 });
  await orders.createIndex({ shop_id: 1 });
  await orders.createIndex({ placed_at: -1 });

  console.log("[DB] Mongo connected →", db.databaseName);
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

function checkApiKey(req) {
  const key = req.headers["x-api-key"] || "";
  return key && key === DEFAULT_API_KEY;
}

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function getShopMeta(shopId) {
  let meta = await shopMeta.findOne({ _id: shopId });
  if (!meta) {
    meta = { _id: shopId, logo_uri: "", banner_uri: "", rating: 0, rating_count: 0 };
    await shopMeta.insertOne(meta);
  }
  return meta;
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

  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname.replace(/\/+$/, "") || "/";

  try {
    if (req.method === "GET" && (p === "/" || p === "/health")) {
      const [mCount, oCount, prCount] = await Promise.all([
        merchants.countDocuments(),
        orders.countDocuments(),
        products.countDocuments(),
      ]);
      return json(res, 200, {
        ok: true,
        service: "nexora-server",
        storage: "mongodb",
        merchants: mCount,
        orders: oCount,
        products: prCount,
      });
    }

    if (!checkApiKey(req)) {
      return json(res, 401, { ok: false, error: "Invalid or missing X-API-Key" });
    }

    // ----- OTP -----
    if (req.method === "POST" && p === "/send-otp") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      if (phone.length < 10) return json(res, 400, { ok: false, error: "Valid phone required" });
      const code = genOtp();
      await otps.updateOne(
        { _id: phone },
        { $set: { code, expires: Date.now() + 5 * 60 * 1000 } },
        { upsert: true }
      );
      console.log(`[OTP] ${phone} → ${code}`);
      return json(res, 200, { ok: true, message: "OTP sent", otp_dev: code });
    }

    if (req.method === "POST" && p === "/verify-otp") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      const otp = String(body.otp || "").trim();
      const rec = await otps.findOne({ _id: phone });
      if (!rec) return json(res, 400, { ok: false, error: "No OTP requested for this phone" });
      if (Date.now() > rec.expires) {
        await otps.deleteOne({ _id: phone });
        return json(res, 400, { ok: false, error: "OTP expired" });
      }
      if (rec.code !== otp) return json(res, 400, { ok: false, error: "Wrong OTP" });
      await otps.deleteOne({ _id: phone });
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

      const existing = await merchants.findOne({ _id: phone });
      if (existing) {
        return json(res, 400, { ok: false, error: "This phone is already registered. Sign in instead." });
      }
      const shop_id = genId("shop_");
      await merchants.insertOne({
        _id: phone,
        pin,
        shop_id,
        shop_name,
        category,
        location,
        created_at: Date.now(),
      });
      await getShopMeta(shop_id);
      console.log(`[MERCHANT] registered ${phone} → ${shop_name} (${shop_id})`);
      return json(res, 200, { ok: true, shop_id, shop_name, category, location });
    }

    if (req.method === "POST" && p === "/merchant/login") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      const pin = String(body.pin || "").trim();
      const m = await merchants.findOne({ _id: phone });
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

      const found = await merchants.findOne({ shop_id });
      if (!found) return json(res, 404, { ok: false, error: "Shop not found" });

      const update = {};
      if (body.shop_name != null) update.shop_name = String(body.shop_name).trim();
      if (body.category != null) update.category = String(body.category).trim();
      if (body.location != null) update.location = String(body.location).trim();
      if (Object.keys(update).length) {
        await merchants.updateOne({ shop_id }, { $set: update });
      }

      const metaUpdate = {};
      if (body.logo_uri != null) metaUpdate.logo_uri = String(body.logo_uri);
      if (body.banner_uri != null) metaUpdate.banner_uri = String(body.banner_uri);
      await getShopMeta(shop_id); // ensure exists
      if (Object.keys(metaUpdate).length) {
        await shopMeta.updateOne({ _id: shop_id }, { $set: metaUpdate });
      }

      const finalMerchant = await merchants.findOne({ shop_id });
      const finalMeta = await shopMeta.findOne({ _id: shop_id });

      return json(res, 200, {
        ok: true,
        shop_id,
        shop_name: finalMerchant.shop_name,
        category: finalMerchant.category,
        location: finalMerchant.location,
        logo_uri: finalMeta.logo_uri || "",
        banner_uri: finalMeta.banner_uri || "",
      });
    }

    // ----- Orders -----
    if (req.method === "POST" && p === "/orders") {
      const body = await readBody(req);
      const order_id = body.order_id || genId("NX");
      const order = {
        _id: order_id,
        order_id,
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
        const m = await merchants.findOne({ shop_name: order.shop_name });
        if (m) order.shop_id = m.shop_id;
      }
      await orders.insertOne(order);
      console.log(`[ORDER] ${order.order_id} ${order.customer_name} ₹${order.total}`);
      return json(res, 200, { ok: true, order_id: order.order_id });
    }

    if (req.method === "GET" && p === "/orders") {
      const shopId = u.searchParams.get("shop_id");
      const query = shopId ? { shop_id: shopId } : {};
      const list = await orders.find(query).sort({ placed_at: -1 }).toArray();
      list.forEach((o) => delete o._id);
      return json(res, 200, { ok: true, orders: list });
    }

    if (req.method === "POST" && p === "/orders/status") {
      const body = await readBody(req);
      const orderId = String(body.order_id || "");
      const status = Number(body.status);
      const result = await orders.updateOne(
        { order_id: orderId },
        { $set: { status, status_label: body.status_label || "" } }
      );
      if (result.matchedCount === 0) return json(res, 404, { ok: false, error: "Order not found" });
      return json(res, 200, { ok: true, order_id: orderId, status });
    }

    // ----- Shops (from merchants + meta) -----
    if (req.method === "GET" && p === "/shops") {
      const all = await merchants.find({}).toArray();
      const shops = await Promise.all(
        all.map(async (m) => {
          const meta = await getShopMeta(m.shop_id);
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
        })
      );
      return json(res, 200, { ok: true, shops });
    }

    // ----- Products -----
    if (req.method === "GET" && p === "/products") {
      const shopId = u.searchParams.get("shop_id");
      const query = shopId ? { shop_id: shopId } : {};
      const list = await products.find(query).toArray();
      list.forEach((pr) => delete pr._id);
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
      await products.updateOne({ id }, { $set: prod, $setOnInsert: { _id: id } }, { upsert: true });
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
      const query = shop_id ? { id, shop_id } : { id };
      const result = await products.deleteOne(query);
      if (result.deletedCount === 0) {
        return json(res, 404, { ok: false, error: "Product not found" });
      }
      console.log(`[PRODUCT] deleted ${id}`);
      return json(res, 200, { ok: true, deleted: id });
    }

    if (req.method === "GET" && p === "/key") {
      return json(res, 200, { ok: true, api_key: DEFAULT_API_KEY });
    }

    // Debug snapshot (authenticated)
    if (req.method === "GET" && p === "/admin/stats") {
      const [mCount, prCount, oCount] = await Promise.all([
        merchants.countDocuments(),
        products.countDocuments(),
        orders.countDocuments(),
      ]);
      return json(res, 200, {
        ok: true,
        merchants: mCount,
        products: prCount,
        orders: oCount,
        db: db.databaseName,
      });
    }

    return json(res, 404, { ok: false, error: "Not found: " + p });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e.message || "Server error" });
  }
});

connectDb()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log("");
      console.log("═══════════════════════════════════════════");
      console.log("  Nexora Server — MongoDB Atlas storage");
      console.log("  Local:    http://127.0.0.1:" + PORT);
      console.log("  API KEY:  " + DEFAULT_API_KEY);
      console.log("═══════════════════════════════════════════");
      console.log("");
    });
  })
  .catch((e) => {
    console.error("[FATAL] Mongo connect failed:", e.message);
    process.exit(1);
  });
