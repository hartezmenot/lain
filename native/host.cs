// LAIN HARNESS — the native application host (LAIN Desktop, then LAIN Harness, now LAIN Harness again).
//
// ---------------------------------------------------------------------------
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
//
// LAIN's Harness used to be a page in the person's Chrome, reached over
// loopback HTTP with a launch token and a session cookie. That made an external
// browser the application: its window, its lifecycle, its title bar, its
// address bar, its idea of when the product had closed. This process replaces
// that. LAIN owns the window.
//
// IT IS A PRESENTATION HOST AND NOTHING ELSE. There is no session here, no task
// runtime, no permission model, no browser harness, no model routing. Every one
// of those already exists in LAIN Core and stays there; this process renders the
// Harness frontend and relays its calls down a private pipe. If a capability is
// not offered by Core's route table, it does not exist here either — there is no
// "renderer can call anything" escape hatch, which is the single most important
// property of this file.
//
//     renderer (the Harness UI)
//         │  window.chrome.webview.postMessage  — a request, by route
//         ▼
//     this host            — window, lifecycle, OS integration. Decides nothing.
//         │  named pipe, one secret, proven once
//         ▼
//     LAIN Core            — gate.js · trust.js · permissions.js still decide
//
// WEBVIEW2 IS AN IMPLEMENTATION DETAIL. It is the renderer Windows already
// ships; it is not "Chrome again". There is no address bar, no navigation to a
// localhost URL, no browser profile the user manages, no page reload that
// re-authenticates. The host owns startup, connection, reconnection and
// shutdown, and the content is loaded from packaged files through a virtual
// host name so that a release needs no server to show its own UI.
//
// THE BROWSER HARNESS IS UNAFFECTED. Verification, WebModel and the Frontend
// Workshop each still drive a real browser with its own profile and lifetime.
// Those are instruments. This is the application.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program {
  [STAThread]
  static void Main(string[] argv) {
    var args = Args.Parse(argv);
    // WINDOWS' "OPEN WITH" CHANGED (src/winassoc.js registered or removed LAIN): tell Explorer, then leave.
    if (args.Has("assoc-changed")) { AssocNotify.Changed(); return; }
    if (args.Get("pipe") == null) {
      // ---- LAUNCHER MODE: SOMEBODY DOUBLE-CLICKED LAIN -------------------
      //
      // With a pipe, this process is the WINDOW and LAIN started it. Without
      // one, nothing started it — a shortcut, the Start menu or Explorer did —
      // so there is no Core to talk to and the job is to start one.
      //
      // That is the whole of "LAIN Desktop is not summoned from the CLI": the
      // application is the entry point, and the terminal is optional. Core then
      // opens the real window over its own private channel, which is why this
      // process exits rather than trying to become the window itself.
      //
      // "OPEN WITH LAIN" / "OPEN FOLDER IN LAIN": Explorer passes the file or
      // folder as the first plain argument. Core opens it (src/openpath.js) —
      // in the LAIN that is already running, or in the one this starts.
      // `--startup`: the Startup shortcut launched this at Windows sign-in (src/startup.js) — passed on to Core.
      Launcher.Start(Target(argv), Array.IndexOf(argv, "--startup") >= 0);
      return;
    }
    // DPI: the UI is a rendered document and must be crisp on every monitor,
    // including a second one with a different scale factor attached later.
    //
    // `Application.SetHighDpiMode` is .NET 5+; on the .NET Framework that ships
    // with Windows the same thing is a Win32 call, and it must happen BEFORE
    // any window exists or the process is stuck with what it started as.
    Dpi.Aware();
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.Run(new Shell(args));
  }

  /** The first plain argument: a path Explorer handed over ("%1" / "%V"), or null. */
  static string Target(string[] argv) {
    foreach (var a in argv) {
      if (String.IsNullOrEmpty(a) || a.StartsWith("--")) continue;
      return a;
    }
    return null;
  }
}

/** SHChangeNotify(SHCNE_ASSOCCHANGED): Explorer re-reads "Open with" and the context menus. */
static class AssocNotify {
  [System.Runtime.InteropServices.DllImport("shell32.dll")]
  static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
  public static void Changed() { try { SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); } catch { } }
}

/**
 * STARTING LAIN WHEN NOTHING STARTED US.
 *
 * ------------------------------------------------------------------------
 * IT RUNS NODE, WHICH MEANS IT HAS TO FIND NODE.
 *
 * A process launched from Explorer inherits the PATH that Explorer had when it
 * started — which on a machine where Node was installed afterwards, or by a
 * version manager that edits a shell profile, does not contain Node. That is
 * the "node error" this exists to end.
 *
 * So the answer is written down at build time by the resolver that already
 * owns this question (src/noderesolve.js) into `launch.json` beside this exe,
 * and only re-derived here if that file is missing or stale. The re-derivation
 * is deliberately small — the standard install location and PATH — because it
 * is a fallback for a machine whose LAIN has moved, not a second resolver.
 *
 * ------------------------------------------------------------------------
 * IT NEVER FALLS BACK TO A BROWSER.
 *
 * If Core cannot be started the person is told, natively, what was looked for.
 * Silently opening the old HTML Harness in Chrome would hide exactly the
 * regression this message exists to report.
 */
static class Launcher {
  public static void Start(string target = null, bool startup = false) {
    string dir = Path.GetDirectoryName(Application.ExecutablePath);
    string node = null, entry = null, why = null;
    try {
      string manifest = Path.Combine(dir, "launch.json");
      if (File.Exists(manifest)) {
        var m = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(manifest)) as Dictionary<string, object>;
        if (m != null) {
          node = Str(m, "node");
          entry = Str(m, "entry");
          why = Str(m, "why");
        }
      }
    } catch (Exception ex) { why = ex.Message; }

    if (String.IsNullOrEmpty(node) || !File.Exists(node)) node = Probe();
    if (String.IsNullOrEmpty(node)) { Fail("LAIN could not find Node on this machine.", why); return; }
    if (String.IsNullOrEmpty(entry) || !File.Exists(entry)) {
      Fail("LAIN could not find its own program files.",
        "launch.json did not name a readable entry point. Reinstall LAIN, or run `lain --desktop` once from a terminal to rewrite it.");
      return;
    }

    try {
      // ARGUMENT LIST, NOT A COMMAND STRING. The entry point lives under a path
      // with spaces on every ordinary Windows install; quoting it by hand is a
      // second escaping problem, so each argument is quoted exactly once here
      // and nowhere else.
      var psi = new System.Diagnostics.ProcessStartInfo();
      psi.FileName = node;
      psi.Arguments = "\"" + entry + "\" --desktop" + (startup ? " --startup" : "");
      // A PATH FROM EXPLORER, quoted once. A trailing backslash (a drive root, "C:\") is doubled, or it would
      // escape the closing quote under the C runtime's argument rules.
      if (!String.IsNullOrEmpty(target)) psi.Arguments += " --open \"" + (target.EndsWith("\\") ? target + "\\" : target) + "\"";
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;              // no console flash, and none left behind
      psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      System.Diagnostics.Process.Start(psi);
    } catch (Exception ex) {
      Fail("LAIN could not start.", node + Environment.NewLine + ex.Message);
    }
  }

  static string Str(Dictionary<string, object> m, string k) {
    object v;
    if (m == null || !m.TryGetValue(k, out v) || v == null) return null;
    return Convert.ToString(v, CultureInfo.InvariantCulture);
  }

  /** The standard install, then PATH. A fallback, not a second resolver. */
  static string Probe() {
    var seen = new List<string>();
    foreach (var var_ in new string[] { "ProgramFiles", "ProgramW6432", "ProgramFiles(x86)" }) {
      string root = Environment.GetEnvironmentVariable(var_);
      if (!String.IsNullOrEmpty(root)) seen.Add(Path.Combine(root, "nodejs", "node.exe"));
    }
    seen.Add(@"C:\Program Files\nodejs\node.exe");
    seen.Add(@"C:\Program Files (x86)\nodejs\node.exe");
    string p = Environment.GetEnvironmentVariable("PATH") ?? "";
    foreach (string d in p.Split(';')) {
      if (String.IsNullOrEmpty(d.Trim())) continue;
      try { seen.Add(Path.Combine(d.Trim(), "node.exe")); } catch { }
    }
    foreach (string c in seen) { try { if (File.Exists(c)) return c; } catch { } }
    return null;
  }

  static void Fail(string headline, string detail) {
    MessageBox.Show(
      headline + Environment.NewLine + Environment.NewLine
        + (String.IsNullOrEmpty(detail) ? "" : detail + Environment.NewLine + Environment.NewLine)
        + "Looked for node.exe in Program Files and on PATH."
        + Environment.NewLine
        + "Install Node from https://nodejs.org, or set \"nodePath\" in your LAIN config.json.",
      "LAIN", MessageBoxButtons.OK, MessageBoxIcon.Error);
    Environment.Exit(2);
  }
}

