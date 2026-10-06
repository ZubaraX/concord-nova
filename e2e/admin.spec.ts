import { expect, test } from "@playwright/test";
import { BASE, api, grantAdmin, guildWith, noErrors, openAs, register, run } from "./helpers";

test("instance admin: accounts, server ownership and registration from the app", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL, "grants admin rights through the local database");
  const admin = await register(request, `Админ ${run}`);
  const owner = await register(request, `Владелец ${run}`);
  const member = await register(request, `Участник ${run}`);
  grantAdmin(admin);
  const { guild } = await guildWith(request, owner, [member]);

  const a = await openAs(browser, admin);
  const p = a.page;
  try {
    await p.getByRole("button", { name: "Настройки" }).last().click();
    const nav = p.locator("[data-settings] nav");
    const dialog = () => p.getByRole("dialog").last();

    // Overview: live numbers + registration mode.
    await nav.getByRole("button", { name: "Обзор", exact: true }).click();
    await expect(p.getByText("Сейчас в сети")).toBeVisible();
    await p.getByRole("button", { name: "По приглашению", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`${BASE}/api/auth/info`)).json()).registration).toBe("invite");
    await p.getByRole("button", { name: "Открыта", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`${BASE}/api/auth/info`)).json()).registration).toBe("open");

    // Users: disabling signs the account out everywhere and blocks sign-in.
    await nav.getByRole("button", { name: "Пользователи", exact: true }).click();
    const search = p.getByPlaceholder("Имя, @логин или email");
    await search.fill(owner.username);
    const row = p.locator(`[data-user="${owner.username}"]`);
    await row.getByRole("button", { name: "Ещё" }).click();
    await p.getByRole("menuitem", { name: "Отключить аккаунт" }).click();
    await dialog().getByRole("button", { name: "Отключить аккаунт" }).click();
    await expect(row.getByText(/отключён/i)).toBeVisible();
    expect((await request.post(`${BASE}/api/auth/login`, { data: { login: owner.username, password: owner.password } })).status()).toBe(403);
    expect((await request.get(`${BASE}/api/users/@me`, { headers: { authorization: `Bearer ${owner.access}` } })).status()).toBe(401);

    // Servers: the one with a disabled owner is flagged and handed to a member.
    await nav.getByRole("button", { name: "Серверы", exact: true }).click();
    const g = p.locator(`[data-guild="${guild.name}"]`);
    await expect(g.getByText(/отключён/i)).toBeVisible();
    await expect(p.getByText(/владелец отключён/)).toBeVisible();
    await g.getByRole("button", { name: "Сменить владельца" }).click();
    await dialog().getByRole("button", { name: new RegExp(member.username) }).click();
    await dialog().getByRole("button", { name: "Передать" }).click();
    await expect(g).toContainText(member.displayName);
    expect((await api<{ id: string; ownerId: string }[]>(request, admin, "GET", "/api/admin/guilds")).find((x) => x.id === guild.id)?.ownerId).toBe(member.id);

    // Back to users: enable again, then issue a new password that works at once.
    await nav.getByRole("button", { name: "Пользователи", exact: true }).click();
    await search.fill(owner.username);
    await row.getByRole("button", { name: "Ещё" }).click();
    await p.getByRole("menuitem", { name: "Включить аккаунт" }).click();
    await expect(row.getByText(/отключён/i)).toHaveCount(0);
    await row.getByRole("button", { name: "Ещё" }).click();
    await p.getByRole("menuitem", { name: "Сбросить пароль" }).click();
    await dialog().getByRole("button", { name: "Сбросить пароль" }).click();
    const issued = dialog().locator(".font-mono");
    await expect(issued).toHaveText(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    const password = (await issued.textContent())!;
    await dialog().getByRole("button", { name: "Готово" }).click();
    expect((await request.post(`${BASE}/api/auth/login`, { data: { login: owner.username, password } })).status()).toBe(200);

    // Admin rights: granted from the menu, the new admin reaches the admin API.
    await search.fill(member.username);
    const mrow = p.locator(`[data-user="${member.username}"]`);
    await mrow.getByRole("button", { name: "Ещё" }).click();
    await p.getByRole("menuitem", { name: "Сделать администратором" }).click();
    await dialog().getByRole("button", { name: "Сделать администратором" }).click();
    await expect(mrow.getByText(/админ/i)).toBeVisible();
    expect((await request.get(`${BASE}/api/admin/overview`, { headers: { authorization: `Bearer ${member.access}` } })).status()).toBe(200);
    noErrors(a);
  } finally {
    // Never leave the shared dev instance closed to new accounts.
    await api(request, admin, "PUT", "/api/admin/settings", { registration: "open" });
    await a.context.close();
  }
});

test("password-reset mail: set up in the app; without it the sign-in screen says whom to ask", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL, "grants admin rights through the local database");
  const admin = await register(request, `Почта ${run}`);
  grantAdmin(admin);
  await api(request, admin, "DELETE", "/api/admin/mail");

  // Signed out: "Forgot password?" explains instead of promising a letter.
  const anon = await openAs(browser, null, "/");
  await anon.page.getByRole("button", { name: "Забыли пароль?" }).click();
  await expect(anon.page.getByText(/не настроена почта/)).toBeVisible();
  await expect(anon.page.getByRole("button", { name: "Отправить код" })).toHaveCount(0);

  const a = await openAs(browser, admin);
  const p = a.page;
  try {
    await p.getByRole("button", { name: "Настройки" }).last().click();
    await p.locator("[data-settings] nav").getByRole("button", { name: "Обзор", exact: true }).click();
    const box = p.locator("[data-mail-settings]");
    await expect(box.getByText("Выключен")).toBeVisible();
    await expect(box.getByText(/id\.yandex\.ru/)).toBeVisible(); // Yandex is the default, with its how-to
    await box.getByLabel("Адрес ящика").fill("nova-test@yandex.ru");
    await box.getByLabel("Пароль приложения").fill("app-password");
    await box.getByRole("button", { name: "Сохранить" }).click();
    await expect(box.getByText("Включён")).toBeVisible();
    await expect(box.getByText(/nova-test@yandex\.ru/)).toBeVisible();
    await expect(box.getByLabel("Пароль приложения")).toHaveAttribute("placeholder", /сохранён/);
    expect((await (await request.get(`${BASE}/api/auth/info`)).json()).mail).toBe(true);
    // Off again.
    await box.getByRole("button", { name: "Выключить" }).click();
    await expect(box.getByText("Выключен")).toBeVisible();
    expect((await (await request.get(`${BASE}/api/auth/info`)).json()).mail).toBe(false);
    noErrors(a, anon);
  } finally {
    await api(request, admin, "DELETE", "/api/admin/mail");
  }
});
