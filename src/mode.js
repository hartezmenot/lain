'use strict';

/** THE KINDS OF WORK — named once. (The sentence classifier that guessed them for the IDE's BOT pane went with S12: the pane's Chat | Agent toggle decides.) */


const KIND = Object.freeze({
  CHAT: 'CHAT',
  MIGRATE: 'MIGRATE',
  EXPLAIN: 'EXPLAIN',
  AUDIT: 'AUDIT',
  BUGFIX: 'BUGFIX',
  TROUBLESHOOT: 'TROUBLESHOOT',
  IMPLEMENT: 'IMPLEMENT',
  REFACTOR: 'REFACTOR',
  NEW_PROJECT: 'NEW_PROJECT',
  RESUME: 'RESUME',
});

/** Read-only modes. Nothing here should be writing to the user's files. */
const READ_ONLY = new Set([KIND.AUDIT, KIND.EXPLAIN, KIND.CHAT]);

module.exports = { KIND, READ_ONLY };
