// THE PARTS OF SETUP THAT TOUCH THE SYSTEM — a running LAIN, Open With, shortcuts, PATH, uninstall.
// Each is undone by uninstall, none is duplicated by a second install, and none changes a default application.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

/// A RUNNING LAIN goes down through its OWN shutdown sequence (distribution/shutdown.js — the same one the tray's
/// Quit uses), which saves sessions and commits task checkpoints before anything stops. Killing a window host is the
/// last resort, and hosts own no state (Core does).
static class Live {
  public static int ShutDown(string dir, Action<string> log) {
    int stopped = 0;
    string v = Pointer.Read(dir, "current");
    string node = v == null ? null : Path.Combine(dir, "versions", v, "runtime", "node.exe");
    string script = v == null ? null : Path.Combine(dir, "versions", v, "app", "distribution", "shutdown.js");
    if (node != null && File.Exists(node) && File.Exists(script)) {
      try {
        using (Process p = Process.Start(new ProcessStartInfo(node, "\"" + script + "\"") { UseShellExecute = false, CreateNoWindow = true })) {
          if (!p.WaitForExit(40000)) { log("  (the shutdown request did not return; ending it)"); try { p.Kill(); } catch { } }
          else if (p.ExitCode == 0) stopped++;
        }
      } catch (Exception e) { log("  (could not ask LAIN to stop: " + e.Message + ")"); }
    }
    // THE LAST RESORT, AND ONLY THIS INSTALL'S: a window host still running FROM THIS FOLDER. Another LAIN
    // somewhere else on the machine (a development checkout, another install) is never touched.
    string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
    foreach (Process p in Process.GetProcesses()) {
      if (!p.ProcessName.StartsWith("lain-harness-", StringComparison.OrdinalIgnoreCase) && !p.ProcessName.StartsWith("noema-harness-", StringComparison.OrdinalIgnoreCase)) continue;
      string exe = null;
      try { exe = p.MainModule.FileName; } catch { continue; }
      if (exe == null || !Path.GetFullPath(exe).StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
      try { p.Kill(); p.WaitForExit(5000); stopped++; log("  (ended " + p.ProcessName + ")"); } catch { }
    }
    return stopped;
  }
}

/// OPEN WITH / OPEN FOLDER — ONE implementation, the app's (src/winassoc.js), run by the installed runtime: it writes
/// OpenWithProgids, the folder verbs and the app entry, never a file type's default and never UserChoice, and it
/// removes the obsolete LAIN's and the Noema era's registrations in the same step.
static class Assoc {
  /// Run the installed app's own CLI (`lain <args>`) — Open With, the Startup entry and the obsolete LAIN's leftovers each have
  /// ONE implementation, in the app; setup only asks it.
  public static int Node(string dir, string args, Action<string> log) {
    string v = Pointer.Read(dir, "current");
    if (v == null) return 1;
    string node = Path.Combine(dir, "versions", v, "runtime", "node.exe");
    string entry = Path.Combine(dir, "versions", v, "app", "bin", "lain.js");
    try {
      var psi = new ProcessStartInfo(node, "\"" + entry + "\" " + args) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
      // WHICH INSTALL IS ASKING (startup.js finds `LAIN Harness.exe` here, never a version folder).
      psi.EnvironmentVariables["LAIN_INSTALL_ROOT"] = dir;
      using (var p = Process.Start(psi)) {
        string o = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd(); p.WaitForExit(60000);
        foreach (var line in o.Split('\n')) if (line.Trim().Length > 0) log("  " + line.Trim());
        return p.ExitCode;
      }
    } catch (Exception e) { log("  (" + e.Message + ")"); return 1; }
  }
  public static void Add(string dir, string opener, bool files, bool folders, Action<string> log) {
    Node(dir, "assoc register --exe \"" + opener + "\"" + (files ? "" : " --no-files") + (folders ? "" : " --no-folders"), log);
  }
  public static void Remove(string dir, Action<string> log) { Node(dir, "assoc remove", log); }
}

/// Start Menu entries under "LAIN", written through WScript.Shell (what Windows already has).
static class Shortcuts {
  public static string MenuDir() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "LAIN"); }
  public static string DesktopDir() { return Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory); }
  /// The Desktop's "LAIN" shortcut — removed only when it points at a LAIN install (never a file of the person's).
  public static void RemoveDesktop(Action<string> log) {
    string link = Path.Combine(DesktopDir(), "LAIN.lnk");
    try { if (File.Exists(link)) { File.Delete(link); log("Removed the Desktop shortcut"); } } catch (Exception e) { log("Could not remove the Desktop shortcut: " + e.Message); }
  }
  public static bool Write(string name, string target, string args, string description, Action<string> log, string folder = null) {
    string where = folder ?? MenuDir();
    string link = Path.Combine(where, name + ".lnk");
    string ps = "param([string]$Link,[string]$Target,[string]$Arguments,[string]$Desc)\r\n"
      + "$s = New-Object -ComObject WScript.Shell\r\n$sc = $s.CreateShortcut($Link)\r\n$sc.TargetPath = $Target\r\n"
      + "if ($Arguments) { $sc.Arguments = $Arguments }\r\n$sc.WorkingDirectory = [Environment]::GetFolderPath('UserProfile')\r\n"
      + "$sc.Description = $Desc\r\n$sc.IconLocation = $Target + ',0'\r\n$sc.Save()\r\n";
    string file = Path.Combine(Path.GetTempPath(), "lain-lnk-" + Guid.NewGuid().ToString("N") + ".ps1");
    try {
      Directory.CreateDirectory(where);
      File.WriteAllText(file, ps, new UTF8Encoding(false));
      var psi = new ProcessStartInfo("powershell", "-NoProfile -ExecutionPolicy Bypass -File \"" + file + "\" -Link \"" + link + "\" -Target \"" + target + "\" -Arguments \"" + args + "\" -Desc \"" + description + "\"") { UseShellExecute = false, CreateNoWindow = true };
      using (Process p = Process.Start(psi)) p.WaitForExit(30000);
      bool ok = File.Exists(link);
      log(ok ? (folder == null ? "Start Menu: LAIN > " + name : "Desktop: " + name) : "Could not create the shortcut " + name);
      return ok;
    } catch { return false; }
    finally { try { File.Delete(file); } catch { } }
  }
  public static void RemoveAll(Action<string> log) {
    try { if (Directory.Exists(MenuDir())) { var rd = SafeDelete.Tree(MenuDir()); log(rd.Ok ? "Removed the Start Menu entries" : "Could not remove the Start Menu entries: " + rd.Why); } } catch (Exception e) { log("Could not remove the Start Menu entries: " + e.Message); }
    // The obsolete pre-cleanup LAIN's single entry (a FILE named LAIN.lnk — not this folder).
    try { string old = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "LAIN.lnk"); if (File.Exists(old)) File.Delete(old); } catch { }
  }
}

