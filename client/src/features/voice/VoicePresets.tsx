// Voice changer presets of your own: the effects grid in voice settings (the
// built-in effects, yours and the ones shared with your servers) and the
// editor — sliders you can hear live, saved to your account or to a server.
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { MAX_GUILD_PRESETS, MAX_OWN_PRESETS, type VoiceParams, type VoicePresetDTO } from "@nova/shared";
import { errorText, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { useData } from "../../store/data";
import { useSettings } from "../../store/settings";
import { useUI } from "../../store/ui";
import { Button, Field, Input, Slider } from "../../components/ui/primitives";
import { Modal, ModalFooter, ModalHeader } from "../../components/ui/overlay";
import { DEFAULT_PARAMS, VOICE_EFFECTS, calibrateTrim } from "./effects";
import { addPreset, canEdit, editPreset, removePreset, useExpressions } from "./expressions";
import { startMicTest } from "./processor";
import { TargetSelect } from "./Soundboard";
import { holdMicForTest } from "./voice";

/** The name of whatever the voiceEffect setting holds. */
export function effectName(id: string, presets: VoicePresetDTO[]): string {
  if (id.startsWith("custom:")) {
    const p = presets.find((x) => x.id === id.slice("custom:".length));
    return p ? `${p.emoji ? p.emoji + " " : ""}${p.name}` : t("voice.fx.none");
  }
  return t(`voice.fx.${id}`);
}

/** Your presets and those shared with servers you're in, grouped. */
export function usePresetGroups(onlyGuild?: string | null): { title: string; guildId: string | null; items: VoicePresetDTO[] }[] {
  const presets = useExpressions((s) => s.presets);
  const me = useData((s) => s.me?.id);
  const guilds = useData((s) => s.guilds);
  const groups = [{ title: t("voice.fx.mine"), guildId: null as string | null, items: presets.filter((p) => !p.guildId && p.ownerId === me) }];
  const ids = [...new Set(presets.filter((p) => p.guildId && guilds[p.guildId]).map((p) => p.guildId!))];
  for (const gid of ids) if (onlyGuild === undefined || onlyGuild === gid) groups.push({ title: t("soundboard.server", { name: guilds[gid].name }), guildId: gid, items: presets.filter((p) => p.guildId === gid) });
  return groups;
}

const tile = (on: boolean) => clsx("relative flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl px-2 py-2.5 text-center text-[13.5px] font-semibold ring-1 transition-colors", on ? "bg-star/15 text-star ring-star/50" : "text-fg-2 ring-line/15 hover:bg-raised hover:text-fg");

/** Voice settings: built-in effects, then yours and your servers'. */
export function VoiceEffectsGrid() {
  const effect = useSettings((s) => s.voiceEffect);
  const setLocal = useSettings((s) => s.setLocal);
  const supported = useExpressions((s) => s.supported);
  const groups = usePresetGroups();
  const open = (id?: string, guildId?: string | null) => useUI.getState().pushModal({ kind: "voicePreset", id, guildId });
  return (
    <div className="flex flex-col gap-3 py-3" data-voice-effects>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {VOICE_EFFECTS.map((e) => (
          <button key={e} onClick={() => setLocal({ voiceEffect: e })} className={tile(effect === e)} aria-pressed={effect === e}>
            {t(`voice.fx.${e}`)}
          </button>
        ))}
      </div>
      {supported &&
        groups.map((g) => (
          <div key={g.guildId ?? "mine"} data-preset-group={g.guildId ?? "mine"}>
            <h4 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-fg-3">{g.title}</h4>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {g.items.map((p) => {
                const id = `custom:${p.id}` as const;
                return (
                  <div key={p.id} className="group/preset relative">
                    <button onClick={() => setLocal({ voiceEffect: id })} className={tile(effect === id)} aria-pressed={effect === id} data-preset={p.id}>
                      {p.emoji && <span className="text-[16px] leading-none">{p.emoji}</span>}
                      <span className="truncate">{p.name}</span>
                    </button>
                    {canEdit(p) && (
                      <button
                        onClick={() => open(p.id)}
                        aria-label={`${t("common.edit")}: ${p.name}`}
                        className="touch-visible absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-md bg-panel text-fg-2 opacity-0 shadow ring-1 ring-line/15 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/preset:opacity-100"
                      >
                        <Pencil size={11} />
                      </button>
                    )}
                  </div>
                );
              })}
              {g.items.length < (g.guildId ? MAX_GUILD_PRESETS : MAX_OWN_PRESETS) && (
                <button onClick={() => open(undefined, g.guildId)} className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-dashed border-line/25 px-2 text-[13px] font-semibold text-fg-3 transition-colors hover:border-star/60 hover:text-star">
                  <Plus size={15} /> {t("voice.fx.add")}
                </button>
              )}
            </div>
          </div>
        ))}
      {!supported && <p className="text-[12.5px] text-fg-3">{t("voice.fx.serverOld")}</p>}
    </div>
  );
}

