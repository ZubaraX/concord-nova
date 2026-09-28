import { useEffect, useRef } from "react";
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useData } from "../../store/data";
import { applyRoute, navigate, useUI } from "../../store/ui";
import { settings, useSettings } from "../../store/settings";
import { useIsMobile, useIsWide, selectFirstTextChannel } from "../../lib/hooks";
import { ServerRail } from "./ServerRail";
import { GuildSidebar } from "./GuildSidebar";
import { HomeSidebar } from "./HomeSidebar";
import { UserPanel } from "./UserPanel";
import { ConnectionBanner } from "./ConnectionBanner";
import { QuickSwitcher } from "./QuickSwitcher";
import { useGlobalEffects } from "./globalEffects";
import { FriendsView } from "../friends/FriendsView";
import { ChannelView } from "../chat/ChannelView";
import { RightPanel } from "../panels/RightPanel";
import { ModalHost } from "../modals/ModalHost";
import { Lightbox } from "../chat/Lightbox";
import { IncomingCall } from "../voice/IncomingCall";

export function AppShell() {
  useGlobalEffects();
  const guildId = useUI((s) => s.guildId);
  const channelId = useUI((s) => s.channelId);
  const panel = useUI((s) => s.panel);
  const pane = useUI((s) => s.mobilePane);
  const guildExists = useData((s) => guildId === "@me" || !!s.guilds[guildId]);
  const channelExists = useData((s) => !channelId || !!s.channels[channelId]);
  const mobile = useIsMobile();
  const wide = useIsWide();
  const memberListOpen = useSettings((s) => s.memberListOpen);

  // Route guards: unknown guild → home; guild without channel → last/first channel.
  useEffect(() => {
    applyRoute();
    const on = () => applyRoute();
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    if (!guildExists) return navigate("@me", null, true);
    if (guildId !== "@me" && (!channelId || !channelExists)) {
      const s = useData.getState();
      const last = settings().lastChannels[guildId];
      const target = last && s.channels[last]?.guildId === guildId ? last : selectFirstTextChannel(s, guildId);
      if (target && target !== channelId) navigate(guildId, target, true);
    } else if (guildId === "@me" && channelId && !channelExists) navigate("@me", null, true);
  }, [guildId, channelId, guildExists, channelExists]);

  // Phones: swipe right from the left edge → navigation; swipe left → back to chat.
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current;
    touch.current = null;
    if (!s || !mobile) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Date.now() - s.t > 500 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    if (dx > 0 && s.x < 60 && useUI.getState().mobilePane === "chat") useUI.setState({ mobilePane: "nav" });
    else if (dx < 0 && useUI.getState().mobilePane === "nav" && useUI.getState().channelId) useUI.setState({ mobilePane: "chat" });
  };

  const main = guildId === "@me" && !channelId ? <FriendsView /> : channelId ? <ChannelView key={channelId} channelId={channelId} /> : <div className="flex-1" />;
  const showRight = !!panel || (guildId !== "@me" && memberListOpen && wide);

  return (
    <div className="flex h-full min-h-0" data-shell onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {(!mobile || pane === "nav") && (
        <div className={clsx("flex min-h-0", mobile && "w-full")}>
          <ServerRail />
          <aside className={clsx("flex min-h-0 flex-col overflow-hidden bg-panel hairline", mobile ? "flex-1 rounded-tl-2xl" : "w-[248px] rounded-tl-2xl")}>
            {guildId === "@me" ? <HomeSidebar /> : <GuildSidebar guildId={guildId} />}
            <UserPanel />
          </aside>
        </div>
      )}
      {(!mobile || pane === "chat") && (
        <main className={clsx("relative flex min-w-0 flex-1 overflow-hidden bg-surface", !mobile && "border-l border-line/8")}>
          <div className="flex min-w-0 flex-1 flex-col">
            <ConnectionBanner />
            <div className="flex min-h-0 flex-1">{main}</div>
          </div>
          <AnimatePresence initial={false}>
            {showRight && !mobile && (
              <motion.div
                key="right"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: panel === "search" || panel === "thread" || panel === "inbox" || panel === "bookmarks" || panel === "pins" ? 420 : 248, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 420, damping: 40 }}
                className="shrink-0 overflow-hidden border-l border-line/8 bg-panel"
              >
                <RightPanel />
              </motion.div>
            )}
          </AnimatePresence>
          {mobile && panel && (
            <div className="absolute inset-0 z-30 bg-panel anim-fade">
              <RightPanel />
            </div>
          )}
        </main>
      )}
      <ModalHost />
      <QuickSwitcher />
      <Lightbox />
      <IncomingCall />
    </div>
  );
}
