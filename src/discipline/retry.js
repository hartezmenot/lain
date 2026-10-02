'use strict';

/**
 * NO BLIND RETRIES (Execution Discipline §46). The same command, failing, with nothing changed since, is the same
 * observation again — it costs a run and teaches nothing. Before it runs a second time LAIN returns the evidence it
 * already has, and names the ways forward: change an input, observe something different, or — for a failure
 * classified TRANSIENT — retry, which is allowed a bounded number of times.
 *
 * "Nothing changed" is measured, not guessed: the task's mutation generation is the same as when it failed.
 */

const TRANSIENT_RETRIES = 2;

/**
 * @returns {null|string} a contextual refusal, or null when the command may run
 */
function check(life, name, input) {
  const d = life && life.discipline;
  if (!d || !/^run_/.test(String(name))) return null;
  const command = String((input && input.command) || name);
  const c = d.checks.byKey.has(`cmd:${require('./checks').keyOf(command)}`) ? d.checks.get(d.checks.byKey.get(`cmd:${require('./checks').keyOf(command)}`)) : null;
  if (!c || !c.latest || c.latest.state !== 'FAIL') return null;
  const gen = life.mutationSeq || 0;
  if (c.latest.gen !== gen) return null;                         // something changed since: a new observation
  const cls = c.latest.classification || 'UNKNOWN';
  // A DELIBERATE RETRY: the model names what is different (a flaky check, an external condition that changed, a
  // service it just started). Recorded on the check, so the report shows why it ran twice.
  const reason = String((input && (input.retry_reason || input.reason)) || '').trim();
  if (reason.length >= 8) { c.retryReason = reason.slice(0, 200); return null; }
  if (cls === 'TRANSIENT') {
    const tries = c.history.filter((h) => h.gen === gen && h.state === 'FAIL').length;
    if (tries <= TRANSIENT_RETRIES) return null;
  }
  return `NOT RE-RUN: ${c.id} \`${c.command}\` already failed at this exact state (${cls}${c.latest.exitCode != null ? `, exit ${c.latest.exitCode}` : ''}) and nothing has changed since. `
    + 'Running it again would observe the same thing. Use the failure you already have, change a relevant input (code, arguments, environment), or observe something different. '
    + 'If something outside the code has changed (a flaky check, a service you started, the environment), call it again with `retry_reason` saying what.'
    + (cls === 'TRANSIENT' ? ` (Transient failures may be retried ${TRANSIENT_RETRIES} times; that budget is spent.)` : '');
}

module.exports = { check, TRANSIENT_RETRIES };
