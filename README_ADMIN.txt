ADMIN_SECRET=258000 required on Render

DELIVERY DISTANCE CONFIG
Set XOFROW_BASE_LAT and XOFROW_BASE_LNG on the server to the XOFROW delivery hub/base coordinates.
Distance pricing is server-controlled: <=2 km ₹25, <=5 km ₹30, <=8 km ₹40. If coordinates are unavailable, DELIVERY_FEE is used as fallback.
FREE_DELIVERY_ABOVE defaults to 0 (disabled); set it explicitly if you later want free delivery above a threshold.

CUSTOMER OFFERS
Offers are stored server-side and can be changed by the Admin app without a customer APK update.
Default first-order coupon: FIRST10, 10% OFF, eligible when the order subtotal is <= ₹1,500, limited to the first 1,000 qualifying uses and only for a phone number with no previous order.
