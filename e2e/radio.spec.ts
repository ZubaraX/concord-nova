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
  // A Yandex link isn't a track of the queue: it is a tile of its own.
  await expect(panel.locator("[data-radio-link][data-service=yandex]")).toBeVisible();
  await expect(panel.locator("[data-radio-item]")).toHaveCount(2);
  const fileId = (await player(a.page)).itemId;
  await panel.getByRole("button", { name: "Следующий" }).click();
  await expect(panel.locator("[data-radio-item][data-current]")).toContainText("song");
  await expect.poll(async () => (await player(b.page)).paused, { timeout: 20_000 }).toBe(false);
  // Back to the file: the listeners kept it, so it plays again at once, for everyone.
  await panel.getByRole("button", { name: "Предыдущий" }).click();
  await expect(panel.locator("[data-radio-item][data-current]")).toContainText("Тихая песня");
  for (const p of [b.page, c.page]) {
    await expect.poll(async () => (await player(p)).itemId, { timeout: 3000 }).toBe(fileId);
    await expect.poll(async () => (await player(p)).paused, { timeout: 3000 }).toBe(false);
  }
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
  // The stations come from this server (its built-in catalogue — no Radio Browser, no VPN);
  // the stream of Anon.FM (an https station of it) is played by the test.
  for (const p of [a.page, b.page]) await p.route("https://icecast.anon.fm/**", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: wav(120, 520) }));
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  await expect(b.page.locator(`[data-user="${alice.id}"]`).first()).toBeVisible();

  await a.page.getByRole("button", { name: "FM-радио" }).last().click();
  const fm = a.page.locator("[data-fm]");
  await fm.getByRole("button", { name: /Anon.FM/ }).click();
  await expect(fm.locator("[data-fm-now]")).toContainText("Anon.FM");
  await expect.poll(async () => (await player(b.page)).paused, { timeout: 20_000 }).toBe(false);
  expect((await player(b.page)).itemId).toBe("station");
  await expect(b.page.locator("[data-radio-now]")).toContainText("📻 Anon.FM");

  // Bob's FM volume is his own.
  await b.page.getByRole("button", { name: "FM-радио" }).last().click();
  await b.page.locator("[data-fm]").locator('input[type="range"]').fill("30");
  await expect.poll(async () => (await player(b.page)).volume).toBeCloseTo(0.3, 2);
  expect((await player(a.page)).volume).toBeCloseTo(0.6, 2);

  // Search finds a station by name; off stops it for everyone.
  await fm.getByPlaceholder(/Найти станцию/).fill("европа");
  await expect(fm.getByRole("button", { name: /Europa Plus/ })).toBeVisible();
  await fm.getByRole("button", { name: "Выключить" }).click();
  await expect.poll(async () => (await player(b.page)).itemId).toBeNull();
  noErrors(a, b);
});

test("radio: shared links are tiles that play in the corner player (desktop: Yandex and VK); playlists and folders fill the queue; switching tracks both ways", async ({ browser, request }) => {
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

  // In the desktop app a tile plays in the player in the corner: the service's own page (its
  // own session, pop-ups allowed for signing in), at the player's volume. VK too.
  await link.fill("https://music.yandex.ru/album/41735634/track/150614117?utm_source=desktop");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  await panel.locator("[data-radio-link][data-service=yandex]").click();
  const dock = a.page.locator("[data-music-dock]");
  const view = dock.locator("webview");
  await expect(view).toHaveAttribute("src", "https://music.yandex.ru/iframe/album/41735634/track/150614117");
  await expect(view).toHaveAttribute("partition", "persist:music");
  await expect(view).toHaveAttribute("allowpopups", /.*/);
  await expect(dock.locator('input[type="range"]')).toBeVisible();
  await link.fill("https://vk.com/audio_playlist-147845620_2949");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  await panel.locator("[data-radio-link][data-service=vk]").click();
  await expect(view).toHaveAttribute("src", "https://vk.ru/audio_playlist-147845620_2949");
  expect(await a.page.evaluate(() => (window as unknown as { __external?: string[] }).__external ?? [])).toEqual([]);
  // It outlives the panel, and folds into a bar (still there, still playing).
  await a.page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await dock.getByRole("button", { name: "Свернуть" }).click();
  await expect(dock).toHaveAttribute("data-min", "");
  await expect(view).toBeAttached();
  await a.page.getByRole("button", { name: "Радио", exact: true }).last().click();

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

  // Switching: any queued track now (the player goes with it), and back to the one before.
  await expect.poll(async () => (await player(a.page)).paused, { timeout: 20_000 }).toBe(false);
  const first = (await player(a.page)).itemId;
  await panel.locator("[data-radio-item]").nth(3).getByRole("button", { name: "Включить сейчас" }).click();
  await expect(panel.locator("[data-radio-item][data-current]")).toContainText("02 Б");
  await expect.poll(async () => (await player(a.page)).itemId).not.toBe(first);
  await expect.poll(async () => (await player(a.page)).paused, { timeout: 20_000 }).toBe(false);
  await panel.getByRole("button", { name: "Предыдущий" }).click();
  await expect(panel.locator("[data-radio-item][data-current]")).toContainText("Первая");
  await expect(panel.locator("[data-radio-item]").nth(1)).toContainText("02 Б");
  await expect.poll(async () => (await player(a.page)).itemId).toBe(first);
  await expect.poll(async () => (await player(a.page)).paused, { timeout: 20_000 }).toBe(false);
  noErrors(a);
});

