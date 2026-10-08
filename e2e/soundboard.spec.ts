import sharp from "sharp";
import { expect, test, type Page } from "@playwright/test";
import { BASE, guildWith, noErrors, openAs, register } from "./helpers";

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

test("soundboard: a sound reaches the call with the mic muted; own sounds follow the account, server sounds are shared", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`, { local: { noise: "off" } });
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`);
  const p = a.page;
  const aliceSpeaks = b.page.locator(`[data-user="${alice.id}"] [data-speaking="true"]`);
  // Bob's app plays her sounds itself (they don't travel as audio) and marks her tile meanwhile.
  const aliceSound = b.page.locator(`[data-user="${alice.id}"] [data-soundboard-playing]`);
  const board = p.locator("[data-soundboard]");
  const openBoard = () => p.getByRole("button", { name: "Саундпад" }).last().click();

  await p.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  // The fake microphone beeps — then Alice mutes, and Bob hears nothing from her.
  await expect(aliceSpeaks).toBeVisible({ timeout: 20_000 });
  await p.getByRole("button", { name: "Выключить микрофон" }).last().click();
  await expect(aliceSpeaks).toHaveCount(0);

  // A built-in sound reaches Bob with her microphone muted — and stops when she stops it.
  await openBoard();
  await expect(board.locator('[data-section="builtin"] [data-clip]')).toHaveCount(12);
  await board.locator('[data-clip="siren"]').click();
  await expect(board.locator('[data-clip="siren"]')).toHaveAttribute("data-playing", "true");
  await expect(aliceSound).toBeVisible();
  await expect(aliceSpeaks).toHaveCount(0); // nothing went out through her microphone
  await board.getByRole("button", { name: "Остановить звуки" }).click();
  await expect(board.locator('[data-clip="siren"]')).toHaveAttribute("data-playing", "false");
  await expect(aliceSound).toHaveCount(0);

  // Her own sound: a file, a name taken from it, an emoji — kept on her account.
  await board.locator('[data-section="mine"]').getByRole("button", { name: "Добавить" }).click();
  const dialog = p.getByRole("dialog").last();
  await choose(p, () => dialog.getByRole("button", { name: "Выбрать файл" }).click(), { name: "гудок.wav", mimeType: "audio/wav", buffer: wav(2) });
  await expect(dialog.getByPlaceholder(/Бадумтс/)).toHaveValue("гудок");
  await expect(dialog.getByLabel("Где сохранить")).toHaveValue("");
  await dialog.getByRole("button", { name: "🚀" }).click();
  await dialog.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await openBoard();
  const mine = board.locator('[data-section="mine"] [data-clip]').filter({ hasText: "гудок" });
  await expect(mine).toContainText("🚀");
  await mine.click();
  await expect(aliceSound).toBeVisible(); // Bob fetched her file
  await expect(mine).toHaveAttribute("data-playing", "false", { timeout: 6000 });

  // A picture instead of the emoji.
  await mine.hover();
  await board.getByRole("button", { name: "Изменить: гудок" }).click();
  const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 230, g: 60, b: 120 } } }).png().toBuffer();
  await choose(p, () => dialog.getByRole("button", { name: "Своя картинка" }).click(), { name: "icon.png", mimeType: "image/png", buffer: png });
  await expect(dialog.locator("[data-sound-icon] img")).toBeVisible();
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toHaveCount(0);

  // A sound for the server: Bob gets it at once and can play it, muted too.
  await openBoard();
  await board.locator(`[data-section="guild:${guild.id}"]`).getByRole("button", { name: "Добавить" }).click();
  await choose(p, () => dialog.getByRole("button", { name: "Выбрать файл" }).click(), { name: "горн-сервера.wav", mimeType: "audio/wav", buffer: wav(2, 330) });
  await expect(dialog.getByLabel("Где сохранить")).toHaveValue(guild.id);
  await dialog.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const bobSound = p.locator(`[data-user="${bob.id}"] [data-soundboard-playing]`);
  await b.page.getByRole("button", { name: "Выключить микрофон" }).last().click();
  await b.page.getByRole("button", { name: "Саундпад" }).last().click();
  const shared = b.page.locator(`[data-soundboard] [data-section="guild:${guild.id}"] [data-clip]`).filter({ hasText: "горн-сервера" });
  await expect(shared).toBeVisible();
  await expect(b.page.getByRole("button", { name: "Изменить: горн-сервера" })).toHaveCount(0); // not his to change
  await shared.click();
  await expect(bobSound).toBeVisible();

  // Her own sound is on her other devices too, picture and all.
  const other = await openAs(browser, alice, "/");
  await other.page.getByRole("button", { name: "Настройки" }).last().click();
  await other.page.locator("[data-settings] nav").getByRole("button", { name: "Голос и видео", exact: true }).click();
  const kept = other.page.locator('[data-soundboard] [data-section="mine"] [data-clip]').filter({ hasText: "гудок" });
  await expect(kept.locator("img")).toBeVisible();
  await kept.click(); // outside a call it just plays locally
  await expect(kept).toHaveAttribute("data-playing", "true");

  // …until it is deleted — everywhere.
  await kept.hover();
  await other.page.getByRole("button", { name: "Изменить: гудок" }).click();
  await other.page.getByRole("dialog").last().getByRole("button", { name: "Удалить" }).click();
  await expect(kept).toHaveCount(0);
  await openBoard();
  await expect(board.locator('[data-section="mine"] [data-clip]')).toHaveCount(0);
  noErrors(a, b, other);
  await other.context.close();
});

