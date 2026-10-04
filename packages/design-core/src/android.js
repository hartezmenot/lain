'use strict';

/**
 * THE ANDROID ADAPTER (D7) — XML layouts, the Activities that show them, and adb.
 *
 *   screens   each layout an Activity shows (setContentView(R.layout.x)), home = the LAUNCHER activity
 *   layers    the layout's views; a view's name is its android:id
 *   styles    attributes, in place: width/height → layout_width/height (dp), opacity → alpha, color → textColor,
 *             fill → background, font size → textSize (sp), padding, rotation, translation
 *   moves     a child of ConstraintLayout / RelativeLayout / FrameLayout moves by its parent-anchored margins, the
 *             anchor switching across the middle exactly as on the web; a LinearLayout child gets Reorder / Offset
 *   flows     `findViewById(R.id.x).setOnClickListener { startActivity(Intent(this, Y::class.java)) }` in the Activity,
 *             read back, and written in a marked block with the preset's res/anim enter/exit pair
 *   interact  adb (`input tap/text/swipe`, `uiautomator dump`, `screencap`, `dumpsys activity`, `logcat`) — the
 *             device or emulator, never this machine's desktop
 *
 * VERIFIED AGAINST FIXTURES ONLY (tests/fixtures/design/android-chat, recorded adb output). Not run on a device here.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const xml = require('./xml');
const layout = require('./layout');
const anim = require('./animations');
const { WebProject, slug } = require('./web');
const { sha1 } = require('./text');

const ABSOLUTE_PARENTS = /(^|\.)(ConstraintLayout|RelativeLayout|FrameLayout|CoordinatorLayout)$/;
const A = 'android:';
const dp = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? `${Math.round(n)}dp` : String(v); };
const sp = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? `${Math.round(n)}sp` : String(v); };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const idName = (v) => (v ? String(v).replace(/^@\+?id\//, '') : null);

/** CSS-ish prop → [attribute, value converter]. */
const ATTR = {
  width: [`${A}layout_width`, dp], height: [`${A}layout_height`, dp], opacity: [`${A}alpha`, (v) => String(v)],
  color: [`${A}textColor`, (v) => String(v)], 'background-color': [`${A}background`, (v) => String(v)], 'font-size': [`${A}textSize`, sp],
  padding: [`${A}padding`, dp], rotate: [`${A}rotation`, (v) => String(num(v))],
};

