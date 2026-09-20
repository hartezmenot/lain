// THE PARTS THAT TOUCH THE SYSTEM: a running LAIN, shortcuts, PATH, uninstall.
//
// Each one is undone by the uninstaller, and none of them is duplicated by a
// second install. That symmetry is the whole design constraint here — an
// installer that cannot cleanly reverse itself is one nobody should run twice.

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

/// ---- A RUNNING LAIN DURING AN UPDATE -------------------------------------
///
/// LAIN.exe sits in the tray, a Bot may be connected and Core may be mid-turn.
/// Overwriting those binaries underneath them is how an update corrupts an
/// install, and killing them throws away durable state that was about to be
/// written.
///
/// So it asks LAIN to shut itself down THROUGH ITS OWN SEQUENCE — the same one
/// the tray's Quit uses (src/teardown.js, reached by bin/lain-control.js) —
/// which stops the gateway, the jobs, the terminals, the sessions and the
/// window in the order they have to stop in. Killing is the last resort and is
/// reported when it happens.
static class Live {
  public static int ShutDown(string dir, string node, Action<string> log) {
    int stopped = 0;
    // THE CONTROL PATH IS corelock's, AND IT IS REACHED THROUGH ONE SCRIPT.
    // (This first called bin/lain-control.js — which is the Computer MCP stop
    // WINDOW, takes a directory rather than a verb, and sat forever waiting for
    // a state file. The install hung with no output at all.)
    string shutdown = Path.Combine(dir, "distribution", "shutdown.js");
    if (File.Exists(shutdown) && node != null) {
      try {
        ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + shutdown + "\"");
        psi.UseShellExecute = false; psi.CreateNoWindow = true;
        // NOT REDIRECTED, AND THAT IS THE FIX. ReadToEnd() blocks until the
        // child exits, so a child that never exits made the 30-second timeout
        // below unreachable — the deadlock that hung the first upgrade.
        using (Process p = Process.Start(psi)) {
          if (!p.WaitForExit(40000)) {
            log("  (the shutdown request did not return; ending it)");
            try { p.Kill(); } catch { }
          } else if (p.ExitCode == 0) stopped += 1;
        }
      } catch (Exception e) { log("  (could not ask LAIN to stop: " + e.Message + ")"); }
    }
    // WHATEVER IS LEFT AFTER THE POLITE ROUTE. The host processes are named
    // lain-desktop-<hash>.exe and own no state of their own — Core does.
    foreach (string name in new string[] { "lain-desktop", "lain-pty" }) {
      try {
        foreach (Process p in Process.GetProcesses()) {
          if (!p.ProcessName.StartsWith(name, StringComparison.OrdinalIgnoreCase)) continue;
          try { p.Kill(); p.WaitForExit(5000); stopped += 1; log("  (ended " + p.ProcessName + ")"); } catch { }
        }
      } catch { }
    }
    return stopped;
  }
}

/// A .lnk is a COM shell object, so it is written through WScript.Shell — the
/// same "use what Windows already has" arrangement as csc.exe and PowerShell.
static class Shortcuts {
  public static string MenuDir() {
    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs");
  }
  public static string MenuLink() { return Path.Combine(MenuDir(), "LAIN.lnk"); }
  public static string DesktopLink() {
    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "LAIN.lnk");
  }

  public static bool StartMenu(string target, string workdir, Action<string> log) {
    bool ok = Write(MenuLink(), target, workdir);
    log(ok ? "Start Menu: LAIN" : "Start Menu: could not create the entry");
    return ok;
  }
  public static bool Desktop(string target, string workdir, Action<string> log) {
    bool ok = Write(DesktopLink(), target, workdir);
    log(ok ? "Desktop shortcut: LAIN" : "Desktop shortcut: could not create it");
    return ok;
  }

  /// THE TARGET IS LAIN.exe. Never lain.cmd, never node.exe, never a URL: a
  /// shortcut that opens a console window or a browser is not this product.
  static bool Write(string link, string target, string workdir) {
    string ps =
      "param([string]$Link,[string]$Target,[string]$Work)\r\n" +
      "$s = New-Object -ComObject WScript.Shell\r\n" +
      "$sc = $s.CreateShortcut($Link)\r\n" +
      "$sc.TargetPath = $Target\r\n" +
      "$sc.WorkingDirectory = $Work\r\n" +
      "$sc.Description = 'LAIN'\r\n" +
      "$sc.IconLocation = $Target + ',0'\r\n" +
      "$sc.WindowStyle = 1\r\n" +
      "$sc.Save()\r\n";
    string file = Path.Combine(Path.GetTempPath(), "lain-lnk-" + Guid.NewGuid().ToString("N") + ".ps1");
    try {
      Directory.CreateDirectory(Path.GetDirectoryName(link));
      File.WriteAllText(file, ps, new UTF8Encoding(false));
      ProcessStartInfo psi = new ProcessStartInfo("powershell",
        "-NoProfile -ExecutionPolicy Bypass -File \"" + file + "\" -Link \"" + link + "\" -Target \"" + target + "\" -Work \"" + workdir + "\"");
      psi.UseShellExecute = false; psi.CreateNoWindow = true;
      using (Process p = Process.Start(psi)) p.WaitForExit(30000);
      return File.Exists(link);
    } catch { return false; }
    finally { try { File.Delete(file); } catch { } }
  }

  public static void Remove(Action<string> log) {
    foreach (string p in new string[] { MenuLink(), DesktopLink() }) {
      try { if (File.Exists(p)) { File.Delete(p); log("Removed " + p); } } catch (Exception e) { log("Could not remove " + p + ": " + e.Message); }
    }
  }
}

