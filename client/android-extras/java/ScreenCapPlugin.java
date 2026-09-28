package dev.concord.nova;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

// Android screen share: the WebView has no getDisplayMedia, so the screen is
// captured natively (MediaProjection) and JPEG frames are streamed to JS, where
// canvas.captureStream() turns them into a WebRTC video track.
@CapacitorPlugin(name = "ScreenCap")
public class ScreenCapPlugin extends Plugin {
  private static ScreenCapPlugin instance;

  @Override
  public void load() {
    instance = this;
  }

  static void sendFrame(String b64) {
    ScreenCapPlugin p = instance;
    if (p == null) return;
    JSObject d = new JSObject();
    d.put("b64", b64);
    p.notifyListeners("frame", d);
  }

  static void sendStopped() {
    ScreenCapPlugin p = instance;
    if (p != null) p.notifyListeners("stopped", new JSObject());
  }

  @PluginMethod
  public void start(PluginCall call) {
    MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
    startActivityForResult(call, mpm.createScreenCaptureIntent(), "onProjectionResult");
  }

  @ActivityCallback
  private void onProjectionResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
      call.reject("declined");
      return;
    }
    Intent svc = new Intent(getContext(), ScreenCapService.class)
        .putExtra("resultCode", result.getResultCode())
        .putExtra("data", result.getData())
        .putExtra("maxDim", call.getInt("maxDim", 1280))
        .putExtra("fps", call.getInt("fps", 12))
        .putExtra("quality", call.getInt("quality", 60));
    try {
      if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(svc);
      else getContext().startService(svc);
      call.resolve();
    } catch (Exception e) {
      call.reject("service: " + e.getMessage());
    }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    getContext().stopService(new Intent(getContext(), ScreenCapService.class));
    call.resolve();
  }
}
