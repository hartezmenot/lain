'use strict';

/**
 * THE BOT HANDS WORK TO THE CODING AGENT.
 *
 * In the IDE the BOT answers on its own model and cannot edit (tools/index.js
 * refuses a mutating tool on a BOT turn). When it concludes that code has to
 * change, this is how it says so: the task, written for the agent, and what it
 * already found. harnessapp/botroute.js then asks the person "Move to Agent?"
 * and, on yes, starts the Coding Agent on that task in the same session.
 *
 * It mutates nothing itself — it records an intention on the session — so it is
 * allowed on a read-only turn. Outside an IDE BOT turn it refuses and says why:
 * in Chat the path to implementation is "Continue in IDE", which carries the
 * plan and its constraints; a second, quieter path would skip them.
 */

const tools = {
  hand_to_coding_agent: {
    mutates: false,
    schema: {
      name: 'hand_to_coding_agent',
      description:
        'In the IDE only: hand implementation work to the Coding Agent (a separate model with edit, shell and test '
        + 'tools). Use it when the person asked for a change to the code — a fix, a rename, a new feature, running '
        + 'and fixing tests — and do not use it for questions you can answer yourself. Write `task` as a complete '
        + 'instruction the agent can act on without this conversation; put what you already found (files, lines, '
        + 'errors) in `context`. The person is then asked whether to move the work to the Agent; say briefly what must change.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'the instruction for the Coding Agent' },
          context: { type: 'string', description: 'relevant findings: files, symbols, error messages' },
        },
        required: ['task'],
      },
    },
    async run(input, ctx) {
      const s = ctx && ctx.app && ctx.app.session;
      if (!s || !s._botTurn) {
        return { output: 'hand_to_coding_agent is for the BOT in the IDE. In Chat, suggest "Continue in IDE" so the plan and its constraints go with the work.', isError: true };
      }
      const task = String((input && input.task) || '').trim();
      if (!task) return { output: 'hand_to_coding_agent needs a task', isError: true };
      // THE ONE TRANSFER RECORD (planhandoff.js): BOT → Agent, waiting for the person.
      require('../journey').propose(ctx.app, { text: task, task, context: String((input && input.context) || ''), origin: 'bot', via: s._agentVia ? s._agentVia.via : 'ide', reason: 'the BOT found that code must change' });
      return { output: 'Recorded. When this reply ends the person is asked "This requires code changes. Move to Agent?" and chooses. Say in one or two sentences what has to change, and stop — do not claim the Agent has started.' };
    },
  },
};

module.exports = { tools };
