// LAIN DESKTOP — the native application host.
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
      Launcher.Start();
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
  public static void Start() {
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
      psi.Arguments = "\"" + entry + "\" --desktop";
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

  public Shell(Args a) {
    args = a;
    core = new Core(a.Get("pipe"), a.Get("secret"));
    stateFile = a.Get("window-state") ?? Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".lain-v2", "desktop-window.json");

    Text = "LAIN";
    MinimumSize = new Size(880, 560);
    BackColor = Color.FromArgb(11, 13, 16);
    AllowDrop = true;
    StartPosition = FormStartPosition.Manual;
    RestoreWindow();

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
    BuildTray();

    core.Connected += () => BeginInvoke((Action)(() => Banner(null)));
    core.Lost += why => BeginInvoke((Action)(() => Banner("LAIN Core is not responding — reconnecting. " + why)));
    core.Message += line => BeginInvoke((Action)(() => FromCore(line)));

    HandleCreated += (s, e) => Caption.Dark(Handle);
    Load += async (s, e) => await Boot();
  }

  void Banner(string text) {
    if (String.IsNullOrEmpty(text)) { status.Visible = false; return; }
    status.Text = text;
    status.Visible = true;
  }

  async Task Boot() {
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
      string home = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".lain-v2", "desktop");
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
    var browserArgs = "--disable-features=msSmartScreenProtection";
    var debugPort = args.Get("debug-port");
    if (args.Has("dev") && !String.IsNullOrEmpty(debugPort)) {
      browserArgs += " --remote-debugging-port=" + debugPort;
    }
    var opts = new CoreWebView2EnvironmentOptions(browserArgs);
    CoreWebView2Environment env;
    try {
      env = await CoreWebView2Environment.CreateAsync(null, userData, opts);
      await view.EnsureCoreWebView2Async(env);
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
        headline = "LAIN Desktop could not open a second window with different settings.";
        advice = "Another LAIN Desktop window is already using this renderer profile."
          + "\r\n\r\nQuit LAIN from the tray and open it again.";
      } else if (hr == unchecked((int)0x80004005) || ex is DllNotFoundException) {
        headline = "LAIN Desktop needs the Microsoft Edge WebView2 runtime, which is part of Windows.";
        advice = "Install the WebView2 runtime from Microsoft, then open LAIN again.";
      } else {
        headline = "LAIN Desktop could not start its renderer.";
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

    core.Start();

    var start = args.Get("url") ?? "https://lain.app/index.html";
    view.Source = new Uri(start);
    ready = true;
  }

  static void OpenExternally(string uri) {
    if (String.IsNullOrEmpty(uri)) return;
    if (!uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
      && !uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return;
    try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
  }

  /**
   * A REQUEST FROM THE UI. It is forwarded verbatim and answered verbatim; the
   * host does not interpret routes, does not keep a whitelist of its own, and
   * does not add anything the page did not ask for. Core decides.
   */
  void OnRendererMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
    string json;
    try { json = e.WebMessageAsJson; } catch { return; }
    core.Send(json);
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
   * THE TRAY ICON AND ITS MENU.
   *
   * DELIBERATELY THREE ITEMS. A tray menu is not a dashboard: it is the handful
   * of things a person wants when LAIN has no window on screen — bring it back,
   * check it is alive, end it. Everything else is in the application, which is
   * one click away.
   *
   * The two session items are there because "start a new conversation" is the
   * one action worth having before the window is even up; they open the window
   * and ask Core for the session, so the window and the tray cannot end up with
   * two different ideas of what a new session is.
   */
  void BuildTray() {
    var menu = new ContextMenuStrip();
    menu.Items.Add("Open LAIN", null, (s, e) => ShowWindow());
    menu.Items.Add("New Chat / Coding session", null, (s, e) => NewSession("engineering"));
    menu.Items.Add("New Cowork session", null, (s, e) => NewSession("cowork"));
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Status", null, (s, e) => ShowStatus());
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Quit LAIN", null, (s, e) => QuitLain());

    tray = new NotifyIcon();
    tray.Icon = TrayIcon();
    tray.Text = "LAIN";
    tray.Visible = true;
    tray.ContextMenuStrip = menu;
    tray.DoubleClick += (s, e) => ShowWindow();
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

  /** A new conversation, asked for from the tray. Core decides what that means. */
  void NewSession(string lane) {
    ShowWindow();
    var body = new Dictionary<string, object>();
    body["lane"] = lane;
    var msg = new Dictionary<string, object>();
    msg["id"] = 0;
    msg["method"] = "POST";
    msg["path"] = "/api/session/new";
    msg["body"] = body;
    core.Send(new JavaScriptSerializer().Serialize(msg));
  }

  void ShowStatus() {
    MessageBox.Show(
      (core.Live ? "Connected to LAIN Core." : "LAIN Core is not responding.")
        + Environment.NewLine + Environment.NewLine
        + "Closing the window keeps LAIN running so bots and background work carry on."
        + Environment.NewLine + "Quit LAIN from this menu to end it.",
      "LAIN", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
          "Quit LAIN? Bots, background jobs and any work in progress will stop.",
          "Quit LAIN", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
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
    if (e.CloseReason == CloseReason.UserClosing && !quitting) {
      e.Cancel = true;
      Hide();
      return;
    }
    if (tray != null) { tray.Visible = false; tray.Dispose(); tray = null; }
    core.Stop();
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
