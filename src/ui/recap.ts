import { AI_CONFIG } from '@shared/config.ts';
import { aiReady, aiSettled } from '../ai/access';
import { aiCall } from '../ai/client';
import { NUDGE_META_KEY } from '../data/nudge';
import { RECAP_META_KEY, RECAP_MIN_LINKS, recapDue, statsRecap, weekStats, type StoredRecap } from '../data/recap';
import { store } from '../data/store';
import { pathLabel } from '../data/tree';
import { domainOf } from '../platform';
import { byId, svgIcon } from './dom';
import { addRenderHook, fallbackTile, openLink } from './list';
import { view } from './view';

// Weekly recap card at the top of All saves. Once a week (7+ days after the
// last one) it summarises the week's saves: written by AI when AI is on, a
// plain stats version otherwise. With reminders on it counts as that day's
// nudge (and the worker can send the stats version as a notification).

let recap: StoredRecap | null = null;

async function save(next: StoredRecap): Promise<void> {
  recap = next;
  await store.db.setMeta(RECAP_META_KEY, next);
  render();
}

async function checkRecap(): Promise<void> {
  const now = Date.now();
  recap = (await store.db.getMeta<StoredRecap>(RECAP_META_KEY)) || null;
  // First run: start the weekly cycle now rather than recapping a week nobody watched.
  if (!recap) { await save({ at: now, headline: '', summary: '', pickIds: [], dismissed: true, ai: false }); return; }
  if (!recapDue(recap, now)) { render(); return; }

  const stats = weekStats(store.liveLinks(), store.liveFolders(), now);
  if (stats.count < RECAP_MIN_LINKS) { await save({ ...recap, at: now, dismissed: true }); return; }

  let out = statsRecap(stats);
  let ai = false;
  await aiSettled();
  if (aiReady()) {
    try {
      const folders = store.liveFolders();
      const { recap: written } = await aiCall('recap', { input: {
        count: stats.count,
        links: stats.links.slice(0, AI_CONFIG.maxRecapLinks).map((l) => ({
          id: l.id, title: l.title || domainOf(l.url), platform: l.platform,
          folder: pathLabel(folders, l.folderId), opened: l.openedAt != null || l.status === 'done',
        })),
      } });
      if (written) {
        out = { headline: written.headline, summary: written.summary, pickIds: written.pick_ids.length ? written.pick_ids : out.pickIds };
        ai = true;
      }
    } catch { /* the stats version is fine */ }
  }
  await save({ at: now, ...out, dismissed: false, ai });
  // The recap is today's reminder: no separate single-link nudge on top of it.
  if (store.settings.remindersEnabled) await store.db.setMeta(NUDGE_META_KEY, now);
}

function render(): void {
  const el = byId('recapCard');
  const show = !!recap && !recap.dismissed && view.mode === 'all' && !view.query.trim() && !view.related && !view.selectMode
    && !byId('listToolbar').hidden;
  el.hidden = !show;
  if (!show || !recap) return;
  const r = recap;
  const picks = r.pickIds.map((id) => store.link(id)).filter((l): l is NonNullable<typeof l> => !!l && !l.deletedAt && l.openedAt == null);

  const head = document.createElement('div');
  head.className = 'recap-head';
  const kicker = document.createElement('p');
  kicker.className = 'recap-kicker';
  kicker.append(svgIcon(r.ai ? 'sparkle' : 'clock'), document.createTextNode('Weekly recap'));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn small';
  close.setAttribute('aria-label', 'Dismiss weekly recap');
  close.appendChild(svgIcon('x'));
  close.onclick = () => void save({ ...r, dismissed: true });
  head.append(kicker, close);

  const title = document.createElement('h2');
  title.className = 'recap-title';
  title.textContent = r.headline;
  const summary = document.createElement('p');
  summary.className = 'recap-summary';
  summary.textContent = r.summary;
  el.replaceChildren(head, title, summary);

  if (picks.length) {
    const label = document.createElement('p');
    label.className = 'recap-label';
    label.textContent = 'Worth opening first';
    const list = document.createElement('ul');
    list.className = 'recap-picks';
    const folders = store.liveFolders();
    for (const l of picks) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'recap-pick';
      const text = document.createElement('span');
      text.className = 'recap-pick-text';
      const t = document.createElement('span');
      t.className = 'recap-pick-title';
      t.textContent = l.title || domainOf(l.url);
      const f = document.createElement('span');
      f.className = 'recap-pick-folder';
      f.textContent = pathLabel(folders, l.folderId);
      text.append(t, f);
      btn.append(fallbackTile(l), text);
      btn.onclick = () => openLink(l);
      const li = document.createElement('li');
      li.appendChild(btn);
      list.appendChild(li);
    }
    el.append(label, list);
  }
}

export function initRecap(): void {
  addRenderHook(render);
  setTimeout(() => void checkRecap(), 4000);
}