/**
 * PER-MONITOR DPI, THE WAY THE FRAMEWORK ON THIS MACHINE SUPPORTS IT.
 *
 * Newest first, each a real capability of a different Windows generation, and
 * every one of them optional: a host that refuses to start because it could not
 * negotiate a scaling mode would be worse than one that renders slightly soft.
 */
/**
 * THE TITLE BAR BELONGS TO THE APPLICATION TOO.
 *
 * LAIN's interface is dark, and a WinForms window gets the system's light
 * caption by default — so the product shipped with a white strip above a dark
 * document, which is exactly the "a page inside somebody else's frame" look
 * this whole change is meant to end. DWM has owned this since Windows 10 20H1;
 * the attribute number moved once (19 in the earliest builds, 20 after), so
 * both are attempted and neither is required.
 */
static class Caption {
  [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
  static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

  public static void Dark(IntPtr hwnd) {
    int on = 1;
    try { if (DwmSetWindowAttribute(hwnd, 20, ref on, sizeof(int)) == 0) return; } catch { }
    try { DwmSetWindowAttribute(hwnd, 19, ref on, sizeof(int)); } catch { }
  }
}

/**
 * THE PAGE DRAWS THE TITLE BAR (2026-09-30).
 *
 * The system caption is removed and the page's own top bar takes its place:
 * the brand, the usage tracker and the window buttons on one line, as the
 * product's frame. What Windows owns stays Windows': WM_NCCALCSIZE removes only
 * the CAPTION, so the side and bottom resize borders, the drop shadow, snapping,
 * rounded corners and the system menu (Alt+Space) are the system's own. Moving
 * the window, and resizing from the top edge, are started by the page (the
 * "win" verb) and then performed by Windows' own move/size loop — so a drag to
 * the screen edge snaps exactly like any other window.
 *
 * `--native-caption` (or LAIN_NATIVE_CAPTION=1) keeps the system caption.
 */
static class Frame {
  public const int WM_NCCALCSIZE = 0x0083;
  public const int WM_NCLBUTTONDOWN = 0x00A1;
  public const int HTCAPTION = 2, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14;

  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  public struct RECT { public int left, top, right, bottom; }
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
  public struct NCCALCSIZE_PARAMS { public RECT r0, r1, r2; public IntPtr pos; }

  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ReleaseCapture();
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index, uint dpi);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);

  /** The frame thickness a maximised window hangs off the screen by: resize frame + padded border, at the window's DPI. */
  public static int FrameY(IntPtr hwnd) {
    try { uint dpi = GetDpiForWindow(hwnd); if (dpi > 0) return GetSystemMetricsForDpi(33, dpi) + GetSystemMetricsForDpi(92, dpi); } catch { }
    try { return GetSystemMetrics(33) + GetSystemMetrics(92); } catch { return 8; }
  }

  /**
   * WM_NCCALCSIZE, in two halves around Windows' own calculation: remember where the window's
   * top was, let Windows compute the frame, then give the caption back to the client area.
   */
  public static int TopBefore(IntPtr lParam) {
    var p = (NCCALCSIZE_PARAMS)System.Runtime.InteropServices.Marshal.PtrToStructure(lParam, typeof(NCCALCSIZE_PARAMS));
    return p.r0.top;
  }
  public static void TopAfter(ref Message m, int top) {
    var p = (NCCALCSIZE_PARAMS)System.Runtime.InteropServices.Marshal.PtrToStructure(m.LParam, typeof(NCCALCSIZE_PARAMS));
    // MAXIMISED, a window hangs its frame off every screen edge; the top one must come back or the page loses a strip.
    p.r0.top = top + (IsZoomed(m.HWnd) ? FrameY(m.HWnd) : 0);
    System.Runtime.InteropServices.Marshal.StructureToPtr(p, m.LParam, false);
    m.Result = IntPtr.Zero;
  }

  /** Ask Windows to recompute the frame now (after the handle exists). */
  public static void Refresh(IntPtr hwnd) {
    // SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
    try { SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020); } catch { }
  }

  /** Hand the pressed mouse to Windows' own move (HTCAPTION) or size (HTTOP…) loop. */
  public static void Begin(IntPtr hwnd, int hit) {
    try { ReleaseCapture(); SendMessage(hwnd, WM_NCLBUTTONDOWN, new IntPtr(hit), IntPtr.Zero); } catch { }
  }
}

static class Dpi {
  static readonly IntPtr PER_MONITOR_V2 = new IntPtr(-4);
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [System.Runtime.InteropServices.DllImport("shcore.dll")]
  static extern int SetProcessDpiAwareness(int value);          // 2 = per-monitor
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  static extern bool SetProcessDPIAware();

  public static void Aware() {
    try { if (SetProcessDpiAwarenessContext(PER_MONITOR_V2)) return; } catch { }
    try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}

class Args {
  readonly Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
  public static Args Parse(string[] argv) {
    var a = new Args();
    for (int i = 0; i < argv.Length; i++) {
      var k = argv[i];
      if (!k.StartsWith("--")) continue;
      k = k.Substring(2);
      string v = "1";
      int eq = k.IndexOf('=');
      if (eq >= 0) { v = k.Substring(eq + 1); k = k.Substring(0, eq); }
      else if (i + 1 < argv.Length && !argv[i + 1].StartsWith("--")) { v = argv[++i]; }
      a.map[k] = v;
    }
    return a;
  }
  public string Get(string k) { string v; return map.TryGetValue(k, out v) ? v : null; }
  public bool Has(string k) { return map.ContainsKey(k); }
}

/**
 * THE APPLICATION WINDOW.
 *
 * Owns what an operating system owns: where the window is, how big, on which
 * monitor, whether it is maximised, what happens when a file is dropped on it,
 * and when the application has actually closed. None of that belongs to a page.
 */
class Shell : Form {
  readonly Args args;
  readonly WebView2 view = new WebView2();
  readonly Core core;
  readonly string stateFile;
  readonly Label status = new Label();
  bool ready;

  // ---- THE TRAY, AND WHY CLOSING IS NOT QUITTING --------------------------
  //
  // X HIDES. It does not end LAIN, and treating those as the same gesture was
  // the lifecycle defect this section exists to fix.
  //
  // LAIN keeps doing things while no window is open: a messaging gateway holds
  // a connection, Cowork background jobs run, a coding turn started ten minutes
  // ago is still working. If the window owned that lifetime, then tidying your
  // desktop would silently disconnect your bot and cancel work in flight — and
  // nothing on screen would say so, because the screen would be gone.
  //
  //     X            hide to tray; Core, bots and turns carry on
  //     Open LAIN    the same window back, where it was
  //     Quit LAIN    an explicit end, through Core's one shutdown sequence
  //
  // QUIT IS THE ONLY ONE THAT ENDS ANYTHING, and it does not end it HERE: it
  // asks Core to shut down (src/teardown.js), because the host owns a window and
  // Core owns everything a shutdown has to stop. A host that killed itself and
  // let Core go on would leave exactly the orphan this arrangement prevents.
  NotifyIcon tray;
  bool quitting;
  // THE DETACHED PREVIEW (Phase 8.1): a second window on the same Core and the same WebView2 environment.
  CoreWebView2Environment sharedEnv;
  Satellite preview;

  // THE PAGE'S OWN TITLE BAR (see Frame) unless the system caption was asked for.
  readonly bool ownFrame;
  // null (the Harness), "dashboard" or "preview" — see the constructor.
  readonly string mode;
  bool lastMax;
  bool lastMin;

