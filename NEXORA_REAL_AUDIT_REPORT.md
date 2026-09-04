# Nexora Real Audit Report (source-verified)
Date: 2026-09-03

## Why it felt like "same old files"
1. Fixes were incremental — sometimes only one Java file changed while you still held an old extract on the phone.
2. "Audit version" was oversold: compile fixes ≠ Flipkart-level product.
3. UX bugs (shop named "Shop", no photos, 0.0 rating) often come from **server data / merchant profile fields**, not missing screens.

## Compile / resource audit (this workspace)

### Customer (`Nexora_Customer_FINAL`)
- XML: OK
- R.id mismatches: none found
- ProductAdapter uses ivProductThumb (matches layout)
- OrderDetail uses tvShopName / tvCustomerLine
- Config: https://nexora-server-d2nx.onrender.com

### Merchant (`Nexora_Merchant_FIXED_v3` / FINAL)
- STATUS_READY = 100 present in model
- OrdersActivity Ready filter = Packed + Out for delivery
- Config: same server URL
- Manifest icon: mipmap (drawable conflict previously fixed)

### Delivery
- Fixed: ScanActivity used android.R.id.text1 → now R.id.tvCourier
- Config: same server URL
- Flow: Login → Scan/Gallery/Code → Lookup → Result (call/map/OTP)

### Admin
- PIN local + ADMIN_SECRET for platform kill + money APIs (needs server redeploy)
- Config: same server URL

### Server
- Hybrid FCM optional
- /platform/status, /admin/platform, /admin/money
- Delivery fee on order create
- Mongo when MONGODB_URI set

## Still NOT Flipkart (honest)
- No real coupon engine
- No FCM until Firebase service account on Render
- No payment gateway
- Images depend on merchant upload + base64/URL load
- Shop title "Shop" = merchant registered with empty/default name on server
- Rating 0.0 = no real rating aggregate from server yet

## Build rule (important)
Always DELETE old project folder completely, then extract the new zip.
Mixing old + new files causes the same errors again.
