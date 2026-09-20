// THE LAIN INSTALLER — and the uninstaller, which is the same program.
//
// ---------------------------------------------------------------------------
// WHY C# COMPILED BY csc.exe, AND NOT AN INSTALLER FRAMEWORK.
//
// LAIN builds with `node` and the `csc.exe` that is part of Windows. That is the
// whole toolchain: the desktop host (native/host.cs), the pseudoconsole
// (native/pty.cs) and the Computer MCP bridge are all compiled this way, on
// demand, with nothing installed. Requiring WiX, NSIS or Inno Setup to produce
// the installer would make a build machine a prerequisite of the product — for
// the one artifact whose entire job is to need nothing.
//
// The payload rides as an embedded resource, so what ships is ONE FILE.
//
// ---------------------------------------------------------------------------
// ONE PRODUCT, TWO ENTRYPOINTS.
//
//   LAIN.exe   the native Harness window
//   lain       the CLI
//
// They are not two products. Both start or attach to the SAME Core and the same
// session store, and they are installed together, always. There is no separate
// CLI installer and no way to end up with one and not the other.
//
// ---------------------------------------------------------------------------
// PROGRAM FILES HOLD THE PROGRAM. NOTHING MUTABLE IS WRITTEN THERE.
//
// Sessions, goals, plans, credentials, caches and window state live under the
// user's own data directory (%USERPROFILE%\.lain-v2), which is where the
// runtime already keeps them. Uninstalling removes the program and leaves the
// work, unless the person explicitly asks for the data too.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

static class Setup {
  public const string PRODUCT = "LAIN";
  public const string REG_KEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\LAIN";

  [STAThread]
  static int Main(string[] argv) {
    bool uninstall = false, silent = false;
    string dir = null;
    bool? addPath = null, desktop = null;
    bool removeData = false;
    bool shortcuts = true;
    for (int i = 0; i < argv.Length; i++) {
      string a = argv[i];
      if (a == "--uninstall") uninstall = true;
      else if (a == "--silent") silent = true;
      else if (a == "--dir" && i + 1 < argv.Length) dir = argv[++i];
      else if (a == "--path") addPath = true;
      else if (a == "--no-path") addPath = false;
      else if (a == "--desktop") desktop = true;
      // NO SHORTCUTS, NO START MENU, NO ADD/REMOVE ENTRY. For a managed or
      // scripted deployment — and for the test suite, which must not put
      // entries in a developer's own shell.
      else if (a == "--no-shortcuts") shortcuts = false;
      else if (a == "--remove-data") removeData = true;
    }

    Application.EnableVisualStyles();
    if (uninstall) return Uninstall.Run(dir ?? InstalledAt(), silent, removeData);
    if (silent) return Install.Run(dir ?? DefaultDir(), addPath ?? true, desktop ?? false, null, shortcuts);
    Application.Run(new Wizard(dir ?? DefaultDir(), addPath ?? true, desktop ?? false));
    return Wizard.ExitCode;
  }

  /// WHERE IT GOES BY DEFAULT — and nothing anywhere assumes this path.
  /// Every runtime lookup derives from where the program actually is
  /// (Assembly location) or from the user's data directory.
  public static string DefaultDir() {
    string pf = Environment.GetEnvironmentVariable("ProgramFiles");
    if (string.IsNullOrEmpty(pf)) pf = @"C:\Program Files";
    return Path.Combine(pf, PRODUCT);
  }

  public static string InstalledAt() {
    try {
      using (RegistryKey k = Registry.CurrentUser.OpenSubKey(REG_KEY)) {
        if (k != null) {
          string p = k.GetValue("InstallLocation") as string;
          if (!string.IsNullOrEmpty(p)) return p;
        }
      }
    } catch { }
    return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
  }

  public static bool Writable(string dir) {
    try {
      string probe = Path.Combine(dir, ".lain-write-probe");
      Directory.CreateDirectory(dir);
      File.WriteAllText(probe, "x");
      File.Delete(probe);
      return true;
    } catch { return false; }
  }

  public static bool Elevated() {
    try {
      using (WindowsIdentity id = WindowsIdentity.GetCurrent()) {
        return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
      }
    } catch { return false; }
  }

  // ---- NODE IS A REQUIREMENT, AND IT IS CHECKED BEFORE ANYTHING IS COPIED --
  //
  // THE POLICY, decided rather than inherited: LAIN REQUIRES AN INSTALLED NODE
  // RUNTIME (>= 18) AND DETECTS IT. It does not bundle one.
  //
  // Bundling was measured: node.exe is 88 MB against a 6.5 MB product, and
  // redistributing it correctly means shipping the official binary from a
  // verified download together with its licence text — not copying whatever
  // node.exe happens to be on the build machine. That is a fetch-and-verify
  // step of the kind native/vendor.js already does for the WebView2 SDK, and it
  // is a reasonable future option; it is not something to do accidentally.
  //
  // What makes the requirement safe is that it is NEVER A SURPRISE. The
  // installer refuses to complete without Node and says where it looked, and
  // LAIN.exe reports the same thing natively if Node disappears afterwards.
  public static string FindNode() {
    string pf = Environment.GetEnvironmentVariable("ProgramFiles");
    string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");
    string[] guesses = {
      pf == null ? null : Path.Combine(pf, "nodejs", "node.exe"),
      pf86 == null ? null : Path.Combine(pf86, "nodejs", "node.exe"),
    };
    foreach (string g in guesses) {
      try { if (g != null && File.Exists(g)) return g; } catch { }
    }
    string path = Environment.GetEnvironmentVariable("PATH") ?? "";
    foreach (string part in path.Split(';')) {
      if (part.Trim().Length == 0) continue;
      try {
        string c = Path.Combine(part.Trim(), "node.exe");
        if (File.Exists(c)) return c;
      } catch { }
    }
    return null;
  }

  public static string NodeVersion(string exe) {
    try {
      ProcessStartInfo psi = new ProcessStartInfo(exe, "--version");
      psi.UseShellExecute = false; psi.RedirectStandardOutput = true; psi.CreateNoWindow = true;
      using (Process p = Process.Start(psi)) {
        string v = p.StandardOutput.ReadToEnd().Trim();
        p.WaitForExit(10000);
        return v;
      }
    } catch { return null; }
  }

  public static int MajorOf(string version) {
    if (string.IsNullOrEmpty(version)) return 0;
    string v = version.TrimStart('v');
    int dot = v.IndexOf('.');
    if (dot > 0) v = v.Substring(0, dot);
    int n; return int.TryParse(v, out n) ? n : 0;
  }
}
