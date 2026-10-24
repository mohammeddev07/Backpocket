import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Daily Queue: the done/undo loop, keyboard flow, reduced motion, the empty
// and finished states, and an axe pass. Seeds synthetic saves into the app's
// own IndexedDB (schema created by the app on first load), then reloads.

const DAY = 86_400_000;
const TITLES = ['Resume tips that work', 'Ten minute core workout', 'How Postgres scales', 'Pasta for one', 'Sketching hands', 'Night photography basics'];

async function seed(page: Page, opts: { links?: number; doneAll?: boolean } = {}): Promise<void> {
  await page.goto('./');
  await page.locator('.queue').waitFor();
  await page.evaluate(async ({ titles, n, doneAll, DAY }) => {
    const now = Date.now();
    const folder = (id: string, name: string, color: string, isSystem = false) =>
      ({ id, parentId: null, name, color, isSystem, position: 0, createdAt: now, updatedAt: now, deletedAt: null });
    const folders = [folder('inbox', 'Inbox', '#c9cdd6', true), folder('f-work', 'Work', '#3B82F6'), folder('f-fit', 'Fitness', '#10B981')];
    const links = titles.slice(0, n).map((title, i) => ({
      id: 'l' + i, folderId: i % 2 ? 'f-fit' : 'f-work', url: 'https://example.com/post/' + i,
      platform: i % 3 ? 'Instagram' : 'Link', title, titleSource: 'user', note: null, sharedText: null, thumbnailUrl: null,
      tags: ['tag' + i], status: doneAll && i < 5 ? 'done' : 'unread', openedAt: null, aiMeta: null,
      createdAt: now - (20 - i) * DAY, updatedAt: now, deletedAt: null,
    }));
    const d = new Date(now);
    const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const db = await new Promise<IDBDatabase>((res, rej) => { const q = indexedDB.open('backpocket'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const tx = db.transaction(['folders', 'links', 'meta'], 'readwrite');
    for (const s of ['folders', 'links'] as const) tx.objectStore(s).clear();
    folders.forEach((f) => tx.objectStore('folders').put(f));
    links.forEach((l) => tx.objectStore('links').put(l));
    tx.objectStore('meta').delete('queueStreak');
    if (n) tx.objectStore('meta').put({ day, ids: links.slice(0, 5).map((l) => l.id) }, 'queue');
    else tx.objectStore('meta').delete('queue');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  }, { titles: TITLES, n: opts.links ?? 6, doneAll: !!opts.doneAll, DAY });
  await page.reload();
  await page.locator('.queue').waitFor();
}

const heroTitle = (page: Page) => page.locator('.queue-focus .queue-title');
const progress = (page: Page) => page.getByRole('progressbar', { name: 'Today\'s queue' });

test('marking the focus card done moves the next one up and fills the strip', async ({ page }) => {
  await seed(page);
  await expect(heroTitle(page)).toHaveText(TITLES[0]);
  await expect(progress(page)).toHaveAttribute('aria-valuetext', '0 of 5 done today');
  await page.locator('.queue-focus').getByRole('button', { name: 'Done' }).click();
  await expect(heroTitle(page)).toHaveText(TITLES[1]);
  await expect(progress(page)).toHaveAttribute('aria-valuetext', '1 of 5 done today');
  await expect(page.locator('.queue-seg.is-done')).toHaveCount(1);
  await expect(page.locator('.streak-pill')).toHaveText('1-day streak');
  await expect(page.locator('#toast')).toContainText('Done. 1 of 5 today');
});

test('undo puts the item and the streak back', async ({ page }) => {
  await seed(page);
  await page.locator('.queue-focus').getByRole('button', { name: 'Done' }).click();
  await expect(heroTitle(page)).toHaveText(TITLES[1]);
  await page.locator('#toast').getByRole('button', { name: 'Undo' }).click();
  await expect(heroTitle(page)).toHaveText(TITLES[0]);
  await expect(progress(page)).toHaveAttribute('aria-valuetext', '0 of 5 done today');
  await expect(page.locator('.streak-pill')).toHaveText('Finish one today to start a streak');
  await expect(page.locator('#toast')).toContainText('Back in your queue');
});

test('keyboard only: J/K move, D done, U undo, Shift+J reorder', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'keyboard flow is a desktop feature');
  await seed(page);
  const focusedTitle = () => page.evaluate(() =>
    document.activeElement?.closest('[data-qid]')?.querySelector('.queue-title, .queue-card-title')?.textContent);
  await page.keyboard.press('j');
  expect(await focusedTitle()).toBe(TITLES[0]);
  await page.keyboard.press('j');
  expect(await focusedTitle()).toBe(TITLES[1]);
  await page.keyboard.press('k');
  expect(await focusedTitle()).toBe(TITLES[0]);
  await expect(page.locator(':focus')).toHaveText('Start reading');

  await page.keyboard.press('d');
  await expect(heroTitle(page)).toHaveText(TITLES[1]);
  // Focus carries on with the new focus card instead of dropping to the page.
  await expect.poll(focusedTitle).toBe(TITLES[1]);

  await page.keyboard.press('u');
  await expect(heroTitle(page)).toHaveText(TITLES[0]);
  await expect.poll(focusedTitle).toBe(TITLES[0]);

  await page.keyboard.press('Shift+J');
  await expect(heroTitle(page)).toHaveText(TITLES[1]);
  await expect(page.locator('.queue-card-title').first()).toHaveText(TITLES[0]);
  await expect.poll(focusedTitle).toBe(TITLES[0]);
});

test('reduced motion: Done lands at once with no animations or view transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seed(page);
  const result = await page.evaluate(async () => {
    const t0 = performance.now();
    (document.querySelector('.queue-focus [data-part="done"]') as HTMLElement).click();
    const seen: string[] = [];
    // Sample every frame for ~300ms: no animation should ever be running.
    while (performance.now() - t0 < 300) {
      await new Promise(requestAnimationFrame);
      document.getAnimations().forEach((a) => seen.push((a as CSSAnimation).animationName || String((a.effect as KeyframeEffect)?.pseudoElement)));
    }
    return { seen, title: document.querySelector('.queue-focus .queue-title')?.textContent };
  });
  expect(result.seen).toEqual([]);
  expect(result.title).toBe(TITLES[1]);
});

