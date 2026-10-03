'use strict';

/** REGION HEIGHTS — how the terminal's rows are divided, and in what order they are given up when there are not enough of them. */

/** Region heights. The header's rule goes before anything else; the INPUT is never sacrificed, and the conversation keeps at least one row so the layout… */
function regions(screen) {
  const rows = screen.rows;
  const panel = panelRows(screen, rows);
  // ONE ROW OF METADATA plus the rule under it.
  let headerRows = rows < 14 ? 1 : 2;
  // THE INPUT IS EXACTLY THE ROWS ITS TEXT OCCUPIES
  const bufferLines = Math.max(1, screen._wrapped().length);
  const roomForInput = Math.max(1, Math.floor((rows - 8) / 3));
  // A TWO-ROW FLOOR, SO THE COMPOSER IS NOT A STRIP
  const MIN_TEXT_ROWS = rows >= 20 ? 3 : rows >= 14 ? 2 : 1;
  const textRows = Math.max(
    Math.min(MIN_TEXT_ROWS, roomForInput),
    Math.min(bufferLines, require('./inputbox').MAX_INPUT_ROWS, roomForInput),
  );
  // THE EXIT HINT EARNS A ROW, AND ONLY WHILE IT IS ARMED
  const hintRows = screen.exitHint ? 1 : 0;
  const inputRows = textRows + hintRows;
  // THE LIVE ACTIVITY ROW — ONE ROW, AT EVERY SIZE
  let statusRows = 1;
  // THE FOOTER (ui/footer.js): one row of live key hints under the composer,
  // only with room to spare and never while a panel sits in its place.
  let footerRows = !panel && rows >= 20 ? 1 : 0;
  // WHAT IS GIVEN UP FIRST, in order: the header's rule, then background, then pending, then the live row itself.
  let pendingRows = require('./pending').rows(screen.state && screen.state.llm,
    Math.max(0, rows - headerRows - inputRows - panel - statusRows - 1));
  // BACKGROUND WORK sits beside it, for the same reason and on the same terms: it costs nothing when nothing is running, and it is given up before the…
  let jobRows = require('./jobsview').rows(screen.state && screen.state.llm,
    Math.max(0, rows - headerRows - inputRows - panel - statusRows - pendingRows - 1));
  // THE TRANSIENT ACTIVITY BOX — zero rows unless a turn is working on something
  // worth a line; given up before anything else. See ui/activitybox.js.
  let activityRows = require('./activitybox').rows(screen.state && screen.state.llm,
    Math.max(0, rows - headerRows - inputRows - panel - statusRows - pendingRows - jobRows - 4), Date.now(), {
      // THE DIFF IS PRIMARY while it arrives in the feed, or while one is expanded.
      minimal: Boolean(screen.openDiff) || require('./turnsections').arriving((screen.state && screen.state.liveActions) || []),
    });
  const left = () => rows - headerRows - inputRows - panel - footerRows - statusRows - pendingRows - jobRows - activityRows;
  while (footerRows > 0 && left() < 4) footerRows = 0;   // given up first
  if (left() < 1) headerRows = 1;
  while (activityRows > 0 && left() < 1) activityRows = 0;
  // GIVEN UP FIRST. A steer you have typed and not yet sent is more urgent than
  // a status you can get from `/bg`, so this yields before pending does.
  while (jobRows > 0 && left() < 1) jobRows -= 1;
  while (pendingRows > 0 && left() < 1) pendingRows -= 1;
  while (statusRows > 0 && left() < 1) statusRows -= 1;
  const workspace = Math.max(1, left());
  return {
    headerRows, workspace, statusRows, inputRows, textRows, hintRows, panelRows: panel, footerRows, pendingRows, jobRows, activityRows,
    // KEPT AS A NAME, not as a second layout.
    compactHeader: headerRows <= 1,
    framed: false,
  };
}

function panelRows(screen, rows) {
  if (!screen.panel || !screen.panel.visible) return 0;
  // A completion palette is a HINT beside the input, not a screen.
  const n = screen.panel.items.length;
  // COMMAND OUTPUT TAKES WHAT IT NEEDS AND NO MORE.
  const isOutput = screen.panel.kind === require('./panel').KIND.OUTPUT;
  // COMMAND OUTPUT MAY TAKE MORE THAN A PICKER
  const CHROME = 4;
  const wanted = screen.panel.isCompletion || screen.panel.mode === 'compact'
    ? Math.min(12, Math.max(5, n + CHROME))
    : isOutput
      ? Math.min(Math.max(18, Math.floor(rows * 0.6)), Math.max(5, n + CHROME))
      : Math.min(18, Math.max(6, Math.floor(rows * 0.5)));
  // Never let the panel starve the workspace and input entirely.
  return Math.min(wanted, Math.max(0, rows - 6));
}

module.exports = { regions, panelRows };
