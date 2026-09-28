package dev.concord.nova;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import android.util.LruCache;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import org.json.JSONObject;

// Self-hosted push without Google FCM: a foreground service holding one SSE
// stream to the Nova server (/api/push/stream). DMs, mentions and incoming
// calls become system notifications even while the WebView is frozen or the
// app is closed.
//  • reconnects immediately when the default network changes (Wi-Fi ⇄ mobile)
//    instead of waiting for a dead socket to time out;
//  • conversation-style notifications (MessagingStyle) with sender avatars;
//  • incoming calls ring with a full-screen intent and Answer/Decline actions,
//    and are withdrawn as soon as the server says the call ended.
public class PushService extends Service {
  private static final String TAG = "NovaPush";
  static final String PREFS = "nova-push";
  static final String EXTRA_CHANNEL = "nova.channelId";
  static final String EXTRA_ACCEPT = "nova.accept";
  static final String EXTRA_CALL = "nova.call";
  static final int SERVICE_NOTIF_ID = 1;

  private static final String CH_SERVICE = "service";
  private static final String CH_DM = "dm";
  private static final String CH_MENTIONS = "mentions";
  private static final String CH_MESSAGES = "messages";
  private static final String CH_CALLS = "calls-v2";

  /** Set by NovaNativePlugin on resume/pause: the in-app UI covers visible sessions. */
  static volatile boolean appInForeground = false;

  private static final Map<String, Deque<NotificationCompat.MessagingStyle.Message>> conversations = new HashMap<>();
  private static final LruCache<String, Bitmap> avatars = new LruCache<>(48);

  private volatile boolean running = false;
  private volatile HttpURLConnection current;
  private volatile Network lastNetwork;
  private final Object wake = new Object();
  private boolean kicked = false;
  private Thread worker;
  private ConnectivityManager.NetworkCallback netCallback;

  static void start(Context ctx) {
    Intent i = new Intent(ctx, PushService.class);
    try {
      if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
      else ctx.startService(i);
    } catch (Exception e) {
      // Background-start restrictions (Android 12+): the next app open retries.
      Log.w(TAG, "start refused: " + e);
    }
  }

  static void stop(Context ctx) {
    ctx.stopService(new Intent(ctx, PushService.class));
  }

  static synchronized void clearConversations() {
    conversations.clear();
  }

  static int notifId(String channelId) {
    return 1000 + (channelId.hashCode() & 0x7fffffff) % 100_000;
  }

  static int callNotifId(String channelId) {
    return 200_000 + (channelId.hashCode() & 0x7fffffff) % 100_000;
  }

  static void cancelCall(Context ctx, String channelId) {
    NotificationManager nm = ctx.getSystemService(NotificationManager.class);
    if (nm != null) nm.cancel(callNotifId(channelId));
  }

