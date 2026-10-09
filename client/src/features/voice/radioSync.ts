// The radio's small decisions, kept free of the page and the call so they can
// be tested on their own: what a file is called, when the player stops, seeks
// or plays, and what bookkeeping may be let go.

/** A title from a file name, or (`fromUrl`) from the last part of a link, which may be %-encoded. */
export function titleOf(name: string, fromUrl = false): string {
  let s = name;
  if (fromUrl) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* not encoded after all ("100% Love") */
    }
  }
  return s.replace(/\.[^./]+$/, "").replace(/_+/g, " ").trim().slice(0, 200) || "—";
}

/**
 * What to do with the element's source for the current track:
 * keep it, switch to the new one, wait for a file that's on its way, or — when
 * the old track is still loaded and the new one's file hasn't come — stop it.
 */
export function sourceStep(loadedFor: string | null, itemId: string, src: string | undefined): "keep" | "switch" | "wait" | "stop" {
  if (loadedFor === itemId) return "keep";
  if (src) return "switch";
  return loadedFor ? "stop" : "wait";
}

/** Play only inside the track: never an ended element (play() would start it over), never past the file's own end. */
export function shouldPlay(el: { ended: boolean; duration: number }, target: number, itemDuration: number): boolean {
  if (el.ended || target >= itemDuration) return false;
  return !(Number.isFinite(el.duration) && target >= el.duration - 0.05);
}

/** Seek when off by more than 0.3 s — not while a seek is still under way, and not before there's data to play (except the first seek of a track). */
export function shouldSeek(el: { currentTime: number; readyState: number; seeking: boolean }, target: number, first: boolean): boolean {
  if (el.seeking || Math.abs(el.currentTime - target) <= 0.3) return false;
  return first ? el.readyState >= 1 : el.readyState >= 3;
}

/**
 * Of the `tracked` ids, those that were in the queue once and aren't now. `seen`
 * learns the live ones as it goes, so an id that hasn't reached the queue yet
 * (the add's answer can come before the server's update) is kept.
 */
export function goneIds(tracked: Iterable<string>, seen: Set<string>, live: Set<string>): string[] {
  for (const id of live) seen.add(id);
  const gone = [...tracked].filter((id) => seen.has(id) && !live.has(id));
  for (const id of gone) seen.delete(id);
  return gone;
}

/** A state replaces the one held only if it isn't older (a slow GET mustn't undo a newer update). */
export function isNewer(held: { serverNow: number } | undefined, next: { serverNow: number }): boolean {
  return !held || next.serverNow >= held.serverNow;
}