// ── the editor ───────────────────────────────────────────────────────────────
type Knob = { key: keyof VoiceParams; min: number; max: number; step: number; fmt: (v: number) => string };
const pct = (v: number) => `${Math.round(v * 100)}%`;
const KNOBS: { title: string; knobs: Knob[] }[] = [
  { title: "pitch", knobs: [{ key: "pitch", min: -12, max: 12, step: 0.5, fmt: (v) => (v > 0 ? `+${v}` : `${v}`) }] },
  {
    title: "robot",
    knobs: [
      { key: "robot", min: 0, max: 1, step: 0.05, fmt: pct },
      { key: "robotHz", min: 20, max: 400, step: 5, fmt: (v) => `${v} Hz` },
    ],
  },
  { title: "drive", knobs: [{ key: "drive", min: 0, max: 1, step: 0.05, fmt: pct }] },
  {
    title: "tone",
    knobs: [
      { key: "lowpass", min: 300, max: 20_000, step: 100, fmt: (v) => (v >= 19_000 ? "—" : `${(v / 1000).toFixed(1)} kHz`) },
      { key: "highpass", min: 20, max: 3000, step: 10, fmt: (v) => (v <= 25 ? "—" : `${v} Hz`) },
    ],
  },
  {
    title: "echo",
    knobs: [
      { key: "echo", min: 0, max: 1, step: 0.05, fmt: pct },
      { key: "echoMs", min: 40, max: 900, step: 10, fmt: (v) => `${v} ms` },
    ],
  },
  {
    title: "reverb",
    knobs: [
      { key: "reverb", min: 0, max: 1, step: 0.05, fmt: pct },
      { key: "room", min: 0.2, max: 6, step: 0.1, fmt: (v) => `${v.toFixed(1)} s` },
    ],
  },
  {
    title: "tremolo",
    knobs: [
      { key: "tremolo", min: 0, max: 1, step: 0.05, fmt: pct },
      { key: "tremoloHz", min: 0.5, max: 20, step: 0.5, fmt: (v) => `${v} Hz` },
    ],
  },
];

const PRESET_EMOJI = ["🎙️", "🤖", "👹", "🐿️", "🗿", "👽", "📻", "🌊", "🏔️", "👻", "🎸", "🦖"];