  protected override void WndProc(ref Message m) {
    if (ownFrame && m.Msg == Frame.WM_NCCALCSIZE && m.WParam != IntPtr.Zero) {
      int top = Frame.TopBefore(m.LParam);
      base.WndProc(ref m);
      Frame.TopAfter(ref m, top);
      return;
    }
    base.WndProc(ref m);
  }

  /** The window's state as the page draws it: maximised or not (the ▢ / ❐ button), and minimised (the page polls less). */
  void WindowStateToPage() {
    bool max = WindowState == FormWindowState.Maximized;
    bool min = WindowState == FormWindowState.Minimized;
    if (max == lastMax && min == lastMin) return;
    lastMax = max;
    lastMin = min;
    ToRenderer("{\"win\":{\"max\":" + (max ? "true" : "false") + ",\"min\":" + (min ? "true" : "false") + ",\"own\":" + (ownFrame ? "true" : "false") + "}}");
  }

  /// LAIN's home when Core did not say (it always passes --window-state / --user-data): the override, else ~/.lain.
  static string LainHome() {
    foreach (string v in new[] { "LAIN_CONFIG_DIR", "LAIN_HOME", "LAIN_CONFIG_DIR", "LAIN_HOME" }) { string o = Environment.GetEnvironmentVariable(v); if (!String.IsNullOrEmpty(o)) return o; }
    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".lain");
  }

  public Shell(Args a) {
    args = a;
    ownFrame = !a.Has("native-caption") && Environment.GetEnvironmentVariable("LAIN_NATIVE_CAPTION") != "1";
    core = new Core(a.Get("pipe"), a.Get("secret"));
    stateFile = a.Get("window-state") ?? Path.Combine(LainHome(), "desktop-window.json");

    // WHAT THIS WINDOW IS (`--mode`): the full Harness, or one of the two surfaces the LAIN CLI opens on its own —
    // the Model Dashboard (`lain model`) and the Preview (`lain preview`). A mode window has no tray: closing it
    // closes it, and the CLI's Core that opened it ends with it (src/desktoprun.js).
    mode = a.Get("mode");
    if (mode != "dashboard" && mode != "preview") mode = null;
    Text = mode == "dashboard" ? "LAIN Model Dashboard" : mode == "preview" ? "LAIN Preview" : "LAIN";
    try { Icon = TrayIcon(); } catch { /* the system icon */ }
    MinimumSize = new Size(880, 560);
    BackColor = Color.FromArgb(11, 13, 16);
    AllowDrop = true;
    StartPosition = FormStartPosition.Manual;
    RestoreWindow();
    // STARTED MINIMIZED at Windows sign-in (src/startup.js): on the taskbar, not in front of the person.
    if (a.Has("minimized")) WindowState = FormWindowState.Minimized;

    status.Dock = DockStyle.Top;
    status.Height = 26;
    status.TextAlign = ContentAlignment.MiddleLeft;
    status.Padding = new Padding(12, 0, 0, 0);
    status.BackColor = Color.FromArgb(58, 30, 30);
    status.ForeColor = Color.FromArgb(240, 220, 220);
    status.Visible = false;
    Controls.Add(status);

    view.Dock = DockStyle.Fill;
    view.DefaultBackgroundColor = Color.FromArgb(11, 13, 16);
    Controls.Add(view);
    view.BringToFront();

    DragEnter += OnDragEnter;
    DragDrop += OnDragDrop;
    FormClosing += OnClosing;
    if (mode == null) BuildTray();

    core.Connected += () => BeginInvoke((Action)(() => Banner(null)));
    core.Lost += why => BeginInvoke((Action)(() => Banner("LAIN Core is not responding — reconnecting. " + why)));
    core.Message += line => BeginInvoke((Action)(() => FromCore(line)));

    // THE CORE THAT STARTED THIS WINDOW (`--core-pid`): when that process has ended, there is nothing left to show and
    // nothing to reconnect to — the window closes rather than lingering as an orphan (and its tray icon with it).
    int corePid;
    if (int.TryParse(a.Get("core-pid") ?? "", NumberStyles.Integer, CultureInfo.InvariantCulture, out corePid) && corePid > 0) {
      var coreWatch = new System.Windows.Forms.Timer();
      coreWatch.Interval = 2000;
      coreWatch.Tick += (s, e) => {
        bool alive;
        try { using (var p = System.Diagnostics.Process.GetProcessById(corePid)) alive = !p.HasExited; } catch { alive = false; }
        if (alive) return;
        coreWatch.Stop();
        quitting = true;
        if (tray != null) { tray.Visible = false; }
        Application.Exit();
      };
      coreWatch.Start();
    }

    HandleCreated += (s, e) => { Caption.Dark(Handle); if (ownFrame) Frame.Refresh(Handle); };
    Resize += (s, e) => WindowStateToPage();
    Load += async (s, e) => await Boot();
  }

  void Banner(string text) {
    if (String.IsNullOrEmpty(text)) { status.Visible = false; return; }
    status.Text = text;
    status.Visible = true;
  }

