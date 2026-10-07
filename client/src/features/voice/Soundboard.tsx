// Soundboard UI: the grid of sounds behind the call's megaphone button (also
// in voice settings), and the dialog that adds or changes a sound. Built-in
// sounds, your own (on every device) and the ones shared with the server
// you're talking in.
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Copy, ImagePlus, Megaphone, Pencil, Play, Plus, Square, Trash2, Upload } from "lucide-react";
import { MAX_GUILD_SOUNDS, MAX_OWN_SOUNDS, type SoundDTO } from "@nova/shared";
import { errorText, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { decodeAudio, playBuffer } from "../../lib/sound";
import { mediaUrl } from "../../lib/server";
import { data, useData } from "../../store/data";
import { useUI } from "../../store/ui";
import { settings, useSettings } from "../../store/settings";
import { Button, Field, Input, Slider } from "../../components/ui/primitives";
import { Modal, ModalFooter, ModalHeader, Popover, Tooltip, useContextMenu, useLongPress, usePopover, type MenuEntry } from "../../components/ui/overlay";
import { EmojiPicker } from "../chat/EmojiPicker";
import { BUILTIN_CLIPS, MAX_CLIP_SECONDS, checkClip, playClip, setSoundboardVolume, stopClips, useSoundboard } from "./clips";
import { addSound, canEdit, canReorder, copySound, editSound, removeSound, reorderSounds, sectionSounds, useExpressions } from "./expressions";
import { useVoice } from "./voice";

function ClipIcon({ emoji, picture, size = 28 }: { emoji: string | null; picture: string | null | undefined; size?: number }) {
  if (picture) return <img src={picture} alt="" draggable={false} className="rounded-lg object-cover" style={{ width: size + 4, height: size + 4 }} />;
  return (
    <span className="leading-none" style={{ fontSize: size }}>
      {emoji ?? "🔊"}
    </span>
  );
}

function Tile({ id, name, emoji, picture, onEdit }: { id: string; name: string; emoji: string | null; picture?: string | null; onEdit?: () => void }) {
  const playing = useSoundboard((s) => !!s.playing[id]);
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

function AddTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[82px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line/25 text-fg-3 transition-colors hover:border-star/60 hover:text-star"
    >
      <Plus size={22} />
      <span className="text-[11.5px] font-medium leading-tight">{t("soundboard.add")}</span>
    </button>
  );
}

// ── drag and drop between "Mine" and a server ────────────────────────────────
/** The sound being dragged (dataTransfer can't be read during dragover). */
let dragged: SoundDTO | null = null;

const sectionOf = (s: SoundDTO) => s.guildId ?? null;

async function dropInto(target: string | null, beforeId: string | null) {
  const s = dragged;
  dragged = null;
  if (!s) return;
  try {
    if (sectionOf(s) !== target) {
      // Across sections: a copy (yours → the server, the server's → yours).
      await copySound(s.id, target);
      toast(target ? t("soundboard.copiedToServer", { name: s.name }) : t("soundboard.copiedToMine", { name: s.name }), "success");
    } else if (canReorder(target) && beforeId !== s.id) {
      const me = data().me?.id;
      const list = sectionSounds(useExpressions.getState().sounds, (x) => (target ? x.guildId === target : !x.guildId && x.ownerId === me)).map((x) => x.id).filter((id) => id !== s.id);
      const at = beforeId ? list.indexOf(beforeId) : -1;
      list.splice(at < 0 ? list.length : at, 0, s.id);
      await reorderSounds(target, list);
    }
  } catch (e) {
    toast(errorText(e), "error");
  }
}

/** Right-click / long-press: the same moves for people without a mouse to drag with. */
function soundMenu(s: SoundDTO, servers: string[], onEdit: (id: string) => void): MenuEntry[] {
  const guilds = data().guilds;
  return [
    s.guildId && { label: t("soundboard.copyToMine"), icon: <Copy size={15} />, onSelect: () => void copySound(s.id, null).then(() => toast(t("soundboard.copiedToMine", { name: s.name }), "success"), (e) => toast(errorText(e), "error")) },
    ...servers
      .filter((gid) => gid !== s.guildId && guilds[gid])
      .map((gid) => ({
        label: t("soundboard.copyToServer", { name: guilds[gid].name }),
        icon: <Copy size={15} />,
        onSelect: () => void copySound(s.id, gid).then(() => toast(t("soundboard.copiedToServer", { name: s.name }), "success"), (e) => toast(errorText(e), "error")),
      })),
    canEdit(s) && { separator: true },
    canEdit(s) && { label: t("common.edit"), icon: <Pencil size={15} />, onSelect: () => onEdit(s.id) },
  ];
}

function SoundTile({ s, servers, onEdit }: { s: SoundDTO; servers: string[]; onEdit: (id: string) => void }) {
  const menu = useContextMenu();
  const long = useLongPress((e) => menu(e, soundMenu(s, servers, onEdit)));
  return (
    <div
      draggable
      onDragStart={(e) => {
        dragged = s;
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setData("text/plain", s.name);
      }}
      onDragEnd={() => (dragged = null)}
      onContextMenu={(e) => {
        e.preventDefault();
        menu(e, soundMenu(s, servers, onEdit));
      }}
      {...long}
      data-sound={s.id}
      className="cursor-grab active:cursor-grabbing"
    >
      <Tile id={s.id} name={s.name} emoji={s.emoji} picture={s.image ? mediaUrl(s.image, 96) : null} onEdit={canEdit(s) ? () => onEdit(s.id) : undefined} />
    </div>
  );
}

/** A section of tiles; `target` makes it a drop zone (null: your own sounds). */
function Section({ title, children, testId, target }: { title: string; children: React.ReactNode; testId?: string; target?: string | null }) {
  const [over, setOver] = useState(false);
  const accepts = target !== undefined;
  const copying = over && dragged && sectionOf(dragged) !== target;
  return (
    <section
      data-section={testId}
      onDragOver={(e) => {
        if (!accepts || !dragged) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = sectionOf(dragged) !== target ? "copy" : "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!accepts) return;
        e.preventDefault();
        setOver(false);
        const tile = (e.target as HTMLElement).closest("[data-sound]");
        void dropInto(target ?? null, tile?.getAttribute("data-sound") ?? null);
      }}
      className={clsx("rounded-xl transition-colors", over && "bg-star/10 outline-dashed outline-2 outline-offset-2 outline-star/60")}
    >
      <h4 className="mb-1.5 mt-3 flex items-center gap-2 truncate text-[12px] font-semibold uppercase tracking-wide text-fg-3">
        {title}
        {copying && <span className="normal-case tracking-normal text-star">{t("soundboard.dropToCopy")}</span>}
      </h4>
      <div className="grid grid-cols-4 gap-1.5">{children}</div>
    </section>
  );
}

/**
 * The grid itself. In a call it offers the built-in sounds, yours and the
 * server's; `embedded` (voice settings) shows yours and those of every server.
 */
export function SoundboardPanel({ onClose, embedded }: { onClose?: () => void; embedded?: boolean }) {
  const volume = useSoundboard((s) => s.volume);
  const othersVolume = useSettings((s) => s.soundboardVolume ?? 100);
  const sounding = useSoundboard((s) => Object.keys(s.playing).length > 0);
  const inCall = useVoice((s) => s.state === "connected");
  const callChannel = useVoice((s) => s.channelId);
  const callGuild = useData((s) => (callChannel ? (s.channels[callChannel]?.guildId ?? null) : null));
  const me = useData((s) => s.me?.id);
  const guilds = useData((s) => s.guilds);
  const sounds = useExpressions((s) => s.sounds);
  const supported = useExpressions((s) => s.supported);
  const mine = sectionSounds(sounds, (x) => !x.guildId && x.ownerId === me);
  // Settings: every server you're in that has sounds; a call: the server you're talking in.
  // Settings: every server you're in (empty ones too, to drag your sounds onto); a call: the server you're talking in.
  const serverIds = embedded ? Object.keys(guilds).sort((a, b) => guilds[a].name.localeCompare(guilds[b].name)) : callGuild ? [callGuild] : [];
  const copyTargets = serverIds;

  const edit = (id?: string, guildId?: string | null) => {
    onClose?.();
    useUI.getState().pushModal({ kind: "sound", id, guildId });
  };
  return (
    <div className={clsx(!embedded && "menu-surface w-[min(372px,calc(100vw-16px))] rounded-2xl p-3 shadow-lift")} data-soundboard>
      {!embedded && <h3 className="mb-1.5 font-display text-[15px] font-semibold">{t("soundboard.title")}</h3>}
      <div className="flex items-center gap-2.5" title={t("soundboard.myVolumeHint")}>
        <span className="w-[92px] shrink-0 text-[12px] font-semibold text-fg-3">{t("soundboard.myVolume")}</span>
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
      <div className="mb-1 flex items-center gap-2.5 pr-[38px]" title={t("soundboard.othersVolumeHint")}>
        <span className="w-[92px] shrink-0 text-[12px] font-semibold text-fg-3">{t("soundboard.othersVolume")}</span>
        <Slider value={othersVolume} onChange={(v) => settings().setLocal({ soundboardVolume: v })} format={(v) => `${v}%`} className="min-w-0 flex-1" />
      </div>
      <div className={clsx(!embedded && "scroll-thin max-h-[min(400px,58vh)] overflow-y-auto pr-0.5")}>
        <Section title={t("soundboard.builtin")} testId="builtin">
          {BUILTIN_CLIPS.map((c) => (
            <Tile key={c.id} id={c.id} name={t(`soundboard.sounds.${c.id}`)} emoji={c.icon} />
          ))}
        </Section>
        {supported ? (
          <>
            {serverIds.length > 0 && <p className="mt-2 text-[11.5px] leading-snug text-fg-3">{t("soundboard.dragHint")}</p>}
            <Section title={t("soundboard.mine")} testId="mine" target={null}>
              {mine.map((s) => (
                <SoundTile key={s.id} s={s} servers={copyTargets} onEdit={(id) => edit(id)} />
              ))}
              {mine.length < MAX_OWN_SOUNDS && <AddTile onClick={() => edit(undefined, null)} />}
            </Section>
            {serverIds.map((gid) => {
              const list = sectionSounds(sounds, (x) => x.guildId === gid);
              return (
                <Section key={gid} title={t("soundboard.server", { name: guilds[gid]?.name ?? "…" })} testId={`guild:${gid}`} target={gid}>
                  {list.map((s) => (
                    <SoundTile key={s.id} s={s} servers={copyTargets} onEdit={(id) => edit(id)} />
                  ))}
                  {list.length < MAX_GUILD_SOUNDS && <AddTile onClick={() => edit(undefined, gid)} />}
                </Section>
              );
            })}
          </>
        ) : (
          <p className="mt-3 text-[12.5px] text-fg-3">{t("soundboard.serverOld")}</p>
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

/** "Only me" or one of your servers. */
export function TargetSelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const guilds = useData((s) => s.guilds);
  const list = useMemo(() => Object.values(guilds).sort((a, b) => a.name.localeCompare(b.name)), [guilds]);
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-label={t("soundboard.where")} className="h-10 w-full rounded-lg bg-canvas px-3 outline-none ring-1 ring-line/10 focus:ring-star/60">
      <option value="">{t("soundboard.onlyMe")}</option>
      {list.map((g) => (
        <option key={g.id} value={g.id}>
          {t("soundboard.forServer", { name: g.name })}
        </option>
      ))}
    </select>
  );
}

export function SoundModal({ id, guildId, onClose }: { id?: string; guildId?: string | null; onClose: () => void }) {
  const existing = useExpressions((s) => s.sounds.find((x) => x.id === id));
  const guilds = useData((s) => s.guilds);
  const [name, setName] = useState(existing?.name ?? "");
  const [emoji, setEmoji] = useState<string | null>(existing?.emoji ?? "🔊");
  const [audio, setAudio] = useState<File | null>(null);
  const [target, setTarget] = useState<string | null>(guildId ?? null);
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

  const shownPicture = picture === undefined ? (existing?.image ? mediaUrl(existing.image, 96) : null) : pictureUrl;

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
      if (existing) await editSound(existing.id, { name, emoji, picture });
      else await addSound(audio!, { name, emoji, picture, guildId: target, filename: audio!.name });
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    try {
      await removeSound(existing.id);
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const where = existing ? (existing.guildId ? t("soundboard.forServer", { name: guilds[existing.guildId]?.name ?? "…" }) : t("soundboard.onlyMe")) : null;
  return (
    <Modal open onClose={onClose} width={460} label={existing ? t("soundboard.editTitle") : t("soundboard.addTitle")}>
      <ModalHeader title={existing ? t("soundboard.editTitle") : t("soundboard.addTitle")} subtitle={t("soundboard.addHint", { s: MAX_CLIP_SECONDS })} />
      <div className="flex flex-col gap-4 px-6 pb-5 pt-2">
        <Field label={t("soundboard.file")}>
          <div className="flex items-center gap-2">
            {!existing && (
              <Button variant="secondary" icon={<Upload size={16} />} onClick={pickAudio}>
                {audio ? t("soundboard.replaceFile") : t("soundboard.chooseFile")}
              </Button>
            )}
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
        <Field label={t("soundboard.where")} hint={existing ? undefined : t("soundboard.whereHint")}>
          {existing ? <p className="text-[14px] text-fg-2">{where}</p> : <TargetSelect value={target} onChange={setTarget} />}
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
