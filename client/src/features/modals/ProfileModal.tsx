import { useEffect, useState } from "react";
import clsx from "clsx";
import { MessageSquare, Phone, UserPlus, Plus, X, Crown, Clock } from "lucide-react";
import { Permission, RelationshipType, type MemberDTO, type ProfileDTO } from "@nova/shared";
import { api } from "../../lib/api";
import { errorText, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import { fmtDate, fmtDateTime } from "../../lib/time";
import { mediaUrl } from "../../lib/server";
import { can, displayName, guildPerms, useData } from "../../store/data";
import { navigate } from "../../store/ui";
import { Modal } from "../../components/ui/overlay";
import { Button } from "../../components/ui/primitives";
import { GuildIcon, UserAvatar } from "../../components/ui/avatar";
import { Markdown } from "../chat/markdown";
import { callUser, openDmWith } from "../shell/menus";
import { activityText } from "../people/presence";
import { UserVolume } from "../voice/VoiceStage";
import { useVoice } from "../voice/voice";
import { MenuList, Popover, usePopover } from "../../components/ui/overlay";

interface ProfileRes {
  user: ProfileDTO;
  mutualGuilds: string[];
  mutualFriends: string[];
  relationship: number | null;
  member: MemberDTO | null;
}

export function ProfileModal({ userId, guildId, onClose }: { userId: string; guildId: string | null; onClose: () => void }) {
  const [data, setData] = useState<ProfileRes | null>(null);
  const [tab, setTab] = useState<"about" | "servers" | "friends">("about");
  const me = useData((s) => s.me?.id);
  const presence = useData((s) => s.presences[userId]);
  const member = useData((s) => (guildId ? s.members[guildId]?.[userId] : undefined));
  const roles = useData((s) => (guildId ? s.roles[guildId] : undefined));
  const bits = useData((s) => guildPerms(s, guildId));
  const guilds = useData((s) => s.guilds);
  const inCall = useVoice((s) => !!s.channelId) && useData.getState().voiceStates[userId]?.channelId === useVoice.getState().channelId;
  const addRole = usePopover();

  useEffect(() => {
    api<ProfileRes>(`/api/users/${userId}/profile`, { query: { guildId: guildId ?? undefined } })
      .then(setData)
      .catch((e) => toast(errorText(e), "error"));
  }, [userId, guildId]);

  const u = data?.user;
  const self = userId === me;
  const accent = u?.accentColor ? `#${u.accentColor.toString(16).padStart(6, "0")}` : null;
  const canRoles = !!guildId && can(bits, Permission.MANAGE_ROLES);
  const memberRoles = (member?.roles ?? []).map((id) => roles?.[id]).filter(Boolean).sort((a, b) => b!.position - a!.position);
  const s = useData.getState();
  const setRoles = (next: string[]) => void api(`/api/guilds/${guildId}/members/${userId}`, { method: "PATCH", body: { roles: next } }).catch((e) => toast(errorText(e), "error"));

  return (
    <Modal open onClose={onClose} width={600} className="!bg-panel">
      <div className="relative h-[150px] overflow-hidden" style={{ background: accent ?? "linear-gradient(120deg, rgb(var(--star) / 0.45), rgb(var(--sky-glow) / 0.6))" }}>
        {u?.banner && <img src={mediaUrl(u.banner, 600)} alt="" className="h-full w-full object-cover" />}
      </div>
      <div className="relative px-5 pb-5">
        <div className="-mt-[52px] flex items-end justify-between">
          <div className="rounded-full bg-panel p-1.5">
            <UserAvatar userId={userId} size={96} statusRing="ring-panel" />
          </div>
          <div className="mb-2 flex gap-2">
            {!self && data?.relationship === RelationshipType.FRIEND && (
              <>
                <Button size="sm" icon={<MessageSquare size={15} />} onClick={() => void openDmWith(userId).then(onClose)}>
                  {t("profile.sendMessage")}
                </Button>
                <Button size="sm" variant="secondary" icon={<Phone size={15} />} onClick={() => void callUser(userId).then(onClose)} aria-label={t("friends.call")} />
              </>
            )}
            {!self && data && data.relationship !== RelationshipType.FRIEND && data.relationship !== RelationshipType.BLOCKED && (
              <>
                {data.relationship !== RelationshipType.OUTGOING && (
                  <Button size="sm" variant="success" icon={<UserPlus size={15} />} onClick={() => void api(`/api/users/@me/relationships/${userId}`, { method: "PUT", body: {} }).then(() => setData({ ...data, relationship: RelationshipType.OUTGOING })).catch((e) => toast(errorText(e), "error"))}>
                    {data.relationship === RelationshipType.INCOMING ? t("friends.accept") : t("friends.add")}
                  </Button>
                )}
                <Button size="sm" variant="secondary" icon={<MessageSquare size={15} />} onClick={() => void openDmWith(userId).then(onClose).catch((e) => toast(errorText(e), "error"))}>
                  {t("friends.message")}
                </Button>
              </>
            )}
          </div>
        </div>
        <div className="mt-2 rounded-2xl bg-canvas/60 p-4 hairline">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-[21px] font-semibold tracking-[-0.01em]">{u ? displayName(s, userId, guildId) : "…"}</h2>
            {guildId && guilds[guildId]?.ownerId === userId && <Crown size={16} className="text-warn" />}
          </div>
          <div className="text-[14px] text-fg-2">
            @{u?.username}
            {u?.pronouns ? ` · ${u.pronouns}` : ""}
          </div>
          {activityText(presence) && <div className="mt-2 text-[14px]">{activityText(presence)}</div>}
          {member?.timeoutUntil && (
            <div className="mt-2 flex items-center gap-1.5 text-[13px] text-bad">
              <Clock size={14} /> {t("profile.timedOut", { time: fmtDateTime(member.timeoutUntil) })}
            </div>
          )}

          {!self && (data?.mutualGuilds.length || data?.mutualFriends.length) ? (
            <div className="mt-4 flex gap-1 border-b border-line/10">
              {(["about", "servers", "friends"] as const).map((x) => (
                <button key={x} onClick={() => setTab(x)} className={clsx("-mb-px border-b-2 px-2 pb-2 text-[13.5px] font-semibold", tab === x ? "border-star text-fg" : "border-transparent text-fg-3 hover:text-fg-2")}>
                  {x === "about" ? t("profile.about") : x === "servers" ? `${t("profile.mutualServers")} (${data?.mutualGuilds.length ?? 0})` : `${t("profile.mutualFriends")} (${data?.mutualFriends.length ?? 0})`}
                </button>
              ))}
            </div>
          ) : null}

          {tab === "about" && (
            <div className="mt-4 flex flex-col gap-4">
              {u?.bio && (
                <section>
                  <h4 className="mb-1 text-[12.5px] font-semibold text-fg-3">{t("profile.about")}</h4>
                  <Markdown content={u.bio} guildId={guildId} className="text-[14px]" />
                </section>
              )}
              <section className="flex gap-8">
                <div>
                  <h4 className="mb-1 text-[12.5px] font-semibold text-fg-3">{t("profile.memberSince")}</h4>
                  <div className="text-[14px]">{u ? fmtDate(u.createdAt) : "…"}</div>
                </div>
                {member && (
                  <div>
                    <h4 className="mb-1 text-[12.5px] font-semibold text-fg-3">{t("profile.joinedServer")}</h4>
                    <div className="text-[14px]">{fmtDate(member.joinedAt)}</div>
                  </div>
                )}
              </section>
              {guildId && member && (
                <section>
                  <h4 className="mb-1.5 text-[12.5px] font-semibold text-fg-3">{t("profile.roles")}</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {memberRoles.map((r) => (
                      <span key={r!.id} className="group flex items-center gap-1.5 rounded-lg bg-raised px-2 py-1 text-[12.5px] font-medium">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: r!.color ? `#${r!.color.toString(16).padStart(6, "0")}` : "rgb(var(--fg-3))" }} />
                        {r!.name}
                        {canRoles && (
                          <button onClick={() => setRoles(member.roles.filter((x) => x !== r!.id))} className="text-fg-3 opacity-0 hover:text-bad group-hover:opacity-100" aria-label={t("common.remove")}>
                            <X size={12} />
                          </button>
                        )}
                      </span>
                    ))}
                    {!memberRoles.length && <span className="text-[13px] text-fg-3">{t("profile.noRoles")}</span>}
                    {canRoles && (
                      <button onClick={addRole.toggle} className="flex h-[26px] w-[26px] items-center justify-center rounded-lg bg-raised text-fg-2 hover:text-fg" aria-label={t("profile.addRole")}>
                        <Plus size={14} />
                      </button>
                    )}
                  </div>
                </section>
              )}
              {inCall && !self && (
                <section className="rounded-xl bg-raised/50 p-3">
                  <UserVolume userId={userId} />
                </section>
              )}
            </div>
          )}
          {tab === "servers" && (
            <div className="mt-3 flex flex-col">
              {data?.mutualGuilds.map((gid) =>
                guilds[gid] ? (
                  <button
                    key={gid}
                    onClick={() => {
                      onClose();
                      navigate(gid);
                    }}
                    className="flex items-center gap-3 rounded-lg p-2 text-left hover:bg-raised/60"
                  >
                    <GuildIcon guildId={gid} name={guilds[gid].name} icon={guilds[gid].icon} size={36} />
                    <span className="font-medium">{guilds[gid].name}</span>
                  </button>
                ) : null
              )}
            </div>
          )}
          {tab === "friends" && (
            <div className="mt-3 flex flex-col">
              {data?.mutualFriends.map((fid) => (
                <div key={fid} className="flex items-center gap-3 rounded-lg p-2">
                  <UserAvatar userId={fid} size={32} statusRing="ring-canvas" />
                  <span className="font-medium">{displayName(s, fid)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <Popover anchor={addRole.anchor} onClose={addRole.close}>
        <MenuList
          onClose={addRole.close}
          items={Object.values(roles ?? {})
            .filter((r) => r.id !== guildId && !member?.roles.includes(r.id))
            .sort((a, b) => b.position - a.position)
            .map((r) => ({
              label: r.name,
              icon: <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : "rgb(var(--fg-3))" }} />,
              onSelect: () => setRoles([...(member?.roles ?? []), r.id]),
            }))}
        />
      </Popover>
    </Modal>
  );
}
