import { expect, test } from "@playwright/test";
import { api, befriend, composer, guildWith, handle, messageRow, noErrors, openAs, register, run, send } from "./helpers";

test("sign up in the UI, create a server, a friend joins through the invite link", async ({ browser }) => {
  const a = await openAs(browser, null, "/");
  const pa = a.page;
  await pa.getByRole("button", { name: "Зарегистрироваться" }).click();
  const username = handle("ui");
  await pa.getByLabel("Отображаемое имя").fill("Алиса Тестова");
  await pa.getByLabel("Имя пользователя").fill(username);
  await pa.getByLabel("Email").fill(`${username}@e2e.test`);
  await pa.getByLabel("Пароль").fill("e2e-secret-pass-1");
  await pa.getByRole("button", { name: "Зарегистрироваться" }).click();
  await expect(pa.getByText(`@${username}`).first()).toBeVisible();

  // Create a server from a template.
  await pa.getByRole("button", { name: "Добавить сервер" }).click();
  await pa.getByRole("button", { name: "Для друзей" }).click();
  await pa.getByLabel("Название сервера").fill("Сервер Алисы");
  await pa.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(pa.getByText("Сервер Алисы").first()).toBeVisible();

  // Invite link from the invite dialog.
  await pa.getByText("Сервер Алисы").first().click();
  await pa.getByRole("menuitem", { name: /Пригласить/ }).click();
  const linkEl = pa.locator(".font-mono").filter({ hasText: "/invite/" });
  await expect(linkEl).toBeVisible();
  const link = (await linkEl.textContent())!.trim();
  const path = new URL(link).pathname;
  await pa.keyboard.press("Escape");

  // A new person opens the link: registration knows about the invite and lands them in the server.
  const b = await openAs(browser, null, path);
  const pb = b.page;
  await expect(pb.getByText("Сервер Алисы").first()).toBeVisible();
  const bName = handle("inv");
  await pb.getByLabel("Отображаемое имя").fill("Борис");
  await pb.getByLabel("Имя пользователя").fill(bName);
  await pb.getByLabel("Email").fill(`${bName}@e2e.test`);
  await pb.getByLabel("Пароль").fill("e2e-secret-pass-1");
  await pb.getByRole("button", { name: "Зарегистрироваться" }).click();
  await expect(pb.getByText("Сервер Алисы").first()).toBeVisible();

  // Alice sees Boris in the member list, live.
  await expect(pa.getByText("Борис").first()).toBeVisible();
  noErrors(a, b);
});

test("messages: live delivery, typing, reply, reaction, edit, delete, pin", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, text } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);

  // typing indicator
  await composer(a.page).click();
  await composer(a.page).pressSequentially("пишу…", { delay: 30 });
  await expect(b.page.getByText(/Алиса печатает/)).toBeVisible();
  await composer(a.page).fill("");

  await send(a.page, "Привет, Боб! **жирный** и `код`");
  const onB = messageRow(b.page, "Привет, Боб!");
  await expect(onB).toBeVisible();
  await expect(onB.locator("strong")).toHaveText("жирный");

  // reply
  await onB.hover();
  await onB.getByRole("button", { name: "Ответить" }).click();
  await send(b.page, "Отвечаю тебе");
  const reply = messageRow(a.page, "Отвечаю тебе");
  await expect(reply).toContainText("Привет, Боб!");

  // reaction (quick bar) shows up for the other side
  const mine = messageRow(a.page, "Привет, Боб!");
  await mine.hover();
  await mine.getByRole("button", { name: "👍" }).click();
  await expect(messageRow(b.page, "Привет, Боб!").getByRole("button", { name: "👍 1" })).toBeVisible();

  // edit
  await mine.hover();
  await mine.getByRole("button", { name: "Изменить" }).click();
  const editor = mine.locator("textarea, [contenteditable=true]").first();
  await editor.fill("Привет, Боб! (исправлено)");
  await editor.press("Enter");
  await expect(messageRow(b.page, "(исправлено)")).toContainText("изм.");

  // pin through the context menu → a system line for both
  await messageRow(a.page, "(исправлено)").click({ button: "right" });
  await a.page.getByRole("menuitem", { name: "Закрепить" }).click();
  await expect(b.page.getByText(/закрепляет сообщение/).first()).toBeVisible();

  // delete (Shift skips the confirmation) → gone on the other side
  await send(a.page, "удали меня");
  const doomed = messageRow(a.page, "удали меня");
  await doomed.click({ button: "right" });
  await a.page.keyboard.down("Shift");
  await a.page.getByRole("menuitem", { name: "Удалить" }).click();
  await a.page.keyboard.up("Shift");
  await expect(b.page.getByText("удали меня")).toHaveCount(0);

  noErrors(a, b);
});