test("soundboard: sounds kept on the device by 1.3 move to the account", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const a = await openAs(browser, alice);
  const wavBytes = [...wav(1)];
  await a.page.evaluate(async (bytes) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("nova-assets", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "sound:old-1");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    localStorage.setItem("nova.soundboard", JSON.stringify([{ id: "old-1", name: "старый звук", emoji: "🐸", image: false }]));
  }, wavBytes);
  await a.page.reload();
  await expect(a.page.getByText(/Ваши звуки перенесены в аккаунт/)).toBeVisible();
  await expect.poll(() => a.page.evaluate(() => localStorage.getItem("nova.soundboard"))).toBeNull();
  const list = await (await request.get(`${BASE}/api/expressions`, { headers: { authorization: `Bearer ${alice.access}` } })).json();
  expect(list.sounds.map((s: { name: string; emoji: string }) => `${s.emoji} ${s.name}`)).toEqual(["🐸 старый звук"]);
  noErrors(a);
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

test("soundboard: drag a sound of yours onto the server and a server's into yours; drag to reorder", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild } = await guildWith(request, alice, [bob]);
  // Two sounds of Bob's own, one of the server's (added by Alice).
  const add = async (who: typeof alice, name: string, guildId?: string) => {
    const res = await request.post(`${BASE}/api/sounds?${new URLSearchParams({ name, emoji: "🔊", ...(guildId ? { guildId } : {}) })}`, {
      headers: { authorization: `Bearer ${who.access}` },
      multipart: { file: { name: `${name}.wav`, mimeType: "audio/wav", buffer: wav(0.5) } },
    });
    expect(res.status(), await res.text()).toBe(201);
  };
  await add(bob, "первый");
  await add(bob, "второй");
  await add(alice, "серверный", guild.id);

  const b = await openAs(browser, bob);
  const p = b.page;
  await p.getByRole("button", { name: "Настройки" }).last().click();
  await p.locator("[data-settings] nav").getByRole("button", { name: "Голос и видео", exact: true }).click();
  const mine = p.locator('[data-soundboard] [data-section="mine"]');
  const server = p.locator(`[data-soundboard] [data-section="guild:${guild.id}"]`);
  const names = (section: typeof mine) => section.locator("[data-sound]").allInnerTexts();
  await expect(server.locator("[data-sound]")).toHaveCount(1);

  // Yours → the server: a copy appears there for everyone.
  await mine.locator("[data-sound]").filter({ hasText: "первый" }).dragTo(server);
  await expect(server.locator("[data-sound]").filter({ hasText: "первый" })).toBeVisible();
  await expect(mine.locator("[data-sound]").filter({ hasText: "первый" })).toBeVisible(); // still yours too

  // The server's → yours.
  await server.locator("[data-sound]").filter({ hasText: "серверный" }).dragTo(mine);
  await expect(mine.locator("[data-sound]").filter({ hasText: "серверный" })).toBeVisible();
  expect((await names(mine)).map((s) => s.trim().split("\n").pop())).toEqual(["первый", "второй", "серверный"]);

  // Reorder yours: drop "серверный" onto "первый" → it goes first, and stays so on another device.
  await mine.locator("[data-sound]").filter({ hasText: "серверный" }).dragTo(mine.locator("[data-sound]").filter({ hasText: "первый" }));
  await expect.poll(async () => (await names(mine)).map((s) => s.trim().split("\n").pop())).toEqual(["серверный", "первый", "второй"]);
  // The screen moves at once; the server gets the order a moment later.
  const saved = async () => {
    const list = await (await request.get(`${BASE}/api/expressions`, { headers: { authorization: `Bearer ${bob.access}` } })).json();
    return list.sounds.filter((s: { guildId: string | null }) => !s.guildId).sort((a: { position: number }, c: { position: number }) => a.position - c.position).map((s: { name: string }) => s.name);
  };
  await expect.poll(saved).toEqual(["серверный", "первый", "второй"]);

  // The menu does the same without dragging.
  await mine.locator("[data-sound]").filter({ hasText: "второй" }).click({ button: "right" });
  await p.getByRole("menuitem", { name: /Копировать на сервер/ }).first().click();
  await expect(server.locator("[data-sound]").filter({ hasText: "второй" })).toBeVisible();
  noErrors(b);
});

