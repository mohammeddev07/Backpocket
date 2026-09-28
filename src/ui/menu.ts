// Generic popover menu (link "⋯" menu + folder kebab menu).

export type MenuItem =
  | { separator: true }
  | { label: string; onClick: () => void; danger?: boolean; separator?: false };

let openMenuEl: HTMLElement | null = null;
let openMenuCloser: ((e: Event) => void) | null = null;

export function closeMenu(): void {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
  if (openMenuCloser) {
    document.removeEventListener('click', openMenuCloser, true);
    document.removeEventListener('keydown', openMenuCloser, true);
    openMenuCloser = null;
  }
}

export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu';
  menu.setAttribute('role', 'menu');
  items.forEach((item) => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-item' + (item.danger ? ' danger' : '');
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    btn.onclick = (e) => { e.stopPropagation(); closeMenu(); item.onClick(); };
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  let left = r.right - menu.offsetWidth;
  if (left < 8) left = 8;
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - menu.offsetHeight - 4;
  if (top < 8) top = 8;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  openMenuEl = menu;
  const closer = (e: Event) => {
    if (e.type === 'keydown') {
      if ((e as KeyboardEvent).key === 'Escape') { closeMenu(); anchor.focus(); }
      return;
    }
    if (!menu.contains(e.target as Node) && e.target !== anchor) closeMenu();
  };
  openMenuCloser = closer;
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('keydown', closer, true);
  }, 0);

  // Arrow-key cycling between items, per the APG menu pattern. Tab closes
  // the menu instead of tabbing into it, since menus aren't a tab stop.
  menu.addEventListener('keydown', (e) => {
    const menuItems = Array.from(menu.querySelectorAll<HTMLElement>('.menu-item'));
    const i = menuItems.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (menuItems[i + 1] || menuItems[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (menuItems[i - 1] || menuItems[menuItems.length - 1]).focus(); }
    else if (e.key === 'Home') { e.preventDefault(); menuItems[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); menuItems[menuItems.length - 1].focus(); }
    else if (e.key === 'Tab') { closeMenu(); }
  });

  const first = menu.querySelector<HTMLElement>('.menu-item');
  if (first) first.focus();
}
