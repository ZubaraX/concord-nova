import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Hash, Volume2, Users, Search } from "lucide-react";
import { t } from "../../lib/i18n";
import { channelTitle, dmPartner, isUnread, useData } from "../../store/data";
import { navigate, useUI } from "../../store/ui";
import { Modal } from "../../components/ui/overlay";
import { GuildIcon, UserAvatar } from "../../components/ui/avatar";
import { openDmWith } from "./menus";

interface Hit {
  key: string;
  label: string;
  sub?: string;
  icon: React.ReactNode;
  score: number;
  go: () => void;
}

function fuzzy(text: string, q: string): number {
  const a = text.toLowerCase().replace(/ё/g, "е");
  const b = q.toLowerCase().replace(/ё/g, "е");
  if (!b) return 1;
  if (a.startsWith(b)) return 100 - a.length / 100;
  if (a.includes(b)) return 60 - a.indexOf(b);
  let i = 0;
  for (const ch of a) if (ch === b[i]) i++;
  return i === b.length ? 20 : 0;
}

export function QuickSwitcher() {
  const open = useUI((s) => s.switcher);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const s = useData();
  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);

  const hits = useMemo<Hit[]>(() => {
    if (!open) return [];
    const out: Hit[] = [];
    const mode = q.startsWith("#") ? "#" : q.startsWith("@") ? "@" : q.startsWith("*") ? "*" : "";
    const needle = mode ? q.slice(1) : q;
    if (mode === "" || mode === "#") {
      for (const c of Object.values(s.channels)) {
        if (!c.guildId || c.type === "category") continue;
        const sc = fuzzy(c.name, needle) + (isUnread(s, c.id) ? 5 : 0);
        if (sc > 0)
          out.push({
            key: c.id,
            label: c.name,
            sub: s.guilds[c.guildId]?.name,
            icon: c.type === "voice" ? <Volume2 size={18} /> : <Hash size={18} />,
            score: sc,
            go: () => navigate(c.guildId!, c.id),
          });
      }
    }
    if (mode === "" || mode === "@") {
      for (const c of Object.values(s.channels)) {
        if (c.type !== "dm" && c.type !== "group_dm") continue;
        const title = channelTitle(s, c);
        const partner = c.type === "dm" ? dmPartner(s, c) : undefined;
        const sc = Math.max(fuzzy(title, needle), partner ? fuzzy(partner.username, needle) : 0) + 3;
        if (sc > 3 || !needle)
          out.push({ key: c.id, label: title, sub: partner ? `@${partner.username}` : undefined, icon: partner ? <UserAvatar userId={partner.id} size={22} /> : <Users size={18} />, score: sc, go: () => navigate("@me", c.id) });
      }
      if (needle) {
        const seen = new Set(out.map((h) => h.key));
        for (const u of Object.values(s.users)) {
          if (u.id === s.me?.id) continue;
          const sc = Math.max(fuzzy(u.displayName ?? "", needle), fuzzy(u.username, needle));
          if (sc > 0 && !seen.has(u.id)) out.push({ key: `u${u.id}`, label: u.displayName || u.username, sub: `@${u.username}`, icon: <UserAvatar userId={u.id} size={22} />, score: sc - 5, go: () => void openDmWith(u.id) });
        }
      }
    }
    if (mode === "" || mode === "*") {
      for (const g of Object.values(s.guilds)) {
        const sc = fuzzy(g.name, needle);
        if (sc > 0) out.push({ key: g.id, label: g.name, icon: <GuildIcon guildId={g.id} name={g.name} icon={g.icon} size={22} />, score: sc - 2, go: () => navigate(g.id) });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 12);
  }, [open, q, s]);

  const close = () => useUI.setState({ switcher: false });
  const pick = (h: Hit | undefined) => {
    if (!h) return;
    close();
    h.go();
  };

  return (
    <Modal open={open} onClose={close} width={560} closeButton={false} label={t("switcher.placeholder")}>
      <div className="p-4">
        <div className="relative">
          <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-3" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(hits.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") pick(hits[idx]);
            }}
            placeholder={t("switcher.placeholder")}
            className="h-12 w-full rounded-xl bg-canvas/80 pl-11 pr-4 text-[17px] outline-none ring-1 ring-line/10 focus:ring-star/60"
          />
        </div>
        <div className="scroll-thin mt-3 max-h-[50vh] overflow-y-auto">
          {hits.map((h, i) => (
            <button key={h.key} onMouseEnter={() => setIdx(i)} onClick={() => pick(h)} className={clsx("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left", i === idx ? "bg-raised" : "")}>
              <span className="flex w-6 justify-center text-fg-3">{h.icon}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{h.label}</span>
              {h.sub && <span className="shrink-0 truncate text-[12.5px] text-fg-3">{h.sub}</span>}
            </button>
          ))}
        </div>
        <div className="mt-3 text-[12px] text-fg-3">{t("switcher.hint")} · {t("switcher.prefixes")}</div>
      </div>
    </Modal>
  );
}
