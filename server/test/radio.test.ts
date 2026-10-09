import { describe, expect, it } from "vitest";
import type { RadioStateDTO } from "@nova/shared";
import { RadioManager } from "../src/state/radio";

function make() {
  let t = 1_000_000;
  let n = 0;
  const sent: RadioStateDTO[] = [];
  const timers: { at: number; fn: () => void; on: boolean }[] = [];
  const m = new RadioManager({
    now: () => t,
    newId: () => `id${++n}`,
    emit: (_c, s) => sent.push(s),
    setTimer: (fn, ms) => {
      const h = { at: t + ms, fn, on: true };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      // Like clearTimeout: nothing to clear is fine.
      if (h) (h as { on: boolean }).on = false;
    },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const h of timers) if (h.on && h.at <= t) (h.on = false), h.fn();
  };
  return { m, sent, advance, now: () => t };
}
const song = (title: string, duration = 100) => ({ kind: "file" as const, title, duration });

describe("RadioManager", () => {
  it("the first track starts at once; the next follows when it ends", () => {
    const { m, advance, now } = make();
    m.add("c", "alice", song("A"));
    m.add("c", "bob", song("B"));
    expect(m.state("c").current).toEqual({ itemId: "id1", startedAt: now(), pausedAt: null });
    advance(101_600);
    expect(m.state("c").items.map((i) => i.title)).toEqual(["B"]);
    expect(m.state("c").current?.itemId).toBe("id2");
    advance(101_600);
    expect(m.state("c").current).toBeNull();
    expect(m.state("c").items).toEqual([]);
  });

  it("skip carries the id: two skips at once skip one track", () => {
    const { m } = make();
    m.add("c", "a", song("A"));
    m.add("c", "a", song("B"));
    m.add("c", "a", song("C"));
    m.skip("c", "id1");
    m.skip("c", "id1");
    expect(m.state("c").items.map((i) => i.title)).toEqual(["B", "C"]);
  });

  it("pause keeps the position; resume continues from it", () => {
    const { m, advance, now } = make();
    m.add("c", "a", song("A", 100));
    advance(30_000);
    m.pause("c");
    expect(m.state("c").current?.pausedAt).toBe(30_000);
    advance(500_000); // paused: no advance
    expect(m.state("c").current?.itemId).toBe("id1");
    m.resume("c");
    expect(m.state("c").current).toEqual({ itemId: "id1", startedAt: now() - 30_000, pausedAt: null });
  });

  it("only the adder or a moderator removes an item", () => {
    const { m } = make();
    m.add("c", "a", song("A"));
    m.add("c", "a", song("B"));
    expect(() => m.remove("c", "b", "id2", false)).toThrow();
    m.remove("c", "b", "id2", true);
    expect(m.state("c").items.map((i) => i.title)).toEqual(["A"]);
  });

  it("removing the current item moves on", () => {
    const { m } = make();
    m.add("c", "a", song("A"));
    m.add("c", "a", song("B"));
    m.remove("c", "a", "id1", false);
    expect(m.state("c").current?.itemId).toBe("id2");
  });

  it("a leaver's not-started items go; their current one keeps playing", () => {
    const { m } = make();
    m.add("c", "a", song("A"));
    m.add("c", "b", song("B"));
    m.add("c", "a", song("C"));
    m.onLeave("c", "a", 1);
    expect(m.state("c").items.map((i) => i.title)).toEqual(["A", "B"]);
    expect(m.state("c").current?.itemId).toBe("id1");
  });

  it("the last one leaving drops the radio", () => {
    const { m, sent } = make();
    m.add("c", "a", song("A"));
    m.onLeave("c", "a", 0);
    expect(m.state("c")).toMatchObject({ items: [], current: null, links: [] });
    expect(sent.at(-1)).toMatchObject({ channelId: "c", items: [], current: null });
  });

  it("limits: 50 items, 20 links (oldest dropped)", () => {
    const { m } = make();
    for (let i = 0; i < 50; i++) m.add("c", "a", song(`S${i}`));
    expect(() => m.add("c", "a", song("too many"))).toThrow();
    for (let i = 0; i < 25; i++) m.addLink("c", "a", { url: `https://music.yandex.ru/track/${i}` }, "yandex");
    const links = m.state("c").links;
    expect(links).toHaveLength(20);
    expect(links[0].url).toBe("https://music.yandex.ru/track/5");
  });

  it("every change is sent, with the server clock", () => {
    const { m, sent, now } = make();
    m.add("c", "a", song("A"));
    expect(sent.at(-1)).toMatchObject({ channelId: "c", serverNow: now() });
  });
});