test("friends by display name, then a DM with an unread badge", async ({ browser, request }) => {
  const alice = await register(request, `Алёна Ёжикова ${run}`);
  const bob = await register(request, "Боря");
  const a = await openAs(browser, alice, "/#/channels/@me");
  const b = await openAs(browser, bob, "/#/channels/@me");

  // Bob types Alice's display name (with е instead of ё) — the server resolves it.
  await b.page.getByRole("button", { name: "Добавить в друзья" }).first().click();
  await b.page.getByPlaceholder(/Имя пользователя/).fill(`алена ежикова ${run}`);
  await b.page.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(b.page.getByText(/Запрос отправлен/)).toBeVisible();

  // Alice accepts in the "Запросы" tab.
  await a.page.getByRole("button", { name: /^Запросы/ }).click();
  await a.page.getByRole("button", { name: "Принять" }).click();
  await a.page.getByRole("button", { name: /^Все/ }).click();
  await expect(a.page.getByText("Боря").first()).toBeVisible();

  // Alice opens the DM and writes; Bob gets it live.
  const dm = await api<{ id: string }>(request, alice, "POST", "/api/users/@me/channels", { recipientId: bob.id });
  await a.page.goto(`/#/channels/@me/${dm.id}`);
  await send(a.page, "Привет в личке");
  // The DM pops up in Bob's list with an unread badge; he opens it from there.
  const dmLink = b.page.getByRole("link", { name: new RegExp(`Алёна Ёжикова ${run}`) }).or(b.page.locator("aside, nav").getByText(`Алёна Ёжикова ${run}`)).first();
  await expect(dmLink).toBeVisible();
  await dmLink.click();
  await expect(messageRow(b.page, "Привет в личке")).toBeVisible();
  noErrors(a, b);
});

test("uploads: an image arrives with a preview", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, text } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);
  // 2×2 red PNG
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwMDAwMDAAAANBAIAx0mCdwAAAABJRU5ErkJggg==", "base64");
  const chooser = a.page.waitForEvent("filechooser");
  await a.page.getByRole("button", { name: "Файлы и другое" }).click();
  await a.page.getByRole("menuitem", { name: "Прикрепить файл" }).click();
  await (await chooser).setFiles({ name: "red.png", mimeType: "image/png", buffer: png });
  await composer(a.page).press("Enter");
  await expect(b.page.locator('img[src*="/files/"]').last()).toBeVisible();
  noErrors(a, b);
});

test("settings: theme and language persist across reloads", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const s = await openAs(browser, alice, "/#/channels/@me");
  const p = s.page;
  await p.getByRole("button", { name: "Настройки" }).last().click();
  await p.getByRole("button", { name: "Внешний вид", exact: true }).click();
  await p.getByRole("button", { name: /Аврора/ }).click();
  await p.getByRole("button", { name: "Язык", exact: true }).click();
  await p.getByRole("button", { name: /English/ }).click();
  await expect(p.getByRole("button", { name: "Appearance", exact: true })).toBeVisible();
  await p.reload();
  await expect(p.locator("html")).toHaveAttribute("data-theme", "aurora");
  await expect(p.getByText("Friends").first()).toBeVisible();
  noErrors(s);
});

