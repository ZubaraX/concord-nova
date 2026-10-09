import { describe, expect, it } from "vitest";
import { goneIds, isNewer, shouldPlay, shouldSeek, sourceStep, titleOf } from "./radioSync";

describe("radio titles", () => {
  it("a file name with % becomes a title instead of an error", () => {
    expect(titleOf("100% Love.mp3")).toBe("100% Love");
  });
  it("a link's encoded name is decoded", () => {
    expect(titleOf("My%20Song_01.mp3", true)).toBe("My Song 01");
  });
});

describe("radio player decisions", () => {
  it("skipped to a track whose file hasn't come: the old one stops", () => {
    expect(sourceStep("A", "B", undefined)).toBe("stop");
    expect(sourceStep(null, "B", undefined)).toBe("wait");
    expect(sourceStep("A", "B", "blob:b")).toBe("switch");
    expect(sourceStep("B", "B", "blob:b")).toBe("keep");
  });
  it("an ended element is not played again (play() would start it over)", () => {
    expect(shouldPlay({ ended: true, duration: 29.4 }, 29.6, 30)).toBe(false);
    expect(shouldPlay({ ended: false, duration: 29.4 }, 29.45, 30)).toBe(false);
    expect(shouldPlay({ ended: false, duration: 29.4 }, 10, 30)).toBe(true);
    expect(shouldPlay({ ended: false, duration: NaN }, 10, 30)).toBe(true);
  });
  it("no seeking while a seek is under way or the data isn't there yet — except the first one", () => {
    expect(shouldSeek({ currentTime: 0, readyState: 1, seeking: false }, 12, true)).toBe(true);
    expect(shouldSeek({ currentTime: 11, readyState: 2, seeking: false }, 12, false)).toBe(false);
    expect(shouldSeek({ currentTime: 11, readyState: 4, seeking: true }, 12, false)).toBe(false);
    expect(shouldSeek({ currentTime: 11, readyState: 4, seeking: false }, 12, false)).toBe(true);
    expect(shouldSeek({ currentTime: 11.9, readyState: 4, seeking: false }, 12, false)).toBe(false);
  });
});

describe("radio bookkeeping", () => {
  it("a file of yours goes only after its track was in the queue and left it (whatever came first)", () => {
    const seen = new Set<string>();
    // The add's answer came before the server's update: not in the queue yet — kept.
    expect(goneIds(["x"], seen, new Set())).toEqual([]);
    expect(goneIds(["x"], seen, new Set(["x"]))).toEqual([]);
    expect(goneIds(["x"], seen, new Set())).toEqual(["x"]);
  });
  it("an older state doesn't replace a newer one", () => {
    expect(isNewer(undefined, { serverNow: 5 })).toBe(true);
    expect(isNewer({ serverNow: 10 }, { serverNow: 5 })).toBe(false);
    expect(isNewer({ serverNow: 10 }, { serverNow: 10 })).toBe(true);
  });
});