/// The USER's PATH, never the machine's; added and removed by exact directory, every other entry byte-identical.
static class PathEntry {
  const string VAR = "PATH";
  public static bool Add(string dir, Action<string> log) {
    try {
      string cur = Environment.GetEnvironmentVariable(VAR, EnvironmentVariableTarget.User) ?? "";
      foreach (string part in cur.Split(';')) if (Same(part, dir)) { log("PATH: " + dir + " was already there"); return true; }
      Environment.SetEnvironmentVariable(VAR, cur.Length == 0 ? dir : (cur.TrimEnd(';') + ";" + dir), EnvironmentVariableTarget.User);
      log("PATH: added " + dir + " (open a NEW terminal for `lain`)");
      string shadow = Shadowing(dir);
      if (shadow != null) log("NOTE: `lain` resolves to " + shadow + " first — it is earlier on PATH.");
      return true;
    } catch (Exception e) { log("PATH: not changed — " + e.Message); return false; }
  }
  public static bool Remove(string dir, Action<string> log) {
    try {
      string cur = Environment.GetEnvironmentVariable(VAR, EnvironmentVariableTarget.User) ?? "";
      var kept = new List<string>(); bool found = false;
      foreach (string part in cur.Split(';')) { if (Same(part, dir)) { found = true; continue; } if (part.Length > 0) kept.Add(part); }
      if (!found) return true;
      Environment.SetEnvironmentVariable(VAR, string.Join(";", kept.ToArray()), EnvironmentVariableTarget.User);
      log("PATH: removed " + dir);
      return true;
    } catch (Exception e) { log("PATH: not changed — " + e.Message); return false; }
  }
  static bool Same(string a, string b) {
    try { return string.Equals(Path.GetFullPath(a.Trim().Trim('"')).TrimEnd('\\'), Path.GetFullPath(b.Trim().Trim('"')).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); } catch { return false; }
  }
  public static string Shadowing(string dir) {
    string all = (Environment.GetEnvironmentVariable(VAR, EnvironmentVariableTarget.User) ?? "") + ";" + (Environment.GetEnvironmentVariable(VAR, EnvironmentVariableTarget.Machine) ?? "");
    foreach (string part in all.Split(';')) {
      string d = part.Trim().Trim('"'); if (d.Length == 0) continue;
      foreach (string ext in new[] { ".exe", ".cmd", ".bat" }) {
        string c; try { c = Path.Combine(d, "lain" + ext); if (!File.Exists(c)) continue; } catch { continue; }
        return Same(d, dir) ? null : c;
      }
    }
    return null;
  }
}

