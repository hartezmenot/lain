'use strict';

/**
 * GITHUB IN THE WINDOW (Phase 8) — the drawing half of Core's github.js.
 *
 *   LAIN.github.pick({then})   choose a repository for this conversation: one
 *                              already cloned attaches at once; one that is not
 *                              says so and offers Clone (Coding Agent stays
 *                              disabled until it is a local working tree)
 *   Settings › GitHub          the connection (GitHub CLI's own sign-in, or a
 *                              fine-grained token kept in the Windows secret
 *                              store — never shown again, never in a prompt),
 *                              repositories, and THIS PROJECT's git state with
 *                              explicit actions
 *
 * EXPLICIT ACTIONS ONLY. Pull, branch, commit, push, pull request and issue are
 * buttons the person presses, each confirmed; nothing is pushed, merged or
 * opened because the Agent edited files. Remote files are never edited in
 * place — work happens in the local clone.
 */

const CSS = `
.gh-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
.gh-card{background:var(--surface-base);border-radius:14px;padding:20px 22px;min-width:0}
.gh-card h4{display:flex;align-items:center;gap:10px;font:600 18px/1.3 var(--sans);margin:0 0 8px}
.gh-card p{margin:0 0 12px;color:var(--text-secondary);font-size:14.5px;line-height:1.5}
.gh-card code{font:13.5px var(--mono);background:var(--surface-raised);padding:2px 7px;border-radius:6px}
.gh-acts{display:flex;flex-wrap:wrap;gap:8px}
.gh-list{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.gh-row{display:grid;grid-template-columns:minmax(0,1fr);grid-auto-flow:column;grid-auto-columns:auto;gap:14px;align-items:center;padding:12px 16px;border-radius:12px;background:var(--surface-base)}
.gh-row b{font-size:15.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.gh-row small{display:block;color:var(--text-muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gh-state{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--separator);border-radius:10px;overflow:hidden;margin:12px 0}
.gh-state > div{background:var(--surface-base);padding:10px 12px;min-width:0}
.gh-state span{display:block;color:var(--text-muted);font-size:12.5px}
.gh-state b{display:block;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gh-state b.st-up_to_date{color:var(--positive)} .gh-state b.st-behind,.gh-state b.st-diverged,.gh-state b.st-local_changes{color:var(--warning,#D8A650)} .gh-state b.st-conflict,.gh-state b.st-offline{color:var(--danger)}
.ghdlg{width:min(760px,calc(100vw - 32px))}
.ghdlg input.q{width:100%;padding:10px 14px;border-radius:10px;background:var(--surface-raised);border:1px solid var(--separator);font-size:15px;margin:6px 0 10px}
.ghdlg .gh-list{max-height:52vh;overflow:auto;margin:0}
.ghdlg .gh-row{background:var(--surface-raised)}
.ghdlg .gh-row:hover{background:var(--surface-active)}
.gh-out{margin-top:10px;font:13px/1.5 var(--mono);color:var(--text-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.gh-alist{display:flex;flex-direction:column;gap:6px;margin:4px 0 14px}
.gh-acct{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:10px 12px;border-radius:12px;background:var(--surface-raised)}
.gh-acct.on{box-shadow:inset 0 0 0 1px var(--accent-border)}
.gh-av{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:var(--surface-active) center/cover no-repeat;color:var(--text-secondary);font-weight:600;flex:none}
.gh-at{min-width:0}
.gh-at b{display:block;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gh-at small{display:block;color:var(--text-muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gh-hint{margin-top:12px!important;font-size:13.5px!important}
.ghdev{width:min(460px,calc(100vw - 32px));text-align:center}
.ghdev .gh-code{font:600 30px/1.2 var(--mono);letter-spacing:.18em;margin:14px 0 10px;padding:14px;border-radius:12px;background:var(--surface-raised);user-select:all}
.gh-row .tag.acc-write{color:var(--positive)} .gh-row .tag.acc-read{color:var(--text-muted)}
@media (max-width: 1000px){.gh-grid{grid-template-columns:minmax(0,1fr)}.gh-state{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

/* eslint-disable no-var, prefer-arrow-callback, func-names, prefer-template -- renderer ES5 style */
function client() {
  var L = window.LAIN;
  var el = L.el;
  var st = { status: null, repos: null, reposWhy: null, project: null, loading: false, out: null };
  var redraw = function () { if (L.nav.tab() === 'settings' && L.settings) L.settings.draw(); };

  async function loadStatus() {
    var r = await L.api('/api/github/status', {});
    st.status = r && r.ok ? r.github : { connected: false, why: (r && r.why) || 'GitHub status is not available' };
  }
  async function loadRepos() {
    st.loading = true; redraw();
    var r = await L.api('/api/github/repos', { limit: 100 });
    st.loading = false;
    if (r && r.ok) { st.repos = r.repos; st.reposWhy = null; } else { st.repos = []; st.reposWhy = (r && r.why) || 'could not list repositories'; }
  }
  async function loadProject() {
    var r = await L.api('/api/github/project', {});
    st.project = r && r.ok ? r : null;
  }
  async function refresh() { await loadStatus(); await loadProject(); if (st.status && st.status.connected) await loadRepos(); redraw(); }

  async function connectToken() {
    var v = await L.dialog({
      title: 'Connect with a fine-grained token',
      text: 'Create a fine-grained personal access token on GitHub limited to the repositories LAIN should see (Contents: read & write; Pull requests and Issues if you want those actions). Classic tokens are refused. LAIN keeps it in the Windows secret store; it never appears again, in a log or in a prompt.',
      fields: [{ key: 'token', label: 'Token', value: '', type: 'password', placeholder: 'github_pat_…' }], ok: 'Connect',
    });
    if (!v || !v.token) return;
    var r = await L.api('/api/github/connect-token', { token: v.token.trim() });
    v.token = '';
    if (!r || !r.ok) { L.toast((r && r.why) || 'the token was refused', true); return; }
    L.toast('GitHub connected'); refresh();
  }

  async function assign(full, then) {
    var r = await L.api('/api/github/assign', { fullName: full });
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not use that repository', true); return false; }
    await L.poll();
    if (r.cloned) { L.toast(full + ' attached to this conversation'); if (then) then(); return true; }
    var ok = await L.dialog({ title: 'Clone ' + full + '?', text: r.why + ' LAIN clones it into a local folder and attaches it; nothing on GitHub changes.', fields: [{ key: 'dir', label: 'Location (optional)', value: '', placeholder: 'default: ~/LAIN Projects/' + full.split('/')[1], action: { label: 'Choose…', run: function () { return L.ide.pickFolder('Clone into'); } } }], ok: 'Clone project' });
    if (!ok) return false;
    return clone(full, ok.dir, then);
  }
  async function clone(full, dir, then) {
    L.toast('Cloning ' + full + '…');
    var r = await L.api('/api/github/clone', { fullName: full, dir: dir || null });
    if (!r || !r.ok) { L.toast((r && r.why) || 'the clone failed', true); return false; }
    await L.poll();
    L.toast(r.attached ? full + ' cloned and attached' : full + ' cloned' + (r.why ? ' — ' + r.why : ''));
    if (then) then();
    return true;
  }

  /** CHOOSE A REPOSITORY for this conversation. */
  async function pick(opts) {
    opts = opts || {};
    await loadStatus();
    if (!st.status || !st.status.connected) {
      if (await L.confirm('GitHub is not connected. ' + ((st.status && st.status.why) || '') + ' Open Settings › GitHub?', { ok: 'Open GitHub settings' })) L.nav.go('settings', { section: 'github' });
      return;
    }
    var back = el('div', 'dlg-back'); var box = el('div', 'dlg ghdlg'); box.setAttribute('role', 'dialog');
    box.appendChild(el('h3', '', 'Choose a GitHub repository'));
    box.appendChild(el('p', '', 'Signed in as ' + (st.status.user || 'you') + '. A repository already cloned attaches at once; others are cloned first.'));
    var q = document.createElement('input'); q.className = 'q'; q.placeholder = 'Filter repositories…';
    box.appendChild(q);
    var list = el('div', 'gh-list'); list.appendChild(el('div', 'missing', 'Reading repositories…'));
    box.appendChild(list);
    var acts = el('div', 'dlg-actions'); var cancel = el('button', 'btn', 'Cancel'); acts.appendChild(cancel); box.appendChild(acts);
    var close = function () { back.remove(); document.removeEventListener('keydown', key, true); };
    var key = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    cancel.onclick = close;
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    back.appendChild(box); document.body.appendChild(back);
    document.addEventListener('keydown', key, true);
    setTimeout(function () { q.focus(); }, 0);
    await loadRepos();
    var draw = function () {
      list.textContent = '';
      if (st.reposWhy) { list.appendChild(el('div', 'missing', st.reposWhy)); return; }
      var f = q.value.trim().toLowerCase();
      var rows = (st.repos || []).filter(function (r) { return !f || r.fullName.toLowerCase().indexOf(f) >= 0; });
      if (!rows.length) { list.appendChild(el('div', 'missing', 'No repositories match.')); return; }
      rows.slice(0, 200).forEach(function (r) {
        var row = el('button', 'gh-row'); row.style.textAlign = 'left';
        var t = el('span'); t.appendChild(el('b', '', r.fullName)); t.appendChild(el('small', '', r.local ? r.local : 'default branch ' + r.defaultBranch)); row.appendChild(t);
        row.appendChild(el('span', 'tag', r.private ? 'Private' : 'Public'));
        if (r.access) row.appendChild(el('span', 'tag acc-' + (r.access === 'read' ? 'read' : 'write'), r.access === 'read' ? 'Read only' : r.access === 'admin' ? 'Admin' : 'Write'));
        row.appendChild(el('span', 'tag ' + (r.local ? 'ok' : ''), r.state && r.state.label || (r.local ? 'Local clone' : 'Not downloaded')));
        row.onclick = async function () { close(); await assign(r.fullName, opts.then); };
        list.appendChild(row);
      });
    };
    q.oninput = draw;
    draw();
  }

  // ---- the explicit actions ----------------------------------------------------------------------
  var WRITE_WORDS = { sync: 'Sync with GitHub — fetch, then bring the remote commits in safely (never a reset; conflicts are left for you)', 'merge-abort': 'Abort the merge and go back to your commits', pull: 'Pull from the remote (fast-forward only)', branch: 'Create and switch to a new branch', commit: 'Commit every change in the working tree', push: 'Push this branch to GitHub', 'pr-create': 'Open a pull request on GitHub', 'issue-create': 'Open an issue on GitHub' };
  async function action(kind) {
    var args = {};
    if (kind === 'branch') { var b = await L.dialog({ title: 'New branch', fields: [{ key: 'name', label: 'Branch name', value: '' }], ok: 'Create branch' }); if (!b || !b.name) return; args.name = b.name.trim(); }
    if (kind === 'commit') { var c = await L.dialog({ title: 'Commit', text: 'Commits every change in the local working tree (LAIN’s own .lain folder excluded from the count).', fields: [{ key: 'message', label: 'Message', value: '' }], ok: 'Commit' }); if (!c || !c.message) return; args.message = c.message; }
    if (kind === 'pr-create') { var p = await L.dialog({ title: 'Create pull request', fields: [{ key: 'title', label: 'Title', value: '' }, { key: 'base', label: 'Into branch', value: 'main' }, { key: 'body', label: 'Description', value: '' }], ok: 'Continue' }); if (!p) return; args = p; }
    if (kind === 'issue-create') { var i = await L.dialog({ title: 'New issue', fields: [{ key: 'title', label: 'Title', value: '' }, { key: 'body', label: 'Description', value: '' }], ok: 'Continue' }); if (!i || !i.title) return; args = i; }
    var confirm = false;
    if (WRITE_WORDS[kind]) {
      var g = st.project && st.project.git;
      if (!(await L.confirm(WRITE_WORDS[kind] + (g && g.branch ? ' — branch ' + g.branch : '') + (st.project && st.project.github ? ' of ' + st.project.github : '') + '?', { ok: 'Yes, ' + kind.replace('-create', '').replace('pr', 'open PR') }))) return;
      confirm = true;
    }
    var r = await L.api('/api/github/action', { kind: kind, args: args, confirm: confirm });
    if (!r || !r.ok) { L.toast((r && r.why) || kind + ' failed', true); st.out = (r && r.why) || null; await loadProject(); redraw(); return; }
    st.out = r.out || (r.pr ? 'Pull request #' + r.pr.number + ': ' + r.pr.url : '') || (r.issue ? 'Issue #' + r.issue.number + ': ' + r.issue.url : '')
      || (r.prs ? (r.prs.length ? r.prs.map(function (x) { return '#' + x.number + ' ' + x.title + ' (' + x.head + ')'; }).join('\n') : 'No open pull requests.') : '')
      || (r.issues ? (r.issues.length ? r.issues.map(function (x) { return '#' + x.number + ' ' + x.title; }).join('\n') : 'No open issues.') : '') || (kind + ' done');
    L.toast(kind.replace('-', ' ') + ' done');
    await loadProject(); redraw();
  }

  // ---- ACCOUNTS: every identity LAIN may act as; LAIN's active one; each one's own actions ------------------
  function avatarOf(a, size) {
    var av = el('span', 'gh-av'); av.style.width = av.style.height = size + 'px';
    if (a.avatar) av.style.backgroundImage = 'url("' + a.avatar + '")'; else av.textContent = String(a.login || '?').charAt(0).toUpperCase();
    return av;
  }
  async function switchTo(a) {
    var r = await L.api('/api/github/switch', { id: a.id });
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not switch', true); return; }
    L.toast('GitHub: now @' + a.login + ' in LAIN');
    st.repos = null; await refresh(); if (L.shellGithub) L.shellGithub();
  }
  async function renameAcct(a) {
    var v = await L.dialog({ title: 'Name this account', text: 'Shown instead of @' + a.login + ' in LAIN only.', fields: [{ key: 'n', label: 'Name', value: a.name || '' }], ok: 'Save' });
    if (!v) return;
    await L.api('/api/github/rename', { id: a.id, name: v.n || '' }); await refresh(); if (L.shellGithub) L.shellGithub();
  }
  async function forget(a) {
    var gh = a.via === 'gh';
    var ok = await L.confirm(gh ? 'Hide @' + a.login + ' from LAIN? GitHub CLI keeps its own sign-in (gh auth logout signs it out); no other account changes.' : 'Forget @' + a.login + '? Its token is deleted from the Windows secret store. No other account is touched.', { ok: gh ? 'Hide' : 'Forget', danger: true });
    if (!ok) return;
    var r = await L.api('/api/github/disconnect', { id: a.id });
    if (!r || !r.ok) { L.toast((r && r.why) || 'could not forget it', true); return; }
    st.repos = null; await refresh(); if (L.shellGithub) L.shellGithub();
  }
  /** GITHUB'S DEVICE FLOW with the person's own OAuth App — the scope is chosen here, read-only unless they say. */
  async function signInWithGithub() {
    var v = await L.dialog({
      title: 'Sign in with GitHub',
      text: 'GitHub shows a code; you approve it in your browser. Choose what LAIN may do — you can add another account later with different access.',
      fields: [{ key: 'access', label: 'Access', type: 'select', value: 'read', options: [['read', 'Read only — see your profile and public repositories'], ['public', 'Public repositories — read and write (public_repo)'], ['private', 'Private and public — read and write (repo: every private repository you can reach)']] }],
      ok: 'Get a code',
    });
    if (!v) return;
    var r = await L.api('/api/github/device/start', { access: v.access || 'read' });
    if (!r || !r.ok) { L.toast((r && r.why) || 'GitHub did not start the sign-in', true); return; }
    var stop = false;
    var back = el('div', 'dlg-back'); var box = el('div', 'dlg ghdev'); box.setAttribute('role', 'dialog');
    box.appendChild(el('h3', '', 'Enter this code on GitHub'));
    var code = el('div', 'gh-code', r.userCode); box.appendChild(code);
    var note = el('p', '', 'Waiting for you to approve it at ' + r.verificationUri + ' …'); box.appendChild(note);
    var acts = el('div', 'dlg-actions');
    var cp = el('button', 'btn', 'Copy code'); cp.onclick = function () { try { navigator.clipboard.writeText(r.userCode); L.toast('Code copied'); } catch (e) { /* select it */ } }; acts.appendChild(cp);
    var op = el('button', 'btn primary', 'Open GitHub'); op.onclick = function () { L.hostCall('openExternal', { url: r.verificationUri }); }; acts.appendChild(op);
    var cn = el('button', 'btn', 'Cancel'); cn.onclick = function () { stop = true; back.remove(); }; acts.appendChild(cn);
    box.appendChild(acts); back.appendChild(box); document.body.appendChild(back);
    var tick = async function (wait) {
      await new Promise(function (res) { setTimeout(res, wait * 1000); });
      if (stop) return;
      var p = await L.api('/api/github/device/poll', { handle: r.handle });
      if (stop) return;
      if (p && p.ok && p.pending) return tick(p.interval || wait);
      back.remove();
      if (!p || !p.ok) { L.toast((p && p.why) || 'the sign-in did not finish', true); return; }
      L.toast('GitHub account added'); st.repos = null; await refresh(); if (L.shellGithub) L.shellGithub();
    };
    tick(r.interval || 5);
  }
  async function setClientId() {
    var v = await L.dialog({ title: 'Your GitHub OAuth App', text: 'Register an OAuth App on GitHub (Settings › Developer settings › OAuth Apps), enable Device Flow, and paste its Client ID. LAIN never borrows another application’s. No client secret is needed or taken.', fields: [{ key: 'id', label: 'Client ID', value: '' }], ok: 'Save' });
    if (!v || !v.id) return;
    var r = await L.api('/api/github/client', { clientId: v.id.trim() });
    if (!r || !r.ok) { L.toast((r && r.why) || 'that is not a client id', true); return; }
    await refresh();
  }
  function accountsCard(s) {
    var c1 = el('div', 'gh-card gh-accts');
    var h1 = el('h4'); h1.appendChild(L.icon('github', 20)); h1.appendChild(document.createTextNode('Accounts')); c1.appendChild(h1);
    var list = s.accounts || [];
    if (list.length) {
      c1.appendChild(el('p', '', 'LAIN acts as the active account. A repository keeps the account it was opened with — switching here never changes GitHub CLI’s own account, and nothing is pushed without your say-so.'));
      var rows = el('div', 'gh-alist');
      list.forEach(function (a) {
        var row = el('div', 'gh-acct' + (a.active ? ' on' : '')); row.setAttribute('data-gh-account', a.id);
        row.appendChild(avatarOf(a, 32));
        var t = el('span', 'gh-at'); t.appendChild(el('b', '', a.name || a.login)); t.appendChild(el('small', '', '@' + a.login + ' · ' + (a.viaLabel || a.via))); row.appendChild(t);
        if (a.active) row.appendChild(el('span', 'tag ok', 'Active'));
        else { var u = el('button', 'fbtn small ghost', 'Use'); u.onclick = function () { switchTo(a); }; row.appendChild(u); }
        row.appendChild(L.kit.overflow([
          { label: 'Rename…', run: function () { renameAcct(a); } },
          { sep: true },
          { label: a.via === 'gh' ? 'Hide from LAIN' : 'Forget this account', danger: true, run: function () { forget(a); } },
        ], 'More about @' + a.login));
        rows.appendChild(row);
      });
      c1.appendChild(rows);
    } else {
      c1.appendChild(el('p', '', s.why || 'Not connected.'));
    }
    // ADD ANOTHER: GitHub CLI's own sign-in, GitHub's device flow (the person's own OAuth App), or a fine-grained token.
    var a2 = el('div', 'gh-acts');
    if (s.deviceFlow) { var sg = el('button', 'fbtn primary', 'Sign in with GitHub…'); sg.onclick = signInWithGithub; a2.appendChild(sg); }
    var tk = el('button', 'fbtn ' + (list.length ? 'ghost' : ''), 'Add a fine-grained token…'); tk.onclick = connectToken; a2.appendChild(tk);
    var ck = el('button', 'fbtn ghost', 'Check GitHub CLI'); ck.title = 'Accounts signed in with `gh auth login` appear here'; ck.onclick = function () { L.api('/api/github/accounts', { refresh: true }).then(refresh); }; a2.appendChild(ck);
    if (!s.deviceFlow) { var ci = el('button', 'fbtn ghost', 'Use my OAuth App…'); ci.title = 'Sign in with GitHub needs an OAuth App you registered'; ci.onclick = setClientId; a2.appendChild(ci); }
    if (s.install && !s.gh) { var ins = el('button', 'fbtn ghost', 'Get GitHub CLI'); ins.onclick = function () { L.hostCall('openExternal', { url: s.install }); }; a2.appendChild(ins); }
    c1.appendChild(a2);
    if (!list.length) { var p2 = el('p', 'gh-hint'); p2.appendChild(document.createTextNode('With GitHub CLI: run ')); p2.appendChild(el('code', '', 'gh auth login')); p2.appendChild(document.createTextNode(' in a terminal (once per account), then Check GitHub CLI.')); c1.appendChild(p2); }
    return c1;
  }

  // ---- Settings › GitHub ---------------------------------------------------------------------------
  function page(pane) {
    var pf = el('div', 'pf'); pane.appendChild(pf);
    var head = el('div', 'pf-sec');
    head.appendChild(el('h3', '', 'GitHub'));
    head.appendChild(el('p', 'lede', 'Repositories become LAIN projects by cloning them into a real local folder. Nothing is pushed, merged or opened on GitHub unless you press the button for it.'));
    pf.appendChild(head);
    if (!st.status) { pf.appendChild(el('div', 'missing', 'Reading…')); refresh(); return; }
    var s = st.status;
    var grid = el('div', 'gh-grid');
    grid.appendChild(accountsCard(s));

    var c2 = el('div', 'gh-card');
    var h2 = el('h4'); h2.appendChild(L.icon('branch', 20)); h2.appendChild(document.createTextNode('This project')); c2.appendChild(h2);
    var P = st.project;
    if (!P || !P.project || !P.project.attached) {
      c2.appendChild(el('p', '', P && P.github ? P.github + ' is chosen for this conversation but not cloned yet — Coding Agent is disabled until it is a local working tree.' : 'No project is attached to the current conversation.'));
      var a3 = el('div', 'gh-acts');
      if (P && P.github) { var cl = el('button', 'fbtn primary', 'Clone project'); cl.onclick = function () { clone(P.github, null, refresh); }; a3.appendChild(cl); }
      if (s.connected) { var pk = el('button', 'fbtn ghost', 'Choose repository…'); pk.onclick = function () { pick({ then: refresh }); }; a3.appendChild(pk); }
      c2.appendChild(a3);
    } else if (!P.git || P.git.ok === false) {
      c2.appendChild(el('p', '', P.project.name + ' is not a git working tree.'));
    } else {
      var g = P.git;
      // THE GITHUB PROJECT AND ITS LOCAL WORKING TREE, side by side.
      var sg = el('div', 'gh-state gh-link');
      [['GitHub', P.github || 'no GitHub origin'], ['Local', P.project.root], ['Branch', g.branch], ['Status', g.label || '\u2014']].forEach(function (x, i) { var d = el('div'); d.appendChild(el('span', '', x[0])); var bb = el('b', i === 3 ? 'st-' + String(g.state || '').toLowerCase() : '', x[1]); bb.title = x[1]; d.appendChild(bb); sg.appendChild(d); });
      c2.appendChild(sg);
      if (g.conflicts && g.conflicts.length) c2.appendChild(el('p', '', 'Conflicts in: ' + g.conflicts.join(', ') + ' — resolve them in the IDE and commit, or abort the merge.'));
      var a4 = el('div', 'gh-acts');
      [['sync', 'Sync'], ['merge-abort', 'Abort merge'], ['pull', 'Pull'], ['push', 'Push'], ['commit', 'Commit\u2026'], ['branch', 'Create branch'], ['pr-create', 'Open PR\u2026'], ['pr-view', 'Pull requests'], ['issue-view', 'Issues'], ['issue-create', 'New issue\u2026']].forEach(function (x) {
        if (x[0] === 'merge-abort' && !(g.merging || (g.conflicts && g.conflicts.length))) return;
        var b = el('button', 'fbtn ' + (x[0] === 'sync' ? 'primary' : x[0] === 'commit' || x[0] === 'push' ? '' : 'ghost'), x[1]);
        if ((x[0] === 'commit' && !g.modified) || (x[0] === 'push' && g.unpushed === 0 && g.upstream)) b.disabled = true;
        if (x[0] === 'sync' && !P.github) { b.disabled = true; b.title = 'No GitHub origin'; }
        if (/^(pr|issue)/.test(x[0]) && !P.github) { b.disabled = true; b.title = 'No GitHub origin'; }
        if (/^(pr|issue)/.test(x[0]) && !s.connected) { b.disabled = true; b.title = 'Connect GitHub first'; }
        b.onclick = function () { action(x[0]); };
        a4.appendChild(b);
      });
      c2.appendChild(a4);
      if (st.out) c2.appendChild(el('div', 'gh-out', st.out));
    }
    grid.appendChild(c2);
    pf.appendChild(grid);

    if (s.connected) {
      var rs = el('div', 'pf-sec'); rs.style.marginTop = '28px';
      var rh = el('div', 'pf-row'); var rt = el('div'); rt.appendChild(el('h3', '', 'Repositories')); rt.appendChild(el('p', 'lede', 'What this identity can see, and whether each is on this machine.')); rh.appendChild(rt);
      var rr = el('button', 'fbtn ghost', st.loading ? 'Reading…' : 'Refresh'); rr.onclick = function () { loadRepos().then(redraw); }; rh.appendChild(rr);
      rs.appendChild(rh);
      var list = el('div', 'gh-list');
      if (st.reposWhy) list.appendChild(el('div', 'missing', st.reposWhy));
      else if (!st.repos) list.appendChild(el('div', 'missing', 'Reading…'));
      else if (!st.repos.length) list.appendChild(el('div', 'missing', 'No repositories visible to this identity.'));
      else st.repos.slice(0, 100).forEach(function (r) {
        var row = el('div', 'gh-row');
        var t = el('span'); t.appendChild(el('b', '', r.fullName)); t.appendChild(el('small', '', [(r.private ? 'Private' : 'Public'), r.local || 'not on this machine', r.boundTo ? 'opened as @' + r.boundTo.replace(/^\w+:/, '') : ''].filter(Boolean).join(' · '))); row.appendChild(t);
        // WHAT THIS ACCOUNT MAY DO HERE, as GitHub said — Read means pushes are refused, not retried as someone else.
        if (r.access) row.appendChild(el('span', 'tag acc-' + (r.access === 'read' ? 'read' : 'write'), r.access === 'admin' ? 'Admin' : r.access === 'write' ? 'Write' : 'Read only'));
        row.appendChild(el('span', 'tag ' + (r.local ? 'ok' : ''), (r.state && r.state.label) || 'Not downloaded'));
        var b = el('button', 'fbtn small ' + (r.local ? 'ghost' : ''), r.local ? 'Use in this chat' : 'Clone…');
        b.onclick = function () { assign(r.fullName, refresh); };
        row.appendChild(b);
        list.appendChild(row);
      });
      rs.appendChild(list);
      pf.appendChild(rs);
    }
  }

  L.github = { pick: pick, page: page, refresh: refresh, action: action };
}

function js() { return `(${client.toString()})();`; }

module.exports = { CSS, js, client };
