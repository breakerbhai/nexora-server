package com.breakerbhai.nexora;

/**
 * Call after login when Firebase Messaging is added to the app.
 * Without Firebase deps this file is reference-only — copy methods into app after gradle setup.
 *
 * FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
 *   FcmRegister.send(context, "customer", phone, "", token);
 * });
 */
public class FcmRegister {
    public static void send(android.content.Context ctx, String role, String phone,
                            String shopId, String token) {
        new Thread(() -> {
            try {
                org.json.JSONObject body = new org.json.JSONObject();
                body.put("role", role);
                body.put("phone", phone);
                body.put("shop_id", shopId != null ? shopId : "");
                body.put("token", token);
                java.net.URL url = new java.net.URL(Config.API_BASE_URL + "/fcm/register");
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) url.openConnection();
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setRequestProperty("X-API-Key", Config.API_KEY);
                byte[] bytes = body.toString().getBytes("UTF-8");
                c.getOutputStream().write(bytes);
                int code = c.getResponseCode();
                android.util.Log.i("FcmRegister", "register HTTP " + code);
            } catch (Exception e) {
                android.util.Log.e("FcmRegister", "fail", e);
            }
        }).start();
    }
}
