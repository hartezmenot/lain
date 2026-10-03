'use strict';

/** `/skill` · `/hooks` · `/mcp servers|trust` — the capability surface from the CLI (Phase CAP). */

function register({ define, C }) {
  define('/skill', {
    surface: true,
    args: '[list | <name> [request]]',
    desc: 'Skills: list them, or run one now (/<skill-name> works too)',
    async run(app, { args, rest }) {
      const w = (s) => app.render.write(s);
      const first = String(args[0] || 'list').toLowerCase();
      if (first === 'list') {
        const r = require('./skills').rows(app);
        if (!r.skills.length) { w(C.dim(`  No skills installed. Put one in ${r.roots.user}\\<name>\\SKILL.md or <project>\\.lain\\skills\\<name>\\SKILL.md.\n`)); return; }
        w('\n' + C.bold('Skills') + C.dim(`  · ${r.promptTokens} tokens per request for the list`) + '\n');
        for (const k of r.skills) {
          const flags = [k.scope, k.plugin ? `plugin ${k.plugin}` : '', k.manualOnly ? 'manual only' : '', k.context === 'scout' ? 'scout' : ''].filter(Boolean).join(' · ');
          w(`  ${k.name.padEnd(24)} ${C.dim(flags)}\n    ${k.description.slice(0, 110)}\n`);
        }
        for (const s of r.shadowed) w(C.dim(`  (${s.name} in ${s.scope} is shadowed by the ${s.by} skill of the same name)\n`));
        for (const s of r.invalid) w(C.yellow(`  ! ${s.path}: ${s.why}\n`));
        return;
      }
      const request = rest.slice(args[0].length).trim();
      const x = require('./skills').expand(app, args[0], request);
      if (!x.ok) { w(C.yellow(`  ${x.why}\n`)); return; }
      const text = x.scout ? `${x.text}\n\nThis skill runs as a scout: call use_skill {"name":"${x.skill.name}","request":${JSON.stringify(request)}} and report its result.` : x.text;
      return app.handle(text, { asText: true, background: true, from: 'skill' });
    },
  });

  define('/hooks', {
    surface: true,
    args: '[consent | revoke]',
    desc: 'Your hooks: what runs at which point, and consent for this project\'s hooks file',
    run(app, { args }) {
      const w = (s) => app.render.write(s);
      const hooks = require('./userhooks');
      const sub = String(args[0] || '').toLowerCase();
      if (sub === 'consent' || sub === 'revoke') {
        const root = hooks.rows(app).project.root;
        const r = hooks.consent(app, root, { revoke: sub === 'revoke' });
        w(r.ok ? `  ${sub === 'consent' ? C.green('✓ This project\'s hooks will run') : C.green('✓ This project\'s hooks will not run')}${C.dim(' — recorded in your settings, not in the repository')}\n` : C.yellow(`  ${r.why}\n`));
        return;
      }
      const r = hooks.rows(app);
      w('\n' + C.bold('Hooks') + C.dim(`  · events: ${r.events.join(', ')}`) + '\n');
      w(C.dim(`  user     ${r.user.file} (${r.user.count})\n`));
      if (r.project.present) w(C.dim(`  project  ${r.project.file} (${r.project.count}) — `) + (r.project.consented ? C.green('consented') : r.project.changed ? C.yellow('CHANGED since you consented — /hooks consent to run it again') : C.yellow('not consented — /hooks consent to run it')) + '\n');
      if (!r.hooks.length) w(C.dim('  nothing runs.\n'));
      for (const h of r.hooks) w(`  ${h.event.padEnd(18)} ${h.match ? C.dim(`[${h.match}] `) : ''}${h.command.slice(0, 80)} ${C.dim(`(${h.source}, ${h.timeout}s)`)}\n`);
      for (const p of r.problems) w(C.yellow(`  ! ${p}\n`));
      w(C.dim('  Hooks run outside the model\'s context and can deny or ask — never allow past a LAIN refusal.\n'));
    },
  });
}

/** `/mcp servers` and `/mcp trust <id> <level>` (wired from the /mcp command). */
function mcp(app, args, { C }) {
  const w = (s) => app.render.write(s);
  const reg = require('./mcpreg');
  if (String(args[0]).toLowerCase() === 'trust') {
    const [, id, level] = args;
    if (!id || !level) { w(C.dim(`  usage: /mcp trust <server-id> ${reg.TRUST.join('|')}\n`)); return; }
    const r = reg.setTrust(app, id, level);
    w(r.ok ? `  ${C.green('✓')} ${id} is ${r.trust}\n` : C.yellow(`  ${r.why}\n`));
    return;
  }
  const rows = reg.rows(app);
  if (!rows.length) { w(C.dim('  No MCP servers. Add one in Settings › MCP.\n')); return; }
  w('\n' + C.bold('MCP servers') + '\n');
  for (const r of rows) {
    const st = r.health.state === 'READY' ? C.green(r.health.state) : r.health.state === 'UNAVAILABLE' ? C.red(r.health.state) : C.dim(r.health.state);
    w(`  ${r.id.padEnd(20)} ${st}  ${r.trust.padEnd(9)} ${String(r.tools).padStart(3)} tools  ${r.schemas}${r.impact.perRequestTokens ? C.dim(` · ${r.impact.perRequestTokens} tokens/request`) : ''}${r.health.why ? C.dim(`  — ${r.health.why}`) : ''}\n`);
  }
}

module.exports = { register, mcp };
