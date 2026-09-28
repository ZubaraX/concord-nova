import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Plus, Smile, Send, X, Mic, Upload, BarChart3, Clock, BellOff, Eye, EyeOff, RotateCw, FileText, AtSign } from "lucide-react";
import { Permission, RelationshipType, type GifDTO } from "@nova/shared";
import { api, ApiError } from "../../lib/api";
import { bus, toast } from "../../lib/bus";
import { gw } from "../../lib/gateway";
import { errorText, t } from "../../lib/i18n";
import { isTouch, isAndroid } from "../../lib/platform";
import { useIsMobile } from "../../lib/hooks";
import { can, channelPerms, channelTitle, data, displayName, useData } from "../../store/data";
import { lastOwnMessage, sendMessage } from "../../store/messages";
import { useUI } from "../../store/ui";
import { useSettings } from "../../store/settings";
import { MenuList, Popover, usePopover } from "../../components/ui/overlay";
import { useStaged, stageFiles, removeStaged, toggleSpoiler, retryStaged, takeStaged, uploadVoice } from "./composerFiles";
import { textToTokens, type TokenMap } from "./mentionText";
import { AutocompleteList, findTrigger, useSuggestions, type Suggestion } from "./Autocomplete";
import { EmojiPicker } from "./EmojiPicker";
import { VoiceRecorder } from "./VoiceRecorder";
import { formatBytes } from "@nova/shared";

const drafts = new Map<string, { text: string; map: TokenMap }>();
const DRAFT_KEY = "nova.drafts";
try {
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Record<string, { text: string; map: TokenMap }>)) drafts.set(k, v);
} catch {
  /* ignore */
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persistDrafts() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of drafts) if (v.text.trim()) obj[k] = v;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(obj));
    } catch {
      /* quota */
    }
  }, 600);
}

