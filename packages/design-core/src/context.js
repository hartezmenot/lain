'use strict';

/**
 * THE PROMPT BAR'S CONTEXT PACK — what the person selected, stated as facts beside what they typed, sent to the Agent as
 * part of THEIR message (like an IDE selection). It names the layer, its source, its declared styles and its wires;
 * it carries no instruction, no mode and no advice.
 */

function pack(design, { prompt, node = null, screen = null, device = null } = {}) {
  const p = design.project;
  const lines = [String(prompt || '').trim()];
  const facts = [];
  const scr = screen ? p.scanScreens().find((s) => s.file === screen) : null;
  if (scr) facts.push(`Screen: ${scr.name} (${scr.file})${device ? ` on ${device.name || `${device.width}×${device.height}`}` : ''}`);
  if (node && !p.readOnly) {
    const at = p.locate(node);
    if (at) {
      const el = at.el;
      facts.push(`Selected: <${el.tag}>${el.attrs.id ? ` #${el.attrs.id}` : ''}${el.classes.length ? ` .${el.classes.join(' .')}` : ''} — ${el.file || at.screen}:${el.line}:${el.col} (design node ${el.id})`);
      const dec = Object.entries(p.declaredFor(at.screen, el)).slice(0, 14).map(([k, v]) => `${k}: ${v.value}`);
      if (dec.length) facts.push(`Its styles: ${dec.join('; ')}`);
      const wires = p.scanFlows().filter((w) => w.source.node === node);
      if (wires.length) facts.push(`Its wires: ${wires.map((w) => `${w.trigger} → ${w.action}${w.target ? ` ${w.target}` : ''}${w.transition && w.transition !== 'none' ? ` (${w.transition})` : ''} in ${w.file}:${w.line}`).join('; ')}`);
    }
  }
  if (facts.length) lines.push('', '[Design selection]', ...facts);
  return lines.join('\n');
}

module.exports = { pack };
