'use strict';

/**
 * TRANSITION AND ANIMATION PRESETS. One definition per preset; each adapter turns it into its own code:
 *   web       Web Animations keyframes for screen transitions (the wire helper plays them on leave and enter),
 *             CSS @keyframes + an `animation` declaration for an element (`setAnimation`)
 *   android   the native transition names (adapter-android.js)
 * `expand-from-element` grows the source element's rectangle into the next screen — the profile avatar opening the
 * Profile screen.
 */

const PRESETS = Object.freeze({
  'slide-left': { label: 'Slide left', leave: [{ transform: 'translateX(0)' }, { transform: 'translateX(-30%)', opacity: 0.6 }], enter: [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }] },
  'slide-right': { label: 'Slide right', leave: [{ transform: 'translateX(0)' }, { transform: 'translateX(30%)', opacity: 0.6 }], enter: [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }] },
  'slide-up': { label: 'Slide up', leave: [{ opacity: 1 }, { opacity: 0.85 }], enter: [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }] },
  fade: { label: 'Fade', leave: [{ opacity: 1 }, { opacity: 0 }], enter: [{ opacity: 0 }, { opacity: 1 }] },
  scale: { label: 'Scale', leave: [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.96)', opacity: 0 }], enter: [{ transform: 'scale(0.92)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }] },
  'expand-from-element': { label: 'Expand from element', fromElement: true, enter: [{ opacity: 0 }, { opacity: 1 }] },
  'dropdown-reveal': { label: 'Dropdown reveal', element: true, enter: [{ opacity: 0, transform: 'translateY(-6px) scale(0.98)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }] },
  none: { label: 'None' },
});

const EASINGS = Object.freeze(['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'cubic-bezier(0.2, 0, 0, 1)']);

function preset(name) { return PRESETS[name] ? name : 'none'; }

/** CSS @keyframes for an element animation: `lain-<preset>`. */
function keyframesCss(name) {
  const p = PRESETS[preset(name)];
  const frames = p.enter || [{ opacity: 0 }, { opacity: 1 }];
  const decl = (f) => Object.entries(f).map(([k, v]) => `${k}: ${v};`).join(' ');
  return `@keyframes lain-${preset(name)} { from { ${decl(frames[0])} } to { ${decl(frames[frames.length - 1])} } }`;
}

/** The `animation` value for an element. */
function animationValue(name, { duration = 300, easing = 'ease-out' } = {}) {
  return `lain-${preset(name)} ${Math.max(0, Math.round(Number(duration) || 300))}ms ${EASINGS.includes(easing) ? easing : 'ease-out'} both`;
}

/** Every preset's keyframes as one JSON object — what the web wire helper carries. */
function webTable() {
  const out = {};
  for (const [k, v] of Object.entries(PRESETS)) out[k] = { leave: v.leave || null, enter: v.enter || null, fromElement: Boolean(v.fromElement) };
  return out;
}

module.exports = { PRESETS, EASINGS, preset, keyframesCss, animationValue, webTable };