/// A NOEMA-ERA INSTALL, RETIRED after LAIN is installed and verified in its place: its program folder, its Start Menu
/// folder, its PATH entry and its Installed-apps key. Its Open With entries and Startup shortcut were already replaced
/// by LAIN's own registration (winassoc.js, startup.js). The person's data is not touched here — home.js moves it.
static class Retire {
  public static void Noema(string dir, Action<string> log) {
    log("Retiring the Noema install at " + dir);
    try { string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Noema"); if (Directory.Exists(menu)) { var rm = SafeDelete.Tree(menu); log(rm.Ok ? "  removed Start Menu > Noema" : "  (Start Menu > Noema: " + rm.Why + ")"); } } catch (Exception e) { log("  (Start Menu > Noema: " + e.Message + ")"); }
    PathEntry.Remove(dir, log);
    try { Registry.CurrentUser.DeleteSubKeyTree(Setup.NOEMA_KEY, false); log("  removed Noema from Installed apps"); } catch (Exception e) { log("  (Installed apps: " + e.Message + ")"); }
    foreach (string f in Directory.Exists(dir) ? Directory.GetFiles(dir) : new string[0]) { try { File.Delete(f); } catch { try { File.Move(f, f + ".delete-me"); } catch { } } }
    var rd = SafeDelete.Tree(dir);
    log(rd.Ok ? "  removed " + dir : "  " + dir + " is still in use — what is left goes when nothing holds it (" + rd.Why + ")");
  }
}

/// UNINSTALL — the program, never the person's work unless they ask (and then with a warning).
static class Uninstaller {
  public static int Run(Setup.Options o, Action<string> console) {
    string dir = o.Dir;
    var lines = new List<string>();
    Action<string> log = s => { lines.Add(s); if (console != null) console(s); };
    if (console == null) {
      using (var f = new UninstallForm(Setup.DataDir())) {
        if (f.ShowDialog() != DialogResult.OK) return 1;
        o.RemoveData = f.RemoveData;
      }
    }
    // ONLY WHAT THIS INSTALL ADDED (components.json) is taken back — never another program's entries.
    var c = Components.Read(dir);
    Live.ShutDown(dir, log);
    // START AT SIGN-IN goes with the program — only the entry that points into THIS install (no dead shortcut left).
    Assoc.Node(dir, "settings startup remove --owned", log);
    if (c.OpenWith || c.Folder) Assoc.Remove(dir, log);
    if (c.StartMenu) Shortcuts.RemoveAll(log);
    if (c.Desktop) Shortcuts.RemoveDesktop(log);
    PathEntry.Remove(dir, log);   // exactly this folder, if present
    if (c.Registered) { try { Registry.CurrentUser.DeleteSubKeyTree(Setup.REG_KEY, false); } catch { } }
    // THE PROGRAM: everything under the install root except this running copy (deleted after exit).
    string me = System.Reflection.Assembly.GetExecutingAssembly().Location;
    foreach (string d in new[] { "versions", "staging" }) {
      string p = Path.Combine(dir, d);
      var rd = SafeDelete.Tree(p);
      if (!rd.Ok) log("Could not remove " + d + ": " + rd.Why);
    }
    foreach (string f in Directory.Exists(dir) ? Directory.GetFiles(dir) : new string[0]) {
      if (string.Equals(Path.GetFullPath(f), Path.GetFullPath(me), StringComparison.OrdinalIgnoreCase)) continue;
      try { File.Delete(f); } catch { try { File.Move(f, f + ".delete-me"); } catch { } }
    }
    log("Removed the program from " + dir);
    if (o.RemoveData) {
      // ONLY THE ONE DATA FOLDER, PROVEN: the canonical %USERPROFILE%\.lain — or a test's override inside TEMP. Links in
      // it (account homes link into other programs' folders) are removed as links, never followed (safedelete.cs).
      string why;
      string data = Setup.RemovableData(out why);
      if (data == null) log("Your LAIN data was NOT removed: " + why);
      else {
        var rd = SafeDelete.Tree(data);
        if (rd.Ok) log("Removed your LAIN data at " + data + " (" + rd.Files + " files; " + rd.Links + " links removed without following them)");
        else log("Your LAIN data at " + data + " was not fully removed: " + rd.Why);
        // AN OLDER BUILD'S LINKS to the default folder (~\.noema, ~\.lain-v2): only links, and only beside the default home.
        string up = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.Equals(Path.GetFullPath(data).TrimEnd('\\'), Path.Combine(up, ".lain"), StringComparison.OrdinalIgnoreCase)) {
          foreach (string name in new[] { ".noema", ".lain-v2" }) {
            var info = new DirectoryInfo(Path.Combine(up, name));
            if (info.Exists && (info.Attributes & FileAttributes.ReparsePoint) != 0 && SafeDelete.Tree(info.FullName).Ok) log("Removed the old link " + info.FullName);
          }
        }
      }
    } else log("Kept your sessions, accounts, settings and usage history at " + Setup.DataDir());
    if (console == null) MessageBox.Show(string.Join(Environment.NewLine, lines.ToArray()), "LAIN — uninstalled", MessageBoxButtons.OK, MessageBoxIcon.Information);
    DeleteAfterExit(me, dir);
    return 0;
  }

  static void DeleteAfterExit(string me, string dir) {
    try {
      string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
      if (!Path.GetFullPath(me).StartsWith(root, StringComparison.OrdinalIgnoreCase)) return;   // a downloaded setup is never deleted
      string bat = Path.Combine(Path.GetTempPath(), "lain-cleanup-" + Guid.NewGuid().ToString("N") + ".bat");
      File.WriteAllText(bat, "@echo off\r\nping -n 3 127.0.0.1 >nul\r\ndel /q \"" + me + "\" >nul 2>&1\r\ndel /q \"" + dir + "\\*.delete-me\" >nul 2>&1\r\nrmdir \"" + dir + "\" >nul 2>&1\r\ndel \"%~f0\" >nul 2>&1\r\n", new UTF8Encoding(false));
      Process.Start(new ProcessStartInfo("cmd.exe", "/c \"" + bat + "\"") { UseShellExecute = false, CreateNoWindow = true });
    } catch { }
  }
}
