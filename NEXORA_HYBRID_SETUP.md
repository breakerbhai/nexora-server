# Nexora Hybrid (Node + Mongo + FCM)

Lock this architecture so you do not migrate platforms later.

## Stack
- **API + business logic:** Node `server.js` on Render
- **Database:** MongoDB (`MONGODB_URI`)
- **OTP SMS:** MessageCentral env vars
- **Push only:** Firebase Cloud Messaging via `firebase-admin`

## Render Environment
```
API_KEY=...
MONGODB_URI=...
MC_CUSTOMER_ID=...
MC_BASE64_KEY=...
FIREBASE_SERVICE_ACCOUNT_JSON={...entire service account json one line...}
```

## Firebase Console (once)
1. Create project
2. Add 3 Android apps (customer, merchant, delivery package names)
3. Download `google-services.json` into each app
4. Project Settings → Service accounts → Generate new private key
5. Paste JSON into Render env `FIREBASE_SERVICE_ACCOUNT_JSON`

## App Gradle (each Android app)
- classpath `com.google.gms:google-services`
- `apply plugin: 'com.google.gms.google-services'`
- dependencies: `firebase-bom`, `firebase-messaging`

## Register token after login
POST `/fcm/register`
```json
{
  "role": "customer",
  "phone": "9876543210",
  "token": "<FCM_TOKEN>",
  "shop_id": ""
}
```
Merchant: `"role":"merchant","shop_id":"<id>","phone":"...","token":"..."`

## What sends push today
- New order → merchant + customer keys
- Out for delivery / delivered / rejected (when status paths hit notify)

Without `FIREBASE_SERVICE_ACCOUNT_JSON`, API still works; push is skipped.

## Do not do
- Move all orders to Firestore only (unnecessary rewrite)
- Put payment verification only on the phone