describe("RadioManager — FM station", () => {
  const europa = { name: "Европа Плюс", url: "http://ep256.hostingradio.ru:8052/europaplus256.mp3", play: "/api/radio/relay?u=x&s=y", favicon: null };
  it("a station plays at once and pauses the music; turning it off brings the music back where it was", () => {
    const { m, advance, now } = make();
    m.add("c", "a", song("A", 100));
    advance(20_000);
    m.setStation("c", "b", europa);
    expect(m.state("c").station).toMatchObject({ name: "Европа Плюс", startedBy: "b" });
    expect(m.state("c").current?.pausedAt).toBe(20_000);
    advance(300_000); // the music doesn't move on under the station
    expect(m.state("c").current?.itemId).toBe("id1");
    m.clearStation("c");
    expect(m.state("c").station).toBeNull();
    expect(m.state("c").current).toEqual({ itemId: "id1", startedAt: now() - 20_000, pausedAt: null });
  });

  it("music someone paused themselves stays paused after the station", () => {
    const { m } = make();
    m.add("c", "a", song("A", 100));
    m.pause("c");
    m.setStation("c", "b", europa);
    m.clearStation("c");
    expect(m.state("c").current?.pausedAt).not.toBeNull();
  });

  it("a track starting while the station plays waits, paused at its start", () => {
    const { m } = make();
    m.setStation("c", "b", europa);
    m.add("c", "a", song("A", 100));
    expect(m.state("c").current).toMatchObject({ itemId: "id1", pausedAt: 0 });
    m.clearStation("c");
    expect(m.state("c").current?.pausedAt).toBeNull();
  });

  it("another station replaces the first; the last one leaving ends it too", () => {
    const { m } = make();
    m.setStation("c", "b", europa);
    m.setStation("c", "a", { ...europa, name: "Ретро FM" });
    expect(m.state("c").station?.name).toBe("Ретро FM");
    m.onLeave("c", "a", 0);
    expect(m.state("c").station).toBeNull();
  });
});

describe("RadioManager — shared links as tiles", () => {
  it("a link gets its title and cover once the page has been read, and everyone is told", () => {
    const { m, sent } = make();
    const link = m.addLink("c", "a", { url: "https://music.yandex.ru/album/1/track/2" }, "yandex");
    expect(link.image).toBeNull();
    m.updateLink("c", link.id, { title: "Сыграю на гитаре — Zavodit", image: "/media-proxy?u=x&s=y" });
    expect(m.state("c").links[0]).toMatchObject({ title: "Сыграю на гитаре — Zavodit", image: "/media-proxy?u=x&s=y" });
    expect(sent.at(-1)?.links[0].title).toBe("Сыграю на гитаре — Zavodit");
  });
  it("a link that's gone meanwhile is left alone", () => {
    const { m } = make();
    expect(() => m.updateLink("c", "nope", { title: "x", image: null })).not.toThrow();
  });
});

