import { byId, ICON_CHECK } from './dom';

export interface ToastAction { label: string; onClick: () => void }

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function hideToast(): void {
  byId('toast').classList.remove('show');
}

/**
 * Shows a toast. Pass an undo function (v1 signature) or a list of actions
 * ("Undo", "Change"). Toasts with actions stay up longer.
 */
export function showToast(msg: string, ok: boolean, actions?: (() => void) | ToastAction[], ms?: number): void {
  const toastEl = byId('toast');
  toastEl.replaceChildren();
  if (ok) {
    const check = document.createElement('span');
    check.className = 'check';
    check.innerHTML = ICON_CHECK;
    toastEl.appendChild(check);
  }
  const text = document.createElement('span');
  text.textContent = msg;
  toastEl.appendChild(text);
  const list: ToastAction[] = typeof actions === 'function' ? [{ label: 'Undo', onClick: actions }] : (actions || []);
  for (const a of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-undo';
    btn.textContent = a.label;
    btn.onclick = () => { a.onClick(); hideToast(); };
    toastEl.appendChild(btn);
  }
  toastEl.classList.toggle('has-actions', list.length > 0);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms ?? (list.length ? 5000 : 1900));
}
