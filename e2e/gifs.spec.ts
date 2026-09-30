import sharp from "sharp";
import { expect, test, type BrowserContext } from "@playwright/test";
import { BASE, api, grantAdmin, guildWith, noErrors, openAs, register, run } from "./helpers";

const KEY = `e2e-key-${run}`;
const media = (slug: string) => `https://static.klipy.com/e2e/${slug}.webp`;

/** KLIPY as the apps see it: the API answers only to the right key, the CDN serves pictures. */
async function fakeKlipy(context: BrowserContext, picture: Buffer, shares: string[]) {
  const item = (slug: string, width: number, height: number) => ({
    id: slug,
    slug,
    title: slug,
    type: "gif",
    file: { hd: { webp: { url: media(slug), width, height } }, sm: { webp: { url: media(`${slug}-sm`), width: width / 2, height: height / 2 } } },
  });
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  await context.route("https://api.klipy.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const [, , , key, , op, slug] = url.pathname.split("/"); // /api/v1/<key>/gifs/<op>[/<slug>]
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
    if (key !== KEY) return json({ result: false, errors: { message: ["The provided API key is invalid."] } }, 404);
    if (op === "categories") return json({ result: true, data: { locale: "ru_RU", categories: [{ category: "привет", query: "привет", preview_url: media("hello-sm") }] } });
    if (op === "share") {
      shares.push(slug);
      return json({ result: true });
    }
    const items = op === "search" ? [item("hello", 320, 240)] : [item("wow", 320, 180), item("dance", 240, 320)];
    return json({ result: true, data: { data: items, current_page: 1, per_page: 24, has_next: false } });
  });
  await context.route("https://static.klipy.com/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: picture }));
}

