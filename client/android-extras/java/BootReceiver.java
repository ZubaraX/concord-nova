package dev.concord.nova;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Restart the push service after a reboot or an app update — only while logged
// in (startPush persisted a token; stopPush / a revoked session clears it).
public class BootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    String a = intent.getAction();
    if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
    if (NovaNativePlugin.prefs(context).getString("token", null) != null) PushService.start(context);
  }
}
