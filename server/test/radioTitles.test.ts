import { describe, expect, it } from "vitest";
import { tileTitle } from "../src/routes/radio";

describe("shared-link tile titles", () => {
  it("the site's own tail goes, the name stays", () => {
    expect(tileTitle("Zavodit — Сыграю на гитаре: слушать онлайн песню")).toBe("Zavodit — Сыграю на гитаре");
    expect(tileTitle("Сыграю на гитаре — Яндекс Музыка")).toBe("Сыграю на гитаре");
    expect(tileTitle("Плейлист «Дорога» — ВКонтакте")).toBe("Плейлист «Дорога»");
    expect(tileTitle(null)).toBeNull();
  });
});