/// ---- PATH ----------------------------------------------------------------
///
/// The USER's PATH, never the machine's: installing a command for yourself
/// should not need administrator, and should not change what every other
/// account on the machine resolves. It is matched and removed by exact
/// directory, never by rewriting the variable — every other entry comes back
/// byte-identical, which is the property that matters when somebody's PATH has
/// forty entries in it and one of them is their livelihood.
static class PathEntry {
  const string VAR = "PATH";

  public static bool Add(string dir, Action<string> log) {
    try {
      string cur = Environment.GetEnvironmentVariable(VAR, EnvironmentVariableTarget.User) ?? "";
      foreach (string part in cur.Split(';')) {
        if (Same(part, dir)) { log("PATH: " + dir + " was already there"); return true; }
      }
      string next = cur.Length == 0 ? dir : (cur.TrimEnd(';') + ";" + dir);
      Environment.SetEnvironmentVariable(VAR, next, EnvironmentVariableTarget.User);
      log("PATH: added " + dir + " (open a NEW terminal for `lain`)");
      return true;
    } catch (Exception e) { log("PATH: not changed — " + e.Message); return false; }
  }

  public static bool Remove(string dir, Action<string> log) {
    try {
      string cur = Environment.GetEnvironmentVariable(VAR, EnvironmentVariableTarget.User) ?? "";
      var kept = new System.Collections.Generic.List<string>();
      bool found = false;
      foreach (string part in cur.Split(';')) {
        if (Same(part, dir)) { found = true; continue; }
        if (part.Length > 0) kept.Add(part);
      }
      if (!found) { log("PATH: no entry of ours to remove"); return true; }
      Environment.SetEnvironmentVariable(VAR, string.Join(";", kept.ToArray()), EnvironmentVariableTarget.User);
      log("PATH: removed " + dir);
      return true;
    } catch (Exception e) { log("PATH: not changed — " + e.Message); return false; }
  }

  static bool Same(string a, string b) {
    try {
      return string.Equals(
        Path.GetFullPath(a.Trim().Trim('"')).TrimEnd('\\'),
        Path.GetFullPath(b.Trim().Trim('"')).TrimEnd('\\'),
        StringComparison.OrdinalIgnoreCase);
    } catch { return false; }
  }

  /// ---- IS SOMETHING ELSE ALREADY ANSWERING TO `lain`? -------------------
  ///
  /// Adding a directory to PATH does not make it win. FOUND ON THE FIRST REAL
  /// INSTALL: `lain` resolved to an npm-installed copy in
  /// %APPDATA%\npm — an older LAIN, on an older Node — because that directory
  /// came earlier. The install had succeeded and the command was somebody
  /// else's, which is the worst kind of working.
  ///
  /// This walks PATH the way a shell does, in order, and reports the first
  /// thing that answers. It does not touch the other copy: that is the
  /// person's, and removing it is their decision.
  public static string Shadowing(string dir) {
    string user = Environment.GetEnvironmentVariable(VAR, EnvironmentVariableTarget.User) ?? "";
    string machine = Environment.GetEnvironmentVariable(VAR, EnvironmentVariableTarget.Machine) ?? "";
    foreach (string part in (user + ";" + machine).Split(';')) {
      string d = part.Trim().Trim('"');
      if (d.Length == 0) continue;
      foreach (string ext in new string[] { ".cmd", ".exe", ".bat", ".ps1" }) {
        string candidate;
        try { candidate = Path.Combine(d, "lain" + ext); } catch { continue; }
        try { if (!File.Exists(candidate)) continue; } catch { continue; }
        return Same(d, dir) ? null : candidate;      // ours wins, or theirs does
      }
    }
    return null;
  }
}

