// Transient messages at the bottom-left of the page.

export function toast(text, { ms = 2400 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  el.setAttribute('role', 'status');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}
