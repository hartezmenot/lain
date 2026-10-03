'use strict';

/** A COMMAND WRITTEN FOR ONE SHELL, SENT TO ANOTHER — noticed before it runs. */

const VERBS = 'Get|Set|New|Remove|Select|Where|ForEach|Write|Test|Invoke|Start|Stop|Out|Format|Measure|Sort|Group|Import|Export|ConvertTo|ConvertFrom|Copy|Move|Rename|Add|Clear|Join|Split|Resolve|Push|Pop|Wait|Restart|Expand|Compress';
const CMDLET = new RegExp(`(?:^|[;|({]\\s*|&&\\s*)(?:${VERBS})-[A-Z][A-Za-z]+\\b`);
const PS_ENV = /\$env:[A-Za-z_]/;
const BASH_ONLY = /(?:^|;\s*|&&\s*)export\s+[A-Za-z_][A-Za-z0-9_]*=|[12]?>\s*\/dev\/null|\[\[\s|\|\s*(?:grep|sed|awk|head|tail|xargs)\b/;
const BASH_BLOCK = /\b(?:then|fi|done|esac)\b/;

/** The cmdlet or marker that decided, for the sentence on the result. */
function markerOf(re, command) { const m = re.exec(command); return m ? m[0].replace(/^[;|({&\s]+/, '').trim() : ''; }

function mismatch(shell, command) {
  const c = String(command || '');
  if (!c.trim()) return null;
  if (shell === 'bash') {
    const ps = CMDLET.test(c) || PS_ENV.test(c);
    if (ps && !BASH_ONLY.test(c) && !BASH_BLOCK.test(c)) {
      const m = markerOf(CMDLET, c) || '$env:';
      return { run: 'powershell', why: `${m} is PowerShell syntax` };
    }
    return null;
  }
  if (shell === 'powershell') {
    if (BASH_ONLY.test(c) && !CMDLET.test(c) && !PS_ENV.test(c)) return { run: 'bash', why: `${markerOf(BASH_ONLY, c)} is bash syntax` };
    return null;
  }
  return null;
}

module.exports = { mismatch };