/** Anim resources per preset (enter, exit), as real XML. */
const ANIM_XML = {
  'slide-left': ['<translate android:fromXDelta="100%p" android:toXDelta="0" />', '<translate android:fromXDelta="0" android:toXDelta="-30%p" />'],
  'slide-right': ['<translate android:fromXDelta="-100%p" android:toXDelta="0" />', '<translate android:fromXDelta="0" android:toXDelta="30%p" />'],
  'slide-up': ['<translate android:fromYDelta="100%p" android:toYDelta="0" />', '<alpha android:fromAlpha="1" android:toAlpha="0.85" />'],
  fade: ['<alpha android:fromAlpha="0" android:toAlpha="1" />', '<alpha android:fromAlpha="1" android:toAlpha="0" />'],
  scale: ['<scale android:fromXScale="0.92" android:toXScale="1" android:fromYScale="0.92" android:toYScale="1" android:pivotX="50%" android:pivotY="50%" /><alpha android:fromAlpha="0" android:toAlpha="1" />', '<alpha android:fromAlpha="1" android:toAlpha="0" />'],
  'expand-from-element': ['<scale android:fromXScale="0.2" android:toXScale="1" android:fromYScale="0.2" android:toYScale="1" android:pivotX="85%" android:pivotY="5%" /><alpha android:fromAlpha="0" android:toAlpha="1" />', '<alpha android:fromAlpha="1" android:toAlpha="0.6" />'],
};
const EASE = { 'ease-in': '@android:anim/accelerate_interpolator', 'ease-out': '@android:anim/decelerate_interpolator', 'ease-in-out': '@android:anim/accelerate_decelerate_interpolator', linear: '@android:anim/linear_interpolator', ease: '@android:anim/accelerate_decelerate_interpolator' };
function animXml(inner, duration, easing) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- written by LAIN Design -->\n<set xmlns:android="http://schemas.android.com/apk/res/android"\n    android:duration="${Math.max(0, Math.round(duration || 300))}"\n    android:interpolator="${EASE[easing] || EASE['ease-out']}">\n    ${inner}\n</set>\n`;
}

class AndroidProject extends WebProject {
  constructor(root, opts = {}) {
    super(root, opts);
    this.kind = 'android';
    this.module = AndroidProject.moduleOf(this.root) || 'app';
    this.resDir = `${this.module}/src/main/res`;
  }

  static moduleOf(root) {
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory() && fs.existsSync(path.join(root, d.name, 'src', 'main', 'AndroidManifest.xml'))) return d.name;
      }
    } catch { /* none */ }
    return null;
  }
  static detect(root) {
    const gradle = ['settings.gradle', 'settings.gradle.kts'].some((f) => fs.existsSync(path.join(root, f)));
    return gradle && AndroidProject.moduleOf(root) ? 0.95 : 0;
  }
  detect() { return AndroidProject.detect(this.root); }

  _parse(entry, ext) {
    if (ext === '.xml') { entry.tree = xml.parse(entry.src, entry.rel); for (const el of entry.tree.all) el.attrs.id = idName(el.attrs[`${A}id`]); }
  }
  _parseText(text, rel) { const t = xml.parse(text, rel); for (const el of t.all) el.attrs.id = idName(el.attrs[`${A}id`]); return t; }

  // ---- reading -------------------------------------------------------------------------------------------------
  sources() { return this.files((rel) => rel.startsWith(`${this.module}/src/main/`) && /\.(kt|java)$/.test(rel), 12); }
  layouts() { return this.files((rel) => rel.startsWith(`${this.resDir}/layout`) && rel.endsWith('.xml'), 6); }
  manifest() { try { return fs.readFileSync(path.join(this.root, this.module, 'src', 'main', 'AndroidManifest.xml'), 'utf8'); } catch { return ''; } }
  packageName() {
    const m = /\bpackage="([\w.]+)"/.exec(this.manifest()) || /namespace\s*=\s*"([\w.]+)"/.exec((() => { try { return fs.readFileSync(path.join(this.root, this.module, 'build.gradle.kts'), 'utf8'); } catch { try { return fs.readFileSync(path.join(this.root, this.module, 'build.gradle'), 'utf8'); } catch { return ''; } } })());
    return m ? m[1] : null;
  }
  launcher() {
    const mf = this.manifest();
    const re = /<activity\b[^>]*android:name="([^"]+)"[^>]*>([\s\S]*?)<\/activity>/g; let m;
    while ((m = re.exec(mf))) if (/android\.intent\.category\.LAUNCHER/.test(m[2])) return m[1].replace(/^.*\./, '');
    return null;
  }
  /** Activity class → { file, layout } from setContentView(R.layout.x). */
  activities() {
    const out = [];
    for (const rel of this.sources()) {
      const src = fs.readFileSync(path.join(this.root, rel), 'utf8');
      const cls = /class\s+(\w+)\s*[:(]/.exec(src);
      const lay = /setContentView\(\s*R\.layout\.(\w+)\s*\)/.exec(src);
      if (cls && lay) out.push({ cls: cls[1], file: rel, layout: `${this.resDir}/layout/${lay[1]}.xml` });
    }
    return out;
  }
  scanScreens() {
    const launcher = this.launcher();
    const acts = this.activities();
    const screens = acts.filter((a) => fs.existsSync(path.join(this.root, a.layout))).map((a) => ({
      id: a.layout, name: a.cls.replace(/Activity$/, '') || a.cls, file: a.layout, route: a.cls, activity: a.cls, source: a.file, home: a.cls === launcher,
    }));
    if (!screens.length) return this.layouts().map((l) => ({ id: l, name: path.basename(l, '.xml'), file: l, route: null, home: false }));
    return screens.sort((a, b) => Number(b.home) - Number(a.home));
  }
  scanElements(screen) {
    const e = this.read(screen);
    return e.tree.all.map((el) => ({ id: el.id, tag: el.tag.replace(/^.*\./, ''), name: el.attrs.id || el.tag.replace(/^.*\./, ''), classes: [], text: el.attrs[`${A}text`] || '', attrs: { id: el.attrs.id, src: el.attrs[`${A}src`] || null, href: null }, parent: el.parent, children: el.children, file: screen, line: el.line, col: el.col }));
  }
  locate(id) {
    for (const rel of this.layouts()) { const entry = this.read(rel); const el = entry.tree.byId.get(id); if (el) return { screen: rel, el, entry }; }
    return null;
  }
  sheetsFor() { return []; }
  classUses() { return []; }

  /** What the inspector shows: css-ish names for the attributes it edits, and every attribute as itself. */
  declaredFor(screen, el) {
    const out = {};
    for (const [prop, [attr]] of Object.entries(ATTR)) if (el.attrs[attr] != null) out[prop] = { where: 'attr', value: el.attrs[attr], attr };
    const parent = el.parent ? this.read(screen).tree.byId.get(el.parent) : null;
    if (parent && ABSOLUTE_PARENTS.test(parent.tag)) {
      out.position = { where: 'attr', value: 'absolute' };
      for (const side of ['left', 'right', 'top', 'bottom']) { const a = this._anchor(parent, el, side); if (a.on) out[side] = { where: 'attr', value: `${num(el.attrs[a.margin])}px`, attr: a.margin }; }
    }
    return out;
  }
  planStyle() { return { kind: 'attr' }; }

  /** Is `el` anchored to its parent's `side`, and which attributes say so? */
  _anchor(parent, el, side) {
    const S = { left: ['Start', 'Left'], right: ['End', 'Right'], top: ['Top'], bottom: ['Bottom'] }[side];
    const margin = `${A}layout_margin${S[0]}`;
    if (/ConstraintLayout$/.test(parent.tag)) {
      const key = `app:layout_constraint${S[0]}_to${S[0]}Of`;
      return { on: el.attrs[key] === 'parent', attrs: { [key]: 'parent' }, margin };
    }
    if (/RelativeLayout$/.test(parent.tag)) {
      const key = `${A}layout_alignParent${S[0]}`;
      return { on: el.attrs[key] === 'true', attrs: { [key]: 'true' }, margin };
    }
    // FrameLayout / CoordinatorLayout: layout_gravity; top|start is the default
    const g = String(el.attrs[`${A}layout_gravity`] || '');
    const word = { left: 'start', right: 'end', top: 'top', bottom: 'bottom' }[side];
    const on = g.split('|').includes(word) || (!g && (side === 'left' || side === 'top'));
    return { on, gravity: word, margin };
  }

  // ---- writing -------------------------------------------------------------------------------------------------
  _setAttr(src, el, name, value) {
    if (name === 'id') return xml.setAttr(src, el, `${A}id`, value == null ? null : `@+id/${value}`);
    if (name === 'src') return xml.setAttr(src, el, `${A}src`, value);
    return xml.setAttr(src, el, name, value);
  }

  /** Attribute edits for css-ish props (position props become anchors + margins). */
  _styleEdits(screen, el, props, scope, perFile) {
    const page = this.read(screen);
    const parent = el.parent ? page.tree.byId.get(el.parent) : null;
    const set = {};
    const targets = [];
    for (const [p, v] of Object.entries(props)) {
      if (['left', 'right', 'top', 'bottom'].includes(p)) {
        if (!parent || !ABSOLUTE_PARENTS.test(parent.tag)) return { needs: null, why: `${el.attrs.id || el.tag} is laid out by its ${parent ? parent.tag.replace(/^.*\./, '') : 'parent'}; it has no position of its own` };
        const a = this._anchor(parent, el, p);
        if (v == null) { if (a.attrs) for (const k of Object.keys(a.attrs)) set[k] = null; set[a.margin] = null; } else { if (a.attrs) Object.assign(set, a.attrs); set[a.margin] = dp(v); }
        if (a.gravity) {
          const g = new Set(String(el.attrs[`${A}layout_gravity`] || 'top|start').split('|').filter(Boolean));
          if (v == null) g.delete(a.gravity); else { g.add(a.gravity); const opp = { start: 'end', end: 'start', top: 'bottom', bottom: 'top' }[a.gravity]; g.delete(opp); }
          set[`${A}layout_gravity`] = [...g].join('|');
        }
        continue;
      }
      if (p === 'position') continue;
      if (p === 'translate') { const [x, y = '0'] = String(v || '0 0').split(/\s+/); set[`${A}translationX`] = dp(x); set[`${A}translationY`] = dp(y); continue; }
      if (p === 'border-radius' || p === 'animation') return { why: `${p} on Android is a shape drawable or code, not a view attribute — ask the Agent for it` };
      const m = ATTR[p];
      if (!m) return { why: `"${p}" has no Android view attribute here` };
      set[m[0]] = v == null ? null : m[1](v);
    }
    // ONE SPLICE PER ATTRIBUTE; new ones are appended in order after the last existing attribute.
    const edits = []; let appended = '';
    const names = Object.keys(el.attrLoc); const last = names.length ? el.attrLoc[names[names.length - 1]] : null;
    for (const [k, v] of Object.entries(set)) {
      if (el.attrLoc[k] || v == null) { const e = xml.setAttr(page.src, el, k, v); if (e) edits.push(e); } else {
        const e = xml.setAttr(page.src, el, k, v); appended += e.text;
      }
      targets.push(k.replace(/^(android|app):/, ''));
    }
    if (appended) edits.push({ start: last ? last.end : el.nameEnd, end: last ? last.end : el.nameEnd, text: appended });
    if (!perFile.has(screen)) perFile.set(screen, []);
    perFile.get(screen).push(...edits);
    return { targets: [`attributes ${targets.join(', ')} in ${screen}`] };
  }

  _op_setStyle(op) {
    const { screen, el } = this._at(op);
    const perFile = new Map();
    const r = this._styleEdits(screen, el, op.props || {}, null, perFile);
    if (r.why) return { ok: false, why: r.why };
    return this._result(op, perFile, { summary: `${el.attrs.id || el.tag}: ${Object.entries(op.props || {}).map(([p, v]) => (v == null ? `-${p}` : `${p} ${v}`)).join(', ')} → ${r.targets.join(', ')}`, target: r.targets, follow: { rel: screen, offset: el.start, id: el.id } });
  }
  _op_move(op) {
    const { screen, el } = this._at(op);
    if (!op.layout) return { ok: false, why: 'a move needs the view\'s measured layout (design_inspect, or a uiautomator dump)' };
    const declared = Object.fromEntries(Object.entries(this.declaredFor(screen, el)).map(([k, v]) => [k, v.value]));
    const lay = { ...op.layout, position: declared.position === 'absolute' ? 'absolute' : (op.layout.position || 'static') };
    const d = layout.drag(lay, declared, { dx: op.dx || 0, dy: op.dy || 0, drop: op.drop || null });
    if (d.kind === 'absolute') return this._op_setStyle({ op: 'move', node: op.node, props: d.props });
    if (!op.choice) return { ok: false, needs: { choice: { choices: d.choices.map((c) => ({ id: c.id, label: c.label, index: c.index, props: c.props })).filter((c) => c.id !== 'absolute'), default: d.default, flexChild: true } } };
    const c = d.choices.find((x) => x.id === op.choice);
    if (!c || c.id === 'absolute') return { ok: false, why: `"${op.choice}" is not offered here` };
    if (c.id === 'reorder') return this._op_reorder({ op: 'reorder', node: op.node, index: c.index });
    return this._op_setStyle({ op: 'move', node: op.node, props: c.props });
  }
  _op_resize(op) {
    const { el } = this._at(op);
    if (!op.layout) return { ok: false, why: 'a resize needs the view\'s measured layout' };
    return this._op_setStyle({ op: 'resize', node: op.node, props: { width: `${Math.max(1, Math.round(op.layout.rect.w + (op.dw || 0)))}`, height: `${Math.max(1, Math.round(op.layout.rect.h + (op.dh || 0)))}` }, el });
  }

  /** android:text — a literal in place, or the @string resource it names in res/values/strings.xml. */
  _op_setText(op) {
    const { screen, el, entry } = this._at(op);
    const cur = el.attrs[`${A}text`];
    const text = String(op.text == null ? '' : op.text);
    const m = /^@string\/(\w+)$/.exec(cur || '');
    if (m) {
      const rel = `${this.resDir}/values/strings.xml`;
      const s = this.read(rel);
      const node = s.tree.all.find((x) => x.tag === 'string' && x.attrs.name === m[1]);
      if (!node || !node.endTag) return { ok: false, why: `no string "${m[1]}" in ${rel}` };
      const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, "\\'");
      return this._result(op, new Map([[rel, [{ start: node.startTag.end, end: node.endTag.start, text: esc }]]]), { summary: `${el.attrs.id || el.tag}: text "${text}" (@string/${m[1]})`, target: [rel], follow: { rel: screen, offset: el.start, id: el.id } });
    }
    return this._result(op, new Map([[screen, [xml.setAttr(entry.src, el, `${A}text`, text)]]]), { summary: `${el.attrs.id || el.tag}: text "${text}"`, target: [screen], follow: { rel: screen, offset: el.start } });
  }

  _assetDir() { return `${this.resDir}/drawable`; }
  _asset(screen, source, perFile) {
    const ext = path.extname(source).toLowerCase();
    if (!['.png', '.webp', '.jpg', '.jpeg', '.gif'].includes(ext)) throw new Error(ext === '.svg' ? 'Android draws SVG as a vector drawable — convert it (Android Studio › New › Vector Asset), then add the .xml' : `${ext} is not an Android drawable (png, webp, jpg, gif)`);
    const bytes = this.readBinary(path.resolve(source));
    const base = slug(path.basename(source, ext)).replace(/-/g, '_').replace(/^(\d)/, 'img_$1');
    let name = base; let n = 1;
    const exists = (nm) => { try { return fs.readdirSync(path.join(this.root, this._assetDir())).some((f) => path.basename(f, path.extname(f)) === nm); } catch { return false; } };
    while (exists(name) && !fs.existsSync(path.join(this.root, this._assetDir(), `${name}${ext}`))) name = `${base}_${++n}`;
    const rel = `${this._assetDir()}/${name}${ext}`;
    perFile.binary = perFile.binary || [];
    if (!fs.existsSync(path.join(this.root, rel))) perFile.binary.push({ rel, bytes });
    return `@drawable/${name}`;
  }
  _markup(kind, { elId, src, label, alt }) {
    const t = String(label || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const common = `android:id="@+id/${elId.replace(/-/g, '_')}" android:layout_width="wrap_content" android:layout_height="wrap_content"`;
    if (kind === 'image') return `<ImageView ${common} android:contentDescription="${String(alt || '').replace(/"/g, '&quot;')}" android:src="${src}" />`;
    if (kind === 'button') return `<Button ${common}${src ? ` android:drawableStart="${src}"` : ''} android:text="${t}" />`;
    if (kind === 'text') return `<TextView ${common} android:text="${t}" />`;
    return `<LinearLayout ${common} android:orientation="vertical" />`;
  }
  _op_insert(op) {
    const r = super._op_insert(op);
    if (!r.ok) return r;
    // Android ids are snake_case: the markup wrote the slug that way; find the new view by it.
    r.elementId = String(r.elementId || '').replace(/-/g, '_');
    const f = r.files.find((x) => x.rel === this.locate(op.parent).screen);
    const made = f ? this._parseText(f.after, f.rel).all.find((x) => x.attrs.id === r.elementId) : null;
    r.followId = made ? made.id : null;
    return r;
  }
  _op_setAsset(op) {
    const { screen, el, entry } = this._at(op);
    const perFile = new Map();
    const ref = this._asset(screen, op.asset, perFile);
    const attr = /Image(View|Button)$/.test(el.tag) ? `${A}src` : `${A}drawableStart`;
    perFile.set(screen, [xml.setAttr(entry.src, el, attr, ref)]);
    const res = this._result(op, perFile, { summary: `${el.attrs.id || el.tag}: ${attr.slice(A.length)} → ${ref}`, target: [screen], follow: { rel: screen, offset: el.start } });
    res.binary = perFile.binary || [];
    return res;
  }
  _op_setAnimation() { return { ok: false, why: 'a view animation on Android is code (ViewPropertyAnimator or a MotionLayout scene) — ask the Agent for it; screen transitions are set on the wire' }; }

  // ---- flows ---------------------------------------------------------------------------------------------------
  scanFlows() {
    const screens = this.scanScreens();
    const byAct = new Map(screens.map((s) => [s.activity, s]));
    const wires = [];
    for (const s of screens) {
      if (!s.source) continue;
      const src = fs.readFileSync(path.join(this.root, s.source), 'utf8');
      const marks = []; const mre = /^[ \t]*\/\/ lain:wire (\{.*\})[ \t]*\r?\n[\s\S]*?^[ \t]*\/\/ \/lain:wire ([\w-]+)[ \t]*$/gm; let m;
      while ((m = mre.exec(src))) { try { const meta = JSON.parse(m[1]); if (meta.id === m[2]) marks.push({ meta, start: m.index, end: m.index + m[0].length }); } catch { /* not ours */ } }
      const tree = this.read(s.file).tree;
      const nodeOf = (name) => (tree.all.find((e) => e.attrs.id === name) || {}).id || null;
      for (const mk of marks) wires.push({ id: mk.meta.id, origin: 'design', screen: s.file, source: { node: nodeOf(mk.meta.source), elementId: mk.meta.source }, trigger: mk.meta.trigger, action: mk.meta.action, target: mk.meta.target, transition: mk.meta.transition, duration: mk.meta.duration, easing: mk.meta.easing, file: s.source, line: src.slice(0, mk.start).split('\n').length });
      const blank = marks.reduce((acc, mk) => acc.slice(0, mk.start) + ' '.repeat(mk.end - mk.start) + acc.slice(mk.end), src);
      const hre = /(?:findViewById<[\w.]+>\(\s*R\.id\.(\w+)\s*\)|binding\.(\w+))\s*\.setOnClickListener\s*\{([\s\S]*?)\n\s*\}/g;
      while ((m = hre.exec(blank))) {
        const name = m[1] || m[2].replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        const t = /startActivity\(\s*Intent\(\s*this(?:@\w+)?\s*,\s*(\w+)::class\.java\s*\)\s*\)/.exec(m[3]);
        const target = t && byAct.get(t[1]);
        if (target) wires.push({ id: `kt:${s.source}:${blank.slice(0, m.index).split('\n').length}`, origin: 'code', kind: 'handler', screen: s.file, source: { node: nodeOf(name), elementId: name }, trigger: 'click', action: 'navigate', target: target.file, transition: 'none', file: s.source, line: blank.slice(0, m.index).split('\n').length });
      }
    }
    return wires;
  }

  _op_addWire(op) {
    const { screen, el, entry } = this._at(op);
    const s = this.scanScreens().find((x) => x.file === screen);
    if (!s || !s.source) return { ok: false, why: `no Activity shows ${screen} (setContentView(R.layout.…)) — wire it in code` };
    const action = op.action || 'navigate';
    if (!['navigate', 'back', 'toggleDropdown'].includes(action)) return { ok: false, why: `"${action}" is not written for Android here — navigate, back or toggleDropdown` };
    const target = op.target ? this.scanScreens().find((x) => x.file === op.target) : null;
    if (action === 'navigate' && !target) return { ok: false, why: 'navigate needs a target screen' };
    const perFile = new Map(); const add = (rel, e) => { if (!perFile.has(rel)) perFile.set(rel, []); perFile.get(rel).push(e); };
    let elId = el.attrs.id;
    if (!elId) { elId = slug(el.tag.replace(/^.*\./, '')).replace(/-/g, '_'); const taken = new Set(entry.tree.all.map((x) => x.attrs.id)); let n = 1; const b = elId; while (taken.has(elId)) elId = `${b}_${++n}`; add(screen, this._setAttr(entry.src, el, 'id', elId)); }
    const transition = anim.preset(op.transition || 'none');
    const id = `w${sha1(`${screen}:${el.id}:${Date.now()}:${Math.random()}`).slice(0, 6)}`;
    const kt = s.source; const src = fs.readFileSync(path.join(this.root, kt), 'utf8');
    const anchor = /^([ \t]*)setContentView\(\s*R\.layout\.\w+\s*\)[^\n]*\n/m.exec(src);
    if (!anchor) return { ok: false, why: `${kt} has no setContentView line to wire after` };
    const ind = anchor[1];
    const pair = ANIM_XML[transition];
    const animName = pair ? `lain_${transition.replace(/-/g, '_')}` : null;
    const go = (cls) => `startActivity(Intent(this, ${cls}::class.java))${animName ? `; overridePendingTransition(R.anim.${animName}_enter, R.anim.${animName}_exit)` : ''}`;
    let body;
    if (action === 'navigate') body = go(target.activity);
    else if (action === 'back') body = 'finish()';
    else {
      const items = (Array.isArray(op.items) && op.items.length ? op.items : [{ label: target ? target.name : 'Item', target: op.target }]).map((i) => ({ label: i.label, scr: this.scanScreens().find((x) => x.file === i.target) }));
      body = `PopupMenu(this, it).apply { ${items.map((i, k) => `menu.add(0, ${k}, ${k}, ${JSON.stringify(String(i.label))})`).join('; ')}; setOnMenuItemClickListener { item -> when (item.itemId) { ${items.map((i, k) => `${k} -> ${i.scr ? go(i.scr.activity) : 'Unit'}`).join('; ')} }; true }; show() }`;
    }
    const meta = { id, screen, source: elId, trigger: 'click', action, target: op.target || null, transition, duration: op.duration || 300, easing: op.easing || 'ease-out' };
    const block = `\n${ind}// lain:wire ${JSON.stringify(meta)}\n${ind}findViewById<View>(R.id.${elId}).setOnClickListener { ${body} }\n${ind}// /lain:wire ${id}\n`;
    const at = anchor.index + anchor[0].length;
    const edits = [{ start: at, end: at, text: block }];
    // IMPORTS the block needs, after the last import.
    const need = ['android.view.View', ...(action === 'navigate' || action === 'toggleDropdown' ? ['android.content.Intent'] : []), ...(action === 'toggleDropdown' ? ['android.widget.PopupMenu'] : [])].filter((i) => !new RegExp(`^import ${i.replace(/\./g, '\\.')}$`, 'm').test(src));
    if (need.length) { const li = [...src.matchAll(/^import [^\n]+\n/gm)].pop(); const ip = li ? li.index + li[0].length : (/^package [^\n]+\n/m.exec(src) || { index: 0, 0: '' }).index + ((/^package [^\n]+\n/m.exec(src) || [''])[0].length); edits.push({ start: ip, end: ip, text: need.map((i) => `import ${i}\n`).join('') }); }
    perFile.set(kt, edits);
    // THE TRANSITION'S RESOURCES (once).
    if (pair) {
      for (const [k, which] of [[0, 'enter'], [1, 'exit']]) {
        const rel = `${this.resDir}/anim/${animName}_${which}.xml`;
        if (!fs.existsSync(path.join(this.root, rel))) perFile.set(rel, [{ start: 0, end: 0, text: animXml(pair[k], op.duration, op.easing) }]);
      }
    }
    const res = this._result({ op: 'addWire' }, perFile, { summary: `wire ${elId} click → ${action}${target ? ` ${target.name}` : ''}${transition !== 'none' ? ` (${transition})` : ''}`, target: [kt], follow: { rel: screen, offset: el.start, id: el.id } });
    res.wireId = id;
    return res;
  }
  _op_removeWire(op) {
    for (const s of this.scanScreens()) {
      if (!s.source) continue;
      const src = fs.readFileSync(path.join(this.root, s.source), 'utf8');
      const re = new RegExp(`\\n?[ \\t]*// lain:wire \\{[^\\n]*"id":"${op.id}"[^\\n]*\\}[ \\t]*\\r?\\n[\\s\\S]*?^[ \\t]*// /lain:wire ${op.id}[ \\t]*\\r?\\n`, 'm');
      const m = re.exec(src);
      if (m) return this._result({ op: 'removeWire' }, new Map([[s.source, [{ start: m.index, end: m.index + m[0].length, text: m[0].startsWith('\n') ? '\n' : '' }]]]), { summary: `removed wire ${op.id}`, target: [s.source] });
    }
    return { ok: false, why: `no design-made wire ${op.id}` };
  }
  _op_updateWire() { return { ok: false, why: 'remove the wire and add it again with the new settings' }; }
  wireScript() { return null; }
}