export function Composer({ channelId, placeholderOverride, compact }: { channelId: string; placeholderOverride?: string; compact?: boolean }) {
  const channel = useData((s) => s.channels[channelId]);
  const guildId = channel?.guildId ?? null;
  const bits = useData((s) => channelPerms(s, channelId));
  const title = useData((s) => channelTitle(s, channel));
  const blocked = useData((s) => {
    if (channel?.type !== "dm") return false;
    const other = channel.recipients.find((r) => r !== s.me?.id);
    return !!other && s.relationships[other]?.type === RelationshipType.BLOCKED;
  });
  const replyTo = useUI((s) => s.replyTo[channelId]);
  const staged = useStaged((s) => s.byChannel[channelId]) ?? [];
  const sendOnEnter = useSettings((s) => s.sendOnEnter);
  const mobile = useIsMobile();

  const [text, setText] = useState(() => drafts.get(channelId)?.text ?? "");
  const map = useRef<TokenMap>(drafts.get(channelId)?.map ?? {});
  const [caret, setCaret] = useState(0);
  const [acIndex, setAcIndex] = useState(0);
  const [acDismissed, setAcDismissed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [replyPing, setReplyPing] = useState(true);
  const [slowUntil, setSlowUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const ta = useRef<HTMLTextAreaElement>(null);
  const plus = usePopover();
  const emoji = usePopover();

  const canSend = can(bits, Permission.SEND_MESSAGES) && !blocked;
  const canAttach = can(bits, Permission.ATTACH_FILES);
  const trigger = acDismissed ? null : findTrigger(text, caret);
  const suggestions = useSuggestions(trigger, channelId, guildId);

  // Auto-size the textarea (up to 45% of the viewport).
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.45) + "px";
  }, [text]);

  useEffect(() => {
    drafts.set(channelId, { text, map: map.current });
    persistDrafts();
  }, [text, channelId]);

  useEffect(() => setAcIndex(0), [trigger?.kind, trigger?.query]);

  useEffect(() => {
    if (slowUntil <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [slowUntil]);

  useEffect(() => {
    const offFocus = bus.on("focusComposer", (e) => e.channelId === channelId && ta.current?.focus());
    const offInsert = bus.on("insertText", (e) => {
      if (e.channelId !== channelId) return;
      insertAtCaret(e.text);
    });
    return () => {
      offFocus();
      offInsert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Desktop: typing anywhere in the chat focuses the composer.
  useEffect(() => {
    if (isTouch) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)) return;
      if (useUI.getState().modal || useUI.getState().switcher) return;
      ta.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (replyTo && !isTouch) ta.current?.focus();
  }, [replyTo]);

  const insertAtCaret = (value: string, replace?: { start: number; end: number }) => {
    const el = ta.current;
    const cur = el?.value ?? text;
    const start = replace?.start ?? el?.selectionStart ?? cur.length;
    const end = replace?.end ?? el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + value + cur.slice(end);
    setText(next);
    const pos = start + value.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const pickSuggestion = (s: Suggestion) => {
    if (!trigger) return;
    if (s.token) map.current = { ...map.current, [s.insert]: s.token };
    insertAtCaret(s.insert + " ", { start: trigger.start, end: trigger.end });
  };

  const send = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!canSend) return;
      if (Date.now() < slowUntil) return;
      const files = takeStaged(channelId);
      if (!files) return toast(t("chat.uploading", { p: "…" }));
      const raw = text.trim();
      if (!raw && !files.attachments.length) return;
      const s = data();
      const content = textToTokens(raw, map.current, s, guildId, channelId);
      const input = {
        content,
        replyTo: replyTo?.id,
        replyMention: replyTo ? replyPing : undefined,
        attachments: files.attachments.map((a) => a.id),
        spoilers: files.spoilers,
        silent: opts?.silent,
      };
      sendMessage(channelId, input, files.attachments);
      setText("");
      map.current = {};
      drafts.delete(channelId);
      persistDrafts();
      gw.stopTyping(channelId);
      useUI.setState({ replyTo: { ...useUI.getState().replyTo, [channelId]: undefined } });
      const slow = channel?.slowmode ?? 0;
      if (slow && !can(bits, Permission.MANAGE_MESSAGES) && !can(bits, Permission.MANAGE_CHANNELS)) setSlowUntil(Date.now() + slow * 1000);
    },
    [canSend, slowUntil, channelId, text, guildId, replyTo, replyPing, channel?.slowmode, bits]
  );

  const sendGif = (g: GifDTO) => {
    if (!canSend) return;
    sendMessage(channelId, { content: g.url, replyTo: replyTo?.id });
    useUI.setState({ replyTo: { ...useUI.getState().replyTo, [channelId]: undefined } });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length && trigger) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setAcIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickSuggestion(suggestions[acIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAcDismissed(true);
        return;
      }
    }
    if (e.key === "Escape" && replyTo) {
      useUI.setState({ replyTo: { ...useUI.getState().replyTo, [channelId]: undefined } });
      return;
    }
    if (e.key === "ArrowUp" && !text && !e.shiftKey) {
      const me = data().me?.id;
      const last = me ? lastOwnMessage(channelId, me) : undefined;
      if (last) {
        e.preventDefault();
        useUI.setState({ editing: last.id });
      }
      return;
    }
    const wantsSend = e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (sendOnEnter || e.ctrlKey || e.metaKey);
    if (wantsSend && !(mobile && isTouch)) {
      e.preventDefault();
      void send();
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setCaret(e.target.selectionStart ?? e.target.value.length);
    setAcDismissed(false);
    if (e.target.value.trim()) gw.typing(channelId);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length && canAttach) {
      e.preventDefault();
      stageFiles(channelId, files);
    }
  };

  const pickFiles = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => input.files && stageFiles(channelId, [...input.files]);
    input.click();
  };

  const onVoiceDone = async (blob: Blob, duration: number, waveform: string) => {
    setRecording(false);
    try {
      const att = await uploadVoice(blob, duration, waveform);
      sendMessage(channelId, { content: "", attachments: [att.id], replyTo: replyTo?.id }, [att]);
      useUI.setState({ replyTo: { ...useUI.getState().replyTo, [channelId]: undefined } });
    } catch (e) {
      toast(errorText(e as ApiError), "error");
    }
  };

  const placeholder = !canSend
    ? blocked
      ? t("chat.placeholderBlocked")
      : t("chat.placeholderNoPerm")
    : placeholderOverride ?? (channel?.guildId ? t("chat.placeholderChannel", { name: title }) : t("chat.placeholderDm", { name: title }));
  const slowLeft = Math.max(0, Math.ceil((slowUntil - now) / 1000));
  const uploading = staged.some((s) => s.status === "uploading");
  const hasContent = !!text.trim() || staged.some((s) => s.status === "done");
  const maxLen = useData((s) => s.server?.maxMessageLength ?? 20000);

  return (
    <div className={clsx("relative shrink-0 px-4", compact ? "pb-3" : "pb-5 max-md:pb-2", isAndroid && "safe-bottom")}>
      <AnimatePresence>
        {replyTo && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="flex items-center gap-2 rounded-t-xl bg-raised/70 px-3 py-2 text-[13px] text-fg-2">
              <span className="min-w-0 flex-1 truncate">
                {t("chat.replyingTo", { name: "" })}
                <strong className="text-fg">{displayName(data(), replyTo.author.id, guildId)}</strong>
              </span>
              {replyTo.author.id !== data().me?.id && (
                <button onClick={() => setReplyPing(!replyPing)} className={clsx("flex items-center gap-1 font-semibold", replyPing ? "text-sky" : "text-fg-3")}>
                  <AtSign size={14} /> {t("chat.replyMention")}
                </button>
              )}
              <button onClick={() => useUI.setState({ replyTo: { ...useUI.getState().replyTo, [channelId]: undefined } })} className="rounded-full p-0.5 text-fg-3 hover:text-fg" aria-label={t("common.cancel")}>
                <X size={16} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {staged.length > 0 && (
        <div className={clsx("scroll-thin flex gap-3 overflow-x-auto bg-raised/50 p-3", replyTo ? "" : "rounded-t-xl")}>
          {staged.map((s) => (
            <div key={s.id} className="group relative flex w-44 shrink-0 flex-col overflow-hidden rounded-xl bg-canvas/60 p-2 hairline anim-pop">
              <div className="relative flex h-28 items-center justify-center overflow-hidden rounded-lg bg-raised">
                {s.preview && s.file.type.startsWith("image/") ? (
                  <img src={s.preview} alt="" className={clsx("h-full w-full object-cover", s.spoiler && "blur-xl")} />
                ) : s.preview && s.file.type.startsWith("video/") ? (
                  <video src={s.preview} className={clsx("h-full w-full object-cover", s.spoiler && "blur-xl")} muted />
                ) : (
                  <FileText size={40} className="text-fg-3" />
                )}
                {s.status === "uploading" && (
                  <div className="absolute inset-x-2 bottom-2 h-1.5 overflow-hidden rounded-full bg-canvas/80">
                    <div className="h-full rounded-full bg-star transition-[width] duration-200" style={{ width: `${Math.round(s.progress * 100)}%` }} />
                  </div>
                )}
                {s.status === "error" && (
                  <button onClick={() => retryStaged(channelId, s.id)} className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bad/30 text-[12px] font-semibold text-white">
                    <RotateCw size={18} /> {t("common.retry")}
                  </button>
                )}
              </div>
              <div className="mt-1.5 truncate text-[12.5px] font-medium">{s.file.name}</div>
              <div className="text-[11px] text-fg-3">{s.status === "error" ? s.error : formatBytes(s.file.size)}</div>
              <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 touch-visible">
                <button onClick={() => toggleSpoiler(channelId, s.id)} className="rounded-md bg-canvas/90 p-1 text-fg-2 hover:text-fg" aria-label={t("chat.spoiler")} title={t("chat.spoiler")}>
                  {s.spoiler ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button onClick={() => removeStaged(channelId, s.id)} className="rounded-md bg-canvas/90 p-1 text-bad" aria-label={t("chat.removeAttachment")}>
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={clsx("relative flex items-end gap-1 bg-raised px-2 transition-shadow focus-within:shadow-[0_0_0_1px_rgb(var(--star)/0.35)]", replyTo || staged.length ? "rounded-b-xl" : "rounded-xl", !canSend && "opacity-60")}>
        {trigger && <AutocompleteList items={suggestions} index={acIndex} onPick={pickSuggestion} onHover={setAcIndex} />}
        {recording ? (
          <VoiceRecorder onDone={onVoiceDone} onCancel={() => setRecording(false)} />
        ) : (
          <>
            <button disabled={!canSend} onClick={plus.toggle} className="mb-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-2 transition-colors hover:bg-overlay hover:text-fg disabled:opacity-40" aria-label={t("common.more")}>
              <Plus size={20} className={clsx("transition-transform", plus.anchor && "rotate-45")} />
            </button>
            <textarea
              ref={ta}
              value={text}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              disabled={!canSend}
              placeholder={placeholder}
              rows={1}
              maxLength={maxLen}
              spellCheck
              enterKeyHint={mobile ? "enter" : "send"}
              className="scroll-thin max-h-[45vh] min-h-11 flex-1 resize-none bg-transparent py-[11px] text-[15.5px] leading-[22px] outline-none placeholder:text-fg-3"
            />
            {slowLeft > 0 && <span className="mb-3 flex shrink-0 items-center gap-1 text-[12px] tabular-nums text-fg-3"><Clock size={13} /> {slowLeft}</span>}
            {text.length > maxLen - 500 && <span className={clsx("mb-3 shrink-0 text-[12px] tabular-nums", text.length > maxLen - 50 ? "text-bad" : "text-fg-3")}>{maxLen - text.length}</span>}
            <button disabled={!canSend} onClick={emoji.toggle} className="mb-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-2 transition-[color,transform] hover:scale-110 hover:text-star disabled:opacity-40" aria-label={t("chat.emoji")}>
              <Smile size={21} />
            </button>
            {hasContent || !can(bits, Permission.SEND_VOICE_MESSAGES) ? (
              <button
                disabled={!canSend || !hasContent || uploading || slowLeft > 0}
                onClick={() => void send()}
                className={clsx("mb-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all", hasContent && !uploading ? "star-fill scale-100" : "text-fg-3 opacity-50", !mobile && !hasContent && "hidden")}
                aria-label={t("common.send")}
              >
                <Send size={16} />
              </button>
            ) : (
              <button disabled={!canSend} onClick={() => setRecording(true)} className="mb-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-2 hover:text-fg disabled:opacity-40" aria-label={t("chat.voiceMessage")}>
                <Mic size={20} />
              </button>
            )}
          </>
        )}
      </div>

      <Popover anchor={plus.anchor} onClose={plus.close} placement="top-start">
        <MenuList
          onClose={plus.close}
          items={[
            canAttach && { label: t("chat.attach"), icon: <Upload size={16} />, onSelect: pickFiles },
            can(bits, Permission.SEND_POLLS) && { label: t("chat.poll"), icon: <BarChart3 size={16} />, onSelect: () => useUI.getState().setModal({ kind: "poll", channelId }) },
            can(bits, Permission.SEND_VOICE_MESSAGES) && { label: t("chat.voiceMessage"), icon: <Mic size={16} />, onSelect: () => setRecording(true) },
            { label: t("chat.schedule"), icon: <Clock size={16} />, onSelect: () => useUI.getState().setModal({ kind: "schedule", channelId, content: textToTokens(text.trim(), map.current, data(), guildId, channelId) }) },
            hasContent && { label: t("chat.silent"), icon: <BellOff size={16} />, onSelect: () => void send({ silent: true }) },
          ]}
        />
      </Popover>
      <Popover anchor={emoji.anchor} onClose={emoji.close} placement="top-end">
        <EmojiPicker
          tabs={["emoji", "gif"]}
          closeOnPick={false}
          onClose={emoji.close}
          onPick={(e) => {
            if (e.custom) map.current = { ...map.current, [e.text]: `<${e.custom.animated ? "a" : ""}:${e.custom.name}:${e.custom.id}>` };
            insertAtCaret(e.text);
          }}
          onGif={sendGif}
        />
      </Popover>
    </div>
  );
}

/** Quick helper used by the channel's drop zone. */
export function dropFiles(channelId: string, files: FileList | File[]) {
  const s = data();
  if (!can(channelPerms(s, channelId), Permission.ATTACH_FILES)) return;
  stageFiles(channelId, [...files]);
}

export async function scheduleMessage(channelId: string, content: string, sendAt: Date) {
  await api(`/api/channels/${channelId}/scheduled`, { method: "POST", body: { content, sendAt: sendAt.toISOString() } });
}
