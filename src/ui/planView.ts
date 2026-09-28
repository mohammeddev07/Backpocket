import { AI_CONFIG } from '@shared/config.ts';
import { aiCall, aiErrorMessage } from '../ai/client';
import { showAiNoticeOnce } from '../ai/notice';
import { uid } from '../data/ids';
import { store } from '../data/store';
import type { Folder, Link, Plan } from '../data/types';
import { domainOf } from '../platform';
import { requireAi } from './aiUi';
import { plural } from './dom';
import { addHeaderExtra, fallbackCopy, openLink, setListOverride } from './list';
import { addFolderMenuItems } from './sidebar';
import { showToast } from './toast';
import { go, renderMain, view } from './view';

// Folder -> plan: an AI-made checklist saved to `plans`, shown in a Plan tab
// of the folder view. Ticks sync like any other edit.

/** Folder whose Plan tab is open (null = Links tab). */
let planTabFor: string | null = null;
const generating = new Set<string>();

const folderLinks = (folderId: string): Link[] =>
  store.liveLinks().filter((l) => l.folderId === folderId).sort((a, b) => b.createdAt - a.createdAt);
const currentPlan = (folderId: string): Plan | undefined =>
  store.livePlans().filter((p) => p.folderId === folderId).sort((a, b) => b.updatedAt - a.updatedAt)[0];

export async function makePlan(folder: Folder, confirmReplace = true): Promise<void> {
  if (!requireAi('make plans')) return;
  const links = folderLinks(folder.id);
  if (links.length < 2) { showToast('A plan needs at least 2 links in the folder.', false); return; }
  const existing = currentPlan(folder.id);
  if (existing && confirmReplace && !confirm('Replace the current plan for "' + folder.name + '"? Ticked items will be lost.')) return;
  if (generating.has(folder.id)) return;

  showAiNoticeOnce();
  if (view.mode !== 'folder' || view.folderId !== folder.id) go('folder', folder.id);
  generating.add(folder.id);
  planTabFor = folder.id;
  renderMain();
  try {
    const { plan, model } = await aiCall('plan', {
      input: {
        folder: folder.name,
        links: links.slice(0, AI_CONFIG.maxPlanLinks).map((l) => ({
          id: l.id, title: l.title, note: l.note, caption: l.sharedText, url: l.url, platform: l.platform,
        })),
      },
    });
    if (!plan.items.length) throw new Error('The plan came back empty.');
    const now = Date.now();
    if (existing) store.softDelete('plans', [existing.id]);
    store.write('plans', [{
      id: uid(), folderId: folder.id, title: plan.title, summary: plan.summary, model,
      items: plan.items.map((it) => ({ id: uid(), text: it.text, done: false, linkIds: it.link_ids })),
      createdAt: now, updatedAt: now, deletedAt: null,
    }]);
  } catch (e) {
    showToast('Couldn\'t make a plan - ' + aiErrorMessage(e), false, undefined, 5000);
  } finally {
    generating.delete(folder.id);
    renderMain();
  }
}

function planAsText(plan: Plan): string {
  const lines = [plan.title, '', plan.summary, ''];
  plan.items.forEach((it, i) => {
    lines.push((it.done ? '☑ ' : '☐ ') + (i + 1) + '. ' + it.text);
    for (const id of it.linkIds) {
      const l = store.link(id);
      if (l) lines.push('   - ' + (l.title || domainOf(l.url)) + ' - ' + l.url);
    }
  });
  return lines.join('\n').trim() + '\n';
}

function copyText(text: string): void {
  const done = () => showToast('Plan copied', true);
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}

async function sharePlan(plan: Plan): Promise<void> {
  const text = planAsText(plan);
  if (navigator.share) {
    try { await navigator.share({ title: plan.title, text }); return; } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
    }
  }
  copyText(text);
}

function toggleItem(plan: Plan, itemId: string, done: boolean): void {
  const cur = store.plans.get(plan.id);
  if (!cur) return;
  store.write('plans', [{ ...cur, items: cur.items.map((it) => (it.id === itemId ? { ...it, done } : it)) }]);
}

function skeleton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'plan plan-skeleton';
  wrap.setAttribute('aria-busy', 'true');
  const status = document.createElement('p');
  status.className = 'plan-summary';
  status.setAttribute('role', 'status');
  status.textContent = 'Making a plan from this folder… you can keep using the app.';
  wrap.appendChild(status);
  for (let i = 0; i < 6; i++) {
    const bar = document.createElement('div');
    bar.className = 'skeleton-bar';
    bar.style.width = (60 + ((i * 37) % 35)) + '%';
    wrap.appendChild(bar);
  }
  return wrap;
}

