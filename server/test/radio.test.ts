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
