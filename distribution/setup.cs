// LAIN SETUP — the installer, the maintenance program (modify / repair) and the uninstaller, as one program.
// ---------------------------------------------------------------------------
// WHY C# COMPILED BY csc.exe. LAIN builds with `node` and the csc.exe that is part of Windows: no installer
// framework is a prerequisite of the product. The payload rides inside this file as an embedded resource.
// ---------------------------------------------------------------------------
// WHAT GOES WHERE (per user, no administrator):
//   %LOCALAPPDATA%\Programs\LAIN\                     the PROGRAM
//       lain.exe                console launcher (CLI) — distribution/launcher.cs
//       lainw.exe               the same launcher without a console (Model Dashboard, Preview, Open With)
//       LAIN Harness.exe        the Harness launcher            [LAIN Harness component]
//       Uninstall LAIN.exe      this program, for maintenance
//       noema.cmd               the compatibility `noema` command: a shim onto lain.exe (LAIN_VIA=noema)
//       versions\<v>\runtime\    Node.js (official build, SHA-256 verified at release build) + its licence
//       versions\<v>\app\        LAIN
//       current / previous       which version runs / the last known-good one (updates switch these)
//       components.json          what is installed
//   %USERPROFILE%\.lain\                               the person's DATA (never touched by uninstall unless asked)
//   Windows DPAPI                                       credentials (referenced from the data directory)
// ---------------------------------------------------------------------------
// COMPONENTS: LAIN CLI (Core, CLI, Model Dashboard, Preview window) is the base and always installed.
// LAIN Harness is optional and can be added later (--add-harness / Modify) without touching Core state.
// ---------------------------------------------------------------------------
// THE RENAME BACK TO LAIN (2026-10-02). Two older things share names with this one and are told apart by LAYOUT:
//   * the OBSOLETE pre-cleanup LAIN (LAIN.exe without versions\ or components.json, C:\Program Files\LAIN, the
//     Installed-apps key "LAIN", Start Menu\LAIN.lnk) — its executables are replaced, never kept or restored; its
//     entries are retired by `lain legacy cleanup` (src/legacycleanup.js). This install's key is "LAIN.Install".
//   * a NOEMA-ERA install (%LOCALAPPDATA%\Programs\Noema, key "Noema") — upgraded: its choices carry over, then its
//     program folder, Start Menu folder, PATH entry and key are retired (Retire.Noema). Data is never touched here;
//     the first `lain` run moves ~/.noema to ~/.lain and leaves a junction (src/home.js).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

static class Setup {
  public const string PRODUCT = "LAIN";
  public const string PUBLISHER = "LAIN";
  // NOT "…\Uninstall\LAIN": that key is the obsolete pre-cleanup LAIN's, and legacy cleanup removes it.
  public const string REG_KEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\LAIN.Install";
  public const string NOEMA_KEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Noema";

  public class Options {
    public string Dir; public bool Silent; public bool Harness; public bool Path = true; public bool OpenWith = true; public bool Folder = true;
    public bool StartMenu = true; public bool Uninstall; public bool RemoveData; public bool Repair; public bool AddHarness; public bool RemoveHarness;
    public bool NoRegister; public bool? HarnessExplicit; public bool IntegrationExplicit; public string Log;
  }