test("radio in a browser: a Yandex tile plays in the corner player (at the system's volume); a VK tile opens VK", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const { guild, voice } = await guildWith(request, alice, []);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`);
  await a.page.route("https://music.yandex.ru/iframe/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Яндекс плеер</body></html>" }));
  await a.context.route("https://vk.ru/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>VK</body></html>" }));
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await a.page.getByRole("button", { name: "Радио", exact: true }).last().click();
  const panel = a.page.locator("[data-radio]");
  const link = panel.getByPlaceholder(/Ссылка на mp3/);

  await link.fill("https://music.yandex.ru/album/41735634/track/150614117");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  await panel.locator("[data-radio-link][data-service=yandex]").click();
  const dock = a.page.locator("[data-music-dock]");
  await expect(dock.locator('iframe[src="https://music.yandex.ru/iframe/album/41735634/track/150614117"]')).toBeVisible();
  await expect(dock.getByText(/громкостью системы/)).toBeVisible();
  await expect(dock.locator("webview")).toHaveCount(0);

  await link.fill("https://vk.com/audio_playlist-147845620_2949");
  await panel.getByRole("button", { name: "Добавить", exact: true }).click();
  const [vk] = await Promise.all([a.context.waitForEvent("page"), panel.locator("[data-radio-link][data-service=vk]").click()]);
  await expect.poll(() => vk.url()).toBe("https://vk.ru/audio_playlist-147845620_2949");
  noErrors(a);
});

test("the music player's volume (the desktop app's script in the service's page): sound follows it, the page keeps its own", async ({ page }) => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const script = readFileSync(resolve("client/electron/music-preload.cjs"), "utf8");
  await page.addInitScript(() => {
    (window as unknown as { realVolume: () => number }).realVolume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume")!.get!;
  });
  await page.addInitScript({ content: script + "\ninstallVolume();" });
  await page.goto("data:text/html,<audio id=tag></audio>");
  const r = await page.evaluate(() => {
    const w = window as unknown as { realVolume: () => number; __novaVolume: (f: number) => void };
    const real = (el: HTMLMediaElement) => w.realVolume.call(el);
    const a = new Audio();
    a.volume = 0.8; // the page's own
    const tag = document.getElementById("tag") as HTMLAudioElement;
    void tag.play().catch(() => {});
    w.__novaVolume(0.5);
    const first = { page: a.volume, a: real(a), tag: real(tag) };
    a.volume = 0.6;
    const second = { page: a.volume, a: real(a) };
    let bad = "";
    try {
      a.volume = 2;
    } catch (e) {
      bad = (e as Error).name;
    }
    // Web Audio: the speakers can still be connected and disconnected; an element played
    // through it isn't turned down twice.
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.disconnect(ctx.destination);
    osc.connect(ctx.destination);
    osc.disconnect();
    const c = new Audio();
    c.volume = 0.9;
    ctx.createMediaElementSource(c);
    return { first, second, bad, routed: real(c), dest: ctx.destination instanceof AudioDestinationNode };
  });
  expect(r.first.page).toBeCloseTo(0.8);
  expect(r.first.a).toBeCloseTo(0.4);
  expect(r.first.tag).toBeCloseTo(0.5);
  expect(r.second.page).toBeCloseTo(0.6);
  expect(r.second.a).toBeCloseTo(0.3);
  expect(r.bad).toBe("IndexSizeError");
  expect(r.routed).toBeCloseTo(0.9);
  expect(r.dest).toBe(true);
});
