// Ringing: shows an incoming-call card for DM calls where I'm in `ringing`,
// plays the ring loop, and the outgoing ringback while I wait for others.
import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Phone, PhoneOff, Video } from "lucide-react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { loopSound } from "../../lib/sound";
import { isDesktop } from "../../lib/platform";
import { channelTitle, useData } from "../../store/data";
import { navigate } from "../../store/ui";
import { UserAvatar } from "../../components/ui/avatar";
import { joinVoice, toggleCamera, useVoice } from "./voice";

export function IncomingCall() {
  const me = useData((s) => s.me?.id);
  const status = useData((s) => s.me?.status);
  const call = useData((s) => Object.values(s.calls).find((c) => me && c.ringing.includes(me)));
  const inThatCall = useVoice((s) => !!call && s.channelId === call.channelId);
  const channel = useData((s) => (call ? s.channels[call.channelId] : undefined));
  const title = useData((s) => channelTitle(s, channel));
  const myCall = useVoice((s) => s.channelId);
  const outgoing = useData((s) => (myCall ? s.calls[myCall] : undefined));
  const others = useData((s) => (myCall ? Object.values(s.voiceStates).filter((v) => v.channelId === myCall && v.userId !== me).length : 0));

  const ringing = !!call && !inThatCall && status !== "dnd";

  useEffect(() => {
    if (!ringing) return;
    const stop = loopSound("ring");
    if (isDesktop) window.nova!.flashFrame(true);
    navigator.vibrate?.([400, 200, 400, 200, 400]);
    return () => {
      stop();
      navigator.vibrate?.(0);
    };
  }, [ringing]);

  // Ringback while my own DM call waits for someone to pick up.
  const waiting = !!outgoing && outgoing.initiatorId === me && outgoing.ringing.length > 0 && others === 0;
  useEffect(() => {
    if (!waiting) return;
    return loopSound("ringback");
  }, [waiting]);

  const caller = call?.initiatorId;
  const accept = async (video: boolean) => {
    if (!call) return;
    navigate("@me", call.channelId);
    await joinVoice(call.channelId);
    if (video) await toggleCamera();
  };
  const decline = () => call && void api(`/api/channels/${call.channelId}/call/decline`, { method: "POST" });

  return (
    <AnimatePresence>
      {ringing && call && caller && (
        <motion.div className="fixed inset-0 z-[75] flex items-center justify-center bg-[rgb(4_5_12/0.6)] p-4 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            initial={{ scale: 0.85, y: 24, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 26 }}
            className="glass flex w-[300px] flex-col items-center rounded-[28px] px-6 pb-7 pt-9 text-center shadow-lift"
          >
            <div className="relative">
              <span className="absolute inset-0 rounded-full" style={{ animation: "ring-pulse 1.6s ease-out infinite" }} />
              <span className="absolute inset-0 rounded-full" style={{ animation: "ring-pulse 1.6s ease-out 0.8s infinite" }} />
              <UserAvatar userId={caller} size={96} showStatus={false} />
            </div>
            <div className="mt-5 font-display text-[20px] font-semibold tracking-[-0.01em]">{title}</div>
            <div className="mt-1 text-[14px] text-fg-2">{t("call.incoming")}</div>
            <div className="mt-7 flex items-center gap-4">
              <button onClick={decline} className="flex h-14 w-14 items-center justify-center rounded-full bg-bad text-white transition-transform hover:scale-105 active:scale-95" aria-label={t("call.decline")}>
                <PhoneOff size={24} />
              </button>
              <button onClick={() => void accept(true)} className="flex h-14 w-14 items-center justify-center rounded-full bg-raised text-fg transition-transform hover:scale-105 active:scale-95" aria-label={t("call.acceptVideo")}>
                <Video size={24} />
              </button>
              <button onClick={() => void accept(false)} className="flex h-14 w-14 items-center justify-center rounded-full bg-ok text-[#04150d] transition-transform hover:scale-105 active:scale-95" aria-label={t("call.accept")}>
                <Phone size={24} />
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