  [STAThread]
  static int Main(string[] argv) {
    var o = new Options();
    for (int i = 0; i < argv.Length; i++) {
      string a = argv[i];
      if (a == "--silent" || a == "/S" || a == "--quiet") o.Silent = true;
      else if (a == "--dir" && i + 1 < argv.Length) o.Dir = argv[++i];
      else if (a == "--harness") { o.Harness = true; o.HarnessExplicit = true; }
      else if (a == "--cli-only" || a == "--no-harness") { o.Harness = false; o.HarnessExplicit = false; }
      else if (a == "--no-path") { o.Path = false; o.IntegrationExplicit = true; }
      else if (a == "--no-open-with") { o.OpenWith = false; o.IntegrationExplicit = true; }
      else if (a == "--no-open-folder") { o.Folder = false; o.IntegrationExplicit = true; }
      else if (a == "--no-start-menu") { o.StartMenu = false; o.IntegrationExplicit = true; }
      else if (a == "--no-register") o.NoRegister = true;   // tests: no Add/Remove Programs entry
      else if (a == "--log" && i + 1 < argv.Length) o.Log = argv[++i];   // a silent run's lines, for scripts and tests
      else if (a == "--uninstall") o.Uninstall = true;
      else if (a == "--remove-data") o.RemoveData = true;
      else if (a == "--repair") o.Repair = true;
      else if (a == "--add-harness") o.AddHarness = true;
      else if (a == "--remove-harness") o.RemoveHarness = true;
      else if (a == "--version") { Console.WriteLine("LAIN Setup " + PayloadInfo.Version()); return 0; }
    }
    Application.EnableVisualStyles();
    string installed = InstalledAt();
    if (o.Dir == null) o.Dir = installed ?? DefaultDir();
    Action<string> console = s => { Console.WriteLine(s); if (o.Log != null) { try { File.AppendAllText(o.Log, s + Environment.NewLine); } catch { } } };
    if (o.Uninstall) return Uninstaller.Run(o, o.Silent ? console : null);
    if (o.AddHarness || o.RemoveHarness) return Installer.SetHarness(o, o.AddHarness, console);
    if (o.Silent) {
      // A REINSTALL, REPAIR OR UPGRADE OF THIS FOLDER keeps what was chosen before unless told otherwise.
      // …and an UPGRADE FROM NOEMA keeps what was chosen for the Noema install.
      string from = File.Exists(Path.Combine(o.Dir, "components.json")) ? o.Dir : (installed == null ? Setup.NoemaAt() : null);
      if (from != null) {
        var prior = Components.Read(from);
        if (o.HarnessExplicit == null) o.Harness = prior.Harness;
        if (!o.IntegrationExplicit) { o.Path = prior.Path; o.OpenWith = prior.OpenWith; o.Folder = prior.Folder; o.StartMenu = prior.StartMenu; }
        if (!prior.Registered) o.NoRegister = true;
      }
      return Installer.Run(o, console);
    }
    Application.Run(new Wizard(o, installed));
    return Wizard.ExitCode;
  }

  public static string DefaultDir() {
    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", PRODUCT);
  }

  public static string InstalledAt() {
    try {
      using (RegistryKey k = Registry.CurrentUser.OpenSubKey(REG_KEY)) {
        if (k != null) { string p = k.GetValue("InstallLocation") as string; if (!string.IsNullOrEmpty(p) && File.Exists(Path.Combine(p, "lain.exe"))) return p; }
      }
    } catch { }
    return null;
  }

  /// A Noema-era install of this user (its program folder), or null.
  public static string NoemaAt() {
    try {
      using (RegistryKey k = Registry.CurrentUser.OpenSubKey(NOEMA_KEY)) {
        if (k != null) { string p = k.GetValue("InstallLocation") as string; if (!string.IsNullOrEmpty(p) && File.Exists(Path.Combine(p, "noema.exe"))) return p; }
      }
    } catch { }
    string d = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Noema");
    return File.Exists(Path.Combine(d, "noema.exe")) && File.Exists(Path.Combine(d, "components.json")) ? d : null;
  }

  /// The data directory: an override, else ~/.lain — or, before the first `lain` run has moved it, ~/.noema.
  public static string DataDir() {
    string o = Environment.GetEnvironmentVariable("LAIN_CONFIG_DIR") ?? Environment.GetEnvironmentVariable("LAIN_HOME")
      ?? Environment.GetEnvironmentVariable("NOEMA_CONFIG_DIR") ?? Environment.GetEnvironmentVariable("NOEMA_HOME");
    if (!string.IsNullOrEmpty(o)) return o;
    string up = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    string lain = Path.Combine(up, ".lain"), noema = Path.Combine(up, ".noema");
    if (!Directory.Exists(lain) && Directory.Exists(noema) && (new DirectoryInfo(noema).Attributes & FileAttributes.ReparsePoint) == 0) return noema;
    return lain;
  }
}

/// What the embedded payload is: payload.zip + payload.json ({ "version": "0.1.0", "channel": "stable", ... }).
static class PayloadInfo {
  static string info;
  static string Json() {
    if (info != null) return info;
    using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.json")) {
      if (s == null) return info = "{}";
      using (var r = new StreamReader(s)) return info = r.ReadToEnd();
    }
  }
  public static string Field(string name) {
    string j = Json(); int i = j.IndexOf("\"" + name + "\""); if (i < 0) return null;
    int a = j.IndexOf('"', j.IndexOf(':', i)) + 1; int b = j.IndexOf('"', a);
    return a > 0 && b > a ? j.Substring(a, b - a) : null;
  }
  public static string Version() { return Field("version") ?? "0.0.0"; }
  public static string Channel() { return Field("channel") ?? "stable"; }
}

