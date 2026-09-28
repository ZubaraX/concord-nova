// Concord Nova — desktop shell (Electron main process).
//
// The renderer is served from a privileged app:// scheme (not file://), which
// gives it a stable secure origin: fetch()/WASM (noise suppression) work,
// getUserMedia is allowed, and localStorage survives reinstalls.
const {
  app,
  BrowserWindow,
  Menu,
  MenuItem,
  Notification,
  Tray,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { execFile } = require("node:child_process");
const { autoUpdater } = require("electron-updater");

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(__dirname, "..", "dist");
const APP_URL = "app://nova/index.html";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// ── single instance ──────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let closeToTray = true;

app.on("second-instance", (_e, argv) => {
  showWindow();
  const link = argv.find((a) => a.startsWith("concord-nova://"));
  if (link) handleDeepLink(link);
});
app.on("before-quit", () => (quitting = true));

// Windows notifications need an AppUserModelID matching the installer.
if (process.platform === "win32") app.setAppUserModelId("dev.concord.nova");
app.setAsDefaultProtocolClient("concord-nova");

// ── window state ─────────────────────────────────────────────────────────────
const stateFile = path.join(app.getPath("userData"), "window-state.json");
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { width: 1320, height: 860 };
  }
}
function saveState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {
    /* ignore */
  }
}
function visibleOnSomeDisplay(b) {
  return screen.getAllDisplays().some((d) => b.x >= d.bounds.x - 50 && b.y >= d.bounds.y - 50 && b.x < d.bounds.x + d.bounds.width && b.y < d.bounds.y + d.bounds.height);
}

function iconPath() {
  const candidates = [path.join(DIST, "icon.png"), path.join(__dirname, "..", "public", "icon.png"), path.join(__dirname, "..", "build", "icon.png")];
  return candidates.find((p) => fs.existsSync(p));
}

function createWindow() {
  const st = loadState();
  const hasPos = typeof st.x === "number" && visibleOnSomeDisplay(st);
  win = new BrowserWindow({
    width: st.width ?? 1320,
    height: st.height ?? 860,
    ...(hasPos ? { x: st.x, y: st.y } : {}),
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    backgroundColor: "#0b0d1a",
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false, // calls keep working in the background
    },
  });
  if (st.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL(APP_URL);

  win.on("maximize", () => win?.webContents.send("win:maximized", true));
  win.on("unmaximize", () => win?.webContents.send("win:maximized", false));
  win.on("resize", debounce(saveState, 400));
  win.on("move", debounce(saveState, 400));
  win.on("focus", () => win?.flashFrame(false));
  win.on("close", (e) => {
    saveState();
    if (!quitting && closeToTray && tray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => (win = null));

  // External links → system browser; never navigate the app window away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://") && !(DEV_URL && url.startsWith(DEV_URL))) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  // Spell-check suggestions in text fields.
  win.webContents.on("context-menu", (_e, params) => {
    if (!params.isEditable || !params.misspelledWord) return;
    const menu = new Menu();
    for (const s of params.dictionarySuggestions.slice(0, 6)) menu.append(new MenuItem({ label: s, click: () => win?.webContents.replaceMisspelling(s) }));
    if (params.dictionarySuggestions.length) menu.append(new MenuItem({ type: "separator" }));
    menu.append(new MenuItem({ label: "Добавить в словарь", click: () => win?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }));
    menu.popup();
  });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function handleDeepLink(link) {
  const m = /invite\/([\w-]+)/.exec(link);
  if (m && win) void win.webContents.executeJavaScript(`location.hash = "#/invite/${m[1]}"`);
}

// ── tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  const ic = iconPath();
  if (!ic) return;
  tray = new Tray(nativeImage.createFromPath(ic).resize({ width: 16, height: 16 }));
  tray.setToolTip("Concord Nova");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Открыть Concord Nova", click: showWindow },
      { type: "separator" },
      { label: "Выключить/включить микрофон", click: () => win?.webContents.send("shortcut", "toggleMute") },
      { label: "Выключить/включить звук", click: () => win?.webContents.send("shortcut", "toggleDeafen") },
      { type: "separator" },
      {
        label: "Выйти",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", () => (win?.isVisible() && win.isFocused() ? win.hide() : showWindow()));
}

// ── screen share ─────────────────────────────────────────────────────────────
let pendingCapture = null;
function wireDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_req, callback) => {
      if (pendingCapture) pendingCapture.callback({});
      pendingCapture = { callback };
      if (!win) return callback({});
      win.webContents.send("screen:pick");
    },
    { useSystemPicker: false }
  );
}
ipcMain.handle("screen:sources", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 400, height: 225 }, fetchWindowIcons: true });
  return sources
    .filter((s) => !s.name.startsWith("Concord Nova") || s.id.startsWith("screen:"))
    .map((s) => ({ id: s.id, name: s.name, isScreen: s.id.startsWith("screen:"), thumbnail: s.thumbnail.toDataURL(), appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null }));
});
ipcMain.on("screen:select", async (_e, id, withAudio) => {
  const pending = pendingCapture;
  pendingCapture = null;
  if (!pending) return;
  if (!id) return pending.callback({});
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
  const src = sources.find((s) => s.id === id);
  if (!src) return pending.callback({});
  // Loopback system audio is supported on Windows (and macOS 13+ with Electron's handler).
  pending.callback({ video: src, ...(withAudio && process.platform !== "linux" ? { audio: "loopback" } : {}) });
});