test('swipe right on the focus card marks it done', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'touch only');
  await seed(page);
  await page.evaluate(() => {
    const card = document.querySelector('.queue-focus') as HTMLElement;
    const r = card.getBoundingClientRect();
    const ev = (type: string, x: number) => card.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', clientX: x, clientY: r.top + 40, bubbles: true }));
    ev('pointerdown', r.left + 20);
    ev('pointermove', r.left + 20 + r.width * 0.2);
    ev('pointermove', r.left + 20 + r.width * 0.5);
    ev('pointerup', r.left + 20 + r.width * 0.5);
  });
  await expect(heroTitle(page)).toHaveText(TITLES[1]);
});

test('empty queue and finished queue states', async ({ page }) => {
  await seed(page, { links: 0 });
  await expect(page.getByRole('heading', { name: 'Nothing to catch up on yet' })).toBeVisible();
  await expect(progress(page)).toHaveCount(0);

  await seed(page, { doneAll: true });
  await expect(page.getByRole('heading', { name: 'That\'s today\'s five' })).toBeVisible();
  await expect(progress(page)).toHaveAttribute('aria-valuetext', '5 of 5 done today');
});

for (const scheme of ['dark', 'light'] as const) {
  test(`axe: no serious or critical issues (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await seed(page);
    await page.waitForTimeout(500); // let the entrance finish so axe sees final colours
    const scan = async () => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze())
      .violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(', '));
    expect(await scan()).toEqual([]);
    await page.locator('.queue-focus').getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('#toast')).toContainText('Done.');
    // Mid fade-in, axe would measure the toast's colours at partial opacity.
    await page.locator('#toast').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    expect(await scan()).toEqual([]);
  });
}
