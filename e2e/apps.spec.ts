import { expect, test } from "@playwright/test";
import { BASE, api, guildWith, messageRow, noErrors, openAs, register, send } from "./helpers";

// The desktop app (app://nova) and the Android WebView talk to the server
// cross-origin, so every request goes through CORS — unlike the web app. These
// sessions point the page at the API directly to cover that path.
const API = process.env.E2E_API_URL ?? "http://localhost:4000";

test("apps (cross-origin): edits, reactions, deletes and profile changes reach the server", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL && !process.env.E2E_API_URL, "needs the API address");
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { guild, text } = await guildWith(request, alice, [bob]);
  const a = await openAs(browser, alice, `/#/channels/${guild.id}/${text.id}`, { server: API });
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);
  const p = a.page;

  await send(p, "из программы");
  const mine = messageRow(p, "из программы");
  await expect(messageRow(b.page, "из программы")).toBeVisible();

  // PUT — reaction
  await mine.hover();
  await mine.getByRole("button", { name: "👍" }).click();
  await expect(messageRow(b.page, "из программы").getByText("1")).toBeVisible();

  // PATCH — edit
  await mine.hover();
  await mine.getByRole("button", { name: "Изменить" }).click();
  const editor = mine.locator("textarea, [contenteditable=true]").first();
  await editor.fill("из программы (исправлено)");
  await editor.press("Enter");
  await expect(messageRow(b.page, "(исправлено)")).toContainText("изм.");

  // PATCH — profile, from settings
  await p.getByRole("button", { name: "Настройки" }).last().click();
  await p.locator("[data-settings] nav").getByRole("button", { name: "Профиль", exact: true }).click();
  await p.locator("[data-settings] textarea").first().fill("Пишу из программы");
  await p.getByRole("button", { name: "Сохранить" }).click();
  await expect(p.getByText("Сохранено")).toBeVisible();
  await expect.poll(async () => (await api<{ bio: string | null }>(request, alice, "GET", "/api/users/@me")).bio).toBe("Пишу из программы");
  await p.keyboard.press("Escape");

  // DELETE — message (Shift skips the confirmation)
  await messageRow(p, "(исправлено)").click({ button: "right" });
  await p.keyboard.down("Shift");
  await p.getByRole("menuitem", { name: "Удалить" }).click();
  await p.keyboard.up("Shift");
  await expect(b.page.getByText("из программы")).toHaveCount(0);

  await expect(p.getByText("Нет связи с сервером")).toHaveCount(0);
  noErrors(a, b);
});

test("invite links: in the app they open the join dialog; the web page itself loads", async ({ browser, request }) => {
  const alice = await register(request, "Алиса");
  const bob = await register(request, "Боб");
  const { invite } = await guildWith(request, alice, []);
  const link = `${BASE}/invite/${invite}`;
  // Bob isn't in that server yet — somebody sent him the link in a DM.
  await api(request, alice, "POST", "/api/users/@me/relationships", { username: bob.username });
  await api(request, bob, "PUT", `/api/users/@me/relationships/${alice.id}`, {});
  const dm = await api<{ id: string }>(request, alice, "POST", "/api/users/@me/channels", { recipientId: bob.id });
  await api(request, alice, "POST", `/api/channels/${dm.id}/messages`, { content: `вот ссылка ${link}` });

  const b = await openAs(browser, bob, `/#/channels/@me/${dm.id}`);
  const tabs: string[] = [];
  b.context.on("page", (pg) => tabs.push(pg.url()));
  await b.page.getByRole("link", { name: link }).first().click();
  await expect(b.page.getByRole("dialog")).toContainText(`E2E ${alice.displayName}`);
  expect(tabs, "no browser tab for an invite to this server").toEqual([]);
  noErrors(b);

  // Someone without the app opens the link in a browser: "open in the app" and a download link.
  const visitor = await openAs(browser, null, `/#/invite/${invite}`);
  await expect(visitor.page.getByRole("button", { name: "Открыть в приложении" })).toBeVisible();
  await expect(visitor.page.getByRole("link", { name: /Скачать для Windows/ })).toHaveAttribute("href", /^https:\/\//);
  noErrors(visitor);

  // The server's own web page (production build) at /invite/CODE: it used to
  // look for its scripts under /invite/assets/… and stay blank.
  test.skip(!!process.env.E2E_URL && !process.env.E2E_API_URL, "needs the API address");
  const guest = await openAs(browser, null, `${API}/invite/${invite}`);
  await expect(guest.page.getByText(`E2E ${alice.displayName}`)).toBeVisible();
  noErrors(guest);
});
