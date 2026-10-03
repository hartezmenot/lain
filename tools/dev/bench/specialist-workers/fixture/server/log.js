// Server logging. LOG_LEVEL = debug | info | warn | error.

const ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL = process.env.LOG_LEVEL || 'debug';

function at(level, ...args) {
  if (ORDER[level] < ORDER[LEVEL]) return;
  console.log(`[${level.toUpperCase()}]`, ...args);
}

export const log = {
  debug: (...a) => at('debug', ...a),
  info: (...a) => at('info', ...a),
  warn: (...a) => at('warn', ...a),
  error: (...a) => at('error', ...a),
};
