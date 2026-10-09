// The radio of each voice channel: the queue, what plays since when, the FM
// station if one is on, and the shared Yandex/VK links. Only this, in memory —
// the files themselves go from the adder's app to the others through the call,
// never through here.
import { RADIO_MAX_ITEMS, RADIO_MAX_LINKS, ulid, type RadioCurrentDTO, type RadioItemDTO, type RadioLinkDTO, type RadioStateDTO, type RadioStationDTO } from "@nova/shared";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { toChannel } from "../gateway/io";

/** A short grace after a track's end before the next starts (late starters finish it). */
const GRACE_MS = 800;
/** Played tracks kept to go back to. */
const HISTORY = 20;
/** "Previous" this far into a track starts it over; nearer its start, it goes to the track before. */
const RESTART_AFTER_MS = 5000;

interface Station {
  items: RadioItemDTO[];
  /** Played tracks, oldest first. */
  history: RadioItemDTO[];
  current: RadioCurrentDTO | null;
  links: RadioLinkDTO[];
  timer: unknown;
  /** The FM station on: it plays instead of the queue. */
  fm: RadioStationDTO | null;
  /** The queue was paused by the station (and goes on when it's turned off). */
  heldByFm: boolean;
}

export interface RadioDeps {
  now(): number;
  newId(): string;
  emit(channelId: string, state: RadioStateDTO): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class RadioManager {
  private stations = new Map<string, Station>();
  constructor(private readonly deps: RadioDeps) {}

  state(channelId: string): RadioStateDTO {
    const s = this.stations.get(channelId);
    return { channelId, items: s?.items ?? [], history: s?.history ?? [], current: s?.current ?? null, links: s?.links ?? [], station: s?.fm ?? null, serverNow: this.deps.now() };
  }

  /** Turns an FM station on (or switches to another): the music waits, paused where it was. */
  setStation(channelId: string, userId: string, input: { name: string; url: string; play: string; favicon: string | null }) {
    const s = this.station(channelId);
    if (s.current && s.current.pausedAt === null) {
      this.pause(channelId, false);
      s.heldByFm = true;
    }
    s.fm = { ...input, startedBy: userId, startedAt: this.deps.now() };
    this.send(channelId);
  }

  /** Turns the station off: music the station paused goes on. */
  clearStation(channelId: string) {
    const s = this.stations.get(channelId);
    if (!s?.fm) return;
    s.fm = null;
    if (s.heldByFm) {
      s.heldByFm = false;
      this.resume(channelId, false);
    }
    this.send(channelId);
  }

  add(channelId: string, userId: string, input: { kind: "file" | "link"; title: string; duration: number; url?: string }): RadioItemDTO {
    const s = this.station(channelId);
    if (s.items.length >= RADIO_MAX_ITEMS) throw badRequest("radio_full");
    const item: RadioItemDTO = { id: this.deps.newId(), kind: input.kind, title: input.title, duration: input.duration, addedBy: userId, url: input.kind === "link" ? (input.url ?? null) : null };
    s.items.push(item);
    if (!s.current) this.start(channelId, s);
    this.send(channelId);
    return item;
  }

  addLink(channelId: string, userId: string, input: { url: string; title?: string }, service: "yandex" | "vk"): RadioLinkDTO {
    const s = this.station(channelId);
    const link: RadioLinkDTO = { id: this.deps.newId(), service, url: input.url, title: input.title ?? null, image: null, addedBy: userId, at: this.deps.now() };
    s.links = [...s.links, link].slice(-RADIO_MAX_LINKS);
    this.send(channelId);
    return link;
  }

  /** A shared link's title and cover, read from its page after it was added. */
  updateLink(channelId: string, linkId: string, info: { title: string | null; image: string | null }) {
    const link = this.stations.get(channelId)?.links.find((l) => l.id === linkId);
    if (!link) return;
    link.title = info.title ?? link.title;
    link.image = info.image;
    this.send(channelId);
  }

  remove(channelId: string, userId: string, itemId: string, moderator: boolean) {
    const s = this.stations.get(channelId);
    const item = s?.items.find((i) => i.id === itemId);
    if (!s || !item) throw notFound("unknown_item");
    if (item.addedBy !== userId && !moderator) throw forbidden("not_yours");
    if (s.current?.itemId === itemId) return this.next(channelId, s, false);
    s.items = s.items.filter((i) => i.id !== itemId);
    this.send(channelId);
  }

  /** Skips the current track — only if it's still `itemId` (two people pressing at once skip one). */
  skip(channelId: string, itemId: string) {
    const s = this.stations.get(channelId);
    if (s?.current?.itemId === itemId) this.next(channelId, s);
  }

  /**
   * Back, from the track `itemId` (null: nothing plays — e.g. the queue ran out): far into
   * it, it starts over; near its start, the track before comes back, this one after it.
   * The id guards like skip's: two presses at once go back once.
   */
  previous(channelId: string, itemId: string | null) {
    const s = this.stations.get(channelId);
    if (!s || (s.current?.itemId ?? null) !== itemId) return;
    const at = s.current ? (s.current.pausedAt ?? this.deps.now() - s.current.startedAt) : 0;
    const back = s.history.at(-1);
    if (!back && !s.current) return;
    if (back && at <= RESTART_AFTER_MS) {
      s.history = s.history.slice(0, -1);
      s.items = [back, ...s.items];
    }
    this.deps.clearTimer(s.timer);
    this.start(channelId, s);
    this.send(channelId);
  }

  /** A queued track now: the current one counts as played, the others keep their order. */
  playNow(channelId: string, itemId: string) {
    const s = this.stations.get(channelId);
    const k = s ? s.items.findIndex((i) => i.id === itemId) : -1;
    if (!s || k < 0) throw notFound("unknown_item");
    if (k === 0) return;
    const item = s.items[k];
    const rest = s.items.filter((i) => i.id !== itemId);
    if (s.current) this.played(s, rest.shift()!);
    s.items = [item, ...rest];
    this.deps.clearTimer(s.timer);
    this.start(channelId, s);
    this.send(channelId);
  }

  pause(channelId: string, send = true) {
    const s = this.stations.get(channelId);
    if (!s?.current || s.current.pausedAt !== null) return;
    this.deps.clearTimer(s.timer);
    s.current = { ...s.current, pausedAt: this.deps.now() - s.current.startedAt };
    s.heldByFm = false; // paused by someone: stays paused after the station
    if (send) this.send(channelId);
  }

  resume(channelId: string, send = true) {
    const s = this.stations.get(channelId);
    if (!s?.current || s.current.pausedAt === null) return;
    s.current = { itemId: s.current.itemId, startedAt: this.deps.now() - s.current.pausedAt, pausedAt: null };
    this.schedule(channelId, s);
    if (send) this.send(channelId);
  }

  /** Someone left the call: their tracks that haven't started go; nobody left → the radio goes. */
  onLeave(channelId: string, userId: string, othersLeft: number) {
    const s = this.stations.get(channelId);
    if (!s) return;
    if (othersLeft === 0) {
      this.deps.clearTimer(s.timer);
      this.stations.delete(channelId);
      this.send(channelId);
      return;
    }
    const keep = s.current?.itemId;
    const before = s.items.length + s.history.length;
    s.items = s.items.filter((i) => i.addedBy !== userId || i.id === keep);
    // Their files left with them; links can still be gone back to.
    s.history = s.history.filter((i) => i.addedBy !== userId || i.kind === "link");
    if (s.items.length + s.history.length !== before) this.send(channelId);
  }

  private station(channelId: string): Station {
    let s = this.stations.get(channelId);
    if (!s) this.stations.set(channelId, (s = { items: [], history: [], current: null, links: [], timer: null, fm: null, heldByFm: false }));
    return s;
  }

  private start(channelId: string, s: Station) {
    const first = s.items[0];
    // Under a station a track waits at its start, until the station is turned off.
    const held = !!first && !!s.fm;
    s.current = first ? { itemId: first.id, startedAt: this.deps.now(), pausedAt: held ? 0 : null } : null;
    if (held) s.heldByFm = true;
    else if (first) this.schedule(channelId, s);
  }

  private schedule(channelId: string, s: Station) {
    this.deps.clearTimer(s.timer);
    const item = s.items[0];
    if (!item || !s.current) return;
    const left = item.duration * 1000 - (this.deps.now() - s.current.startedAt) + GRACE_MS;
    const id = item.id;
    s.timer = this.deps.setTimer(() => this.skip(channelId, id), Math.max(0, left));
  }

  /** On to the next track; the one that played goes to the history (unless it was taken out). */
  private next(channelId: string, s: Station, played = true) {
    this.deps.clearTimer(s.timer);
    if (played && s.items[0]) this.played(s, s.items[0]);
    s.items = s.items.slice(1);
    this.start(channelId, s);
    this.send(channelId);
  }

  private played(s: Station, item: RadioItemDTO) {
    s.history = [...s.history, item].slice(-HISTORY);
  }

  private send(channelId: string) {
    this.deps.emit(channelId, this.state(channelId));
  }
}

export const radio = new RadioManager({
  now: () => Date.now(),
  newId: ulid,
  emit: (channelId, state) => toChannel(channelId, "RADIO_STATE", state),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});