// ---- adb ---------------------------------------------------------------------------------------------------------

/**
 * THE DEVICE, OVER ADB. Every action is an `adb` command against one device or emulator (its serial when given);
 * nothing here can reach this machine's own pointer, keyboard or windows. `exec(bin, args)` is injectable for tests.
 */
class Adb {
  constructor({ adb = process.env.LAIN_ADB || 'adb', serial = null, exec = null } = {}) {
    this.bin = adb; this.serial = serial;
    this.exec = exec || ((bin, args, opts) => execFileSync(bin, args, { timeout: 20000, maxBuffer: 32 * 1024 * 1024, ...opts }));
  }
  run(args, { binary = false } = {}) {
    const out = this.exec(this.bin, [...(this.serial ? ['-s', this.serial] : []), ...args], binary ? {} : { encoding: 'utf8' });
    return binary ? Buffer.from(out) : String(out);
  }
  density() { const m = /(\d+)/.exec(this.run(['shell', 'wm', 'density'])); return m ? Number(m[1]) / 160 : 1; }
  dump() { return this.run(['exec-out', 'uiautomator', 'dump', '/dev/tty']).replace(/UI hierchary dumped to:.*$/m, ''); }
  activity() { const m = /mResumedActivity:.*?\s([\w.]+\/[\w.$]+)/.exec(this.run(['shell', 'dumpsys', 'activity', 'activities'])); return m ? m[1] : null; }
  errors() { return this.run(['logcat', '-d', '-t', '200', '*:E']).split(/\r?\n/).filter((l) => /\bE\b|FATAL|Exception/.test(l)).slice(-10); }
  clearLog() { try { this.run(['logcat', '-c']); } catch { /* best effort */ } }
  tap(x, y) { return this.run(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]); }
  swipe(x0, y0, x1, y1, ms = 250) { return this.run(['shell', 'input', 'swipe', ...[x0, y0, x1, y1].map((v) => String(Math.round(v))), String(ms)]); }
  text(s) { return this.run(['shell', 'input', 'text', String(s).replace(/ /g, '%s').replace(/([&|<>;()$`\\"'])/g, '\\$1')]); }
  key(k) { return this.run(['shell', 'input', 'keyevent', { Enter: 'KEYCODE_ENTER', Escape: 'KEYCODE_ESCAPE', Back: 'KEYCODE_BACK', Tab: 'KEYCODE_TAB' }[k] || String(k)]); }
  screencap() { return this.run(['exec-out', 'screencap', '-p'], { binary: true }); }
}

/** Bounds of every node in a uiautomator dump: [{ rid, text, desc, cls, x, y, w, h }] (px). */
function nodes(dumpXml) {
  const out = []; const re = /<node\b([^>]*?)\/?>/g; let m;
  while ((m = re.exec(dumpXml))) {
    const a = {}; m[1].replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { a[k] = v; return ''; });
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds || '');
    if (b) out.push({ rid: a['resource-id'] || '', text: a.text || '', desc: a['content-desc'] || '', cls: a.class || '', x: +b[1], y: +b[2], w: +b[3] - +b[1], h: +b[4] - +b[2] });
  }
  return out;
}

/** Steps on the device (same shape as the web's): each reports the activity, view changes, logcat errors, a screenshot. */
async function runSteps(adb, project, steps, { screenshots = 'last' } = {}) {
  const out = [];
  const pkg = project.packageName();
  const find = (t, list) => {
    if (t && typeof t === 'object' && t.x != null) return t;
    const name = typeof t === 'string' ? (project.locate(t) ? project.locate(t).el.attrs.id : t) : t && t.node ? (project.locate(t.node) || { el: { attrs: {} } }).el.attrs.id : t && t.id ? t.id : null;
    const n = name ? list.find((x) => x.rid === `${pkg}:id/${name}` || x.rid.endsWith(`:id/${name}`)) : t && t.text ? list.find((x) => x.text === t.text || x.desc === t.text) : null;
    return n ? { x: n.x + n.w / 2, y: n.y + n.h / 2 } : null;
  };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const before = nodes(adb.dump());
    const act0 = adb.activity();
    adb.clearLog();
    let res = { ok: true };
    try {
      if (s.action === 'click' || s.action === 'tap') { const p = find(s.target, before); if (!p) throw new Error(`no view ${JSON.stringify(s.target)} on the device's screen`); adb.tap(p.x, p.y); res.at = p; } else if (s.action === 'longpress') { const p = find(s.target, before); if (!p) throw new Error('no such view'); adb.swipe(p.x, p.y, p.x, p.y, s.ms || 650); } else if (s.action === 'swipe' || s.action === 'drag' || s.action === 'scroll') {
        const p = s.target ? find(s.target, before) : { x: 540, y: 1200 }; if (!p) throw new Error('no such view');
        adb.swipe(p.x, p.y, p.x + (s.dx || 0), p.y + (s.dy == null ? (s.action === 'scroll' ? -600 : 0) : s.dy));
      } else if (s.action === 'type') { if (s.target) { const p = find(s.target, before); if (p) adb.tap(p.x, p.y); } adb.text(s.text || ''); } else if (s.action === 'press') adb.key(s.key || 'Enter');
      else if (s.action === 'wait') await new Promise((r) => setTimeout(r, Math.min(10000, s.ms || 500)));
      else throw new Error(`unknown action "${s.action}"`);
    } catch (e) { res = { ok: false, why: e.message }; }
    if (s.action !== 'wait') await new Promise((r) => setTimeout(r, s.settleMs || 600));
    const after = nodes(adb.dump());
    const act1 = adb.activity();
    const key = (n) => `${n.rid}|${n.text}|${n.x},${n.y},${n.w},${n.h}`;
    const a = new Set(before.map(key)); const b = new Set(after.map(key));
    const step = { step: i + 1, action: s.action, target: s.target || null, ...res, url: act1, navigated: act1 !== act0, changes: { added: [...b].filter((k) => !a.has(k)).length, removed: [...a].filter((k) => !b.has(k)).length, attributes: 0 }, errors: adb.errors() };
    if (screenshots === 'each' || (screenshots === 'last' && i === steps.length - 1)) { try { step.screenshot = adb.screencap(); } catch { /* none */ } }
    out.push(step);
    if (!res.ok) break;
  }
  return out;
}

/**
 * A VIEW'S LAYOUT FROM THE DEVICE (dp): its bounds in a uiautomator dump, its parent's as the containing box, and
 * whether its parent positions it (Constraint/Relative/Frame) — what a move needs.
 */
function measure(adb, project, at) {
  const name = at.el.attrs.id;
  if (!name) throw new Error('the view has no android:id to find it on the device by');
  const list = nodes(adb.dump());
  const d = adb.density();
  const me = list.find((x) => x.rid.endsWith(`:id/${name}`));
  if (!me) throw new Error(`@id/${name} is not on the device's screen — open ${at.screen} there`);
  const inside = (o, i) => o !== i && o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
  const par = list.filter((x) => inside(x, me)).sort((a, b) => a.w * a.h - b.w * b.h)[0] || { x: 0, y: 0, w: me.w, h: me.h };
  const px = (n) => ({ x: n.x / d, y: n.y / d, w: n.w / d, h: n.h / d });
  const parentEl = at.el.parent ? at.entry.tree.byId.get(at.el.parent) : null;
  const sibs = parentEl ? parentEl.children.map((cid) => at.entry.tree.byId.get(cid)).map((c) => ({ c, n: c.attrs.id ? list.find((x) => x.rid.endsWith(`:id/${c.attrs.id}`)) : null })).filter((x) => x.n).map((x) => ({ id: x.c.id, rect: px(x.n) })) : [];
  const vertical = parentEl && /LinearLayout$/.test(parentEl.tag) ? parentEl.attrs[`${A}orientation`] !== 'horizontal' : true;
  return {
    id: at.el.id, rect: px(me), containing: px(par), position: parentEl && ABSOLUTE_PARENTS.test(parentEl.tag) ? 'absolute' : 'static',
    parentDisplay: parentEl && /LinearLayout$/.test(parentEl.tag) ? 'flex' : 'block', flexDirection: vertical ? 'column' : 'row', siblings: sibs, margin: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

/** No live preview: the canvas shows the device's own screenshots when a device is attached. */
async function startPreview() {
  return { url: null, why: 'Android screens are previewed from the device or emulator (adb screencap); Design shows the layouts and edits them in place', reload() { return 0; }, close() { return Promise.resolve(); } };
}

module.exports = { AndroidProject, Adb, nodes, runSteps, measure, startPreview, ANIM_XML, animXml };
