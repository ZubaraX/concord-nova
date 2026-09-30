// Soundboard UI: the grid of sounds behind the call's megaphone button (also
// shown in voice settings), and the dialog that adds or changes a sound.
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ImagePlus, Megaphone, Pencil, Play, Plus, Square, Trash2, Upload, Volume2 } from "lucide-react";
import { t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { decodeAudio, playBuffer } from "../../lib/sound";
import { useUI } from "../../store/ui";
import { Button, Field, Input, Slider } from "../../components/ui/primitives";
import { Modal, ModalFooter, ModalHeader, Popover, Tooltip, usePopover } from "../../components/ui/overlay";
import { EmojiPicker } from "../chat/EmojiPicker";
import { BUILTIN_CLIPS, MAX_CLIP_SECONDS, MAX_CUSTOM_CLIPS, checkClip, clipIcon, deleteClip, playClip, saveClip, setSoundboardVolume, stopClips, useSoundboard, type CustomClip } from "./clips";
import { useVoice } from "./voice";

/** The picture of a custom sound (an object URL that lives as long as the component). */
function useClipPicture(clip: CustomClip | undefined): string | null {
  const rev = useSoundboard((s) => s.iconRev);
  const [url, setUrl] = useState<string | null>(null);
  const id = clip?.image ? clip.id : null;
  useEffect(() => {
    if (!id) return setUrl(null);
    let alive = true;
    let made: string | null = null;
    void clipIcon(id).then((blob) => {
      if (!alive || !blob) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id, rev]);
  return url;
}

function ClipIcon({ emoji, picture, size = 28 }: { emoji: string | null; picture: string | null; size?: number }) {
  if (picture) return <img src={picture} alt="" draggable={false} className="rounded-lg object-cover" style={{ width: size + 4, height: size + 4 }} />;
  return (
    <span className="leading-none" style={{ fontSize: size }}>
      {emoji ?? "🔊"}
    </span>
  );
}

function Tile({ id, name, emoji, custom, onEdit }: { id: string; name: string; emoji: string | null; custom?: CustomClip; onEdit?: () => void }) {
  const playing = useSoundboard((s) => !!s.playing[id]);
  const picture = useClipPicture(custom);
  return (
    <div className="group/clip relative">
      <button
        type="button"
        onClick={() => void playClip(id)}
        data-clip={id}
        data-playing={playing}
        title={name}
        className={clsx(
          "flex h-[82px] w-full flex-col items-center justify-center gap-1.5 rounded-xl px-1.5 transition-[background-color,box-shadow,transform] active:scale-95",
          playing ? "bg-star/15 shadow-[inset_0_0_0_1.5px_rgb(var(--star)/0.7)]" : "bg-raised hover:bg-overlay"
        )}
      >
        <ClipIcon emoji={emoji} picture={picture} />
        <span className="line-clamp-2 w-full text-center text-[11px] font-medium leading-[1.15] text-fg-2">{name}</span>
      </button>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`${t("common.edit")}: ${name}`}
          className="touch-visible absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md bg-canvas/80 text-fg-2 opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/clip:opacity-100"
        >
          <Pencil size={12} />
        </button>
      )}
    </div>
  );
}

