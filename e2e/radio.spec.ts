import { expect, test, type Page } from "@playwright/test";
import { BASE, guildWith, noErrors, openAs, register } from "./helpers";

/** A 30 s tone as a WAV file (each test gets its own pitch). */
function wav(seconds = 30, freq = 330, rate = 22_050): Buffer {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2);
  return b;
}

/** The page's radio player as it is (the element itself, not a copy of the module). */
const player = (p: Page) =>
  p.evaluate(() => {
    const el = document.querySelector<HTMLAudioElement>("audio[data-radio-player]");
    return el ? { itemId: el.dataset.item ?? null, time: el.currentTime, volume: el.volume, paused: el.paused } : { itemId: null, time: 0, volume: -1, paused: true };
  });

test("radio: a file plays for everyone in step, each at their own volume; a late joiner catches up; links and cards", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL, "imports modules through the dev server");
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const carol = await register(request, "Кира");
  const { guild, voice } = await guildWith(request, alice, [bob, carol]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`);
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(b.page.locator(`[data-user="${alice.id}"]`).first()).toBeVisible();

  // Alice adds a file.
  await a.page.getByRole("button", { name: "Радио", exact: true }).last().click();
  const panel = a.page.locator("[data-radio]");
  const [chooser] = await Promise.all([a.page.waitForEvent("filechooser"), panel.getByRole("button", { name: "Добавить файлы" }).click()]);
  await chooser.setFiles({ name: "Тихая песня.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(panel.locator("[data-radio-item][data-current]")).toContainText("Тихая песня");

  // Bob gets the file and plays the same moment.
  await expect.poll(async () => (await player(b.page)).paused, { timeout: 20_000 }).toBe(false);
  const [pa, pb] = [await player(a.page), await player(b.page)];
  expect(Math.abs(pa.time - pb.time)).toBeLessThan(0.5);
  await expect(b.page.locator("[data-radio-now]")).toContainText("Тихая песня");

  // Bob turns the radio down for himself only.
  await b.page.getByRole("button", { name: "Радио", exact: true }).last().click();
  await b.page.locator("[data-radio]").locator('input[type="range"]').fill("20");
  await expect.poll(async () => (await player(b.page)).volume).toBeCloseTo(0.2, 2);
  expect((await player(a.page)).volume).toBeCloseTo(0.6, 2);
  await b.page.keyboard.press("Escape");
  // Deafened, Bob hears no radio; back, at his own volume.
  await b.page.getByRole("button", { name: "Выключить звук" }).last().click();
  await expect.poll(async () => (await player(b.page)).volume).toBe(0);
  await b.page.getByRole("button", { name: "Выключить звук" }).last().click();
  await expect.poll(async () => (await player(b.page)).volume).toBeCloseTo(0.2, 2);

  // Carol joins mid-track and plays from the right place.
  const c = await openAs(browser, carol, `/#/channels/${guild.id}/${voice.id}`);
  await c.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect.poll(async () => (await player(c.page)).paused, { timeout: 20_000 }).toBe(false);
  expect(Math.abs((await player(c.page)).time - (await player(a.page)).time)).toBeLessThan(0.6);

  // Pause reaches everyone; skip too.
  await panel.getByRole("button", { name: "Пауза" }).click();
  await expect.poll(async () => (await player(b.page)).paused).toBe(true);
  await panel.getByRole("button", { name: "Продолжить" }).click();
  await expect.poll(async () => (await player(b.page)).paused).toBe(false);

  // A direct link plays for all; a Yandex link is a card.
  await a.page.route("https://radio.test/**", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: wav(20, 440) }));
  await b.page.route("https://radio.test/**", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: wav(20, 440) }));
  await c.page.route("https://radio.test/**", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: wav(20, 440) }));
  // A page that isn't audio is refused with a word, the queue unchanged.
  await a.page.route("https://page.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html>hi</html>" }));
  await panel.getByPlaceholder(/Ссылка на mp3/).fill("https://page.test/song");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(a.page.getByText(/По ссылке не аудиофайл/)).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator("[data-radio-item]")).toHaveCount(1);
  await panel.getByPlaceholder(/Ссылка на mp3/).fill("https://radio.test/song.wav");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(panel.locator("[data-radio-item]")).toHaveCount(2);
  await panel.getByPlaceholder(/Ссылка на mp3/).fill("https://music.yandex.ru/album/1/track/2");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  // A Yandex link isn't a track of the queue: it shows Yandex's own player.
  await expect(panel.locator('[data-radio-link] iframe[src="https://music.yandex.ru/iframe/album/1/track/2"]')).toBeAttached();
  await expect(panel.locator("[data-radio-item]")).toHaveCount(2);
  await panel.getByRole("button", { name: "Следующий" }).click();
  await expect(panel.locator("[data-radio-item][data-current]")).toContainText("song");
  await expect.poll(async () => (await player(b.page)).paused, { timeout: 20_000 }).toBe(false);
  noErrors(a, b, c);
});

