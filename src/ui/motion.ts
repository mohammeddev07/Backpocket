// Shared motion helpers. Timings are the --dur-* and --ease tokens in app.css.
// Under reduced motion the decorative ones do nothing, and the waits resolve
// at once (the stylesheet has already dropped every animation).

export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A token from app.css ('--dur-move'), so JS never carries a copied duration. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Resolves when the element's CSS animations finish (at once if there are none). */
export function settled(el: Element, subtree = true): Promise<void> {
  return Promise.all((el.getAnimations?.({ subtree }) ?? []).map((a) => a.finished)).then(() => {}, () => {});
}

/** Restarts the animation a class carries, even if it's mid-way. */
export function replay(el: Element, cls: string): void {
  el.classList.remove(cls);
  void el.getBoundingClientRect(); // a style flush between the two is what restarts it
  el.classList.add(cls);
}

/**
 * Tosses a copy of `source` over to `target`, shrinking as it lands, and the
 * target gives a small catch. Decorative: whatever it marks is already saved.
 */
export function flyTo(source: Element, target: Element): void {
  const a = source.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  if (reducedMotion() || !a.width || !b.width) return;
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.classList.add('fly-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
  document.body.appendChild(ghost);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const landed = 'translate(' + dx + 'px, ' + dy + 'px) scale(' + (b.width / a.width) * 0.6 + ')';
  ghost.animate(
    [{ transform: 'none', opacity: 1 }, { opacity: 1, offset: 0.7 }, { transform: landed, opacity: 0 }],
    { duration: parseFloat(token('--dur-save')), easing: token('--ease') },
  ).finished.catch(() => {}).then(() => { ghost.remove(); replay(target, 'is-catching'); });
}

/** A small burst of confetti from the middle of `at`. Decorative, and it cleans up after itself. */
export function confetti(at: Element, pieces = 16): void {
  const r = at.getBoundingClientRect();
  if (reducedMotion() || !r.width) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  box.setAttribute('aria-hidden', 'true');
  box.style.left = r.left + r.width / 2 + 'px';
  box.style.top = r.top + r.height / 2 + 'px';
  for (let i = 0; i < pieces; i++) {
    const p = document.createElement('i');
    // Evenly round the circle with a little noise, thrown slightly upward.
    const angle = ((i + Math.random()) / pieces) * 2 * Math.PI;
    const reach = 44 + Math.random() * 52;
    p.style.setProperty('--x', Math.cos(angle) * reach + 'px');
    p.style.setProperty('--y', Math.sin(angle) * reach - 26 + 'px');
    p.style.setProperty('--r', Math.random() * 540 - 270 + 'deg');
    box.appendChild(p);
  }
  document.body.appendChild(box);
  void settled(box).then(() => box.remove());
}
