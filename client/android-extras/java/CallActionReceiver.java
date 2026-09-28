package dev.concord.nova;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

// "Decline" on the incoming-call notification: withdraw it right away and tell
// the server (with the push token — the WebView may not be running) so the
// caller stops ringing us.
public class CallActionReceiver extends BroadcastReceiver {
  static final String ACTION_DECLINE = "dev.concord.nova.DECLINE_CALL";

  @Override
  public void onReceive(Context context, Intent intent) {
    if (!ACTION_DECLINE.equals(intent.getAction())) return;
    String channelId = intent.getStringExtra(PushService.EXTRA_CHANNEL);
    if (channelId == null) return;
    PushService.cancelCall(context, channelId);

    SharedPreferences prefs = context.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE);
    String base = prefs.getString("url", null);
    String token = prefs.getString("token", null);
    if (base == null || token == null) return;

    PendingResult result = goAsync();
    new Thread(
            () -> {
              HttpURLConnection c = null;
              try {
                c = (HttpURLConnection) new URL(base + "/api/push/decline").openConnection();
                c.setConnectTimeout(8_000);
                c.setReadTimeout(8_000);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                JSONObject body = new JSONObject().put("token", token).put("channelId", channelId);
                try (OutputStream os = c.getOutputStream()) {
                  os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                c.getResponseCode();
              } catch (Exception e) {
                Log.w("NovaPush", "decline: " + e);
              } finally {
                if (c != null) c.disconnect();
                result.finish();
              }
            },
            "nova-decline")
        .start();
  }
}