export function VoicePresetModal({ id, guildId, onClose }: { id?: string; guildId?: string | null; onClose: () => void }) {
  const existing = useExpressions((s) => s.presets.find((p) => p.id === id));
  const guilds = useData((s) => s.guilds);
  const [name, setName] = useState(existing?.name ?? "");
  const [emoji, setEmoji] = useState<string | null>(existing?.emoji ?? "🎙️");
  const [params, setParams] = useState<VoiceParams>(existing?.params ?? DEFAULT_PARAMS);
  const [target, setTarget] = useState<string | null>(guildId ?? null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const test = useRef<{ stop: () => void; update: (p: VoiceParams) => void; release: () => void } | null>(null);

  const stopListening = () => {
    test.current?.stop();
    test.current?.release();
    test.current = null;
    setListening(false);
  };
  useEffect(() => () => stopListening(), []);
  useEffect(() => test.current?.update({ ...params, trim: 1 }), [params]);

  const listen = async () => {
    if (listening) return stopListening();
    const release = holdMicForTest();
    try {
      const stop = await startMicTest(() => {}, { ...params, trim: 1 });
      test.current = { stop, update: stop.update, release };
      setListening(true);
    } catch {
      release();
      toast(t("errors.microphone_denied"), "error");
    }
  };

  const set = (key: keyof VoiceParams, v: number) => setParams((p) => ({ ...p, [key]: v }));

  const save = async () => {
    setBusy(true);
    try {
      // Every preset is brought to the plain voice's loudness — no blasting the call.
      const tuned = { ...params, trim: await calibrateTrim(params) };
      if (existing) await editPreset(existing.id, { name, emoji, params: tuned });
      else {
        const p = await addPreset({ name, emoji, params: tuned, guildId: target });
        useSettings.getState().setLocal({ voiceEffect: `custom:${p.id}` });
      }
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
      await removePreset(existing.id);
      if (useSettings.getState().voiceEffect === `custom:${existing.id}`) useSettings.getState().setLocal({ voiceEffect: "none" });
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <Modal open onClose={onClose} width={520} label={existing ? t("voice.fx.editTitle") : t("voice.fx.newTitle")}>
      <ModalHeader title={existing ? t("voice.fx.editTitle") : t("voice.fx.newTitle")} subtitle={t("voice.fx.editorHint")} />
      <div className="scroll-thin flex max-h-[62vh] flex-col gap-4 overflow-y-auto px-6 pb-5 pt-2" data-preset-editor>
        <div className="flex items-end gap-2">
          <Field label={t("voice.fx.name")} className="min-w-0 flex-1">
            <Input value={name} maxLength={32} placeholder={t("voice.fx.untitled")} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button variant={listening ? "danger" : "secondary"} onClick={() => void listen()} className="h-11 shrink-0">
            {listening ? t("voice.fx.stopListen") : t("voice.fx.listen")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1">
          {PRESET_EMOJI.map((e) => (
            <button key={e} type="button" onClick={() => setEmoji(e)} className={clsx("flex h-8 w-8 items-center justify-center rounded-lg text-[19px] hover:bg-raised", emoji === e && "bg-star/20")}>
              {e}
            </button>
          ))}
        </div>
        {KNOBS.map((g) => (
          <div key={g.title} className="flex flex-col gap-1.5">
            <div className="text-[13px] font-semibold text-fg-2">{t(`voice.fx.knob.${g.title}`)}</div>
            {g.knobs.map((k) => (
              <div key={k.key} className="flex items-center gap-3">
                {g.knobs.length > 1 && <span className="w-28 shrink-0 text-[12.5px] text-fg-3">{t(`voice.fx.knob.${k.key}`)}</span>}
                <Slider value={params[k.key]} min={k.min} max={k.max} step={k.step} onChange={(v) => set(k.key, v)} format={k.fmt} className="min-w-0 flex-1" />
              </div>
            ))}
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={() => setParams(DEFAULT_PARAMS)} className="self-start">
          {t("voice.fx.reset")}
        </Button>
        <Field label={t("soundboard.where")} hint={existing ? undefined : t("voice.fx.whereHint")}>
          {existing ? (
            <p className="text-[14px] text-fg-2">{existing.guildId ? t("soundboard.forServer", { name: guilds[existing.guildId]?.name ?? "…" }) : t("soundboard.onlyMe")}</p>
          ) : (
            <TargetSelect value={target} onChange={setTarget} />
          )}
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
          <Button loading={busy} onClick={() => void save()}>
            {existing ? t("common.save") : t("common.add")}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