/// components.json in the install root — the one record of what is installed and which integrations were added.
/// It is also what uninstall and a reinstall UNDO: only what this install recorded is ever removed from the system.
class Components {
  public bool Harness; public bool Path; public bool OpenWith; public bool Folder; public bool StartMenu; public bool Registered;
  public static Components Read(string dir) {
    var c = new Components();
    try {
      string j = File.ReadAllText(System.IO.Path.Combine(dir, "components.json"));
      c.Harness = j.Contains("\"harness\": true"); c.Path = j.Contains("\"path\": true"); c.OpenWith = j.Contains("\"openWith\": true");
      c.Folder = j.Contains("\"openFolder\": true"); c.StartMenu = j.Contains("\"startMenu\": true"); c.Registered = j.Contains("\"registered\": true");
    } catch { }
    return c;
  }
  public void Write(string dir) {
    File.WriteAllText(System.IO.Path.Combine(dir, "components.json"),
      "{\n  \"cli\": true,\n  \"harness\": " + (Harness ? "true" : "false") + ",\n  \"path\": " + (Path ? "true" : "false")
      + ",\n  \"openWith\": " + (OpenWith ? "true" : "false") + ",\n  \"openFolder\": " + (Folder ? "true" : "false")
      + ",\n  \"startMenu\": " + (StartMenu ? "true" : "false") + ",\n  \"registered\": " + (Registered ? "true" : "false") + "\n}\n");
  }
}

static class Installer {
  public static int Run(Setup.Options o, Action<string> log) {
    log = log ?? (s => { });
    string dir = o.Dir;
    string version = PayloadInfo.Version();
    log("LAIN " + version + " (" + PayloadInfo.Channel() + ") → " + dir);

    // 1. WEBVIEW2 — the Model Dashboard, the Preview window and the Harness draw with it. Part of Windows 11.
    if (!Prereq.WebView2(log)) return 2;

    // 2. A RUNNING LAIN (or a Noema-era one being upgraded) GOES DOWN ITS OWN WAY before any file it uses could change.
    Live.ShutDown(dir, log);
    string noema = Setup.NoemaAt();
    if (noema != null && !SameDir(noema, dir)) Live.ShutDown(noema, log);
    // THE OBSOLETE PRE-CLEANUP LAIN in this folder (its LAIN.exe, no versions\ / components.json) is replaced, not kept.
    bool obsolete = File.Exists(Path.Combine(dir, "lain.exe")) && !File.Exists(Path.Combine(dir, "components.json")) && !Directory.Exists(Path.Combine(dir, "versions"));
    if (obsolete) log("  replacing the obsolete pre-cleanup LAIN executables in " + dir);

    // 3. THE VERSION, SIDE BY SIDE. An upgrade adds a directory; the running files of the old one are never touched.
    string vdir = Path.Combine(dir, "versions", version);
    string previous = Pointer.Read(dir, "current");
    try {
      Directory.CreateDirectory(dir);
      if (Directory.Exists(vdir) && (o.Repair || previous != version)) { try { Directory.Delete(vdir, true); } catch (Exception e) { log("  (could not clear " + vdir + ": " + e.Message + ")"); } }
      if (!File.Exists(Path.Combine(vdir, "app", "bin", "lain.js"))) {
        using (Stream z = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
          if (z == null) { log("This installer has no payload."); return 4; }
          string tmp = Path.Combine(Path.GetTempPath(), "lain-payload-" + Guid.NewGuid().ToString("N") + ".zip");
          using (FileStream f = File.Create(tmp)) z.CopyTo(f);
          try { Zip.Extract(tmp, dir); } finally { try { File.Delete(tmp); } catch { } }
        }
      }
    } catch (Exception e) { log("Could not install the files: " + e.Message); return 5; }
    if (!File.Exists(Path.Combine(vdir, "runtime", "node.exe")) || !File.Exists(Path.Combine(vdir, "app", "bin", "lain.js"))) { log("The payload is incomplete (" + vdir + ")."); return 5; }

    // 4. THE POINTERS: previous keeps the last known-good version for rollback.
    if (previous != null && previous != version && Directory.Exists(Path.Combine(dir, "versions", previous))) Pointer.Write(dir, "previous", previous);
    Pointer.Write(dir, "current", version);
    try { File.Delete(Path.Combine(dir, "pending")); } catch { }

    // 5. LAUNCHERS (shipped in the payload root) and the uninstaller.
    if (!o.Harness) { try { File.Delete(Path.Combine(dir, "LAIN Harness.exe")); } catch { } }
    // lain.exe / lainw.exe came from THIS payload (Zip.Extract overwrote any obsolete ones). What no current build
    // ships goes: the obsolete supervisor beside the launchers, and — over a folder that held Noema — its launchers
    // and its `lain.cmd` shim (which pointed at noema.exe). `noema` stays a COMMAND: a shim onto the same lain.exe —
    // same Core, same home, same pipe.
    foreach (string old in new[] { "lain-supervisor.exe", "noema.exe", "noemaw.exe", "Noema Harness.exe", "Uninstall Noema.exe", "lain.cmd" }) {
      string p = Path.Combine(dir, old);
      if (File.Exists(p)) { try { File.Delete(p); log("  removed the obsolete " + old); } catch (Exception e) { try { File.Move(p, p + ".delete-me"); } catch { log("  (could not remove " + old + ": " + e.Message + ")"); } } }
    }
    try { File.WriteAllText(Path.Combine(dir, "noema.cmd"), NoemaShim); } catch (Exception e) { log("  (the noema command was not written: " + e.Message + ")"); }
    try { File.Copy(Assembly.GetExecutingAssembly().Location, Path.Combine(dir, "Uninstall LAIN.exe"), true); } catch (Exception e) { log("  (no maintenance program was written: " + e.Message + ")"); }
    var prior = Components.Read(dir);
    var c = new Components { Harness = o.Harness, Path = o.Path, OpenWith = o.OpenWith, Folder = o.Folder, StartMenu = o.StartMenu, Registered = !o.NoRegister || prior.Registered };
    c.Write(dir);

    // 6. INTEGRATION — each one optional, each one undone by uninstall, none changing a default application.
    Integrate(dir, c, prior, log);

    // 7. ADD/REMOVE PROGRAMS
    if (c.Registered) Register(dir, version, c, log);

    // 8. VERIFIED, NOT ASSUMED: the installed CLI must answer.
    string said = Run(Path.Combine(dir, "lain.exe"), "--version", dir);
    bool ok = said != null && said.Contains("LAIN") && said.Contains(version);
    log(ok ? "Verified: " + said.Trim() : "The installed CLI did not answer as expected: " + (said ?? "no output"));
    if (!ok) return 6;
    // 9. A NOEMA-ERA INSTALL IS RETIRED only now, with LAIN verified in its place.
    if (noema != null && !SameDir(noema, dir) && c.Registered) Retire.Noema(noema, log);
    log("");
    log("LAIN " + version + " is installed" + (o.Harness ? " with LAIN Harness" : " (CLI — LAIN Harness can be added later)") + ".");
    log("  lain                       the CLI" + (o.Path ? " (open a NEW terminal)" : " — " + Path.Combine(dir, "lain.exe")));
    if (o.Harness) log("  Start > LAIN Harness       the desktop environment");
    return 0;
  }