test("radio: a listener who rejoins hears it again; a skip to a file that never comes stops the old track; the sidebar knows after a reload", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const dave = await register(request, "Дима");
  const { guild, voice, text } = await guildWith(request, alice, [bob, dave]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`);
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(b.page.locator(`[data-user="${alice.id}"]`).first()).toBeVisible();
  await a.page.getByRole("button", { name: "Радио", exact: true }).last().click();
  const panel = a.page.locator("[data-radio]");
  const [chooser] = await Promise.all([a.page.waitForEvent("filechooser"), panel.getByRole("button", { name: "Добавить файлы" }).click()]);
  await chooser.setFiles({ name: "Длинная.wav", mimeType: "audio/wav", buffer: wav(60, 300) });
  await expect.poll(async () => (await player(b.page)).paused, { timeout: 20_000 }).toBe(false);

  // Bob leaves and comes back: the file comes to him again, he plays where everyone is.
  await b.page.getByRole("button", { name: "Отключиться" }).first().click();
  await expect.poll(async () => (await player(b.page)).itemId).toBeNull();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect.poll(async () => (await player(b.page)).paused, { timeout: 25_000 }).toBe(false);
  expect(Math.abs((await player(b.page)).time - (await player(a.page)).time)).toBeLessThan(0.6);

  // Dave, not in the call, opens the app afresh: the sidebar shows what plays.
  const d = await openAs(browser, dave, `/#/channels/${guild.id}/${text.id}`);
  await expect(d.page.locator("[data-radio-now]")).toContainText("Длинная");

  // Bob queues a "file" his app doesn't have (straight through the API): it can never arrive.
  // Skipping to it, everyone stops the old track instead of playing on.
  const res = await request.post(`${BASE}/api/channels/${voice.id}/radio/items`, { data: { kind: "file", title: "Призрак", duration: 30 }, headers: { authorization: `Bearer ${bob.access}` } });
  expect(res.ok()).toBeTruthy();
  await panel.getByRole("button", { name: "Следующий" }).click();
  await expect(panel.locator("[data-radio-item][data-current]")).toContainText("Призрак");
  await expect.poll(async () => (await player(b.page)).paused).toBe(true);
  await expect.poll(async () => (await player(a.page)).paused).toBe(true);
  noErrors(a, b, d);
});