test("a long channel: back to the latest messages lands exactly at the end, and stays there as new ones come", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, text } = await guildWith(request, alice, [bob]);
  // Few but tall (the send limit is a burst of 8): many screens of text.
  const lines = Array.from({ length: 30 }, (_, k) => `строка ${k + 1}`).join("\n");
  for (let i = 1; i <= 6; i++) await api(request, alice, "POST", `/api/channels/${text.id}/messages`, { content: `Сообщение ${i}\n${lines}`, nonce: `n${i}-${Date.now()}` });
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);
  const scroller = b.page.locator("[data-virtuoso-scroller]").filter({ hasText: "строка" });
  const gap = () => scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  const last = b.page.getByText(/^Сообщение 6/);
  await expect(last).toBeVisible();

  // Up by hand, then the button.
  await scroller.hover();
  for (let i = 0; i < 12; i++) await b.page.mouse.wheel(0, -600);
  await expect(last).toBeHidden();
  await b.page.getByRole("button", { name: "К последним сообщениям" }).click();
  await expect(last).toBeVisible();
  await expect.poll(gap).toBeLessThanOrEqual(2);

  // A new message arrives: still at the very end.
  await b.page.waitForTimeout(1500); // the send limit
  await api(request, alice, "POST", `/api/channels/${text.id}/messages`, { content: "Свежее", nonce: `fresh-${Date.now()}` });
  await expect(b.page.getByText("Свежее", { exact: true })).toBeVisible();
  await expect.poll(gap).toBeLessThanOrEqual(2);
  noErrors(b);
});

test("photo viewer: zooms where you point, 1:1 shows the photo's own pixels, a double click goes back", async ({ browser, request }) => {
  const { default: sharp } = await import("sharp");
  const alice = await register(request, "Алиса");
  const { guild, text } = await guildWith(request, alice, []);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`);
  // A big photo with a gradient, so every spot is different.
  const w = 2400, h = 1600;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([Math.round((x / w) * 255), Math.round((y / h) * 255), 120], (y * w + x) * 3);
  const jpg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
  const chooser = a.page.waitForEvent("filechooser");
  await a.page.getByRole("button", { name: "Файлы и другое" }).click();
  await a.page.getByRole("menuitem", { name: "Прикрепить файл" }).click();
  await (await chooser).setFiles({ name: "big.jpg", mimeType: "image/jpeg", buffer: jpg });
  await composer(a.page).press("Enter");
  await a.page.locator('img[src*="/files/"]').last().click();

  const photo = a.page.locator("[data-lightbox-image]");
  await expect(photo).toBeVisible();
  await a.page.waitForTimeout(500); // the opening animation
  const before = (await photo.boundingBox())!;
  // A spot off the centre: after zooming in it is still under the cursor. (While the photo is
  // still narrower than the screen it stays centred, like in any viewer — so not right at the edge.)
  const fx = 0.45, fy = 0.4;
  const px = before.x + before.width * fx, py = before.y + before.height * fy;
  await a.page.mouse.move(px, py);
  for (let i = 0; i < 5; i++) await a.page.mouse.wheel(0, -120);
  await expect.poll(async () => Number(await a.page.locator("[data-zoom]").getAttribute("data-zoom"))).toBeGreaterThan(150);
  await a.page.waitForTimeout(300);
  const after = (await photo.boundingBox())!;
  expect(Math.abs((px - after.x) / after.width - fx)).toBeLessThan(0.01);
  expect(Math.abs((py - after.y) / after.height - fy)).toBeLessThan(0.01);

  // 1:1 — the photo's own pixels.
  await a.page.locator("[data-zoom] button").nth(1).click();
  await expect.poll(async () => Math.round((await photo.boundingBox())!.width)).toBe(w);
  // A double click goes back to fitting the screen; Escape closes.
  await a.page.mouse.dblclick(px, py);
  await expect(a.page.locator("[data-zoom]")).toHaveAttribute("data-zoom", "100");
  await a.page.keyboard.press("Escape");
  await expect(photo).toBeHidden();
  noErrors(a);
});
