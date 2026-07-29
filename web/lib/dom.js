/* Tiny DOM helpers. Everything builds nodes and sets textContent -- filenames and
 * file contents are untrusted input, so innerHTML is never used anywhere in this app. */

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (tag === 'button') e.type = 'button';
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
  t.setAttribute('role', bad ? 'alert' : 'status');
  t.setAttribute('aria-live', bad ? 'assertive' : 'polite');
  t.classList.add('show');
  clearTimeout(toastTimer);
  // Errors stay up longer: they usually carry an instruction to act on.
  toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 7000 : 3400);
}

let menuEl = null;
let menuReturnFocus = null;
let menuOutsideClick = null;
let menuOutsideContext = null;
export function showMenu(x, y, items, returnFocus = null) {
  hideMenu();
  menuEl = el('div', 'menu');
  menuEl.setAttribute('role', 'menu');
  menuEl.setAttribute('aria-label', 'Actions for selected entry');
  menuReturnFocus = returnFocus;
  const buttons = [];
  for (const item of items) {
    if (item === '-') {
      const separator = el('div', 'menu-sep');
      separator.setAttribute('role', 'separator');
      menuEl.appendChild(separator);
      continue;
    }
    const [label, fn, cls] = item;
    const row = el('button', 'menu-item' + (cls ? ' ' + cls : ''), label);
    row.setAttribute('role', 'menuitem');
    row.tabIndex = -1;
    row.addEventListener('click', () => {
      hideMenu();
      fn();
    });
    menuEl.appendChild(row);
    buttons.push(row);
  }
  // Place it, then nudge back inside the viewport if it would overflow.
  menuEl.style.left = x + 'px';
  menuEl.style.top = y + 'px';
  document.body.appendChild(menuEl);
  const r = menuEl.getBoundingClientRect();
  if (r.right > window.innerWidth) menuEl.style.left = Math.max(4, window.innerWidth - r.width - 6) + 'px';
  if (r.bottom > window.innerHeight) menuEl.style.top = Math.max(4, window.innerHeight - r.height - 6) + 'px';

  menuEl.addEventListener('keydown', (event) => {
    const i = buttons.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = buttons[(i + 1 + buttons.length) % buttons.length];
    else if (event.key === 'ArrowUp') next = buttons[(i - 1 + buttons.length) % buttons.length];
    else if (event.key === 'Home') next = buttons[0];
    else if (event.key === 'End') next = buttons[buttons.length - 1];
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      hideMenu(true);
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });
  if (buttons[0]) buttons[0].focus();

  setTimeout(() => {
    menuOutsideClick = (event) => {
      if (menuEl && !menuEl.contains(event.target)) hideMenu();
    };
    menuOutsideContext = (event) => {
      if (menuEl && !menuEl.contains(event.target)) hideMenu();
    };
    document.addEventListener('click', menuOutsideClick);
    document.addEventListener('contextmenu', menuOutsideContext);
  }, 0);
}

export function hideMenu(restoreFocus = false) {
  const focusTarget = menuReturnFocus;
  if (menuOutsideClick) document.removeEventListener('click', menuOutsideClick);
  if (menuOutsideContext) document.removeEventListener('contextmenu', menuOutsideContext);
  menuOutsideClick = null;
  menuOutsideContext = null;
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
  menuReturnFocus = null;
  if (restoreFocus && focusTarget && focusTarget.isConnected) focusTarget.focus();
}