/** The grid itself. `embedded` drops the popover chrome (voice settings). */
export function SoundboardPanel({ onClose, embedded }: { onClose?: () => void; embedded?: boolean }) {
  const custom = useSoundboard((s) => s.custom);
  const volume = useSoundboard((s) => s.volume);
  const sounding = useSoundboard((s) => Object.keys(s.playing).length > 0);
  const inCall = useVoice((s) => s.state === "connected");
  const edit = (id?: string) => {
    onClose?.();
    useUI.getState().pushModal({ kind: "sound", id });
  };
  return (
    <div className={clsx(!embedded && "menu-surface w-[min(372px,calc(100vw-16px))] rounded-2xl p-3 shadow-lift")} data-soundboard>
      <div className="mb-2.5 flex items-center gap-2.5">
        {!embedded && <h3 className="shrink-0 font-display text-[15px] font-semibold">{t("soundboard.title")}</h3>}
        <Volume2 size={15} className="shrink-0 text-fg-3" />
        <Slider value={volume} onChange={setSoundboardVolume} format={(v) => `${v}%`} className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={stopClips}
          disabled={!sounding}
          aria-label={t("soundboard.stop")}
          title={t("soundboard.stop")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-fg-2 transition-colors hover:bg-overlay hover:text-fg disabled:opacity-40"
        >
          <Square size={12} fill="currentColor" />
        </button>
      </div>
      <div className={clsx("grid grid-cols-4 gap-1.5", !embedded && "scroll-thin max-h-[min(362px,54vh)] overflow-y-auto")}>
        {BUILTIN_CLIPS.map((c) => (
          <Tile key={c.id} id={c.id} name={t(`soundboard.sounds.${c.id}`)} emoji={c.icon} />
        ))}
        {custom.map((c) => (
          <Tile key={c.id} id={c.id} name={c.name} emoji={c.emoji} custom={c} onEdit={() => edit(c.id)} />
        ))}
        {custom.length < MAX_CUSTOM_CLIPS && (
          <button
            type="button"
            onClick={() => edit()}
            className="flex h-[82px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line/25 text-fg-3 transition-colors hover:border-star/60 hover:text-star"
          >
            <Plus size={22} />
            <span className="text-[11.5px] font-medium leading-tight">{t("soundboard.add")}</span>
          </button>
        )}
      </div>
      <p className="mt-2.5 text-[12px] leading-snug text-fg-3">{inCall ? t("soundboard.hintCall") : t("soundboard.hintIdle")}</p>
    </div>
  );
}

/** The call's soundboard button with its popover. */
export function SoundboardButton({ className, iconSize = 21, tooltip = true }: { className?: string; iconSize?: number; tooltip?: boolean }) {
  const pop = usePopover();
  const sounding = useSoundboard((s) => Object.keys(s.playing).length > 0);
  const button = (
    <button type="button" onClick={pop.toggle} className={clsx(className, (pop.anchor || sounding) && "!bg-star/20 !text-star")} aria-label={t("soundboard.title")} aria-expanded={!!pop.anchor}>
      <Megaphone size={iconSize} />
    </button>
  );
  return (
    <>
      {tooltip ? <Tooltip content={t("soundboard.title")}>{button}</Tooltip> : button}
      <Popover anchor={pop.anchor} onClose={pop.close} placement="top">
        <SoundboardPanel onClose={pop.close} />
      </Popover>
    </>
  );
}

// ── add / change a sound ─────────────────────────────────────────────────────
const SUGGESTED = ["🔊", "😂", "🤣", "😱", "🤡", "💀", "🔥", "🎉", "👏", "😎", "🐱", "🐶", "🚀", "💩", "🎵", "⚡"];

export function SoundModal({ id, onClose }: { id?: string; onClose: () => void }) {
  const existing = useSoundboard((s) => s.custom.find((c) => c.id === id));
  const savedPicture = useClipPicture(existing);
  const [name, setName] = useState(existing?.name ?? "");
  const [emoji, setEmoji] = useState<string | null>(existing?.emoji ?? "🔊");
  const [audio, setAudio] = useState<File | null>(null);
  /** undefined — keep what is saved; null — no picture; a file — a new one. */
  const [picture, setPicture] = useState<File | null | undefined>(undefined);
  const [pictureUrl, setPictureUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pop = usePopover();
  const stopPreview = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!picture) return setPictureUrl(null);
    const url = URL.createObjectURL(picture);
    setPictureUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [picture]);
  useEffect(() => () => stopPreview.current?.(), []);

  const shownPicture = picture === undefined ? savedPicture : pictureUrl;

  const pick = (accept: string, then: (f: File) => void) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) then(f);
    };
    input.click();
  };

  const pickAudio = () =>
    pick("audio/*,video/webm,video/mp4", async (f) => {
      const verdict = await checkClip(f);
      if (verdict !== "ok") return toast(t(`soundboard.error.${verdict}`, { s: MAX_CLIP_SECONDS }), "error");
      setAudio(f);
      if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, "").slice(0, 32));
    });

  const pickPicture = () =>
    pick("image/*", (f) => {
      if (f.size > 8 * 1024 * 1024) return toast(t("soundboard.error.picture"), "error");
      setPicture(f);
    });

  const preview = async () => {
    stopPreview.current?.();
    if (audio) {
      const b = await decodeAudio(audio);
      if (b) stopPreview.current = playBuffer(b, useSoundboard.getState().volume / 100);
    } else if (id) void playClip(id, true);
  };

  const save = async () => {
    if (!existing && !audio) return;
    setBusy(true);
    try {
      await saveClip({ name, emoji, audio: audio ?? undefined, picture }, existing?.id);
      onClose();
    } catch {
      toast(t("soundboard.error.save"), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    await deleteClip(existing.id);
    onClose();
  };

  return (
    <Modal open onClose={onClose} width={440} label={existing ? t("soundboard.editTitle") : t("soundboard.addTitle")}>
      <ModalHeader title={existing ? t("soundboard.editTitle") : t("soundboard.addTitle")} subtitle={t("soundboard.addHint", { s: MAX_CLIP_SECONDS })} />
      <div className="flex flex-col gap-4 px-6 pb-5 pt-2">
        <Field label={t("soundboard.file")}>
          <div className="flex items-center gap-2">
            <Button variant="secondary" icon={<Upload size={16} />} onClick={pickAudio}>
              {audio || existing ? t("soundboard.replaceFile") : t("soundboard.chooseFile")}
            </Button>
            {(audio || existing) && (
              <Button variant="ghost" icon={<Play size={15} />} onClick={() => void preview()}>
                {t("soundboard.listen")}
              </Button>
            )}
          </div>
          {audio && <p className="truncate text-[12.5px] text-fg-3">{audio.name}</p>}
        </Field>
        <Field label={t("soundboard.name")}>
          <Input value={name} maxLength={32} placeholder={t("soundboard.namePlaceholder")} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        </Field>
        <Field label={t("soundboard.icon")} hint={t("soundboard.iconHint")}>
          <div className="flex items-start gap-3">
            <div className="flex h-[74px] w-[74px] shrink-0 items-center justify-center rounded-xl bg-raised" data-sound-icon>
              <ClipIcon emoji={emoji} picture={shownPicture} size={34} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap gap-1">
                {SUGGESTED.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => {
                      setEmoji(e);
                      setPicture(null);
                    }}
                    className={clsx("flex h-8 w-8 items-center justify-center rounded-lg text-[19px] transition-colors hover:bg-raised", !shownPicture && emoji === e && "bg-star/20")}
                  >
                    {e}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={pop.toggle}>
                  {t("soundboard.moreEmoji")}
                </Button>
                <Button variant="secondary" size="sm" icon={<ImagePlus size={14} />} onClick={pickPicture}>
                  {t("soundboard.picture")}
                </Button>
              </div>
            </div>
          </div>
        </Field>
      </div>
      <ModalFooter className={existing ? "justify-between" : undefined}>
        {existing && (
          <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => void remove()} className="!text-bad hover:!bg-bad/10">
            {t("common.delete")}
          </Button>
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} disabled={!existing && !audio} onClick={() => void save()}>
            {existing ? t("common.save") : t("common.add")}
          </Button>
        </div>
      </ModalFooter>
      <Popover anchor={pop.anchor} onClose={pop.close}>
        <EmojiPicker
          onClose={pop.close}
          onPick={(e) => {
            if (e.custom) return;
            setEmoji(e.text);
            setPicture(null);
          }}
        />
      </Popover>
    </Modal>
  );
}