function renderPlan(listEl: HTMLElement, folder: Folder): void {
  listEl.replaceChildren();
  if (generating.has(folder.id)) { listEl.appendChild(skeleton()); return; }
  const plan = currentPlan(folder.id);
  if (!plan) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const t = document.createElement('p');
    t.className = 'empty-title';
    t.textContent = 'Turn this folder into a plan';
    const p = document.createElement('p');
    p.textContent = 'AI reads the links saved here and writes an ordered checklist, with each step pointing back to its saves.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-primary';
    btn.style.marginTop = '14px';
    btn.textContent = 'Make a plan';
    btn.onclick = () => void makePlan(folder, false);
    empty.append(t, p, btn);
    listEl.appendChild(empty);
    return;
  }

  const section = document.createElement('section');
  section.className = 'plan';
  section.setAttribute('aria-labelledby', 'planTitle');
  const h = document.createElement('h2');
  h.className = 'plan-title';
  h.id = 'planTitle';
  h.textContent = plan.title;
  const summary = document.createElement('p');
  summary.className = 'plan-summary';
  summary.textContent = plan.summary;
  const doneCount = plan.items.filter((i) => i.done).length;
  const progress = document.createElement('p');
  progress.className = 'plan-progress';
  progress.textContent = doneCount + ' of ' + plural(plan.items.length, 'step') + ' done';
  const meter = document.createElement('div');
  meter.className = 'plan-meter';
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', String(plan.items.length));
  meter.setAttribute('aria-valuenow', String(doneCount));
  meter.setAttribute('aria-label', 'Plan progress');
  const fill = document.createElement('span');
  fill.style.width = (plan.items.length ? (doneCount / plan.items.length) * 100 : 0) + '%';
  meter.appendChild(fill);

  const ol = document.createElement('ol');
  ol.className = 'plan-items';
  for (const it of plan.items) {
    const li = document.createElement('li');
    li.className = 'plan-item' + (it.done ? ' done' : '');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = it.done;
    cb.onchange = () => toggleItem(plan, it.id, cb.checked);
    const text = document.createElement('span');
    text.textContent = it.text;
    label.append(cb, text);
    li.appendChild(label);
    const chips = document.createElement('div');
    chips.className = 'plan-links';
    for (const id of it.linkIds) {
      const l = store.link(id);
      if (!l) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'plan-link-chip';
      chip.textContent = (l.title || domainOf(l.url)).slice(0, 48);
      chip.title = 'Open: ' + (l.title || l.url);
      chip.onclick = () => openLink(l);
      chips.appendChild(chip);
    }
    if (chips.children.length) li.appendChild(chips);
    ol.appendChild(li);
  }

  const actions = document.createElement('div');
  actions.className = 'plan-actions';
  const act = (label: string, fn: () => void, cls = 'btn-ghost') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.onclick = fn;
    actions.appendChild(b);
  };
  act('Regenerate', () => void makePlan(folder, true));
  act('Copy as text', () => copyText(planAsText(plan)));
  act('Share', () => void sharePlan(plan));
  act('Delete', () => {
    if (!confirm('Delete this plan?')) return;
    store.softDelete('plans', [plan.id]);
    showToast('Plan deleted', true, () => store.restore('plans', [plan.id]));
  }, 'btn-ghost danger');

  section.append(h, summary, progress, meter, ol, actions);
  listEl.appendChild(section);
}

/** Links | Plan tabs in the folder header. */
function tabs(container: HTMLElement): void {
  if (view.mode !== 'folder') { planTabFor = null; return; }
  const folder = store.folder(view.folderId);
  if (!folder || folder.isSystem) return;
  if (planTabFor && planTabFor !== folder.id) planTabFor = null;
  const hasPlan = !!currentPlan(folder.id) || generating.has(folder.id);
  if (!hasPlan && folderLinks(folder.id).length < 2) return;
  const seg = document.createElement('div');
  seg.className = 'segmented header-tabs';
  seg.setAttribute('role', 'tablist');
  seg.setAttribute('aria-label', 'Folder view');
  for (const [label, isPlan] of [['Links', false], ['Plan', true]] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    const selected = (planTabFor === folder.id) === isPlan;
    b.setAttribute('aria-selected', String(selected));
    b.setAttribute('aria-checked', String(selected));
    b.textContent = label;
    b.onclick = () => { planTabFor = isPlan ? folder.id : null; renderMain(); };
    seg.appendChild(b);
  }
  container.prepend(seg);
}

export function initPlans(): void {
  addFolderMenuItems((folder) => {
    if (folder.isSystem || folderLinks(folder.id).length < 2) return [];
    const has = !!currentPlan(folder.id);
    return [{
      label: has ? 'Open plan' : 'Make a plan',
      onClick: () => {
        if (!has) { void makePlan(folder, false); return; }
        if (view.mode !== 'folder' || view.folderId !== folder.id) go('folder', folder.id);
        planTabFor = folder.id;
        renderMain();
      },
    }];
  });
  addHeaderExtra(tabs);
  setListOverride((listEl) => {
    if (view.mode !== 'folder' || planTabFor !== view.folderId) return false;
    const folder = store.folder(view.folderId);
    if (!folder) return false;
    renderPlan(listEl, folder);
    return true;
  });
}
