// The music player: a shared Yandex Music / VK link playing on this device, in
// a corner of the app (MusicDock), so it keeps playing with the radio panel
// closed. The desktop app plays both, in the services' own pages; a browser
// can only show Yandex's widget (VK doesn't allow embedding its site).
import { create } from "zustand";
import type { RadioLinkDTO } from "@nova/shared";
import { isDesktop } from "../../lib/platform";
import { yandexEmbed } from "./musicLinks";

export const useMusic = create<{ link: RadioLinkDTO | null; min: boolean }>(() => ({ link: null, min: false }));

/** Plays in the app's player (else it opens the service). */
export const playsHere = (link: RadioLinkDTO) => isDesktop || !!yandexEmbed(link.url);

export const openMusic = (link: RadioLinkDTO) => useMusic.setState({ link, min: false });
export const closeMusic = () => useMusic.setState({ link: null, min: false });
export const setMusicMin = (min: boolean) => useMusic.setState({ min });