/// ---- UNINSTALL -----------------------------------------------------------
///
/// Removes what was installed and NOTHING a person owns. Sessions, goals,
/// plans, credentials and project state live under the user's data directory
/// and stay there unless --remove-data is asked for explicitly.
static class Uninstall {
  public static int Run(string dir, bool silent, bool removeData) {
    var lines = new System.Collections.Generic.List<string>();
    Action<string> log = s => { lines.Add(s); if (silent) Console.WriteLine(s); };

    Live.ShutDown(dir, Setup.FindNode(), log);
    Shortcuts.Remove(log);

    bool addedPath = true;
    try {
      using (RegistryKey k = Registry.CurrentUser.OpenSubKey(Setup.REG_KEY)) {
        if (k != null) {
          object v = k.GetValue("LainAddedPath");
          addedPath = v == null || Convert.ToInt32(v) == 1;
        }
      }
    } catch { }
    // ONLY WHAT THIS INSTALLER ADDED. A PATH entry somebody put there by hand
    // is theirs.
    if (addedPath) PathEntry.Remove(dir, log); else log("PATH: nothing of ours was added");

    try { Registry.CurrentUser.DeleteSubKeyTree(Setup.REG_KEY, false); } catch { }

    // THE PROGRAM, not the work.
    foreach (string sub in new string[] { "bin", "src", "distribution", "native", "docs" }) {
      try { string p = Path.Combine(dir, sub); if (Directory.Exists(p)) Directory.Delete(p, true); } catch (Exception e) { log("Could not remove " + sub + ": " + e.Message); }
    }
    foreach (string f in new string[] { "LAIN.exe", "lain.cmd", "package.json", "README.md", "launch.json" }) {
      try { string p = Path.Combine(dir, f); if (File.Exists(p)) File.Delete(p); } catch { }
    }
    log("Removed the program from " + dir);

    string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".lain-v2");
    if (removeData) {
      try { if (Directory.Exists(data)) { Directory.Delete(data, true); log("Removed your LAIN data at " + data); } }
      catch (Exception e) { log("Could not remove " + data + ": " + e.Message); }
    } else {
      log("Kept your sessions, goals and settings at " + data);
    }

    if (!silent) {
      MessageBox.Show(string.Join(Environment.NewLine, lines.ToArray()),
        "LAIN — uninstalled", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
    // The uninstaller is running from inside the directory it just emptied, so
    // the last two things go after it exits.
    Self.DeleteAfterExit(dir);
    return 0;
  }
}

static class Self {
  /// ---- ONLY THE INSTALLED COPY DELETES ITSELF ---------------------------
  ///
  /// The uninstaller and the installer are the same program, so running
  /// `LAIN-Setup.exe --uninstall` used to delete LAIN-Setup.exe — the artifact
  /// people download, sitting in a downloads folder or, as happened here, in
  /// dist/ where it had just been built. Self-deletion is for the copy that
  /// lives INSIDE the install directory and would otherwise be left behind.
  public static void DeleteAfterExit(string dir) {
    try {
      string me = System.Reflection.Assembly.GetExecutingAssembly().Location;
      string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
      if (!Path.GetFullPath(me).StartsWith(root, StringComparison.OrdinalIgnoreCase)) return;
      string bat = Path.Combine(Path.GetTempPath(), "lain-cleanup-" + Guid.NewGuid().ToString("N") + ".bat");
      File.WriteAllText(bat,
        "@echo off\r\n" +
        "ping -n 3 127.0.0.1 >nul\r\n" +
        "del \"" + me + "\" >nul 2>&1\r\n" +
        "rmdir \"" + dir + "\" >nul 2>&1\r\n" +
        "del \"%~f0\" >nul 2>&1\r\n", new UTF8Encoding(false));
      ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c \"" + bat + "\"");
      psi.UseShellExecute = false; psi.CreateNoWindow = true;
      Process.Start(psi);
    } catch { }
  }
}