  async Task Boot() {
    // CORE FIRST (Phase P, 2026-10-02): the pipe handshake runs WHILE the renderer starts (~0.5 s), so the page's first
    // /api/state finds the channel open. Messages that arrive before the page is ready are dropped (ToRenderer) — the
    // page reads the whole state on boot anyway.
    core.Start();

    // A PROFILE OF OUR OWN, under LAIN's own directory. It is the renderer's
    // scratch space — not a browser profile a person manages, and never the
    // profile any Browser Harness role uses.
    //
    // ---- AND A SEPARATE ONE IN DEV, WHICH IS NOT A TIDINESS CHOICE --------
    //
    // WebView2 requires every environment sharing a user data folder to be
    // created with the SAME options. `--dev` adds a remote debugging port to
    // those options, so a dev window opening against the release folder — while
    // an ordinary LAIN Desktop is running on it — fails the SECOND one with
    // ERROR_INVALID_STATE (0x8007139F), reported as though the WebView2 runtime
    // were missing.
    //
    // Measured, not theorised: an acceptance run with `--dev` put that dialog on
    // a person's screen while their own window was open. Different options mean
    // a different folder.
    var userData = args.Get("user-data");
    if (String.IsNullOrEmpty(userData)) {
      string home = Path.Combine(LainHome(), "desktop");
      userData = args.Has("dev") ? Path.Combine(home, "dev") : home;
    }
    Directory.CreateDirectory(userData);

    // NO DEBUG SURFACE UNLESS ASKED. A release opens no devtools, no context
    // menu of browser affordances, no remote debugging port, and no way to
    // navigate somewhere else.
    //
    // `--dev` is the development workflow §25 asks for, and it is the ONLY way
    // a debugging port is ever opened. It is also how the acceptance suite
    // drives this application for real rather than testing a different build:
    // the port is chosen by the caller, bound to loopback by the renderer
    // itself, and absent from every release launch.
    // AUTOPLAY WITHOUT A GESTURE: a model driving the Preview (src/tools/preview.js) clicks with synthesized events,
    // which a browser does not count as a person's gesture — so a project's Play button would silently fail to play.
    // The renderer only ever shows LAIN's page and the project's own Preview, so this changes nothing elsewhere.
    // Every window on this profile passes the same options (WebView2 requires it), so it is unconditional.
    var browserArgs = "--disable-features=msSmartScreenProtection --autoplay-policy=no-user-gesture-required";
    var debugPort = args.Get("debug-port");
    if (args.Has("dev") && !String.IsNullOrEmpty(debugPort)) {
      browserArgs += " --remote-debugging-port=" + debugPort;
    }
    var opts = new CoreWebView2EnvironmentOptions(browserArgs);
    CoreWebView2Environment env;
    try {
      env = await CoreWebView2Environment.CreateAsync(null, userData, opts);
      await view.EnsureCoreWebView2Async(env);
      sharedEnv = env;
    } catch (Exception ex) {
      // ---- SAY WHICH FAILURE THIS IS -------------------------------------
      //
      // Every one of these used to read "LAIN Desktop needs the Microsoft Edge
      // WebView2 runtime" — which is the right sentence for exactly one cause
      // and a misdiagnosis for the rest. A person whose runtime is installed,
      // reading that their runtime is missing, has been sent to fix the one
      // thing that is not broken.
      //
      // The state error is the one worth naming: it is what a SECOND window
      // gets when it asks for different options than the folder already has,
      // and the fix is about windows rather than about installation.
      int hr = System.Runtime.InteropServices.Marshal.GetHRForException(ex);
      string headline, advice;
      if (hr == unchecked((int)0x8007139F)) {           // ERROR_INVALID_STATE
        headline = "LAIN could not open a second window with different settings.";
        advice = "Another LAIN window is already using this renderer profile."
          + "\r\n\r\nExit LAIN from the tray and open it again.";
      } else if (hr == unchecked((int)0x80004005) || ex is DllNotFoundException) {
        headline = "LAIN needs the Microsoft Edge WebView2 runtime, which is part of Windows.";
        advice = "Install the WebView2 runtime from Microsoft, then open LAIN again.";
      } else {
        headline = "LAIN could not start its renderer.";
        advice = "The profile it uses is:\r\n" + userData;
      }
      MessageBox.Show(
        headline + "\r\n\r\n" + advice
          + "\r\n\r\n" + ex.Message + "  (0x" + hr.ToString("X8", CultureInfo.InvariantCulture) + ")",
        "LAIN", MessageBoxButtons.OK, MessageBoxIcon.Error);
      Close();
      return;
    }

    var w = view.CoreWebView2;
    var s = w.Settings;
    bool dev = args.Has("dev");
    s.AreDefaultContextMenusEnabled = dev;
    s.AreDevToolsEnabled = dev;
    s.IsStatusBarEnabled = false;
    s.AreBrowserAcceleratorKeysEnabled = dev;
    // LAIN OWNS THE ZOOM (the "zoom" verb): persisted, stepped 80–200%, applied to every surface.
    s.IsZoomControlEnabled = false;
    s.IsSwipeNavigationEnabled = false;
    s.IsGeneralAutofillEnabled = false;
    s.IsPasswordAutosaveEnabled = false;

    // ---- THE UI COMES FROM DISK, NOT FROM A SERVER --------------------
    //
    // A virtual host name mapped to the packaged asset folder. A release
    // therefore needs no HTTP listener to show its own interface, and the page
    // has no origin anybody else on the machine can reach.
    var assets = args.Get("assets");
    if (assets != null && Directory.Exists(assets)) {
      w.SetVirtualHostNameToFolderMapping("lain.app", assets, CoreWebView2HostResourceAccessKind.Allow);
    }

    // ---- THE ONLY WAY OUT OF THE RENDERER ------------------------------
    //
    // One message shape, one destination: a route on Core. The host adds no
    // capability of its own and cannot be asked for one.
    w.WebMessageReceived += OnRendererMessage;

    // NOTHING NAVIGATES AWAY. A link to the wider web opens in the person's
    // real browser; the application window stays the application.
    w.NewWindowRequested += (o, e) => {
      e.Handled = true;
      OpenExternally(e.Uri);
    };
    w.NavigationStarting += (o, e) => {
      var uri = e.Uri ?? "";
      if (uri.StartsWith("https://lain.app/", StringComparison.OrdinalIgnoreCase)
        || uri.StartsWith("http://lain.app/", StringComparison.OrdinalIgnoreCase)
        || uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)
        || (dev && uri.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase))) return;
      e.Cancel = true;
      OpenExternally(uri);
    };

    // A MODE WINDOW loads the same page in that mode: the Model Dashboard (`#dashboard=<section>`) or the Preview
    // alone (`#detached-preview`, the same surface the Harness detaches). `lain.app` is the page's internal virtual
    // origin — never shown to the person and never on the network.
    var start = args.Get("url") ?? ("https://lain.app/index.html"
      + (mode == "dashboard" ? "#dashboard=" + Uri.EscapeDataString(args.Get("section") ?? "accounts")
        : mode == "preview" ? "#detached-preview" : ""));
    view.Source = new Uri(start);
    ready = true;
  }

  /**
   * THE DEFAULT BROWSER, FOR A WEB ADDRESS AND NOTHING ELSE.
   *
   * ShellExecute on an arbitrary string is a program launcher: `file:`, a
   * UNC path, `ms-settings:`, a custom protocol handler. So the string must
   * PARSE as an absolute http(s) URI, carry no user:password (a phishing
   * shape, and credentials in a URL end up in history), and be of sane length;
   * what is handed to the shell is the parsed, normalised form, never the raw
   * text. Returns why it refused, or null when the browser was asked.
   */
  static string OpenExternally(string raw) {
    if (String.IsNullOrEmpty(raw) || raw.Length > 4096) return "not a web address";
    Uri u;
    if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out u)) return "not a web address";
    if (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp) return "only http and https addresses open in the browser";
    if (!String.IsNullOrEmpty(u.UserInfo)) return "an address with a user name or password in it is not opened";
    if (String.IsNullOrEmpty(u.Host) || u.IsUnc || u.IsFile) return "not a web address";
    try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); return null; }
    catch (Exception e) { return "the browser could not be opened: " + e.Message; }
  }

  /**
   * A REQUEST FROM THE UI. It is forwarded verbatim and answered verbatim; the
   * host does not interpret routes, does not keep a whitelist of its own, and
   * does not add anything the page did not ask for. Core decides.
   */
  void OnRendererMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
    string json;
    try { json = e.WebMessageAsJson; } catch { return; }
    // ---- THE HOST'S OWN FIVE VERBS, AND NOTHING ELSE ----------------------
    //
    // A folder picker, a file picker, the tray tooltip, hiding the window and
    // handing a web address to the default browser are operating-system
    // PRESENTATION: they
    // need the window, and Core has none. They grant nothing — a picked path
    // still goes to Core's /api/project/open, which checks it like a typed one,
    // and an address opens only if it is http(s). Every other message is forwarded untouched,
    // and an unknown verb is answered as unknown rather than guessed at.
    Dictionary<string, object> m = null;
    try { m = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>; } catch { m = null; }
    if (m != null && m.ContainsKey("host") && m.ContainsKey("id")) { HostVerbFromRenderer(m); return; }
    core.Send(json);
  }

  void HostVerbFromRenderer(Dictionary<string, object> m) {
    string ask = Convert.ToString(m["host"], CultureInfo.InvariantCulture);
    var body = new Dictionary<string, object>();
    body["host"] = ask;
    if (ask == "pickFolder") {
      string title = m.ContainsKey("title") ? Convert.ToString(m["title"], CultureInfo.InvariantCulture) : "Choose a folder";
      string picked = FolderPicker.Pick(this, title);
      body["ok"] = true;
      body["cancelled"] = picked == null;
      body["path"] = picked;
    } else if (ask == "trayTip") {
      string text = m.ContainsKey("text") ? Convert.ToString(m["text"], CultureInfo.InvariantCulture) : "LAIN";
      // NotifyIcon.Text is capped at 63 characters by Windows.
      if (tray != null) { try { tray.Text = String.IsNullOrEmpty(text) ? "LAIN" : (text.Length > 63 ? text.Substring(0, 63) : text); } catch { } }
      body["ok"] = true;
    } else if (ask == "hide") {
      Hide();
      body["ok"] = true;
    } else if (ask == "win") {
      // THE PAGE'S TITLE BAR (see Frame): state · min · max (toggles) · close (the system X: hides to
      // the tray) · drag (Windows' own move loop) · resize from the top edge. Nothing else.
      string act = m.ContainsKey("do") ? Convert.ToString(m["do"], CultureInfo.InvariantCulture) : "state";
      if (act == "min") WindowState = FormWindowState.Minimized;
      else if (act == "max") WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
      else if (act == "close") BeginInvoke((Action)(() => Close()));
      else if (ownFrame && (act == "drag" || act == "resize")) {
        string edge = m.ContainsKey("edge") ? Convert.ToString(m["edge"], CultureInfo.InvariantCulture) : "";
        int hit = act == "drag" ? Frame.HTCAPTION : edge == "top" ? Frame.HTTOP : edge == "topleft" ? Frame.HTTOPLEFT : edge == "topright" ? Frame.HTTOPRIGHT : 0;
        // AFTER this message returns, with the button still down: Windows' loop then owns the mouse until it is released.
        if (hit != 0 && !(act == "resize" && WindowState == FormWindowState.Maximized)) BeginInvoke((Action)(() => Frame.Begin(Handle, hit)));
      }
      body["ok"] = true;
      body["own"] = ownFrame;
      body["max"] = WindowState == FormWindowState.Maximized;
    } else if (ask == "zoom") {
      // THE WHOLE INTERFACE'S SCALE (Settings › Appearance › Interface Scale, Ctrl+ / Ctrl- / Ctrl+0).
      // The renderer's own zoom, so every surface — the editor included — scales together.
      double f = 1.0;
      try { f = Convert.ToDouble(m.ContainsKey("factor") ? m["factor"] : 1.0, CultureInfo.InvariantCulture); } catch { f = 1.0; }
      if (f < 0.5) f = 0.5; if (f > 3.0) f = 3.0;
      try { view.ZoomFactor = f; body["ok"] = true; body["factor"] = f; } catch (Exception ze) { body["ok"] = false; body["why"] = ze.Message; }
    } else if (ask == "detach") {
      // DETACH PREVIEW: the preview in its own window — the same Core, project, dev server,
      // Selection and "Say something to change" (it is LAIN's own page in preview mode).
      // Closing it stops nothing; the main window is untouched.
      string mode = m.ContainsKey("mode") ? Convert.ToString(m["mode"], CultureInfo.InvariantCulture) : "preview";
      if (mode != "preview" || sharedEnv == null) { body["ok"] = false; body["why"] = mode != "preview" ? "only the preview can be detached" : "the window is still starting"; }
      else {
        if (preview == null || preview.IsDisposed) {
          preview = new Satellite(args, sharedEnv, "LAIN \u2014 Preview", "https://lain.app/index.html#detached-preview");
          preview.FormClosed += (o, e2) => { preview = null; };
          preview.Show();
        } else { preview.Activate(); }
        body["ok"] = true;
      }
    } else if (ask == "capture") {
      // A PICTURE OF THE WINDOW, for a feedback report — only when the person ticked it.
      // Asynchronous: the capture completes on the UI thread's own loop, then the reply is sent.
      var ms = new System.IO.MemoryStream();
      object capId = m["id"];
      view.CoreWebView2.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png, ms).ContinueWith(t => {
        var cb = new Dictionary<string, object>();
        cb["host"] = "capture";
        if (t.IsFaulted) { cb["ok"] = false; cb["why"] = t.Exception.GetBaseException().Message; }
        else { cb["ok"] = true; cb["png"] = "data:image/png;base64," + Convert.ToBase64String(ms.ToArray()); }
        ms.Dispose();
        var crep = new Dictionary<string, object>();
        crep["id"] = capId;
        crep["body"] = cb;
        var ser = new JavaScriptSerializer();
        ser.MaxJsonLength = int.MaxValue;
        string json = ser.Serialize(crep);
        BeginInvoke((Action)(() => ToRenderer(json)));
      });
      return;
    } else if (ask == "pickFile") {
      // A FILE TO HAND TO CORE (a .vsix to install). Like the folder picker it
      // grants nothing: Core reads the path and checks it as if it were typed.
      // The filter comes from a fixed list, never from the page.
      string title = m.ContainsKey("title") ? Convert.ToString(m["title"], CultureInfo.InvariantCulture) : "Choose a file";
      string kind = m.ContainsKey("kind") ? Convert.ToString(m["kind"], CultureInfo.InvariantCulture) : "";
      using (var dlg = new OpenFileDialog()) {
        dlg.Title = title;
        dlg.Filter = kind == "vsix" ? "VS Code extension (*.vsix)|*.vsix" : "All files (*.*)|*.*";
        dlg.CheckFileExists = true;
        dlg.Multiselect = false;
        bool chosen = dlg.ShowDialog(this) == DialogResult.OK;
        body["ok"] = true;
        body["cancelled"] = !chosen;
        body["path"] = chosen ? dlg.FileName : null;
      }
    } else if (ask == "openExternal") {
      // SIGN-IN AND "GET A KEY" PAGES OPEN IN THE PERSON'S OWN BROWSER — where
      // their password manager, passkeys and MFA already are — never inside
      // LAIN's page. See OpenExternally for what is and is not opened.
      string url = m.ContainsKey("url") ? Convert.ToString(m["url"], CultureInfo.InvariantCulture) : "";
      string why = OpenExternally(url);
      body["ok"] = why == null;
      if (why != null) body["why"] = why;
    } else {
      body["ok"] = false;
      body["why"] = "the host has no verb \"" + ask + "\"";
    }
    var reply = new Dictionary<string, object>();
    reply["id"] = m["id"];
    reply["body"] = body;
    ToRenderer(new JavaScriptSerializer().Serialize(reply));
  }

  /**
   * A LINE FROM CORE. Almost all of them are answers to something the renderer
   * asked, and those go straight through untouched.
   *
   * A FEW ARE FOR THE WINDOW ITSELF, and they are the reason this is not simply
   * a forward. A window can be HIDDEN — which a page cannot be — so Core needs a
   * way to say "show yourself" when somebody asks for LAIN while it is in the
   * tray. Those carry a `host` verb, are acted on here, and are NEVER forwarded:
   * this is not a channel for running things in the renderer.
   */
  void FromCore(string json) {
    var verb = HostVerb(json);
    if (verb != null) {
      if (verb == "show") ShowWindow();
      else if (verb == "hide") Hide();
      else if (verb.StartsWith("notify:")) Notify(verb.Substring(7));
      else if (verb.StartsWith("remind:")) Remind(verb.Substring(7));
      // THE TRAY'S QUOTA SUMMARY (Phase 8.3, Core's fabric/tray.js): text lines and one percentage.
      // Presentation data only — drawn into the tooltip, the menu and the icon; never run, never forwarded.
      else if (verb.StartsWith("tray:")) TrayUpdate(verb.Substring(5));
      // CORE IS SHUTTING DOWN AND IS CLOSING ITS WINDOW. Asked rather than
      // killed, so `OnClosing` runs and the tray icon is DISPOSED — a killed
      // process leaves its icon in the notification area until somebody hovers
      // over it, which is a ghost LAIN in the corner of the screen.
      else if (verb == "exit") { quitting = true; Close(); Application.Exit(); }
      return;
    }
    ToRenderer(json);
  }

  /**
   * A COMPLETION WORTH INTERRUPTING SOMEBODY FOR.
   *
   * Only meaningful endings reach here — Core decides which, and deliberately
   * not every tool call (src/notify.js). It is a tray balloon rather than a
   * modern toast because that is what the framework shipped with Windows can do
   * without a packaged identity; the alternative was a dependency and an
   * installer requirement for one line of text.
   *
   * IT IS SKIPPED WHEN THE WINDOW IS IN FRONT. Being told what you are already
   * looking at is noise, and noise is how a notification channel gets muted.
   */
  void Notify(string text) {
    if (tray == null || String.IsNullOrEmpty(text)) return;
    if (Visible && WindowState != FormWindowState.Minimized && ContainsFocus) return;
    try {
      tray.BalloonTipTitle = "LAIN";
      tray.BalloonTipText = text.Length > 240 ? text.Substring(0, 240) : text;
      tray.BalloonTipIcon = ToolTipIcon.Info;
      tray.ShowBalloonTip(5000);
    } catch { /* a notification that cannot be shown is not worth failing over */ }
  }

  /**
   * AN ASSISTANT DELIVERY — a reminder, a schedule's result, a watch that
   * fired (src/assistant/delivery.js). Unlike a completion it is shown even
   * when the window is in front: the person asked to be told at this moment.
   * CLICKING IT OPENS LAIN WHERE IT BELONGS: the window is shown and the page
   * is handed the navigation Core attached ({ nav: { tab, section, task } }) —
   * navigation only, nothing runs.
   */
  string pendingNav;
  void Remind(string json) {
    if (tray == null || String.IsNullOrEmpty(json)) return;
    try {
      var o = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
      if (o == null) return;
      string title = o.ContainsKey("title") ? Convert.ToString(o["title"], CultureInfo.InvariantCulture) : "LAIN";
      string text = o.ContainsKey("text") ? Convert.ToString(o["text"], CultureInfo.InvariantCulture) : "";
      pendingNav = o.ContainsKey("nav") ? new JavaScriptSerializer().Serialize(o["nav"]) : null;
      tray.BalloonTipTitle = title.Length > 63 ? title.Substring(0, 63) : title;
      tray.BalloonTipText = String.IsNullOrEmpty(text) ? title : (text.Length > 240 ? text.Substring(0, 240) : text);
      tray.BalloonTipIcon = ToolTipIcon.Info;
      tray.ShowBalloonTip(10000);
    } catch { /* a notification that cannot be shown is not worth failing over */ }
  }
  void RemindClicked() {
    var nav = pendingNav;
    pendingNav = null;
    ShowWindow();
    if (nav != null) ToRenderer("{\"nav\":" + nav + "}");
  }

  /**
   * The `host` verb in a line from Core, or null.
   *
   * Parsed with the same serializer everything else uses, and defensively: a
   * malformed line from a Core that is mid-restart must not take the window
   * down. Anything that is not an object with a string `host` is an ordinary
   * reply.
   */
  static string HostVerb(string json) {
    try {
      var o = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
      if (o == null || !o.ContainsKey("host")) return null;
      return Convert.ToString(o["host"], CultureInfo.InvariantCulture);
    } catch { return null; }
  }

  void ToRenderer(string json) {
    if (!ready || view.CoreWebView2 == null) return;
    try { view.CoreWebView2.PostWebMessageAsJson(json); } catch { }
  }

  // ---- NATIVE FILE WORKFLOWS ------------------------------------------
  //
  // A dropped file becomes a PATH handed to Core, which turns it into an
  // artifact through the authority that already owns files. The renderer never
  // receives a raw filesystem path it could hand to a model.
  void OnDragEnter(object sender, DragEventArgs e) {
    e.Effect = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
  }

  void OnDragDrop(object sender, DragEventArgs e) {
    if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
    var paths = (string[])e.Data.GetData(DataFormats.FileDrop);
    if (paths == null || paths.Length == 0) return;
    var ser = new JavaScriptSerializer();
    var body = new Dictionary<string, object>();
    body["paths"] = paths;
    var msg = new Dictionary<string, object>();
    msg["id"] = 0;                       // a host-originated call wants no reply
    msg["method"] = "POST";
    msg["path"] = "/api/desktop/drop";
    msg["body"] = body;
    core.Send(ser.Serialize(msg));
  }

  // ---- WINDOW STATE ----------------------------------------------------
  //
  // Persisted because an application that forgets where it was is one a person
  // has to arrange every morning. Restored DEFENSIVELY: a saved rectangle can
  // name a monitor that is no longer attached or a resolution that no longer
  // exists, and a window placed there is invisible with no way to reach it.
  void RestoreWindow() {
    Size = new Size(1280, 840);
    var area = Screen.PrimaryScreen.WorkingArea;
    Location = new Point(area.X + Math.Max(0, (area.Width - Width) / 2), area.Y + Math.Max(0, (area.Height - Height) / 2));
    try {
      if (!File.Exists(stateFile)) return;
      var ser = new JavaScriptSerializer();
      var d = (Dictionary<string, object>)ser.DeserializeObject(File.ReadAllText(stateFile));
      int x = Convert.ToInt32(d["x"], CultureInfo.InvariantCulture);
      int y = Convert.ToInt32(d["y"], CultureInfo.InvariantCulture);
      int w = Convert.ToInt32(d["w"], CultureInfo.InvariantCulture);
      int h = Convert.ToInt32(d["h"], CultureInfo.InvariantCulture);
      bool max = d.ContainsKey("max") && Convert.ToBoolean(d["max"], CultureInfo.InvariantCulture);
      if (w < MinimumSize.Width || h < MinimumSize.Height) return;
      var wanted = new Rectangle(x, y, w, h);
      // IT MUST LAND SOMEWHERE A PERSON CAN SEE. Any real intersection with an
      // attached screen is enough; otherwise the centred default stands.
      bool visible = false;
      foreach (Screen sc in Screen.AllScreens) {
        var hit = Rectangle.Intersect(sc.WorkingArea, wanted);
        if (hit.Width >= 200 && hit.Height >= 120) { visible = true; break; }
      }
      if (!visible) return;
      Size = new Size(w, h);
      Location = new Point(x, y);
      if (max) WindowState = FormWindowState.Maximized;
    } catch { /* an unreadable window state is simply the default one */ }
  }

  void SaveWindow() {
    try {
      var r = WindowState == FormWindowState.Normal ? new Rectangle(Location, Size) : RestoreBounds;
      var d = new Dictionary<string, object>();
      d["x"] = r.X; d["y"] = r.Y; d["w"] = r.Width; d["h"] = r.Height;
      d["max"] = WindowState == FormWindowState.Maximized;
      Directory.CreateDirectory(Path.GetDirectoryName(stateFile));
      File.WriteAllText(stateFile, new JavaScriptSerializer().Serialize(d));
    } catch { /* failing to remember the window must never stop it closing */ }
  }

  /**
   * THE TRAY — LAIN's intelligence health and quota (Phase 8.3).
   *
   * HOVER shows the provider/account quota summary Core sends (fabric/tray.js):
   * only windows a provider reported. CLICK opens a compact panel — those lines,
   * then Open LAIN · Models & Accounts · Usage · Active Tasks · Pause/Continue
   * task · Exit. A tray menu is not a dashboard: everything else is one click
   * away in the application.
   *
   * THE HOST NEVER ASKS FOR ANY OF THIS. Core pushes the summary when it changes
   * (a receipt, an account change, a fallback, a known reset); the host only
   * draws it — no timer here, no polling, nothing at idle.
   */
  List<string> trayLines = new List<string>();
  string trayNote = null;
  string trayWork = null;
  IntPtr trayIconHandle = IntPtr.Zero;

  [System.Runtime.InteropServices.DllImport("user32.dll")]
  static extern bool DestroyIcon(IntPtr handle);

  void BuildTray() {
    tray = new NotifyIcon();
    tray.Icon = TrayIcon();
    tray.Text = "LAIN";
    tray.Visible = true;
    RebuildTrayMenu();
    tray.DoubleClick += (s, e) => ShowWindow();
    // A LEFT CLICK opens the same compact panel a right click does.
    tray.MouseUp += (s, e) => {
      if (e.Button != MouseButtons.Left) return;
      try {
        var show = typeof(NotifyIcon).GetMethod("ShowContextMenu", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
        if (show != null) show.Invoke(tray, null);
      } catch { /* the right-click menu still works */ }
    };
    tray.BalloonTipClicked += (s, e) => RemindClicked();
  }

  void RebuildTrayMenu() {
    if (tray == null) return;
    var menu = new ContextMenuStrip();
    // THE QUOTA LINES (the first is the "LAIN" title — the menu does not repeat it).
    for (int i = 1; i < trayLines.Count && i < 24; i++) {
      var line = new ToolStripMenuItem(trayLines[i]);
      line.Enabled = false;
      menu.Items.Add(line);
    }
    if (!String.IsNullOrEmpty(trayNote)) { var n = new ToolStripMenuItem(trayNote); n.Enabled = false; menu.Items.Add(n); }
    if (menu.Items.Count > 0) menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Open LAIN", null, (s, e) => ShowWindow());
    menu.Items.Add("Models & Accounts", null, (s, e) => ShowAt("model", "accts"));
    menu.Items.Add("Usage", null, (s, e) => ShowAt("usage", null));
    menu.Items.Add("Active Tasks", null, (s, e) => ShowAt("chat", null));
    if (trayWork == "running") menu.Items.Add("Pause task", null, (s, e) => CorePost("/api/interrupt"));
    else if (trayWork == "paused") menu.Items.Add("Continue task", null, (s, e) => CorePost("/api/workbench/continue"));
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Exit LAIN", null, (s, e) => QuitLain());
    var old = tray.ContextMenuStrip;
    tray.ContextMenuStrip = menu;
    if (old != null) old.Dispose();
  }

  /** Core's summary: { tooltip, lines[], active: { percent (used), remaining, limited }, note, task }. */
  void TrayUpdate(string json) {
    if (tray == null) return;
    Dictionary<string, object> m = null;
    try { m = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>; } catch { m = null; }
    if (m == null) return;
    var lines = new List<string>();
    var raw = m.ContainsKey("lines") ? m["lines"] as System.Collections.IEnumerable : null;
    if (raw != null) foreach (var l in raw) lines.Add(Convert.ToString(l, CultureInfo.InvariantCulture));
    trayLines = lines;
    trayNote = m.ContainsKey("note") && m["note"] != null ? Convert.ToString(m["note"], CultureInfo.InvariantCulture) : null;
    trayWork = m.ContainsKey("task") && m["task"] != null ? Convert.ToString(m["task"], CultureInfo.InvariantCulture) : null;
    SetTrayText(m.ContainsKey("tooltip") ? Convert.ToString(m["tooltip"], CultureInfo.InvariantCulture) : "LAIN");
    int pct = -1; bool limited = false;
    var act = m.ContainsKey("active") ? m["active"] as Dictionary<string, object> : null;
    if (act != null) {
      // WHAT REMAINS is what the icon draws (Core sends it; an older summary sends only what was used).
      try { pct = act.ContainsKey("remaining") ? Convert.ToInt32(act["remaining"], CultureInfo.InvariantCulture) : 100 - Convert.ToInt32(act["percent"], CultureInfo.InvariantCulture); } catch { pct = -1; }
      try { limited = act.ContainsKey("limited") && Convert.ToBoolean(act["limited"], CultureInfo.InvariantCulture); } catch { limited = false; }
    }
    SetTrayIcon(pct, limited);
    RebuildTrayMenu();
  }

  /** Windows shows up to 127 tooltip characters; NotifyIcon.Text accepts 63, so the field is set directly. */
  void SetTrayText(string text) {
    if (String.IsNullOrEmpty(text)) text = "LAIN";
    if (text.Length > 127) text = text.Substring(0, 127);
    try {
      var t = typeof(NotifyIcon);
      var hidden = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
      t.GetField("text", hidden).SetValue(tray, text);
      if ((bool)t.GetField("added", hidden).GetValue(tray)) t.GetMethod("UpdateIcon", hidden).Invoke(tray, new object[] { true });
    } catch {
      try { tray.Text = text.Length > 63 ? text.Substring(0, 63) : text; } catch { /* keep the old text */ }
    }
  }

  /**
   * THE ICON CARRIES ONE FACT: how much of the active account's tightest
   * reported window REMAINS — a thin bar along the bottom (green; amber at 20 %
   * or less; red at 5 % or less, or when limited). A full bar is a full window
   * still available; 100 % remaining is never red. No figure is drawn: at 16 px
   * digits are unreadable. With nothing reported, the plain icon.
   */
  void SetTrayIcon(int pct, bool limited) {
    if (pct < 0 && !limited) {
      if (trayIconHandle != IntPtr.Zero) { tray.Icon = TrayIcon(); DestroyIcon(trayIconHandle); trayIconHandle = IntPtr.Zero; }
      return;
    }
    try {
      int size = Math.Max(16, SystemInformation.SmallIconSize.Width);
      using (var bmp = new Bitmap(size, size))
      using (var g = Graphics.FromImage(bmp)) {
        g.Clear(Color.Transparent);
        using (var baseIcon = new Icon(TrayIcon(), size, size)) g.DrawIcon(baseIcon, new Rectangle(0, 0, size, size));
        int h = Math.Max(3, size / 5);
        int p = Math.Min(100, Math.Max(0, pct));
        // A LIMITED account is an alert, not a reading: a full red bar.
        int w = limited ? size - 2 : Math.Max(1, (int)Math.Round((size - 2) * p / 100.0));
        Color c = limited || p <= 5 ? Color.FromArgb(220, 64, 64) : p <= 20 ? Color.FromArgb(230, 170, 40) : Color.FromArgb(60, 180, 110);
        using (var back = new SolidBrush(Color.FromArgb(210, 24, 24, 24))) g.FillRectangle(back, 0, size - h, size, h);
        using (var fill = new SolidBrush(c)) g.FillRectangle(fill, 1, size - h + 1, w, h - 2);
        IntPtr handle = bmp.GetHicon();
        IntPtr old = trayIconHandle;
        tray.Icon = Icon.FromHandle(handle);
        trayIconHandle = handle;
        if (old != IntPtr.Zero) DestroyIcon(old);
      }
    } catch { /* the plain icon stays */ }
  }

  /** Open the window at a surface — the same navigation message a clicked reminder sends. */
  void ShowAt(string tab, string section) {
    ShowWindow();
    var nav = new Dictionary<string, object>();
    nav["tab"] = tab;
    if (section != null) nav["section"] = section;
    var msg = new Dictionary<string, object>();
    msg["nav"] = nav;
    ToRenderer(new JavaScriptSerializer().Serialize(msg));
  }

  /** One of Core's own routes, asked for from the tray — Core decides what it means. */
  void CorePost(string path) {
    var msg = new Dictionary<string, object>();
    msg["id"] = 0;
    msg["method"] = "POST";
    msg["path"] = path;
    msg["body"] = new Dictionary<string, object>();
    core.Send(new JavaScriptSerializer().Serialize(msg));
  }

  /**
   * THE ICON. The executable's own, when it has one, and the system application
   * icon when it does not — never nothing: a tray entry with no icon is a blank
   * gap a person cannot find again, which would strand a hidden LAIN.
   */
  static Icon TrayIcon() {
    try {
      var own = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
      if (own != null) return own;
    } catch { /* fall through to the system icon */ }
    return SystemIcons.Application;
  }

  void ShowWindow() {
    Show();
    if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
    Activate();
    BringToFront();
  }


  /**
   * QUIT — the explicit one, and the only thing here that ends anything.
   *
   * It tells CORE to shut down rather than tearing this process down: Core owns
   * the gateway, the jobs, the child processes and the browsers, and only its
   * own sequence stops all of them (src/teardown.js). Core then closes this
   * host. If Core cannot be reached, the window closes anyway — a tray icon for
   * something that is already gone is worse than no tray icon.
   */
  void QuitLain() {
    if (MessageBox.Show(
          "Exit LAIN? Bots, background jobs and any work in progress will stop.",
          "Exit LAIN", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
    quitting = true;
    var msg = new Dictionary<string, object>();
    msg["id"] = 0;
    msg["method"] = "POST";
    msg["path"] = "/api/desktop/quit";
    msg["body"] = new Dictionary<string, object>();
    core.Send(new JavaScriptSerializer().Serialize(msg));
    // Core closes this host as part of its shutdown. This is the backstop for a
    // Core that is already gone, and it is bounded rather than immediate so an
    // ordinary quit ends the ordinary way.
    // System.Windows.Forms.Timer by name: `Timer` alone is ambiguous with
    // System.Threading.Timer, and only the Forms one ticks on the UI thread.
    var t = new System.Windows.Forms.Timer();
    t.Interval = 4000;
    t.Tick += (s, e) => { t.Stop(); Application.Exit(); };
    t.Start();
  }

  /**
   * CLOSING THE WINDOW.
   *
   * A user close HIDES. Everything else — Windows shutting down, Core closing
   * this host, `Application.Exit` — really closes, because in those cases
   * something else has already decided.
   */
  void OnClosing(object sender, FormClosingEventArgs e) {
    SaveWindow();
    if (e.CloseReason == CloseReason.UserClosing && !quitting && mode == null) {
      e.Cancel = true;
      Hide();
      return;
    }
    if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
    core.Stop();
  }
}

/**
 * THE SYSTEM FOLDER PICKER — the one Explorer shows, not a tree in a box.
 *
 * The modern dialog (IFileOpenDialog with FOS_PICKFOLDERS) is what every
 * Windows application uses to choose a folder; the .NET Framework's
 * FolderBrowserDialog is the old tree-only one. The modern one is tried first
 * and the old one is the fallback, so a picker always appears.
 *
 * Returns the chosen folder's full path, or null when the person cancelled.
 */
/**
 * A SECOND WINDOW ON THE SAME CORE (Phase 8.1) — the detached preview.
 *
 * It shows LAIN's own page in a mode (#detached-preview) that draws only the
 * preview, the picker and "Say something to change". It holds its OWN pipe
 * connection to the same Core, so every request goes through the same routes
 * and every state broadcast reaches it: one session, one Selection, one dev
 * server. It has no tray and no verbs beyond the two a preview needs.
 */
class Satellite : Form {
  readonly WebView2 view = new WebView2();
  readonly Core core;
  readonly Args args;
  readonly CoreWebView2Environment env;
  readonly string start;
  bool ready;

  public Satellite(Args a, CoreWebView2Environment e, string title, string url) {
    args = a; env = e; start = url;
    core = new Core(a.Get("pipe"), a.Get("secret"));
    Text = title;
    MinimumSize = new Size(560, 420);
    Size = new Size(1180, 820);
    BackColor = Color.FromArgb(11, 13, 16);
    StartPosition = FormStartPosition.WindowsDefaultLocation;
    view.Dock = DockStyle.Fill;
    Controls.Add(view);
    core.Message += line => { try { BeginInvoke((Action)(() => FromCore(line))); } catch { } };
    Load += async (s, ev) => await Boot();
    FormClosed += (s, ev) => { core.Stop(); };
  }

  async Task Boot() {
    try { await view.EnsureCoreWebView2Async(env); } catch { Close(); return; }
    var w = view.CoreWebView2;
    var s = w.Settings;
    bool dev = args.Has("dev");
    s.AreDefaultContextMenusEnabled = dev;
    s.AreDevToolsEnabled = dev;
    s.IsStatusBarEnabled = false;
    s.AreBrowserAcceleratorKeysEnabled = dev;
    s.IsZoomControlEnabled = false;
    s.IsSwipeNavigationEnabled = false;
    var assets = args.Get("assets");
    if (assets != null && Directory.Exists(assets)) w.SetVirtualHostNameToFolderMapping("lain.app", assets, CoreWebView2HostResourceAccessKind.Allow);
    w.WebMessageReceived += (o, e) => {
      string json; try { json = e.WebMessageAsJson; } catch { return; }
      Dictionary<string, object> m = null;
      try { m = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>; } catch { m = null; }
      if (m != null && m.ContainsKey("host") && m.ContainsKey("id")) { Verb(m); return; }
      core.Send(json);
    };
    w.NewWindowRequested += (o, e) => { e.Handled = true; };
    w.NavigationStarting += (o, e) => {
      var uri = e.Uri ?? "";
      if (uri.StartsWith("https://lain.app/", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return;
      e.Cancel = true;
    };
    core.Start();
    view.Source = new Uri(start);
    ready = true;
  }

  void Verb(Dictionary<string, object> m) {
    string ask = Convert.ToString(m["host"], CultureInfo.InvariantCulture);
    var body = new Dictionary<string, object>();
    body["host"] = ask;
    if (ask == "close") { body["ok"] = true; BeginInvoke((Action)(() => Close())); }
    else if (ask == "zoom") {
      double f = 1.0;
      try { f = Convert.ToDouble(m["factor"], CultureInfo.InvariantCulture); } catch { f = 1.0; }
      view.ZoomFactor = Math.Max(0.5, Math.Min(3.0, f));
      body["ok"] = true;
    } else { body["ok"] = false; body["why"] = "the preview window does not offer " + ask; }
    var rep = new Dictionary<string, object>();
    rep["id"] = m["id"];
    rep["body"] = body;
    ToRenderer(new JavaScriptSerializer().Serialize(rep));
  }

  void FromCore(string line) {
    // A HOST VERB FROM CORE (show, quit) is the main window's business, not the preview's.
    try {
      var o = new JavaScriptSerializer().DeserializeObject(line) as Dictionary<string, object>;
      if (o != null && o.ContainsKey("host")) return;
    } catch { }
    ToRenderer(line);
  }

  void ToRenderer(string json) {
    if (!ready || view.CoreWebView2 == null) return;
    try { view.CoreWebView2.PostWebMessageAsJson(json); } catch { }
  }
}

static class FolderPicker {
  [System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialogCom { }

  [System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
   System.Runtime.InteropServices.InterfaceType(System.Runtime.InteropServices.ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [System.Runtime.InteropServices.PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string pszName);
    void GetFileName([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }

  [System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
   System.Runtime.InteropServices.InterfaceType(System.Runtime.InteropServices.ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;
  const int ERROR_CANCELLED = unchecked((int)0x800704C7);

  public static string Pick(IWin32Window owner, string title) {
    try {
      var dlg = (IFileDialog)new FileOpenDialogCom();
      try {
        uint opts;
        dlg.GetOptions(out opts);
        dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        dlg.SetTitle(title);
        dlg.SetOkButtonLabel("Select Folder");
        int hr = dlg.Show(owner == null ? IntPtr.Zero : owner.Handle);
        if (hr == ERROR_CANCELLED) return null;
        if (hr != 0) throw new System.Runtime.InteropServices.COMException("the folder dialog failed", hr);
        IShellItem item;
        dlg.GetResult(out item);
        string path;
        item.GetDisplayName(SIGDN_FILESYSPATH, out path);
        return String.IsNullOrEmpty(path) ? null : path;
      } finally {
        System.Runtime.InteropServices.Marshal.ReleaseComObject(dlg);
      }
    } catch {
      using (var old = new FolderBrowserDialog()) {
        old.Description = title;
        old.ShowNewFolderButton = true;
        return old.ShowDialog(owner) == DialogResult.OK ? old.SelectedPath : null;
      }
    }
  }
}

/**
 * THE PRIVATE CHANNEL TO CORE.
 *
 * A named pipe, a secret proven once, newline-delimited JSON. It reconnects on
 * its own with a bounded backoff, because LAIN Core restarting is an ordinary
 * event — a person running `lain` again — and the application should recover
 * from it rather than needing to be closed and reopened.
 */
class Core {
  readonly string pipe;
  readonly string secret;
  NamedPipeClientStream stream;
  StreamWriter writer;
  Thread reader;
  volatile bool stopping;
  readonly object gate = new object();

  public event Action Connected;
  public event Action<string> Lost;
  public event Action<string> Message;

  public Core(string pipeName, string sharedSecret) {
    // `\\.\pipe\name` from the parent; the client API wants the name alone.
    pipe = (pipeName ?? "").Replace("\\\\.\\pipe\\", "");
    secret = sharedSecret ?? "";
  }

  public void Start() {
    reader = new Thread(Loop);
    reader.IsBackground = true;
    reader.Start();
  }

  void Loop() {
    int wait = 250;
    while (!stopping) {
      try {
        var s = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.Asynchronous);
        s.Connect(3000);
        var w = new StreamWriter(s, new UTF8Encoding(false));
        w.AutoFlush = true;
        w.Write("{\"id\":0,\"secret\":\"" + secret + "\"}\n");
        lock (gate) { stream = s; writer = w; }
        wait = 250;
        var handler = Connected;
        if (handler != null) handler();

        var r = new StreamReader(s, new UTF8Encoding(false));
        string line;
        while ((line = r.ReadLine()) != null) {
          if (line.Length == 0) continue;
          var m = Message;
          if (m != null) m(line);
        }
      } catch (Exception ex) {
        var l = Lost;
        if (l != null && !stopping) l(ex.Message);
      } finally {
        lock (gate) { stream = null; writer = null; }
      }
      if (stopping) break;
      Thread.Sleep(wait);
      wait = Math.Min(wait * 2, 5000);      // bounded: it never hammers, never gives up
    }
  }

  /** Is the channel up right now? Read by the tray's Status item. */
  public bool Live { get { lock (gate) { return writer != null; } } }

  public void Send(string json) {
    StreamWriter w;
    lock (gate) { w = writer; }
    if (w == null) return;
    try { w.Write(json + "\n"); } catch { /* the reconnect loop owns recovery */ }
  }

  public void Stop() {
    stopping = true;
    try { lock (gate) { if (stream != null) stream.Dispose(); } } catch { }
  }
}