  /// THE `noema` SHIM. setlocal keeps the mark out of the calling console; boot.js prints the rename notice once.
  const string NoemaShim = "@echo off\r\nsetlocal\r\nset \"LAIN_VIA=noema\"\r\n\"%~dp0lain.exe\" %*\r\nexit /b %ERRORLEVEL%\r\n";

  public static bool SameDir(string a, string b) { try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); } catch { return false; } }

  /// ADD OR REMOVE THE HARNESS without reinstalling Core or touching the person's data.
  public static int SetHarness(Setup.Options o, bool on, Action<string> log) {
    string dir = o.Dir;
    if (!File.Exists(Path.Combine(dir, "lain.exe"))) { log("LAIN is not installed at " + dir); return 3; }
    var c = Components.Read(dir);
    var prior = Components.Read(dir);
    c.Harness = on;
    string src = Path.Combine(dir, "versions", Pointer.Read(dir, "current") ?? "", "app", "distribution", "LAIN Harness.exe");
    if (on) {
      try { File.Copy(src, Path.Combine(dir, "LAIN Harness.exe"), true); } catch (Exception e) { log("Could not add LAIN Harness: " + e.Message); return 5; }
    } else {
      Live.ShutDown(dir, log);
      try { File.Delete(Path.Combine(dir, "LAIN Harness.exe")); } catch { }
    }
    c.Write(dir);
    Integrate(dir, c, prior, log);
    if (c.Registered) Register(dir, Pointer.Read(dir, "current"), c, log);
    log(on ? "LAIN Harness added. Your sessions, accounts and settings are the same ones the CLI uses." : "LAIN Harness removed. The CLI and your data are unchanged.");
    return 0;
  }

  /// `prior` is what the last install of THIS folder added: only that is taken back before `c` is applied, so an
  /// install without Open With / Start Menu never touches another program's (or an older LAIN's) entries.
  public static void Integrate(string dir, Components c, Components prior, Action<string> log) {
    string cli = Path.Combine(dir, "lain.exe"), gui = Path.Combine(dir, "lainw.exe"), harness = Path.Combine(dir, "LAIN Harness.exe");
    // Open With / Open folder: the Harness when installed; otherwise a LAIN CLI in that folder.
    string opener = c.Harness && File.Exists(harness) ? harness : gui;
    if ((prior.OpenWith || prior.Folder) && !(c.OpenWith || c.Folder)) Assoc.Remove(dir, s => { });
    // Registering REPLACES the previous registration (winassoc.js removes the obsolete LAIN's and Noema's entries first).
    if (c.OpenWith || c.Folder) Assoc.Add(dir, opener, c.OpenWith, c.Folder, log);
    if (c.Path) PathEntry.Add(dir, log); else PathEntry.Remove(dir, s => { });
    if (prior.StartMenu || c.StartMenu) Shortcuts.RemoveAll(s => { });
    if (c.StartMenu) {
      Shortcuts.Write("LAIN CLI", cli, "", "The LAIN command line", log);
      Shortcuts.Write("LAIN Model Dashboard", gui, "dashboard", "Accounts, models, API keys and local models", log);
      if (c.Harness && File.Exists(harness)) Shortcuts.Write("LAIN Harness", harness, "", "The LAIN desktop environment", log);
      Shortcuts.Write("Uninstall LAIN", Path.Combine(dir, "Uninstall LAIN.exe"), "--uninstall", "Remove LAIN (your data is kept unless you choose otherwise)", log);
    }
    // START AT SIGN-IN made to match the person's setting — added with the Harness, gone without it, never opted in.
    // `--owned`: setup only ever takes away an entry that points into THIS folder.
    Assoc.Node(dir, "settings startup sync --owned" + (c.Registered ? "" : " --no-legacy"), log);
    // THE OBSOLETE LAIN'S LEFTOVERS (its Startup choice carried over, old LAIN.exe builds, Start Menu\\LAIN.lnk, the
    // "LAIN" key) are the machine's, so
    // only the registered install takes them over — an unregistered one is portable or a test.
    if (c.Registered) Assoc.Node(dir, "legacy cleanup --exe \"" + opener + "\"" + (c.OpenWith || c.Folder ? "" : " --no-open-with"), log);
  }

  static void Register(string dir, string version, Components c, Action<string> log) {
    try {
      using (RegistryKey k = Registry.CurrentUser.CreateSubKey(Setup.REG_KEY)) {
        string maint = Path.Combine(dir, "Uninstall LAIN.exe");
        k.SetValue("DisplayName", c.Harness ? "LAIN (CLI + Harness)" : "LAIN (CLI)");
        k.SetValue("DisplayVersion", version ?? "0");
        k.SetValue("Publisher", Setup.PUBLISHER);
        k.SetValue("InstallLocation", dir);
        k.SetValue("DisplayIcon", Path.Combine(dir, "lain.exe") + ",0");
        k.SetValue("UninstallString", "\"" + maint + "\" --uninstall");
        k.SetValue("QuietUninstallString", "\"" + maint + "\" --uninstall --silent");
        k.SetValue("ModifyPath", "\"" + maint + "\"");
        k.SetValue("NoRepair", 0, RegistryValueKind.DWord);
        k.SetValue("EstimatedSize", (int)(DirSize(dir) / 1024), RegistryValueKind.DWord);
        k.SetValue("LainComponents", c.Harness ? "cli,harness" : "cli");
        k.SetValue("LainLayout", "versions");   // the current layout — what tells this install from the obsolete LAIN
      }
    } catch (Exception e) { log("  (not registered in Installed apps: " + e.Message + ")"); }
  }

  static long DirSize(string d) { long n = 0; try { foreach (var f in new DirectoryInfo(d).EnumerateFiles("*", SearchOption.AllDirectories)) n += f.Length; } catch { } return n; }

  public static string Run(string exe, string args, string cwd) {
    try {
      var psi = new ProcessStartInfo(exe, args) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true, WorkingDirectory = cwd, StandardOutputEncoding = System.Text.Encoding.UTF8, StandardErrorEncoding = System.Text.Encoding.UTF8 };
      using (var p = Process.Start(psi)) { string o = p.StandardOutput.ReadToEnd(); p.WaitForExit(60000); return o; }
    } catch (Exception e) { return "error: " + e.Message; }
  }
}

