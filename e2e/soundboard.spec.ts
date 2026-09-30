import sharp from "sharp";
import { expect, test, type Page } from "@playwright/test";
import { guildWith, noErrors, openAs, register } from "./helpers";

/** A plain tone as a 16-bit mono WAV file. */
function wav(seconds: number, freq = 440, rate = 22_050): Buffer {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 20_000), 44 + i * 2);
  return b;
}

async function choose(page: Page, click: () => Promise<void>, file: { name: string; mimeType: string; buffer: Buffer }) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), click()]);
  await chooser.setFiles(file);
}

test("soundboard: a sound reaches the call with the mic muted; an own sound with its own icon", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`, { local: { noise: "off" } });
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`);
  const p = a.page;
  const aliceSpeaks = b.page.locator(`[data-user="${alice.id}"] [data-speaking="true"]`);
  const board = p.locator("[data-soundboard]");
  const openBoard = () => p.getByRole("button", { name: "Саундпад" }).last().click();

  await p.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  // The fake microphone beeps — then Alice mutes, and Bob hears nothing from her.
  await expect(aliceSpeaks).toBeVisible({ timeout: 20_000 });
  await p.getByRole("button", { name: "Выключить микрофон" }).last().click();
  await expect(aliceSpeaks).toHaveCount(0);

  // A built-in sound goes out through her muted microphone track.
  await openBoard();
  await expect(board.locator("[data-clip]")).toHaveCount(12);
  await board.locator('[data-clip="siren"]').click();
  await expect(board.locator('[data-clip="siren"]')).toHaveAttribute("data-playing", "true");
  await expect(aliceSpeaks).toBeVisible();
  await board.getByRole("button", { name: "Остановить звуки" }).click();
  await expect(board.locator('[data-clip="siren"]')).toHaveAttribute("data-playing", "false");
  await expect(aliceSpeaks).toHaveCount(0);

  // Her own sound: a file, a name taken from it, an emoji.
  await board.getByRole("button", { name: "Добавить" }).click();
  const dialog = p.getByRole("dialog").last();
  await choose(p, () => dialog.getByRole("button", { name: "Выбрать файл" }).click(), { name: "гудок.wav", mimeType: "audio/wav", buffer: wav(2) });
  await expect(dialog.getByPlaceholder(/Бадумтс/)).toHaveValue("гудок");
  await dialog.getByRole("button", { name: "🚀" }).click();
  await dialog.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await openBoard();
  const mine = board.locator("[data-clip]").filter({ hasText: "гудок" });
  await expect(mine).toContainText("🚀");
  await mine.click();
  await expect(aliceSpeaks).toBeVisible();
  await expect(mine).toHaveAttribute("data-playing", "false", { timeout: 6000 });

  // A picture instead of the emoji.
  await mine.hover();
  await board.getByRole("button", { name: "Изменить: гудок" }).click();
  const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 230, g: 60, b: 120 } } }).png().toBuffer();
  await choose(p, () => dialog.getByRole("button", { name: "Своя картинка" }).click(), { name: "icon.png", mimeType: "image/png", buffer: png });
  await expect(dialog.locator("[data-sound-icon] img")).toBeVisible();
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toHaveCount(0);

  // It is kept on the device: after a reload it is in voice settings, picture and all.
  await p.reload();
  await expect(p.locator("[data-shell]")).toBeVisible();
  await p.getByRole("button", { name: "Настройки" }).last().click();
  await p.locator("[data-settings] nav").getByRole("button", { name: "Голос и видео", exact: true }).click();
  const kept = p.locator("[data-soundboard] [data-clip]").filter({ hasText: "гудок" });
  await expect(kept.locator("img")).toBeVisible();
  await kept.click(); // outside a call it just plays locally
  await expect(kept).toHaveAttribute("data-playing", "true");

  // …until it is deleted.
  await kept.hover();
  await p.getByRole("button", { name: "Изменить: гудок" }).click();
  await p.getByRole("dialog").last().getByRole("button", { name: "Удалить" }).click();
  await expect(p.locator("[data-soundboard] [data-clip]").filter({ hasText: "гудок" })).toHaveCount(0);
  await expect(p.locator("[data-soundboard] [data-clip]")).toHaveCount(12);
  noErrors(a, b);
});

test("soundboard: every built-in sound renders audibly and without clipping", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL, "imports the module through the dev server");
  const alice = await register(request, "Алиса");
  const a = await openAs(browser, alice);
  const stats = await a.page.evaluate(async () => {
    const m = (await import(/* @vite-ignore */ "/src/features/voice/clips.ts")) as { BUILTIN_CLIPS: { id: string }[]; renderBuiltin: (id: string) => Promise<AudioBuffer | null> };
    const out: { id: string; seconds: number; peak: number; rms: number; tail: number; ok: boolean }[] = [];
    for (const { id } of m.BUILTIN_CLIPS) {
      const b = await m.renderBuiltin(id);
      if (!b) {
        out.push({ id, seconds: 0, peak: 0, rms: 0, tail: 0, ok: false });
        continue;
      }
      const d = b.getChannelData(0);
      let peak = 0;
      let sum = 0;
      let bad = false;
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (!Number.isFinite(v)) bad = true;
        peak = Math.max(peak, Math.abs(v));
        sum += v * v;
      }
      // The last 20 ms: a sound that ends mid-swing clicks.
      let tail = 0;
      for (let i = d.length - 960; i < d.length; i++) tail = Math.max(tail, Math.abs(d[i]));
      out.push({ id, seconds: b.duration, peak, rms: Math.sqrt(sum / d.length), tail, ok: !bad });
    }
    return out;
  });
  expect(stats).toHaveLength(12);
  for (const s of stats) {
    expect(s.ok, `${s.id}: finite samples`).toBe(true);
    expect(s.seconds, `${s.id}: length`).toBeGreaterThan(0.5);
    expect(s.seconds, `${s.id}: length`).toBeLessThanOrEqual(3.1);
    expect(s.peak, `${s.id}: no clipping`).toBeLessThanOrEqual(0.901);
    expect(s.peak, `${s.id}: loud enough`).toBeGreaterThan(0.2);
    expect(s.rms, `${s.id}: loud enough`).toBeGreaterThan(0.02);
    expect(s.tail, `${s.id}: fades out`).toBeLessThan(0.05);
  }
  console.log(stats.map((s) => `${s.id.padEnd(9)} ${s.seconds.toFixed(2)}s peak ${s.peak.toFixed(2)} rms ${s.rms.toFixed(3)} tail ${s.tail.toFixed(3)}`).join("\n"));
  noErrors(a);
});
