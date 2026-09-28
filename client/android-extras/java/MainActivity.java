package dev.concord.nova;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

// Replaces the Capacitor-generated MainActivity (client/scripts/android-prepare.mjs
// copies it in): registers the local plugins and forwards every launch intent —
// share targets, invite links, notification taps, incoming calls — to JS.
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(NovaNativePlugin.class);
    registerPlugin(ScreenCapPlugin.class);
    super.onCreate(savedInstanceState);
  }

  // BridgeActivity.load() calls this for the launch intent too, so one override
  // covers cold starts and intents delivered to the running activity.
  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    if (intent == null) return;
    setIntent(intent);
    if (intent.getBooleanExtra(PushService.EXTRA_CALL, false) && Build.VERSION.SDK_INT >= 27) {
      // Incoming call launched over the lock screen: show above it and wake the display.
      setShowWhenLocked(true);
      setTurnScreenOn(true);
    }
    NovaNativePlugin.handleIntent(this, intent);
  }
}
