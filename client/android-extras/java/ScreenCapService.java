package dev.concord.nova;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;
import androidx.core.app.NotificationCompat;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

// Foreground service (mediaProjection type): mirrors the screen into an
// ImageReader and forwards throttled, downscaled JPEG frames to the WebView.
// Follows rotation by resizing the virtual display instead of restarting.
public class ScreenCapService extends Service {
  private static final String TAG = "NovaScreen";
  private static final String CHANNEL = "screen";
  static final int NOTIF_ID = 3;

  private MediaProjection projection;
  private VirtualDisplay display;
  private ImageReader reader;
  private HandlerThread thread;
  private Handler handler;
  private int maxDim = 1280;
  private long minFrameMs = 80;
  private int quality = 60;
  private int width, height, dpi;
  private long lastFrameAt = 0;
  private final ByteArrayOutputStream jpeg = new ByteArrayOutputStream(256 * 1024);

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Демонстрация экрана", NotificationManager.IMPORTANCE_LOW));
    }
    Notification notif =
        new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Concord Nova")
            .setContentText("Идёт демонстрация экрана")
            .setSmallIcon(R.drawable.ic_stat_nova)
            .setOngoing(true)
            .build();
    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
    else startForeground(NOTIF_ID, notif);

    if (intent == null || projection != null) return START_NOT_STICKY;
    Intent data = intent.getParcelableExtra("data");
    if (data == null) {
      stopSelf();
      return START_NOT_STICKY;
    }
    maxDim = Math.max(320, Math.min(1920, intent.getIntExtra("maxDim", 1280)));
    minFrameMs = 1000L / Math.max(1, Math.min(30, intent.getIntExtra("fps", 12)));
    quality = Math.max(20, Math.min(90, intent.getIntExtra("quality", 60)));

    MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
    projection = mpm.getMediaProjection(intent.getIntExtra("resultCode", 0), data);
    if (projection == null) {
      stopSelf();
      return START_NOT_STICKY;
    }
    thread = new HandlerThread("nova-screen");
    thread.start();
    handler = new Handler(thread.getLooper());
    // Android 14+ requires the callback before the first virtual display.
    projection.registerCallback(
        new MediaProjection.Callback() {
          @Override
          public void onStop() {
            stopSelf();
          }
        },
        handler);

    measure();
    reader = newReader();
    display =
        projection.createVirtualDisplay(
            "nova-screen", width, height, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
    return START_NOT_STICKY;
  }

  private void measure() {
    DisplayMetrics dm = new DisplayMetrics();
    ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(dm);
    float scale = Math.min(1f, (float) maxDim / Math.max(dm.widthPixels, dm.heightPixels));
    width = Math.max(2, (int) (dm.widthPixels * scale) / 2 * 2);
    height = Math.max(2, (int) (dm.heightPixels * scale) / 2 * 2);
    dpi = dm.densityDpi;
  }

  private ImageReader newReader() {
    ImageReader r = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
    final int w = width, h = height;
    r.setOnImageAvailableListener(rd -> onImage(rd, w, h), handler);
    return r;
  }

  private void onImage(ImageReader r, int w, int h) {
    Image img = null;
    try {
      img = r.acquireLatestImage();
      if (img == null) return;
      long now = System.currentTimeMillis();
      if (now - lastFrameAt < minFrameMs) return;
      lastFrameAt = now;
      Image.Plane plane = img.getPlanes()[0];
      ByteBuffer buf = plane.getBuffer();
      int pixelStride = plane.getPixelStride();
      int rowPadding = plane.getRowStride() - pixelStride * w;
      Bitmap bmp = Bitmap.createBitmap(w + rowPadding / pixelStride, h, Bitmap.Config.ARGB_8888);
      bmp.copyPixelsFromBuffer(buf);
      Bitmap frame = rowPadding == 0 ? bmp : Bitmap.createBitmap(bmp, 0, 0, w, h);
      jpeg.reset();
      frame.compress(Bitmap.CompressFormat.JPEG, quality, jpeg);
      if (frame != bmp) frame.recycle();
      bmp.recycle();
      ScreenCapPlugin.sendFrame(Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP));
    } catch (Exception e) {
      Log.w(TAG, "frame: " + e);
    } finally {
      if (img != null) img.close();
    }
  }

  @Override
  public void onConfigurationChanged(Configuration newConfig) {
    super.onConfigurationChanged(newConfig);
    if (display == null || handler == null) return;
    handler.post(
        () -> {
          int ow = width, oh = height;
          measure();
          if (ow == width && oh == height) return;
          ImageReader old = reader;
          reader = newReader();
          display.resize(width, height, dpi);
          display.setSurface(reader.getSurface());
          old.close();
        });
  }

  @Override
  public void onDestroy() {
    try {
      if (display != null) display.release();
      if (reader != null) reader.close();
      if (projection != null) projection.stop();
      if (thread != null) thread.quitSafely();
    } catch (Exception ignored) {
    }
    ScreenCapPlugin.sendStopped();
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
