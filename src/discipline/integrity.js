'use strict';

/** TEST INTEGRITY (Execution Discipline §29) — a change that makes a check pass by changing the CHECK. */

const TEST_FILE = /(^|\/)(tests?|spec|specs|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|Tests?\.cs$/i;
const SNAPSHOT = /\.snap$|(^|\/)__snapshots__\//i;
const FIXTURE = /(^|\/)(fixtures?|__fixtures__|testdata|test-data)\//i;

const ASSERT_RE = /\b(?:assert\w*\s*[.(]|expect\s*\(|\.should\b|t\.(?:is|ok|deepEqual|equal|true|false|throws)\s*\(|self\.assert\w+\s*\(|require\.\w+\s*\(|Assert\.\w+\s*\()/g;
const SKIP_RE = /\b(?:it|test|describe|context)\.skip\b|\bx(?:it|test|describe)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\w*\(|#\[ignore\]|\.todo\s*\(|\bpending\s*\(/g;
const XFAIL_RE = /@pytest\.mark\.xfail|\.failing\s*\(|\btest\.fails\b|expectedFailure/g;
const MOCK_RE = /\b(?:jest|vi)\.mock\s*\(|\bsinon\.(?:stub|mock|fake)\b|\bmock\.patch\b|@patch\(|monkeypatch\.setattr|\bnock\s*\(/g;
const TEST_BRANCH_RE = /process\.env\.(?:NODE_ENV\s*===?\s*['"]test['"]|JEST_WORKER_ID|VITEST)|['"]pytest['"]\s+in\s+sys\.modules|\bif\s+TESTING\b|isTestEnv\s*\(/g;
const TIMEOUT_RE = /(?:timeout\s*[:=(]\s*|setTimeout\s*\(\s*(?:[^,]+,\s*)?|this\.timeout\s*\(\s*|--timeout[= ]|\}\s*,\s*)(\d{3,7})(?=\s*[),])/gi;
// A STRICT CHECK REPLACED BY A LOOSER ONE: the stronger form disappears while the weaker appears.
const WEAKER = [
  [/\bstrictEqual\b/g, /\b(?<!strict)equal\b/g, 'strictEqual → equal'],
  [/\bdeepStrictEqual\b/g, /\bdeepEqual\b/g, 'deepStrictEqual → deepEqual'],
  [/\.toBe\(|\.toEqual\(|\.toStrictEqual\(/g, /\.toBeTruthy\(|\.toBeDefined\(|\.not\.toBeNull\(/g, 'exact match → truthy/defined'],
  [/\bassertEqual\b/g, /\bassertTrue\b/g, 'assertEqual → assertTrue'],
];

const count = (re, s) => (String(s || '').match(re) || []).length;
function maxTimeout(s) { let m = 0; for (const x of String(s || '').matchAll(TIMEOUT_RE)) m = Math.max(m, Number(x[1]) || 0); return m; }

/** What one write did to the measurement. Pure: (rel path, before text|null, after text|null) → flags. */
function analyze(rel, before, after) {
  const file = String(rel || '').replace(/\\/g, '/');
  const b = before == null ? '' : String(before);
  const a = after == null ? '' : String(after);
  const flags = [];
  const add = (kind, detail) => flags.push({ kind, file, detail });
  const isTest = TEST_FILE.test(file);
  if (SNAPSHOT.test(file) && before != null) add('SNAPSHOT_UPDATED', 'a stored snapshot was rewritten');
  else if (FIXTURE.test(file) && before != null) add('FIXTURE_CHANGED', 'a test fixture changed');
  if (isTest && before != null) {
    const ab = count(ASSERT_RE, b); const aa = count(ASSERT_RE, a);
    if (aa < ab) add('ASSERTION_REMOVED', `${ab - aa} assertion(s) fewer (${ab} → ${aa})`);
    for (const [strong, weak, label] of WEAKER) if (count(strong, a) < count(strong, b) && count(weak, a) > count(weak, b)) add('ASSERTION_WEAKENED', label);
    if (count(SKIP_RE, a) > count(SKIP_RE, b)) add('SKIP_ADDED', 'a test is now skipped');
    if (count(XFAIL_RE, a) > count(XFAIL_RE, b)) add('XFAIL_ADDED', 'a test is now expected to fail');
    if (count(MOCK_RE, a) > count(MOCK_RE, b)) add('MOCK_ADDED', 'a dependency is now mocked');
    const tb = maxTimeout(b); const ta = maxTimeout(a);
    if (ta >= 3 * Math.max(tb, 1) && ta - tb >= 5000) add('TIMEOUT_INFLATED', `timeout ${tb || 'default'} → ${ta}`);
  } else if (isTest && before == null) {
    if (count(SKIP_RE, a) || count(XFAIL_RE, a)) add('SKIP_ADDED', 'a new test file is skipped or expected to fail');
  }
  if (!isTest && !SNAPSHOT.test(file) && !FIXTURE.test(file) && count(TEST_BRANCH_RE, a) > count(TEST_BRANCH_RE, b)) {
    add('TEST_ONLY_BRANCH', 'production code now behaves differently under test');
  }
  return flags;
}

module.exports = { analyze, TEST_FILE, SNAPSHOT, FIXTURE };