// ── notifications, badge, window controls ───────────────────────────────────
ipcMain.on("notify", (_e, { title, body, tag }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath(), silent: true });
  n.on("click", () => {
    showWindow();
    win?.webContents.send("notification:click", tag);
  });
  n.show();
});
ipcMain.on("badge", (_e, { count, dataUrl }) => {
  try {
    app.setBadgeCount(count);
  } catch {
    /* not supported */
  }
  if (!win) return;
  if (process.platform === "win32") win.setOverlayIcon(dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, count ? `${count} непрочитанных` : "");
});
ipcMain.on("flash", (_e, on) => win && !win.isFocused() && win.flashFrame(!!on));
ipcMain.on("win:minimize", () => win?.minimize());
ipcMain.on("win:maximize", () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
ipcMain.on("win:close", () => win?.close());
ipcMain.on("win:isMaximized", (e) => (e.returnValue = !!win?.isMaximized()));
ipcMain.on("app:version", (e) => (e.returnValue = app.getVersion()));
ipcMain.on("open-external", (_e, url) => /^https?:/i.test(url) && void shell.openExternal(url));
ipcMain.on("close-to-tray", (_e, on) => (closeToTray = !!on));
ipcMain.on("autolaunch", (_e, on) => app.setLoginItemSettings({ openAtLogin: !!on, args: ["--hidden"] }));

// ── global shortcuts ─────────────────────────────────────────────────────────
const toAccelerator = (combo) =>
  combo
    .split("+")
    .map((p) => (p === "Ctrl" ? "CommandOrControl" : p === "Super" ? "Super" : p))
    .join("+");
ipcMain.on("shortcuts", (_e, map) => {
  globalShortcut.unregisterAll();
  for (const [action, combo] of Object.entries(map || {})) {
    if (!combo) continue;
    try {
      globalShortcut.register(toAccelerator(combo), () => win?.webContents.send("shortcut", action));
    } catch {
      /* invalid or taken accelerator */
    }
  }
  globalShortcut.register("CommandOrControl+Shift+O", () => {
    overlayHidden = !overlayHidden;
    applyOverlay();
  });
});

// ── overlay ("who's speaking", on top of games) ─────────────────────────────
let overlay = null;
let overlayState = null;
let overlayHidden = false;
function applyOverlay() {
  const show = overlayState && overlayState.people?.length && !overlayHidden;
  if (!show) return overlay?.hide();
  if (!overlay || overlay.isDestroyed()) {
    overlay = new BrowserWindow({
      width: 240,
      height: 400,
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.setIgnoreMouseEvents(true);
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (DEV_URL) overlay.loadURL(`${DEV_URL}#overlay`);
    else overlay.loadURL(`${APP_URL}#overlay`);
    overlay.webContents.once("did-finish-load", () => overlay?.webContents.send("overlay:data", overlayState));
    const { workArea } = screen.getPrimaryDisplay();
    overlay.setPosition(workArea.x + 16, workArea.y + 16);
  }
  overlay.webContents.send("overlay:data", overlayState);
  overlay.showInactive();
}
ipcMain.on("overlay:state", (_e, state) => {
  overlayState = state;
  applyOverlay();
});

// ── "Playing …" detection (Windows process list, no native modules) ─────────
const GAMES = {
  "cs2.exe": "Counter-Strike 2",
  "dota2.exe": "Dota 2",
  "valorant-win64-shipping.exe": "VALORANT",
  "r5apex.exe": "Apex Legends",
  "r5apex_dx12.exe": "Apex Legends",
  "fortniteclient-win64-shipping.exe": "Fortnite",
  "tslgame.exe": "PUBG",
  "gta5.exe": "GTA V",
  "gta5_enhanced.exe": "GTA V",
  "rdr2.exe": "Red Dead Redemption 2",
  "rustclient.exe": "Rust",
  "minecraft.windows.exe": "Minecraft",
  "javaw.exe": null,
  "league of legends.exe": "League of Legends",
  "wow.exe": "World of Warcraft",
  "overwatch.exe": "Overwatch 2",
  "rocketleague.exe": "Rocket League",
  "eldenring.exe": "Elden Ring",
  "cyberpunk2077.exe": "Cyberpunk 2077",
  "factorio.exe": "Factorio",
  "terraria.exe": "Terraria",
  "stardew valley.exe": "Stardew Valley",
  "phasmophobia.exe": "Phasmophobia",
  "deadbydaylight-win64-shipping.exe": "Dead by Daylight",
  "escapefromtarkov.exe": "Escape from Tarkov",
  "aces.exe": "War Thunder",
  "worldoftanks.exe": "World of Tanks",
  "lesta.exe": "Мир танков",
  "genshinimpact.exe": "Genshin Impact",
  "starrail.exe": "Honkai: Star Rail",
  "robloxplayerbeta.exe": "Roblox",
  "helldivers2.exe": "Helldivers 2",
  "bg3.exe": "Baldur's Gate 3",
  "bg3_dx11.exe": "Baldur's Gate 3",
  "palworld-win64-shipping.exe": "Palworld",
  "valheim.exe": "Valheim",
  "beamng.drive.x64.exe": "BeamNG.drive",
  "left4dead2.exe": "Left 4 Dead 2",
  "brawlhalla.exe": "Brawlhalla",
  "schedule i.exe": "Schedule I",
  "marvel-win64-shipping.exe": "Marvel Rivals",
  "deltaforceclient-win64-shipping.exe": "Delta Force",
  "cod.exe": "Call of Duty",
};
let lastGame = null;
function scanGames() {
  if (process.platform !== "win32" || !win) return;
  execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
    if (err || !out) return;
    let found = null;
    for (const line of out.split("\n")) {
      const exe = line.split('","')[0]?.replace(/^"/, "").trim().toLowerCase();
      if (exe && GAMES[exe]) {
        found = GAMES[exe];
        break;
      }
    }
    if (found !== lastGame) {
      lastGame = found;
      win?.webContents.send("activity", found);
    }
  });
}

// ── auto-update ──────────────────────────────────────────────────────────────
function wireUpdates() {
  if (!app.isPackaged) return;
  const send = (s) => win?.webContents.send("update", s);
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (i) => send({ state: "available", version: i?.version }));
  autoUpdater.on("download-progress", (p) => send({ state: "downloading", percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on("update-downloaded", (i) => send({ state: "downloaded", version: i?.version }));
  autoUpdater.on("error", () => send({ state: "error" }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 60 * 60 * 1000);
}
ipcMain.on("update:install", () => {
  quitting = true;
  autoUpdater.quitAndInstall(true, true);
});

// ── boot ─────────────────────────────────────────────────────────────────────
app.commandLine.appendSwitch("enable-features", "WebRtcAllowInputVolumeAdjustment");

app.whenReady().then(() => {
  protocol.handle("app", (req) => {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || !p) p = "/index.html";
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    if (!fs.existsSync(file)) return net.fetch(pathToFileURL(path.join(DIST, "index.html")).toString());
    return net.fetch(pathToFileURL(file).toString());
  });

  // The app may use the mic, camera, screen, notifications and clipboard.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(["media", "display-capture", "notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen", "pointerLock", "speaker-selection"].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ["media", "notifications", "clipboard-sanitized-write", "speaker-selection"].includes(permission));
  try {
    const langs = session.defaultSession.availableSpellCheckerLanguages;
    session.defaultSession.setSpellCheckerLanguages(["ru", "en-US"].filter((l) => langs.includes(l)));
  } catch {
    /* no dictionaries */
  }

  wireDisplayMedia();
  createWindow();
  createTray();
  wireUpdates();
  setTimeout(scanGames, 10_000);
  setInterval(scanGames, 30_000);
  if (process.argv.includes("--hidden")) win?.hide();

  app.on("activate", () => (BrowserWindow.getAllWindows().length ? showWindow() : createWindow()));
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !tray) app.quit();
});
