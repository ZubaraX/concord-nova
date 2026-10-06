// App-wide side effects that live as long as the signed-in shell.
import { useEffect } from "react";
import { gw } from "../../lib/gateway";
import { bus, toast } from "../../lib/bus";
import { ensureNotificationPermission, initNotifications } from "../../lib/notifications";
import { isAndroid, isDesktop } from "../../lib/platform";
import { initAndroidIntents, sharedFiles, startPush, type SharedContent } from "../../lib/android";
import { t } from "../../lib/i18n";
import { clearPendingInvite, pendingInvite } from "../../lib/deeplink";
import { channelTitle, data, isUnread, useData } from "../../store/data";
import { navigate, ui, useUI } from "../../store/ui";
import { comboOf, globalShortcutMap, settings, useSettings } from "../../store/settings";
import { joinVoice, toggleDeafen, toggleMute, useVoice } from "../voice/voice";
import { stageFiles } from "../chat/composerFiles";
import { installAppAudio } from "../voice/appAudio";

let notificationsReady = false;
const IDLE_MS = 10 * 60_000;

export function useGlobalEffects() {
  useEffect(() => {
    if (!notificationsReady) {
      notificationsReady = true;
      initNotifications();
    }
    const cleanups: (() => void)[] = [];

    // Opened an invite link while logged out, then logged in: offer to join now.
    const invite = pendingInvite();
    if (invite) {
      clearPendingInvite();
      useUI.getState().setModal({ kind: "acceptInvite", code: invite });
    }

    // Ask for notification permission on the first real interaction.
    const askOnce = () => {
      void ensureNotificationPermission();
      window.removeEventListener("pointerdown", askOnce);
    };
    window.addEventListener("pointerdown", askOnce);
    cleanups.push(() => window.removeEventListener("pointerdown", askOnce));

    // Auto-idle after 10 minutes without input (presence shows "idle").
    let lastInput = Date.now();
    let afk = false;
    const activity = () => {
      lastInput = Date.now();
      if (afk) {
        afk = false;
        gw.presence({ afk: false });
      }
    };
    const idleTimer = setInterval(() => {
      if (!afk && Date.now() - lastInput > IDLE_MS && !useVoice.getState().channelId) {
        afk = true;
        gw.presence({ afk: true });
      }
    }, 30_000);
    for (const ev of ["pointermove", "keydown", "pointerdown", "focus"] as const) window.addEventListener(ev, activity, { passive: true });
    cleanups.push(() => {
      clearInterval(idleTimer);
      for (const ev of ["pointermove", "keydown", "pointerdown", "focus"] as const) window.removeEventListener(ev, activity);
    });

    // Tell the server which channel is on screen (push suppression).
    const reportFocus = () => gw.focus(document.visibilityState === "visible" ? ui().channelId : null);
    document.addEventListener("visibilitychange", reportFocus);
    cleanups.push(() => document.removeEventListener("visibilitychange", reportFocus));
    cleanups.push(useUI.subscribe((s, p) => s.channelId !== p.channelId && reportFocus()));
    reportFocus();

    // Keyboard shortcuts.
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useUI.setState({ switcher: !useUI.getState().switcher });
      } else if (!isDesktop && e.code && comboOf(e) === settings().keybinds.toggleMute) {
        // (The desktop app gets these as global shortcuts.)
        e.preventDefault();
        toggleMute();
      } else if (!isDesktop && e.code && comboOf(e) === settings().keybinds.toggleDeafen) {
        e.preventDefault();
        toggleDeafen();
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        stepChannel(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
      }
    };
    window.addEventListener("keydown", onKey);
    cleanups.push(() => window.removeEventListener("keydown", onKey));

    if (isDesktop) {
      const nova = window.nova!;
      cleanups.push(installAppAudio(nova));
      cleanups.push(nova.onGlobalShortcut((a) => (a === "toggleMute" ? toggleMute() : a === "toggleDeafen" ? toggleDeafen() : undefined)));
      nova.setGlobalShortcuts(globalShortcutMap());
      cleanups.push(
        nova.onActivity((game) => gw.presence({ activities: game ? [{ type: "playing", name: game, startedAt: Date.now() }] : [] }))
      );
      // Screen share: Electron asks us which screen/window to capture.
      cleanups.push(
        nova.onScreenPick(() =>
          useUI.getState().pushModal({ kind: "screenPicker", resolve: (r) => nova.selectSource(r?.id ?? null, r?.audio ?? false) })
        )
      );
      nova.setCloseToTray(settings().minimizeToTray);
      cleanups.push(
        useSettings.subscribe((s, p) => {
          if (s.minimizeToTray !== p.minimizeToTray) nova.setCloseToTray(s.minimizeToTray);
        })
      );
    }

    if (isAndroid) {
      void startPush();
      // "Share → Concord Nova": drop into the open chat, or let the user pick one first.
      const deliver = async (channelId: string, s: SharedContent) => {
        const files = await sharedFiles(s);
        if (files.length) stageFiles(channelId, files);
        if (s.text) bus.emit("insertText", { channelId, text: s.text });
      };
      initAndroidIntents({
        share: (s) => {
          const channelId = ui().channelId;
          if (channelId) return void deliver(channelId, s);
          toast(t("switcher.sharePick"));
          useUI.setState({ switcher: true });
          const unsub = useUI.subscribe((u) => {
            if (u.channelId) {
              unsub();
              void deliver(u.channelId, s);
            } else if (!u.switcher) setTimeout(() => !ui().channelId && unsub(), 0); // picking closes first, then navigates
          });
        },
        invite: (code) => useUI.getState().setModal({ kind: "acceptInvite", code }),
        // Notification tap (optionally "Answer" on a call). Cold starts may land
        // before READY — wait for the channel to show up.
        open: (channelId, accept) => {
          const go = () => {
            const c = data().channels[channelId];
            if (!c) return false;
            navigate(c.guildId ?? "@me", channelId);
            if (accept && useVoice.getState().channelId !== channelId) void joinVoice(channelId);
            return true;
          };
          if (go()) return;
          const unsub = useData.subscribe(() => go() && unsub());
          setTimeout(unsub, 20_000);
        },
      });
      void import("@capacitor/app").then(({ App }) =>
        App.addListener("backButton", () => {
          const u = ui();
          if (u.lightbox) useUI.setState({ lightbox: null });
          else if (u.modal) u.popModal();
          else if (u.panel) useUI.setState({ panel: null });
          else if (u.mobilePane === "chat") useUI.setState({ mobilePane: "nav" });
          else void App.minimizeApp();
        })
      );
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  // Desktop overlay: mirror who's in the call and who's speaking.
  useEffect(() => {
    if (!isDesktop) return;
    const push = () => {
      const v = useVoice.getState();
      const s = useData.getState();
      if (!settings().overlay || !v.channelId) return window.nova!.setOverlay(null);
      const members = Object.values(s.voiceStates).filter((x) => x.channelId === v.channelId);
      window.nova!.setOverlay({
        channel: channelTitle(s, s.channels[v.channelId]),
        people: members.map((m) => ({
          id: m.userId,
          name: s.users[m.userId]?.displayName || s.users[m.userId]?.username,
          avatar: s.users[m.userId]?.avatar,
          speaking: !!v.speaking[m.userId],
          muted: m.selfMute || m.serverMute,
        })),
      });
    };
    const a = useVoice.subscribe(push);
    const b = useData.subscribe((s, p) => s.voiceStates !== p.voiceStates && push());
    return () => {
      a();
      b();
    };
  }, []);
}

/** Alt+↑/↓ — previous/next channel (Shift: only unread). */
function stepChannel(dir: 1 | -1, unreadOnly: boolean) {
  const s = data();
  const u = ui();
  if (u.guildId === "@me") return;
  const list = Object.values(s.channels)
    .filter((c) => c.guildId === u.guildId && (c.type === "text" || c.type === "announcement"))
    .sort((a, b) => a.position - b.position);
  const i = list.findIndex((c) => c.id === u.channelId);
  for (let k = 1; k <= list.length; k++) {
    const c = list[(i + dir * k + list.length) % list.length];
    if (!unreadOnly || isUnread(s, c.id)) return navigate(u.guildId, c.id);
  }
}