test("FM: a station from the catalog plays for everyone in the call, each at their own FM volume; off stops it", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`);
  // The catalog (Radio Browser) and the station's stream, played by the test.
  const stations = [
    { stationuuid: "u-1", name: "Тестовое FM", url_resolved: "https://fm.test/live.mp3", favicon: "", codec: "MP3", bitrate: 128, countrycode: "RU", tags: "pop", hls: 0, lastcheckok: 1 },
    { stationuuid: "u-2", name: "Другое радио", url_resolved: "https://fm.test/other.mp3", favicon: "", codec: "MP3", bitrate: 128, countrycode: "RU", tags: "", hls: 0, lastcheckok: 1 },
  ];
  for (const p of [a.page, b.page]) {
    await p.route(/radio-browser\.info\/json\/stations\//, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stations), headers: { "access-control-allow-origin": "*" } }));
    await p.route(/radio-browser\.info\/json\/url\//, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}", headers: { "access-control-allow-origin": "*" } }));
    await p.route("https://fm.test/**", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: wav(120, 520) }));
  }
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(b.page.locator(`[data-user="${alice.id}"]`).first()).toBeVisible();

  await a.page.getByRole("button", { name: "FM-радио" }).last().click();
  const fm = a.page.locator("[data-fm]");
  await fm.getByRole("button", { name: /Тестовое FM/ }).click();
  await expect(fm.locator("[data-fm-now]")).toContainText("Тестовое FM");
  await expect.poll(async () => (await player(b.page)).paused, { timeout: 20_000 }).toBe(false);
  expect((await player(b.page)).itemId).toBe("station");
  await expect(b.page.locator("[data-radio-now]")).toContainText("📻 Тестовое FM");

  // Bob's FM volume is his own.
  await b.page.getByRole("button", { name: "FM-радио" }).last().click();
  await b.page.locator("[data-fm]").locator('input[type="range"]').fill("30");
  await expect.poll(async () => (await player(b.page)).volume).toBeCloseTo(0.3, 2);
  expect((await player(a.page)).volume).toBeCloseTo(0.6, 2);

  // Search finds a station by name; off stops it for everyone.
  await fm.getByPlaceholder(/Найти станцию/).fill("Другое");
  await expect(fm.getByRole("button", { name: /Другое радио/ })).toBeVisible();
  await fm.getByRole("button", { name: "Выключить" }).click();
  await expect.poll(async () => (await player(b.page)).itemId).toBeNull();
  noErrors(a, b);
});

test("radio: Yandex Music plays in Yandex's own player, VK opens the music window; playlists and folders fill the queue", async ({ browser, request }) => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const alice = await register(request, "Алиса");
  const { guild, voice } = await guildWith(request, alice, []);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`, { desktop: true });
  await a.page.route("https://music.yandex.ru/iframe/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Яндекс плеер</body></html>" }));
  await a.page.route("https://songs.test/**", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: wav(15, 400) }));
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await a.page.getByRole("button", { name: "Радио", exact: true }).last().click();
  const panel = a.page.locator("[data-radio]");
  const link = panel.getByPlaceholder(/Ссылка на mp3/);

  // Yandex: its own player, right in the panel.
  await link.fill("https://music.yandex.ru/album/41735634/track/150614117?utm_source=desktop");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(panel.locator('iframe[src="https://music.yandex.ru/iframe/album/41735634/track/150614117"]')).toBeVisible();

  // VK: the music window of the desktop app.
  await link.fill("https://vk.com/audio_playlist-147845620_2949");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  await panel.getByRole("button", { name: /Слушать в мини-окне/ }).click();
  await expect.poll(() => a.page.evaluate(() => (window as unknown as { __music?: string[] }).__music ?? [])).toEqual(["https://vk.com/audio_playlist-147845620_2949"]);

  // A playlist file: its web addresses join the queue (with their titles); one on a computer is left out.
  const m3u = "#EXTM3U\n#EXTINF:15,Первая\nhttps://songs.test/1.wav\n#EXTINF:15,Вторая\nhttps://songs.test/2.wav\nC:\\Music\\track.mp3\n";
  const [pl] = await Promise.all([a.page.waitForEvent("filechooser"), panel.getByRole("button", { name: "Добавить файлы" }).click()]);
  await pl.setFiles({ name: "мой.m3u", mimeType: "audio/x-mpegurl", buffer: Buffer.from(m3u) });
  await expect(panel.locator("[data-radio-item]")).toHaveCount(2, { timeout: 20_000 });
  await expect(panel.locator("[data-radio-item]").nth(0)).toContainText("Первая");
  await expect(panel.locator("[data-radio-item]").nth(1)).toContainText("Вторая");

  // A folder: every audio file in it, in name order.
  const dir = mkdtempSync(join(tmpdir(), "nova-folder-"));
  writeFileSync(join(dir, "02 Б.wav"), wav(5, 300));
  writeFileSync(join(dir, "01 А.wav"), wav(5, 350));
  writeFileSync(join(dir, "обложка.jpg"), Buffer.from("not audio"));
  const [folder] = await Promise.all([a.page.waitForEvent("filechooser"), panel.getByRole("button", { name: "Добавить папку" }).click()]);
  await folder.setFiles(dir);
  await expect(panel.locator("[data-radio-item]")).toHaveCount(4, { timeout: 20_000 });
  await expect(panel.locator("[data-radio-item]").nth(2)).toContainText("01 А");
  await expect(panel.locator("[data-radio-item]").nth(3)).toContainText("02 Б");
  noErrors(a);
});