test("GIFs: favourites without search, then search with a provider key", async ({ browser, request }) => {
  test.skip(!!process.env.E2E_URL, "grants admin rights through the local database");
  const admin = await register(request, `Админ ${run}`);
  const bob = await register(request, `Боб ${run}`);
  grantAdmin(admin);
  await api(request, admin, "PUT", "/api/admin/settings", { gifKey: "" });
  const { guild, text } = await guildWith(request, admin, [bob]);

  // Somebody posts a GIF as a file.
  const picture = await sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 250, g: 180, b: 60 } } }).gif().toBuffer();
  const up = await request.post(`${BASE}/api/attachments`, { headers: { authorization: `Bearer ${admin.access}` }, multipart: { file: { name: "cat.gif", mimeType: "image/gif", buffer: picture } } });
  expect(up.status()).toBe(201);
  const att = await up.json();
  await api(request, admin, "POST", `/api/channels/${text.id}/messages`, { content: "", attachments: [att.id] });

  const shares: string[] = [];
  const a = await openAs(browser, admin, `/#/channels/${guild.id}/${text.id}`);
  const b = await openAs(browser, bob, `/#/channels/${guild.id}/${text.id}`);
  await fakeKlipy(a.context, picture, shares);
  await fakeKlipy(b.context, picture, shares);
  const gifButton = (p: typeof a.page) => p.getByRole("button", { name: "GIF", exact: true }).first();

  try {
    // ── no search key: Bob stars the GIF in chat and sends it again from favourites ──
    const posted = b.page.locator('[data-mid] img[src*="cat.gif"]');
    await expect(posted).toHaveCount(1);
    await posted.hover();
    await b.page.getByRole("button", { name: "В избранное" }).click();
    await expect(b.page.getByRole("button", { name: "Убрать из избранного" })).toBeVisible();
    await expect.poll(async () => (await api<unknown[]>(request, bob, "GET", "/api/users/@me/gifs")).length).toBe(1);

    await gifButton(b.page).click();
    const bTab = b.page.getByTestId("gif-tab");
    await expect(bTab.getByText(/не включён/)).toBeVisible();
    await expect(bTab.getByPlaceholder("Поиск в KLIPY")).toHaveCount(0);
    await expect(bTab.locator("[data-gif]")).toHaveCount(1);
    await bTab.getByRole("button", { name: "Отправить GIF" }).click();
    await expect(bTab).toHaveCount(0);
    // The message is the picture itself: no link text, for the sender and for the others.
    await expect(posted).toHaveCount(2);
    await expect(a.page.locator('[data-mid] img[src*="cat.gif"]')).toHaveCount(2);
    await expect(b.page.locator("[data-mid]").getByText(/\/files\//)).toHaveCount(0);
    await expect(a.page.locator("[data-mid]").getByText(/\/files\//)).toHaveCount(0);

    // ── the admin turns search on from the picker's hint ──
    await gifButton(a.page).click();
    await a.page.getByTestId("gif-tab").getByRole("button", { name: "Настроить" }).click();
    const keyInput = a.page.getByLabel("Ключ KLIPY");
    await keyInput.fill("wrong-key");
    await keyInput.press("Enter");
    await expect(a.page.getByText(/KLIPY не принял этот ключ/)).toBeVisible();
    expect((await (await request.get(`${BASE}/api/auth/info`)).json()).gifs).toBe(false);
    await keyInput.fill(KEY);
    await keyInput.press("Enter");
    await expect.poll(async () => (await (await request.get(`${BASE}/api/auth/info`)).json()).gifs).toBe(true);
    await expect(a.page.getByText("Включён", { exact: true })).toBeVisible();
    await a.page.keyboard.press("Escape");
    await expect(a.page.locator("[data-settings]")).toHaveCount(0);

    // ── trending, a category, a search result: starred and sent ──
    await gifButton(a.page).click();
    const aTab = a.page.getByTestId("gif-tab");
    await expect(aTab.getByPlaceholder("Поиск в KLIPY")).toBeVisible();
    await expect(aTab.locator("[data-gif]")).toHaveCount(2);
    await aTab.getByRole("button", { name: "привет", exact: true }).click();
    const hit = aTab.locator(`[data-gif="${media("hello")}"]`);
    await expect(hit).toBeVisible();
    await expect(aTab.locator("[data-gif]")).toHaveCount(1);
    await hit.hover();
    await hit.getByRole("button", { name: "В избранное" }).click();
    await hit.getByRole("button", { name: "Отправить GIF" }).click();

    for (const s of [a, b]) {
      await expect(s.page.locator(`[data-mid] img[src="${media("hello")}"]`)).toBeVisible();
      await expect(s.page.locator("[data-mid]").getByText(/static\.klipy\.com/)).toHaveCount(0);
    }
    await expect.poll(() => shares).toEqual(["hello"]);

    // Favourites and recent now hold it — on the server, so on every device.
    await gifButton(a.page).click();
    await aTab.getByRole("button", { name: "Избранное", exact: true }).click();
    await expect(aTab.locator("[data-gif]")).toHaveCount(1);
    await expect(aTab.locator(`[data-gif="${media("hello")}"]`)).toBeVisible();
    await aTab.getByRole("button", { name: "Недавние", exact: true }).click();
    await expect(aTab.locator(`[data-gif="${media("hello")}"]`)).toBeVisible();
    expect((await api<{ url: string }[]>(request, admin, "GET", "/api/users/@me/gifs")).map((g) => g.url)).toEqual([media("hello")]);

    // Bob's picker has search too now (the key is asked for again when the picker opens).
    await b.page.reload();
    await expect(b.page.locator("[data-shell]")).toBeVisible();
    await gifButton(b.page).click();
    await expect(b.page.getByTestId("gif-tab").getByPlaceholder("Поиск в KLIPY")).toBeVisible();
    await expect(b.page.getByTestId("gif-tab").locator("[data-gif]")).toHaveCount(2);

    noErrors(a, b);
  } finally {
    await api(request, admin, "PUT", "/api/admin/settings", { gifKey: "" });
    await a.context.close();
    await b.context.close();
  }
});
