// Render an array of rows into a <table>, columns given as [{ key, label }].

export function table(rows, columns) {
  const t = document.createElement('table');
  const head = t.createTHead().insertRow();
  for (const c of columns) head.insertCell().textContent = c.label;
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const c of columns) tr.insertCell().textContent = r[c.key] ?? '';
  }
  return t;
}
