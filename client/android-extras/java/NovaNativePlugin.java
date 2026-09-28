package dev.concord.nova;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import androidx.core.app.ActivityCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

// JS bridge (client/src/lib/android.ts): background push service, call audio
// routing, battery exemption, and the intents MainActivity forwards — share
// target, invite links and notification taps. Events fired before the WebView
// subscribed are kept and handed over by getPending().
@CapacitorPlugin(name = "NovaNative")
public class NovaNativePlugin extends Plugin {
  private static final String TAG = "NovaNative";
  private static final long SHARE_LIMIT = 500L * 1024 * 1024;
  private static NovaNativePlugin instance;
  private static final Map<String, JSObject> pending = new HashMap<>();

  private PowerManager.WakeLock proximityLock;

  @Override
  public void load() {
    instance = this;
  }

  // ── intents ────────────────────────────────────────────────────────────────
  static void handleIntent(Context ctx, Intent intent) {
    String action = intent.getAction();
    if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
      JSObject share = readShare(ctx, intent);
      if (share != null) emit("share", share);
      return;
    }
    if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
      String code = inviteCode(intent.getData());
      if (code != null) {
        JSObject d = new JSObject();
        d.put("code", code);
        emit("invite", d);
      }
    }
    String channelId = intent.getStringExtra(PushService.EXTRA_CHANNEL);
    if (channelId != null && !channelId.isEmpty()) {
      JSObject d = new JSObject();
      d.put("channelId", channelId);
      d.put("accept", intent.getBooleanExtra(PushService.EXTRA_ACCEPT, false));
      // Consumed: a later configuration change must not replay the tap.
      intent.removeExtra(PushService.EXTRA_CHANNEL);
      intent.removeExtra(PushService.EXTRA_ACCEPT);
      if (d.getBoolean("accept", false)) PushService.cancelCall(ctx, channelId);
      emit("open", d);
    }
  }

  private static String inviteCode(Uri uri) {
    // https://<host>/invite/CODE  or  concord-nova://invite/CODE
    List<String> seg = uri.getPathSegments();
    if ("concord-nova".equals(uri.getScheme()) && "invite".equals(uri.getHost()) && !seg.isEmpty()) return seg.get(0);
    if (seg.size() >= 2 && "invite".equals(seg.get(0))) return seg.get(1);
    return null;
  }

  private static synchronized void emit(String event, JSObject data) {
    if (instance != null && instance.hasListeners(event)) instance.notifyListeners(event, data);
    else pending.put(event, data);
  }

  @PluginMethod
  public void getPending(PluginCall call) {
    JSObject out = new JSObject();
    synchronized (NovaNativePlugin.class) {
      for (Map.Entry<String, JSObject> e : pending.entrySet()) {
        out.put("open".equals(e.getKey()) ? "channel" : e.getKey(), e.getValue());
      }
      pending.clear();
    }
    call.resolve(out);
  }

  /**
   * Shared files are copied into the app cache and handed to JS as paths that
   * the WebView fetches through Capacitor's local file server — no base64 over
   * the bridge, so large videos work too.
   */
  private static JSObject readShare(Context ctx, Intent intent) {
    try {
      List<Uri> uris = new ArrayList<>();
      if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
        ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (list != null) uris.addAll(list);
      } else {
        Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (u != null) uris.add(u);
      }
      JSObject data = new JSObject();
      String text = intent.getStringExtra(Intent.EXTRA_TEXT);
      if (text != null && !text.isEmpty()) data.put("text", text);

      File dir = new File(ctx.getCacheDir(), "shared");
      if (!dir.exists() && !dir.mkdirs()) return null;
      File[] old = dir.listFiles();
      if (old != null) for (File f : old) f.delete();

      JSArray files = new JSArray();
      int i = 0;
      for (Uri uri : uris) {
        String name = displayName(ctx, uri);
        if (name == null) name = "shared-" + System.currentTimeMillis() + "-" + i;
        File out = new File(dir, (i++) + "-" + name.replaceAll("[\\\\/:*?\"<>|]", "_"));
        long total = 0;
        try (InputStream in = ctx.getContentResolver().openInputStream(uri);
            OutputStream os = new FileOutputStream(out)) {
          if (in == null) continue;
          byte[] buf = new byte[64 * 1024];
          int n;
          while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > SHARE_LIMIT) break;
            os.write(buf, 0, n);
          }
        }
        if (total > SHARE_LIMIT) {
          out.delete();
          continue;
        }
        String mime = ctx.getContentResolver().getType(uri);
        JSObject f = new JSObject();
        f.put("path", out.getAbsolutePath());
        f.put("name", name);
        f.put("mimeType", mime != null ? mime : intent.getType() != null ? intent.getType() : "application/octet-stream");
        files.put(f);
      }
      if (files.length() > 0) data.put("files", files);
      return data.length() > 0 ? data : null;
    } catch (Exception e) {
      Log.w(TAG, "share failed: " + e);
      return null;
    }
  }

  private static String displayName(Context ctx, Uri uri) {
    try (Cursor c = ctx.getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (c != null && c.moveToFirst()) return c.getString(0);
    } catch (Exception ignored) {
    }
    return uri.getLastPathSegment();
  }

  // ── push service ───────────────────────────────────────────────────────────
  @PluginMethod
  public void startPush(PluginCall call) {
    String url = call.getString("url");
    String token = call.getString("token");
    if (url == null || token == null) {
      call.reject("url and token are required");
      return;
    }
    prefs(getContext()).edit().putString("url", url).putString("token", token).apply();
    if (Build.VERSION.SDK_INT >= 33
        && getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        && getActivity() != null) {
      ActivityCompat.requestPermissions(getActivity(), new String[] {Manifest.permission.POST_NOTIFICATIONS}, 9911);
    }
    PushService.start(getContext());
    call.resolve();
  }

  @PluginMethod
  public void stopPush(PluginCall call) {
    prefs(getContext()).edit().clear().apply();
    PushService.stop(getContext());
    NotificationManager nm = getContext().getSystemService(NotificationManager.class);
    if (nm != null) nm.cancelAll();
    call.resolve();
  }

  static SharedPreferences prefs(Context ctx) {
    return ctx.getSharedPreferences(PushService.PREFS, Context.MODE_PRIVATE);
  }

  /** Asks once to exclude the app from battery optimization (keeps the push link alive). */
  @PluginMethod
  public void batteryExempt(PluginCall call) {
    JSObject r = new JSObject();
    if (Build.VERSION.SDK_INT < 23) {
      r.put("granted", true);
      call.resolve(r);
      return;
    }
    PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
    boolean ok = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    if (!ok && Boolean.TRUE.equals(call.getBoolean("prompt", false))) {
      try {
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
      } catch (Exception e) {
        Log.w(TAG, "battery prompt: " + e);
      }
    }
    r.put("granted", ok);
    call.resolve(r);
  }

  // ── call audio ─────────────────────────────────────────────────────────────
  @PluginMethod
  public void setSpeakerphone(PluginCall call) {
    boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
    AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    try {
      am.setMode(AudioManager.MODE_IN_COMMUNICATION);
      if (Build.VERSION.SDK_INT >= 31) {
        if (on) {
          for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
            if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
              am.setCommunicationDevice(d);
              break;
            }
          }
        } else {
          am.clearCommunicationDevice();
        }
      } else {
        am.setSpeakerphoneOn(on);
      }
    } catch (Exception e) {
      Log.w(TAG, "speakerphone: " + e);
    }
    call.resolve();
  }

  /** Screen blanks when the phone is at the ear during a call. */
  @PluginMethod
  public void setProximity(PluginCall call) {
    boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
    PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
    try {
      if (on) {
        if (proximityLock == null && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
          proximityLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "nova:call");
        }
        if (proximityLock != null && !proximityLock.isHeld()) proximityLock.acquire(3 * 60 * 60 * 1000L);
      } else if (proximityLock != null && proximityLock.isHeld()) {
        proximityLock.release();
      }
    } catch (Exception e) {
      Log.w(TAG, "proximity: " + e);
    }
    call.resolve();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  // While visible the in-app UI announces events, so the service stays quiet;
  // opening the app clears delivered message notifications.
  @Override
  protected void handleOnResume() {
    PushService.appInForeground = true;
    PushService.clearConversations();
    try {
      NotificationManager nm = getContext().getSystemService(NotificationManager.class);
      for (StatusBarNotification sbn : nm.getActiveNotifications()) {
        if (sbn.getId() != PushService.SERVICE_NOTIF_ID && sbn.getId() != ScreenCapService.NOTIF_ID) nm.cancel(sbn.getId());
      }
    } catch (Exception ignored) {
    }
    // Self-heal: the system may have killed the service while we were away.
    if (prefs(getContext()).getString("token", null) != null) PushService.start(getContext());
  }

  @Override
  protected void handleOnPause() {
    PushService.appInForeground = false;
  }
}
