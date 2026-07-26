/* Tiny DOM helpers. Everything builds nodes and sets textContent -- filenames and
 * file contents are untrusted input, so innerHTML is never used anywhere in this app. */

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let toastTimer = null;
export function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.classList.add('show');
  clearTimeout(toastTimer);
  // Errors stay up longer: they usually carry an instruction to act on.
  toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 7000 : 3400);
}

let menuEl = null;
export function showMenu(x, y, items) {
  hideMenu();
  menuEl = el('div', 'menu');
  for (const item of items) {
    if (item === '-') {
      menuEl.appendChild(el('div', 'menu-sep'));
      continue;
    }
    const [label, fn, cls] = item;
    const row = el('div', 'menu-item' + (cls ? ' ' + cls : ''), label);
    row.addEventListener('click', () => {
      hideMenu();
      fn();
    });
    menuEl.appendChild(row);
  }
  // Place it, then nudge back inside the viewport if it would overflow.
  menuEl.style.left = x + 'px';
  menuEl.style.top = y + 'px';
  document.body.appendChild(menuEl);
  const r = menuEl.getBoundingClientRect();
  if (r.right > window.innerWidth) menuEl.style.left = Math.max(4, window.innerWidth - r.width - 6) + 'px';
  if (r.bottom > window.innerHeight) menuEl.style.top = Math.max(4, window.innerHeight - r.height - 6) + 'px';

  setTimeout(() => {
    document.addEventListener('click', hideMenu, { once: true });
    document.addEventListener('contextmenu', hideMenu, { once: true });
  }, 0);
}

export function hideMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}
