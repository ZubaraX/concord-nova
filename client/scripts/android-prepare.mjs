// Turns the Capacitor-generated project (`npx cap add android`) into Concord
// Nova: native sources, manifest (permissions, services, share/invite intents),
// dark theme, launcher icons + splash, version, optional release signing.
// Idempotent — safe to run again after `npx cap sync android`.
//
//   VITE_API_URL / VITE_API_URL_FALLBACK  hosts whose /invite/ links open the app
//   NOVA_BUILD_NUMBER                      added to versionCode (CI run number)
//   NOVA_KEYSTORE (+ _PASSWORD, NOVA_KEY_ALIAS, NOVA_KEY_PASSWORD)  signing, read by Gradle
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTIVE_BG, BG, ICON_SVG, STAR_SVG } from "../../scripts/brand.mjs";

const client = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(client, "..");
const android = join(client, "android");
const main = join(android, "app/src/main");
const APP_ID = "dev.concord.nova";
const MARK = "<!-- nova -->";

if (!existsSync(main)) {
  console.error("✖ client/android not found — run `npx cap add android` first.");
  process.exit(1);
}
const sharp = createRequire(join(root, "server", "package.json"))("sharp");
const read = (p) => readFileSync(p, "utf8");
const write = (p, s) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};

// ── native sources + resources ───────────────────────────────────────────────
const javaDir = join(main, "java", ...APP_ID.split("."));
mkdirSync(javaDir, { recursive: true });
const extras = join(client, "android-extras");
for (const f of readdirSync(join(extras, "java"))) copyFileSync(join(extras, "java", f), join(javaDir, f));
(function copyTree(from, to) {
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(join(from, e.name), join(to, e.name));
    else {
      mkdirSync(to, { recursive: true });
      copyFileSync(join(from, e.name), join(to, e.name));
    }
  }
})(join(extras, "res"), join(main, "res"));

