// A minimal modal dialog: open(content) returns a close function.

export function open(content, { title = '' } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  if (title) {
    const h = document.createElement('h2');
    h.textContent = title;
    dlg.appendChild(h);
  }
  dlg.append(content);
  document.body.appendChild(dlg);
  dlg.showModal();
  return () => { dlg.close(); dlg.remove(); };
}