test("soundboard: playing sounds often sends no audio of its own and leaves the call alone", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL, "imports modules through the dev server");
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, voice } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${voice.id}`, { local: { noise: "off" } });
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${voice.id}`, { local: { noise: "off" } });
  await a.page.getByRole("button", { name: "Зайти в канал" }).click();
  await b.page.getByRole("button", { name: "Зайти в канал" }).click();
  const aliceSpeaks = b.page.locator(`[data-user="${alice.id}"] [data-speaking="true"]`);
  const aliceSound = b.page.locator(`[data-user="${alice.id}"] [data-soundboard-playing]`);
  await expect(aliceSpeaks).toBeVisible({ timeout: 20_000 });

  /** Alice's room as seen from a page: what she publishes, the call state, and a LiveKit scenario to run first. */
  const room = (page: Page, act = "") =>
    page.evaluate(
      async ([aliceId, act]) => {
        const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/features/voice/voice.ts")) ?? "/src/features/voice/voice.ts";
        const m = (await import(/* @vite-ignore */ url)) as { getRoom: () => import("livekit-client").Room | null; useVoice: { getState: () => { state: string } } };
        const r = m.getRoom();
        if (act) await r?.simulateScenario(act as never);
        const p = r?.localParticipant.identity === aliceId ? r.localParticipant : r?.remoteParticipants.get(aliceId);
        return { state: m.useVoice.getState().state, tracks: [...(p?.trackPublications.values() ?? [])].map((t) => `${t.source}:${t.trackName}`).sort() };
      },
      [alice.id, act] as const
    );
  const before = (await room(a.page)).tracks;
  expect(before).toEqual(["microphone:"]);

  // A dozen sounds in quick succession: Bob hears them, no more than four at a time.
  await a.page.getByRole("button", { name: "Саундпад" }).last().click();
  for (let i = 0; i < 12; i++) await a.page.locator('[data-clip="ding"]').click();
  await expect(aliceSound).toBeVisible();
  const most = await b.page.evaluate(async (aliceId) => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/features/voice/clips.ts")) ?? "/src/features/voice/clips.ts";
    const m = (await import(/* @vite-ignore */ url)) as { useSoundboard: { getState: () => { heard: Record<string, number> } } };
    return m.useSoundboard.getState().heard[aliceId] ?? 0;
  }, alice.id);
  expect(most).toBeLessThanOrEqual(4);
  await expect(aliceSound).toHaveCount(0, { timeout: 8000 });

  // Nothing was published for them, on either side; her voice still comes through.
  expect((await room(a.page)).tracks).toEqual(before);
  expect((await room(b.page)).tracks).toEqual(before);
  await expect(aliceSpeaks).toBeVisible();

  // After a full reconnect, sounds and voice both still arrive.
  await room(a.page, "full-reconnect");
  await expect.poll(async () => (await room(a.page)).state, { timeout: 20_000 }).toBe("connected");
  await expect(aliceSpeaks).toBeVisible({ timeout: 20_000 });
  await a.page.locator('[data-clip="ding"]').click();
  await expect(aliceSound).toBeVisible();
  expect((await room(b.page)).tracks).toEqual(before);
  noErrors(a, b);
});