  @Override
  public void onCreate() {
    super.onCreate();
    createChannels();
    ConnectivityManager cm = getSystemService(ConnectivityManager.class);
    if (cm != null && Build.VERSION.SDK_INT >= 24) {
      netCallback =
          new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
              Network prev = lastNetwork;
              lastNetwork = network;
              if (prev != null && !prev.equals(network)) reconnectNow();
              else kick();
            }
          };
      try {
        cm.registerDefaultNetworkCallback(netCallback);
      } catch (Exception e) {
        netCallback = null;
      }
    }
  }

  private void createChannels() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    NotificationChannel svc = new NotificationChannel(CH_SERVICE, "Фоновое подключение", NotificationManager.IMPORTANCE_MIN);
    svc.setShowBadge(false);
    svc.setDescription("Держит связь с сервером, чтобы уведомления приходили вовремя");
    nm.createNotificationChannel(svc);

    NotificationChannel dm = new NotificationChannel(CH_DM, "Личные сообщения", NotificationManager.IMPORTANCE_HIGH);
    dm.enableVibration(true);
    dm.enableLights(true);
    dm.setLightColor(Color.rgb(255, 195, 92));
    nm.createNotificationChannel(dm);

    NotificationChannel mentions = new NotificationChannel(CH_MENTIONS, "Упоминания", NotificationManager.IMPORTANCE_HIGH);
    mentions.enableVibration(true);
    nm.createNotificationChannel(mentions);

    NotificationChannel messages = new NotificationChannel(CH_MESSAGES, "Сообщения на серверах", NotificationManager.IMPORTANCE_DEFAULT);
    nm.createNotificationChannel(messages);

    NotificationChannel calls = new NotificationChannel(CH_CALLS, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH);
    calls.enableVibration(true);
    calls.setVibrationPattern(new long[] {0, 800, 600, 800, 600, 800});
    calls.setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
        new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
    calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    nm.createNotificationChannel(calls);
    nm.deleteNotificationChannel("calls"); // pre-release channel without a ringtone
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    Notification notif =
        new NotificationCompat.Builder(this, CH_SERVICE)
            .setContentTitle("Concord Nova")
            .setContentText("На связи — уведомления придут сразу")
            .setSmallIcon(R.drawable.ic_stat_nova)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(openIntent(null, false, false))
            .build();
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        startForeground(SERVICE_NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
      } else if (Build.VERSION.SDK_INT >= 29) {
        startForeground(SERVICE_NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
      } else {
        startForeground(SERVICE_NOTIF_ID, notif);
      }
    } catch (Exception e) {
      Log.w(TAG, "startForeground failed: " + e);
      stopSelf();
      return START_NOT_STICKY;
    }

    if (worker == null || !worker.isAlive()) {
      running = true;
      worker = new Thread(this::streamLoop, "nova-push");
      worker.setDaemon(true);
      worker.start();
    } else {
      kick();
    }
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    running = false;
    ConnectivityManager cm = getSystemService(ConnectivityManager.class);
    if (cm != null && netCallback != null) {
      try {
        cm.unregisterNetworkCallback(netCallback);
      } catch (Exception ignored) {
      }
    }
    reconnectNow();
    if (worker != null) worker.interrupt();
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  // ── connection ─────────────────────────────────────────────────────────────
  /** Wake the loop if it's sleeping in backoff. */
  private void kick() {
    synchronized (wake) {
      kicked = true;
      wake.notifyAll();
    }
  }

  /** Drop the current socket (bound to a network that's gone) and reconnect. */
  private void reconnectNow() {
    HttpURLConnection c = current;
    if (c != null) {
      new Thread(c::disconnect, "nova-push-drop").start();
    }
    kick();
  }

  private void streamLoop() {
    long backoff = 2_000;
    while (running) {
      SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
      String base = prefs.getString("url", null);
      String token = prefs.getString("token", null);
      if (base == null || token == null) {
        stopSelf();
        return;
      }
      boolean connected = false;
      HttpURLConnection conn = null;
      try {
        URL url = new URL(base + "/api/push/stream?token=" + URLEncoder.encode(token, "UTF-8"));
        conn = (HttpURLConnection) url.openConnection();
        current = conn;
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(70_000); // server pings every 25s
        conn.setRequestProperty("Accept", "text/event-stream");
        conn.setRequestProperty("User-Agent", "ConcordNova-Android-Push");
        int status = conn.getResponseCode();
        if (status == 401) {
          // Session revoked (logout elsewhere): stop until the next app open.
          prefs.edit().remove("token").apply();
          stopSelf();
          return;
        }
        if (status != 200) throw new java.io.IOException("HTTP " + status);
        connected = true;
        backoff = 2_000;
        BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
        StringBuilder data = new StringBuilder();
        String line;
        while (running && (line = reader.readLine()) != null) {
          if (line.isEmpty()) {
            if (data.length() > 0) handleEvent(base, data.toString());
            data.setLength(0);
          } else if (line.startsWith("data:")) {
            if (data.length() > 0) data.append('\n');
            data.append(line.substring(5).trim());
          }
        }
      } catch (Exception e) {
        Log.w(TAG, "stream: " + e);
      } finally {
        current = null;
        if (conn != null) conn.disconnect();
      }
      if (!running) return;
      // A link that worked and then dropped retries almost at once; failures back off with jitter.
      long wait = connected ? 1_000 : backoff + ThreadLocalRandom.current().nextLong(backoff / 2 + 1);
      if (!connected) backoff = Math.min(backoff * 2, 120_000);
      synchronized (wake) {
        if (!kicked) {
          try {
            wake.wait(wait);
          } catch (InterruptedException ie) {
            return;
          }
        }
        kicked = false;
      }
    }
  }

  // ── events ─────────────────────────────────────────────────────────────────
  private void handleEvent(String base, String json) {
    try {
      JSONObject o = new JSONObject(json);
      String type = o.optString("type", "dm");
      String channelId = o.optString("channelId", "");
      if (channelId.isEmpty()) return;
      if ("call_end".equals(type)) {
        cancelCall(this, channelId);
        return;
      }
      if (appInForeground) return;
      Bitmap avatar = loadAvatar(base, o.optString("icon", ""));
      if ("call".equals(type)) showCall(o, channelId, avatar);
      else showMessage(o, type, channelId, avatar);
    } catch (Exception e) {
      Log.w(TAG, "bad event: " + e);
    }
  }

  private void showMessage(JSONObject o, String type, String channelId, Bitmap avatar) {
    String sender = o.optString("sender", o.optString("title", "Concord Nova"));
    String body = o.optString("body", "");
    String conversation = o.optString("conversation", "");
    boolean group = o.optBoolean("group", false);

    Person.Builder pb = new Person.Builder().setName(sender).setKey(o.optString("authorId", sender));
    if (avatar != null) pb.setIcon(IconCompat.createWithBitmap(avatar));
    Person person = pb.build();
    Person me = new Person.Builder().setName("Вы").build();

    NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
    synchronized (PushService.class) {
      Deque<NotificationCompat.MessagingStyle.Message> q = conversations.get(channelId);
      if (q == null) conversations.put(channelId, q = new ArrayDeque<>());
      q.addLast(new NotificationCompat.MessagingStyle.Message(body, System.currentTimeMillis(), person));
      while (q.size() > 7) q.removeFirst();
      for (NotificationCompat.MessagingStyle.Message m : q) style.addMessage(m);
    }
    if (group || !conversation.isEmpty()) {
      style.setGroupConversation(group);
      if (!conversation.isEmpty()) style.setConversationTitle(conversation);
    }

    String ch = "dm".equals(type) ? CH_DM : "mention".equals(type) ? CH_MENTIONS : CH_MESSAGES;
    NotificationCompat.Builder b =
        new NotificationCompat.Builder(this, ch)
            .setSmallIcon(R.drawable.ic_stat_nova)
            .setColor(Color.rgb(255, 170, 80))
            .setStyle(style)
            .setContentTitle(conversation.isEmpty() ? sender : conversation)
            .setContentText(body)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setPriority("message".equals(type) ? NotificationCompat.PRIORITY_DEFAULT : NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(openIntent(channelId, false, false));
    if (avatar != null) b.setLargeIcon(avatar);
    getSystemService(NotificationManager.class).notify(notifId(channelId), b.build());
  }

  private void showCall(JSONObject o, String channelId, Bitmap avatar) {
    String caller = o.optString("title", "Concord Nova");
    Person.Builder pb = new Person.Builder().setName(caller).setImportant(true);
    if (avatar != null) pb.setIcon(IconCompat.createWithBitmap(avatar));
    Person person = pb.build();

    PendingIntent full = openIntent(channelId, false, true);
    PendingIntent answer = openIntent(channelId, true, true);
    Intent dec = new Intent(this, CallActionReceiver.class).setAction(CallActionReceiver.ACTION_DECLINE).putExtra(EXTRA_CHANNEL, channelId);
    PendingIntent decline =
        PendingIntent.getBroadcast(this, channelId.hashCode(), dec, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    NotificationCompat.Builder b =
        new NotificationCompat.Builder(this, CH_CALLS)
            .setSmallIcon(R.drawable.ic_stat_nova)
            .setColor(Color.rgb(255, 170, 80))
            .setContentTitle(caller)
            .setContentText(o.optString("body", "Входящий звонок"))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(45_000)
            .setContentIntent(full)
            .setFullScreenIntent(full, true);
    if (avatar != null) b.setLargeIcon(avatar);

    NotificationManager nm = getSystemService(NotificationManager.class);
    try {
      b.setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer));
      nm.notify(callNotifId(channelId), b.build());
    } catch (Exception e) {
      // CallStyle is strict about its preconditions on some builds — fall back to plain actions.
      b.setStyle(null)
          .addAction(0, "Отклонить", decline)
          .addAction(0, "Ответить", answer);
      nm.notify(callNotifId(channelId), b.build());
    }
  }

  private PendingIntent openIntent(String channelId, boolean accept, boolean call) {
    Intent i = new Intent(this, MainActivity.class);
    i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    if (channelId != null) i.putExtra(EXTRA_CHANNEL, channelId);
    if (accept) i.putExtra(EXTRA_ACCEPT, true);
    if (call) i.putExtra(EXTRA_CALL, true);
    int req = channelId == null ? 0 : (channelId.hashCode() * 4) + (accept ? 1 : 0) + (call ? 2 : 0);
    return PendingIntent.getActivity(this, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  // ── avatars ────────────────────────────────────────────────────────────────
  private Bitmap loadAvatar(String base, String icon) {
    if (icon == null || icon.isEmpty() || "null".equals(icon)) return null;
    String url = icon.startsWith("http") ? icon : base + (icon.startsWith("/") ? icon : "/" + icon);
    if (url.contains("/files/")) url += (url.contains("?") ? "&" : "?") + "w=128";
    Bitmap cached = avatars.get(url);
    if (cached != null) return cached;
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(4_000);
      c.setReadTimeout(4_000);
      if (c.getResponseCode() != 200) return null;
      try (InputStream in = c.getInputStream()) {
        Bitmap src = BitmapFactory.decodeStream(in);
        if (src == null) return null;
        Bitmap round = circle(src);
        avatars.put(url, round);
        return round;
      }
    } catch (Exception e) {
      return null;
    } finally {
      if (c != null) c.disconnect();
    }
  }

  private static Bitmap circle(Bitmap src) {
    int size = Math.min(src.getWidth(), src.getHeight());
    Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(out);
    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint);
    paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
    int dx = (src.getWidth() - size) / 2;
    int dy = (src.getHeight() - size) / 2;
    canvas.drawBitmap(src, new Rect(dx, dy, dx + size, dy + size), new Rect(0, 0, size, size), paint);
    return out;
  }
}