describe("RadioManager — switching tracks", () => {
  const titles = (m: RadioManager) => m.state("c").items.map((i) => i.title);
  const played = (m: RadioManager) => m.state("c").history.map((i) => i.title);

  it("a track that ends is followed within a second (a short grace, not a pause)", () => {
    const { m, advance } = make();
    m.add("c", "a", song("A", 100.4));
    m.add("c", "a", song("B"));
    advance(100_400 + 700);
    expect(m.state("c").current?.itemId).toBe("id1");
    advance(200);
    expect(m.state("c").current?.itemId).toBe("id2");
  });

  it("played tracks are kept to go back to (skipped ones too; one taken out isn't)", () => {
    const { m } = make();
    for (const t of ["A", "B", "C", "D"]) m.add("c", "a", song(t));
    m.skip("c", "id1");
    m.remove("c", "a", "id2", false);
    expect(titles(m)).toEqual(["C", "D"]);
    expect(played(m)).toEqual(["A"]);
  });

  it("previous near a track's start brings the one before back, this one after it", () => {
    const { m, advance, now } = make();
    for (const t of ["A", "B", "C"]) m.add("c", "a", song(t));
    m.skip("c", "id1");
    advance(3000);
    m.previous("c", "id2");
    expect(titles(m)).toEqual(["A", "B", "C"]);
    expect(m.state("c").current).toEqual({ itemId: "id1", startedAt: now(), pausedAt: null });
    expect(played(m)).toEqual([]);
    // And forward again.
    m.skip("c", "id1");
    expect(titles(m)).toEqual(["B", "C"]);
  });

  it("previous far into a track starts it over; with nothing before, too", () => {
    const { m, advance, now } = make();
    m.add("c", "a", song("A"));
    m.add("c", "a", song("B"));
    m.skip("c", "id1");
    advance(20_000);
    m.previous("c", "id2");
    expect(titles(m)).toEqual(["B"]);
    expect(m.state("c").current).toEqual({ itemId: "id2", startedAt: now(), pausedAt: null });
    const fresh = make();
    fresh.m.add("c", "a", song("X"));
    fresh.advance(1000);
    fresh.m.previous("c", "id1");
    expect(fresh.m.state("c").current).toEqual({ itemId: "id1", startedAt: fresh.now(), pausedAt: null });
  });

  it("previous after the queue ran out plays the last track again", () => {
    const { m, advance } = make();
    m.add("c", "a", song("A", 10));
    advance(11_000);
    expect(m.state("c").current).toBeNull();
    m.previous("c", null);
    expect(titles(m)).toEqual(["A"]);
    expect(m.state("c").current?.itemId).toBe("id1");
  });

  it("previous carries the id: two presses at once go back once", () => {
    const { m } = make();
    for (const t of ["A", "B", "C"]) m.add("c", "a", song(t));
    m.skip("c", "id1");
    m.skip("c", "id2");
    m.previous("c", "id3");
    m.previous("c", "id3");
    expect(m.state("c").current?.itemId).toBe("id2");
    expect(played(m)).toEqual(["A"]);
  });

  it("play now: a queued track starts, the current one counts as played, the rest keep their order", () => {
    const { m, now } = make();
    for (const t of ["A", "B", "C", "D"]) m.add("c", "a", song(t));
    m.playNow("c", "id3");
    expect(titles(m)).toEqual(["C", "B", "D"]);
    expect(m.state("c").current).toEqual({ itemId: "id3", startedAt: now(), pausedAt: null });
    expect(played(m)).toEqual(["A"]);
    m.playNow("c", "id3"); // already playing: nothing changes
    expect(titles(m)).toEqual(["C", "B", "D"]);
    expect(() => m.playNow("c", "nope")).toThrow();
  });

  it("the history keeps the last 20; a leaver's files leave it, links stay", () => {
    const { m } = make();
    for (let i = 0; i < 25; i++) m.add("c", "a", song(`S${i}`));
    for (let i = 1; i <= 24; i++) m.skip("c", `id${i}`);
    expect(played(m)).toHaveLength(20);
    expect(played(m)[0]).toBe("S4");
    const two = make();
    two.m.add("c", "b", song("file of b"));
    two.m.add("c", "b", { kind: "link", title: "link of b", duration: 100, url: "https://x.test/a.mp3" });
    two.m.add("c", "a", song("A"));
    two.m.skip("c", "id1");
    two.m.skip("c", "id2");
    two.m.onLeave("c", "b", 1);
    expect(two.m.state("c").history.map((i) => i.title)).toEqual(["link of b"]);
  });

  it("under an FM station, previous brings the track back waiting at its start", () => {
    const { m } = make();
    m.add("c", "a", song("A"));
    m.add("c", "a", song("B"));
    m.skip("c", "id1");
    m.setStation("c", "a", { name: "FM", url: "https://fm.test/live", play: "https://fm.test/live", favicon: null });
    m.previous("c", "id2");
    expect(m.state("c").current).toMatchObject({ itemId: "id1", pausedAt: 0 });
  });
});
