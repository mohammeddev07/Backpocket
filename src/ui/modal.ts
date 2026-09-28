// Dialog accessibility: focus trap, Escape-to-close, focus restoration.
// Watches each backdrop's own 'show' class rather than wrapping every
// open/close call site, so it covers every modal (and bottom sheet) uniformly.

const closeHooks = new WeakMap<HTMLElement, () => void>();

export function setupModalA11y(modalBackdrop: HTMLElement): void {
  const dialog = modalBackdrop.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) return;
  dialog.tabIndex = -1; // guarantees a focusable fallback even if empty
  let lastFocused: Element | null = null;

  function getFocusable(): HTMLElement[] {
    return Array.from(dialog!.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((el) => el.offsetParent !== null);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal(modalBackdrop);
      return;
    }
    if (e.key === 'Tab') {
      const items = getFocusable();
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  new MutationObserver(() => {
    if (modalBackdrop.classList.contains('show')) {
      if (lastFocused) return; // already open (class list changed for another reason)
      lastFocused = document.activeElement;
      document.addEventListener('keydown', onKeydown, true);
      setTimeout(() => {
        const auto = dialog.querySelector<HTMLElement>('[autofocus]');
        (auto && auto.offsetParent !== null ? auto : getFocusable()[0] || dialog).focus();
      }, 50);
    } else {
      document.removeEventListener('keydown', onKeydown, true);
      if (lastFocused instanceof HTMLElement && document.contains(lastFocused)) lastFocused.focus();
      lastFocused = null;
    }
  }).observe(modalBackdrop, { attributes: true, attributeFilter: ['class'] });

  // Backdrop click closes.
  modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(modalBackdrop); });
}

export function openModal(backdrop: HTMLElement): void {
  backdrop.classList.add('show');
}

/** Registers cleanup to run whenever this modal closes (button, Escape or backdrop). */
export function onModalClose(backdrop: HTMLElement, fn: () => void): void {
  closeHooks.set(backdrop, fn);
}

export function closeModal(backdrop: HTMLElement): void {
  if (!backdrop.classList.contains('show')) return;
  backdrop.classList.remove('show');
  closeHooks.get(backdrop)?.();
}
