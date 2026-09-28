// Free-form tag field: chips + text input with autocomplete from existing tags.
// Enter/comma adds a tag, Backspace on an empty field removes the last one.

export interface TagInput {
  get(): string[];
  set(tags: string[]): void;
  focus(): void;
}

let counter = 0;

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').slice(0, 40);
}

export function createTagInput(container: HTMLElement, opts: {
  placeholder: string;
  label: string;
  suggestions: () => string[];
  /** Enter on an empty field (e.g. save the form). */
  onSubmit?: () => void;
}): TagInput {
  const id = 'tags-' + ++counter;
  let tags: string[] = [];
  let active = -1;
  let matches: string[] = [];

  container.classList.add('tag-input');
  const chips = document.createElement('span');
  chips.className = 'tag-input-chips';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = opts.placeholder;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', opts.label);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id + '-list');
  input.setAttribute('enterkeyhint', 'done');
  const list = document.createElement('ul');
  list.className = 'tag-suggestions';
  list.id = id + '-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  container.replaceChildren(chips, input, list);
  container.addEventListener('click', (e) => { if (e.target === container || e.target === chips) input.focus(); });

  function renderChips(): void {
    chips.replaceChildren();
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip removable';
      chip.textContent = '#' + t;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'tag-remove';
      x.setAttribute('aria-label', 'Remove tag ' + t);
      x.textContent = '×';
      x.onclick = (e) => { e.stopPropagation(); tags = tags.filter((y) => y !== t); renderChips(); input.focus(); };
      chip.appendChild(x);
      chips.appendChild(chip);
    }
    input.placeholder = tags.length ? '' : opts.placeholder;
  }

  function add(raw: string): void {
    for (const part of raw.split(',')) {
      const t = normalizeTag(part);
      if (t && !tags.includes(t)) tags.push(t);
    }
    input.value = '';
    renderChips();
    closeList();
  }

  function closeList(): void {
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function openList(): void {
    const q = normalizeTag(input.value);
    matches = opts.suggestions().filter((t) => !tags.includes(t) && (!q || t.includes(q))).slice(0, 6);
    list.replaceChildren();
    if (!matches.length) { closeList(); return; }
    matches.forEach((t, i) => {
      const li = document.createElement('li');
      li.id = id + '-opt-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.textContent = '#' + t;
      li.onmousedown = (e) => { e.preventDefault(); add(t); input.focus(); };
      list.appendChild(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', id + '-opt-' + active);
    else input.removeAttribute('aria-activedescendant');
  }

  input.addEventListener('input', () => {
    if (input.value.includes(',')) { add(input.value); return; }
    active = -1;
    openList();
  });
  input.addEventListener('focus', () => openList());
  input.addEventListener('blur', () => { if (input.value.trim()) add(input.value); closeList(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !list.hidden) { e.preventDefault(); active = Math.min(active + 1, matches.length - 1); openList(); }
    else if (e.key === 'ArrowUp' && !list.hidden) { e.preventDefault(); active = Math.max(active - 1, -1); openList(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && matches[active]) add(matches[active]);
      else if (input.value.trim()) add(input.value);
      else opts.onSubmit?.();
    } else if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); closeList(); }
    else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); renderChips(); }
  });

  renderChips();
  return {
    get: () => { if (input.value.trim()) add(input.value); return tags.slice(); },
    set: (t) => { tags = [...new Set(t.map(normalizeTag).filter(Boolean))]; input.value = ''; renderChips(); closeList(); },
    focus: () => input.focus(),
  };
}
