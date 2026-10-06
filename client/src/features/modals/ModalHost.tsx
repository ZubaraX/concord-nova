import { lazy, Suspense } from "react";
import { useUI, type Modal as ModalState } from "../../store/ui";
import {
  AcceptInviteModal,
  BanModal,
  ConfirmModal,
  CreateChannelModal,
  CreateGuildModal,
  CustomStatusModal,
  InviteModal,
  NewDmModal,
  NickModal,
  PollModal,
  ScheduleModal,
  TimeoutModal,
} from "./basic";
import { ProfileModal } from "./ProfileModal";
import { ScreenPickerModal } from "./ScreenPicker";
import { ChannelSettingsModal } from "./ChannelSettings";

const UserSettings = lazy(() => import("../settings/UserSettings"));
const VoicePresetModal = lazy(() => import("../voice/VoicePresets").then((m) => ({ default: m.VoicePresetModal })));
const SoundModal = lazy(() => import("../voice/Soundboard").then((m) => ({ default: m.SoundModal })));
const GuildSettings = lazy(() => import("../settings/GuildSettings"));

const noop = () => {};

export function ModalHost() {
  const modal = useUI((s) => s.modal);
  const stack = useUI((s) => s.modalStack);
  const close = () => useUI.getState().popModal();
  if (!modal) return null;
  // The whole stack stays mounted — a confirmation over settings must not reset
  // the open tab, search or lists underneath it. Only the top entry can close.
  return [...stack, modal].map((m, i) => (
    <Suspense key={i} fallback={null}>
      {render(m, i === stack.length ? close : noop)}
    </Suspense>
  ));
}

function render(m: ModalState, close: () => void) {
  switch (m.kind) {
    case "createGuild":
      return <CreateGuildModal onClose={close} />;
    case "invite":
      return <InviteModal guildId={m.guildId} channelId={m.channelId} onClose={close} />;
    case "acceptInvite":
      return <AcceptInviteModal code={m.code} onClose={close} />;
    case "createChannel":
      return <CreateChannelModal guildId={m.guildId} parentId={m.parentId} type={m.type} onClose={close} />;
    case "channelSettings":
      return <ChannelSettingsModal channelId={m.channelId} onClose={close} />;
    case "guildSettings":
      return <GuildSettings guildId={m.guildId} tab={m.tab} onClose={close} />;
    case "userSettings":
      return <UserSettings tab={m.tab} onClose={close} />;
    case "profile":
      return <ProfileModal userId={m.userId} guildId={m.guildId ?? null} onClose={close} />;
    case "confirm":
      return <ConfirmModal {...m} onClose={close} />;
    case "poll":
      return <PollModal channelId={m.channelId} onClose={close} />;
    case "schedule":
      return <ScheduleModal channelId={m.channelId} content={m.content} onClose={close} />;
    case "newDm":
      return <NewDmModal onClose={close} />;
    case "status":
      return <CustomStatusModal onClose={close} />;
    case "ban":
      return <BanModal guildId={m.guildId} userId={m.userId} onClose={close} />;
    case "timeout":
      return <TimeoutModal guildId={m.guildId} userId={m.userId} onClose={close} />;
    case "nick":
      return <NickModal guildId={m.guildId} userId={m.userId} onClose={close} />;
    case "sound":
      return <SoundModal id={m.id} guildId={m.guildId ?? null} onClose={close} />;
    case "voicePreset":
      return <VoicePresetModal id={m.id} guildId={m.guildId ?? null} onClose={close} />;
    case "screenPicker":
      return <ScreenPickerModal resolve={m.resolve} onClose={close} />;
    default:
      return null;
  }
}
