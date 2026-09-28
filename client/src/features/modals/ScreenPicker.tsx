// Desktop screen/window picker, shown when the Electron main process asks
// which source to capture (session.setDisplayMediaRequestHandler).
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Monitor, AppWindow } from "lucide-react";
import { t } from "../../lib/i18n";
import { Modal, ModalFooter, ModalHeader } from "../../components/ui/overlay";
import { Button, Segmented, Switch } from "../../components/ui/primitives";
import { settings, useSettings } from "../../store/settings";

interface Source {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
  isScreen: boolean;
}

export function ScreenPickerModal({ resolve, onClose }: { resolve: (r: { id: string | null; audio: boolean } | null) => void; onClose: () => void }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [tab, setTab] = useState<"screens" | "windows">("screens");
  const [picked, setPicked] = useState<string | null>(null);
  const [audio, setAudio] = useState(true);
  const quality = useSettings((s) => s.screenQuality);

  useEffect(() => {
    void window.nova?.getSources().then((list) => {
      setSources(list);
      setPicked(list.find((s) => s.isScreen)?.id ?? list[0]?.id ?? null);
    });
  }, []);

  const finish = (r: { id: string | null; audio: boolean } | null) => {
    resolve(r);
    onClose();
  };
  const list = (sources ?? []).filter((s) => (tab === "screens" ? s.isScreen : !s.isScreen));

  return (
    <Modal open onClose={() => finish(null)} width={720}>
      <ModalHeader title={t("voice.pickScreen")} />
      <div className="px-6">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "screens", label: t("voice.screens") },
            { value: "windows", label: t("voice.windows") },
          ]}
        />
      </div>
      <div className="scroll-thin grid max-h-[50vh] grid-cols-2 gap-3 overflow-y-auto p-6 sm:grid-cols-3">
        {!sources && Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton aspect-video rounded-xl" />)}
        {list.map((s) => (
          <button key={s.id} onClick={() => setPicked(s.id)} onDoubleClick={() => finish({ id: s.id, audio })} className={clsx("flex flex-col gap-2 rounded-xl p-2 text-left ring-2 transition-colors", picked === s.id ? "bg-star/10 ring-star" : "ring-transparent hover:bg-raised")}>
            <img src={s.thumbnail} alt="" className="aspect-video w-full rounded-lg bg-canvas object-contain" />
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
              {s.appIcon ? <img src={s.appIcon} alt="" className="h-4 w-4" /> : s.isScreen ? <Monitor size={14} /> : <AppWindow size={14} />}
              <span className="truncate">{s.name}</span>
            </span>
          </button>
        ))}
      </div>
      <ModalFooter className="justify-between">
        <div className="flex items-center gap-5">
          <label className="flex items-center gap-2 text-[14px] font-medium">
            <Switch checked={audio} onChange={setAudio} /> {t("voice.shareAudio")}
          </label>
          <select value={quality} onChange={(e) => settings().setLocal({ screenQuality: e.target.value as typeof quality })} className="h-9 rounded-lg bg-canvas px-2 text-[13px] outline-none ring-1 ring-line/10">
            <option value="720p30">720p · 30</option>
            <option value="1080p30">1080p · 30</option>
            <option value="1080p60">1080p · 60</option>
            <option value="1440p60">1440p · 60</option>
            <option value="source">{t("voice.qualitySource")} · 60</option>
          </select>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => finish(null)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!picked} onClick={() => finish({ id: picked, audio })}>
            {t("voice.startSharing")}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