static class Pointer {
  public static string Read(string dir, string name) { try { return File.ReadAllText(Path.Combine(dir, name)).Trim(); } catch { return null; } }
  public static void Write(string dir, string name, string v) { string p = Path.Combine(dir, name); File.WriteAllText(p + ".tmp", v); if (File.Exists(p)) File.Replace(p + ".tmp", p, null); else File.Move(p + ".tmp", p); }
}

static class Zip {
  /// Entry by entry, overwriting, and never outside the install directory (a zip can name "..").
  public static void Extract(string zipPath, string dir) {
    string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
    using (ZipArchive zip = ZipFile.OpenRead(zipPath)) {
      foreach (ZipArchiveEntry entry in zip.Entries) {
        string dest = Path.GetFullPath(Path.Combine(dir, entry.FullName));
        if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new IOException("the payload names a path outside the install directory: " + entry.FullName);
        if (entry.Name.Length == 0) { Directory.CreateDirectory(dest); continue; }
        Directory.CreateDirectory(Path.GetDirectoryName(dest));
        try { entry.ExtractToFile(dest, true); }
        catch (IOException) {
          // A LAUNCHER IN USE (someone's `lain` is open): a running image can be renamed, not overwritten.
          if (!dest.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw;
          string old = dest.Substring(0, dest.Length - 4) + "." + Guid.NewGuid().ToString("N").Substring(0, 6) + ".old.exe";
          File.Move(dest, old);
          entry.ExtractToFile(dest, true);
        }
      }
    }
  }
}

static class Prereq {
  const string WEBVIEW2 = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
  public static string WebView2Version() {
    foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser }) {
      foreach (var path in new[] { @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\" + WEBVIEW2, @"SOFTWARE\Microsoft\EdgeUpdate\Clients\" + WEBVIEW2 }) {
        try { using (var k = hive.OpenSubKey(path)) { var v = k == null ? null : k.GetValue("pv") as string; if (!string.IsNullOrEmpty(v) && v != "0.0.0.0") return v; } } catch { }
      }
    }
    return null;
  }
  /// Present on Windows 11. Missing: Microsoft's own Evergreen bootstrapper, from Microsoft, signature-checked.
  public static bool WebView2(Action<string> log) {
    string v = WebView2Version();
    if (v != null) { log("WebView2 Runtime " + v + " — present"); return true; }
    log("WebView2 Runtime is missing — downloading Microsoft's installer from go.microsoft.com …");
    string exe = Path.Combine(Path.GetTempPath(), "MicrosoftEdgeWebview2Setup-" + Guid.NewGuid().ToString("N").Substring(0, 6) + ".exe");
    try {
      System.Net.ServicePointManager.SecurityProtocol = (System.Net.SecurityProtocolType)3072;
      using (var wc = new System.Net.WebClient()) wc.DownloadFile("https://go.microsoft.com/fwlink/p/?LinkId=2124703", exe);
      if (!Signature.IsMicrosoft(exe)) { log("The downloaded WebView2 installer is not signed by Microsoft — refused."); return false; }
      var p = Process.Start(new ProcessStartInfo(exe, "/silent /install") { UseShellExecute = false, CreateNoWindow = true });
      p.WaitForExit(600000);
    } catch (Exception e) { log("Could not install WebView2: " + e.Message); return false; }
    finally { try { File.Delete(exe); } catch { } }
    v = WebView2Version();
    log(v != null ? "WebView2 Runtime " + v + " — installed" : "WebView2 Runtime is still missing.");
    return v != null;
  }
}

static class Signature {
  /// Authenticode-verified AND the signer is Microsoft (WinVerifyTrust through PowerShell's Get-AuthenticodeSignature).
  public static bool IsMicrosoft(string file) {
    try {
      string ps = "$s = Get-AuthenticodeSignature -LiteralPath '" + file.Replace("'", "''") + "'; if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'O=Microsoft Corporation') { 'OK' } else { $s.Status }";
      var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -Command \"" + ps.Replace("\"", "\\\"") + "\"") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
      using (var p = Process.Start(psi)) { string o = p.StandardOutput.ReadToEnd(); p.WaitForExit(60000); return o.Trim() == "OK"; }
    } catch { return false; }
  }
}