// ── manifest ──────────────────────────────────────────────────────────────────
const manifestPath = join(main, "AndroidManifest.xml");
let manifest = read(manifestPath);
if (!manifest.includes(MARK)) {
  const perms = [
    "ACCESS_NETWORK_STATE",
    "RECORD_AUDIO",
    "CAMERA",
    "MODIFY_AUDIO_SETTINGS",
    "POST_NOTIFICATIONS",
    "VIBRATE",
    "WAKE_LOCK",
    "RECEIVE_BOOT_COMPLETED",
    "USE_FULL_SCREEN_INTENT",
    "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
    "FOREGROUND_SERVICE",
    "FOREGROUND_SERVICE_DATA_SYNC",
    "FOREGROUND_SERVICE_SPECIAL_USE",
    "FOREGROUND_SERVICE_MEDIA_PROJECTION",
  ];
  manifest = manifest.replace(
    '<uses-permission android:name="android.permission.INTERNET" />',
    [
      MARK,
      '<uses-permission android:name="android.permission.INTERNET" />',
      ...perms.map((p) => `<uses-permission android:name="android.permission.${p}" />`),
      '<uses-feature android:name="android.hardware.camera" android:required="false" />',
      '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
    ].join("\n    ")
  );

  const hosts = [process.env.VITE_API_URL, process.env.VITE_API_URL_FALLBACK]
    .filter(Boolean)
    .map((u) => {
      try {
        return new URL(u);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const view = (data) => `
            <intent-filter android:autoVerify="false">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                ${data}
            </intent-filter>`;
  const filters = [
    `
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
                <data android:mimeType="video/*" />
                <data android:mimeType="audio/*" />
                <data android:mimeType="text/*" />
                <data android:mimeType="application/*" />
            </intent-filter>`,
    view('<data android:scheme="concord-nova" android:host="invite" />'),
    ...hosts.map((u) => view(`<data android:scheme="${u.protocol.slice(0, -1)}" android:host="${u.hostname}" android:pathPrefix="/invite/" />`)),
  ];
  // First </activity> is MainActivity's.
  manifest = manifest.replace("</activity>", `${filters.join("")}\n        </activity>`);
  manifest = manifest.replace('android:launchMode="singleTask"', 'android:launchMode="singleTask"\n            android:windowSoftInputMode="adjustResize"');

  manifest = manifest.replace(
    "</application>",
    `
        <service
            android:name=".PushService"
            android:exported="false"
            android:foregroundServiceType="dataSync|specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="Self-hosted push: one connection to the user's own chat server delivers messages and calls without Google services" />
        </service>
        <service
            android:name=".ScreenCapService"
            android:exported="false"
            android:foregroundServiceType="mediaProjection" />
        <receiver android:name=".BootReceiver" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>
        <receiver android:name=".CallActionReceiver" android:exported="false" />
    </application>`
  );
  write(manifestPath, manifest);
}

// ── theme: dark bars, splash, no forced edge-to-edge ─────────────────────────
write(
  join(main, "res/values/nova_colors.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="nova_bg">${BG.toUpperCase()}</color>
    <color name="nova_accent">#FFB35C</color>
    <color name="colorPrimary">${BG.toUpperCase()}</color>
    <color name="colorPrimaryDark">${BG.toUpperCase()}</color>
    <color name="colorAccent">#FFB35C</color>
</resources>
`
);
write(
  join(main, "res/values/ic_launcher_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${ADAPTIVE_BG.toUpperCase()}</color>
</resources>
`
);
const bars = `
        <item name="android:statusBarColor">@color/nova_bg</item>
        <item name="android:navigationBarColor">@color/nova_bg</item>
        <item name="android:windowLightStatusBar" tools:targetApi="23">false</item>
        <item name="android:windowLightNavigationBar" tools:targetApi="27">false</item>
        <item name="android:windowOptOutEdgeToEdgeEnforcement" tools:targetApi="35">true</item>`;
write(
  join(main, "res/values/styles.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<resources xmlns:tools="http://schemas.android.com/tools">
    <style name="AppTheme" parent="Theme.AppCompat.NoActionBar">
        <item name="colorPrimary">@color/colorPrimary</item>
        <item name="colorPrimaryDark">@color/colorPrimaryDark</item>
        <item name="colorAccent">@color/colorAccent</item>
    </style>

    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
        <item name="android:background">@null</item>
        <item name="android:windowBackground">@color/nova_bg</item>${bars}
    </style>

    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
        <item name="windowSplashScreenBackground">@color/nova_bg</item>
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>${bars}
    </style>
</resources>
`
);

// ── launcher icons + splash ──────────────────────────────────────────────────
const png = (svg, size) => sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png().toBuffer();
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const roundMask = (size) => Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/></svg>`);
for (const [d, k] of Object.entries(densities)) {
  const dir = join(main, `res/mipmap-${d}`);
  mkdirSync(dir, { recursive: true });
  const legacy = Math.round(48 * k);
  writeFileSync(join(dir, "ic_launcher.png"), await png(ICON_SVG, legacy));
  const fullBleed = ICON_SVG.replace('rx="230"', 'rx="0"');
  writeFileSync(
    join(dir, "ic_launcher_round.png"),
    await sharp(await png(fullBleed, legacy)).composite([{ input: roundMask(legacy), blend: "dest-in" }]).png().toBuffer()
  );
  writeFileSync(join(dir, "ic_launcher_foreground.png"), await png(STAR_SVG, Math.round(108 * k)));
}
const splashSizes = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
const splash = async (w, h) => {
  const s = Math.round(Math.min(w, h) * 0.42);
  return sharp({ create: { width: w, height: h, channels: 4, background: BG } })
    .composite([{ input: await png(STAR_SVG, s), gravity: "centre" }])
    .png()
    .toBuffer();
};
for (const [d, [w, h]] of Object.entries(splashSizes)) {
  write(join(main, `res/drawable-port-${d}/splash.png`), await splash(w, h));
  write(join(main, `res/drawable-land-${d}/splash.png`), await splash(h, w));
}
write(join(main, "res/drawable/splash.png"), await splash(480, 800));

// ── gradle: version + signing ─────────────────────────────────────────────────
const gradlePath = join(android, "app/build.gradle");
let gradle = read(gradlePath);
const version = JSON.parse(read(join(client, "package.json"))).version;
const [ma, mi, pa] = version.split(".").map((n) => parseInt(n, 10) || 0);
const build = parseInt(process.env.NOVA_BUILD_NUMBER ?? "0", 10) % 1000;
const versionCode = ((ma * 100 + mi) * 100 + pa) * 1000 + build;
gradle = gradle.replace(/versionCode \d+/, `versionCode ${versionCode}`).replace(/versionName "[^"]*"/, `versionName "${version}${build ? `.${build}` : ""}"`);
if (!gradle.includes("NOVA_KEYSTORE")) {
  gradle += `
// Concord Nova: stable signing so installed apps can update over each other.
def novaKeystore = System.getenv("NOVA_KEYSTORE")
android {
    signingConfigs {
        if (novaKeystore) {
            nova {
                storeFile file(novaKeystore)
                storePassword System.getenv("NOVA_KEYSTORE_PASSWORD")
                keyAlias System.getenv("NOVA_KEY_ALIAS") ?: "nova"
                keyPassword System.getenv("NOVA_KEY_PASSWORD") ?: System.getenv("NOVA_KEYSTORE_PASSWORD")
            }
        }
    }
    buildTypes {
        release { if (novaKeystore) signingConfig signingConfigs.nova }
        debug { if (novaKeystore) signingConfig signingConfigs.nova }
    }
}
`;
}
write(gradlePath, gradle);

// ── gradle.properties: allow non-ASCII project paths (e.g. a Cyrillic folder
//    on Windows) — AGP refuses them by default; the build itself copes fine.
const propsPath = join(android, "gradle.properties");
const props = read(propsPath);
if (!props.includes("android.overridePathCheck")) write(propsPath, `${props.trimEnd()}\nandroid.overridePathCheck=true\n`);

// ── local SDK location (CI runners export ANDROID_HOME) ──────────────────────
const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk"));
if (sdk && existsSync(sdk)) write(join(android, "local.properties"), `sdk.dir=${sdk.replace(/\\/g, "/")}\n`);

console.log(`✅ android prepared: ${APP_ID} v${version} (code ${versionCode})`);
