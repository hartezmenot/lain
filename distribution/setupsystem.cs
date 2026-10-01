// THE PARTS OF SETUP THAT TOUCH THE SYSTEM — a running Noema, Open With, shortcuts, PATH, uninstall.
// Each is undone by uninstall, none is duplicated by a second install, and none changes a default application.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

/// A RUNNING NOEMA goes down through its OWN shutdown sequence (distribution/shutdown.js — the same one the tray's
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
      } catch (Exception e) { log("  (could not ask Noema to stop: " + e.Message + ")"); }
    }
    // THE LAST RESORT, AND ONLY THIS INSTALL'S: a window host still running FROM THIS FOLDER. A Noema or LAIN
    // somewhere else on the machine (a development checkout, another install) is never touched.
    string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
    foreach (Process p in Process.GetProcesses()) {
      if (!p.ProcessName.StartsWith("noema-harness-", StringComparison.OrdinalIgnoreCase)) continue;
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
/// removes LAIN's old registration in the same step.
static class Assoc {
  /// Run the installed app's own CLI (`noema <args>`) — Open With, the Startup entry and LAIN's leftovers each have
  /// ONE implementation, in the app; setup only asks it.
  public static int Node(string dir, string args, Action<string> log) {
    string v = Pointer.Read(dir, "current");
    if (v == null) return 1;
    string node = Path.Combine(dir, "versions", v, "runtime", "node.exe");
    string entry = Path.Combine(dir, "versions", v, "app", "bin", "noema.js");
    try {
      var psi = new ProcessStartInfo(node, "\"" + entry + "\" " + args) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
      // WHICH INSTALL IS ASKING (startup.js finds `Noema Harness.exe` here, never a version folder).
      psi.EnvironmentVariables["NOEMA_INSTALL_ROOT"] = dir;
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

/// Start Menu entries under "Noema", written through WScript.Shell (what Windows already has).
static class Shortcuts {
  public static string MenuDir() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Noema"); }
  public static bool Write(string name, string target, string args, string description, Action<string> log) {
    string link = Path.Combine(MenuDir(), name + ".lnk");
    string ps = "param([string]$Link,[string]$Target,[string]$Arguments,[string]$Desc)\r\n"
      + "$s = New-Object -ComObject WScript.Shell\r\n$sc = $s.CreateShortcut($Link)\r\n$sc.TargetPath = $Target\r\n"
      + "if ($Arguments) { $sc.Arguments = $Arguments }\r\n$sc.WorkingDirectory = [Environment]::GetFolderPath('UserProfile')\r\n"
      + "$sc.Description = $Desc\r\n$sc.IconLocation = $Target + ',0'\r\n$sc.Save()\r\n";
    string file = Path.Combine(Path.GetTempPath(), "noema-lnk-" + Guid.NewGuid().ToString("N") + ".ps1");
    try {
      Directory.CreateDirectory(MenuDir());
      File.WriteAllText(file, ps, new UTF8Encoding(false));
      var psi = new ProcessStartInfo("powershell", "-NoProfile -ExecutionPolicy Bypass -File \"" + file + "\" -Link \"" + link + "\" -Target \"" + target + "\" -Arguments \"" + args + "\" -Desc \"" + description + "\"") { UseShellExecute = false, CreateNoWindow = true };
      using (Process p = Process.Start(psi)) p.WaitForExit(30000);
      bool ok = File.Exists(link);
      log(ok ? "Start Menu: Noema > " + name : "Start Menu: could not create " + name);
      return ok;
    } catch { return false; }
    finally { try { File.Delete(file); } catch { } }
  }
  public static void RemoveAll(Action<string> log) {
    try { if (Directory.Exists(MenuDir())) { Directory.Delete(MenuDir(), true); log("Removed the Start Menu entries"); } } catch (Exception e) { log("Could not remove the Start Menu entries: " + e.Message); }
    // LAIN's old single entry.
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
      log("PATH: added " + dir + " (open a NEW terminal for `noema`)");
      string shadow = Shadowing(dir);
      if (shadow != null) log("NOTE: `noema` resolves to " + shadow + " first — it is earlier on PATH.");
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
        string c; try { c = Path.Combine(d, "noema" + ext); if (!File.Exists(c)) continue; } catch { continue; }
        return Same(d, dir) ? null : c;
      }
    }
    return null;
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
    PathEntry.Remove(dir, log);   // exactly this folder, if present
    if (c.Registered) { try { Registry.CurrentUser.DeleteSubKeyTree(Setup.REG_KEY, false); } catch { } }
    // THE PROGRAM: everything under the install root except this running copy (deleted after exit).
    string me = System.Reflection.Assembly.GetExecutingAssembly().Location;
    foreach (string d in new[] { "versions", "staging" }) { try { string p = Path.Combine(dir, d); if (Directory.Exists(p)) Directory.Delete(p, true); } catch (Exception e) { log("Could not remove " + d + ": " + e.Message); } }
    foreach (string f in Directory.Exists(dir) ? Directory.GetFiles(dir) : new string[0]) {
      if (string.Equals(Path.GetFullPath(f), Path.GetFullPath(me), StringComparison.OrdinalIgnoreCase)) continue;
      try { File.Delete(f); } catch { try { File.Move(f, f + ".delete-me"); } catch { } }
    }
    log("Removed the program from " + dir);
    string data = Setup.DataDir();
    if (o.RemoveData) {
      try {
        // LAIN'S COMPATIBILITY LINK (~/.lain-v2 → ~/.noema) goes with the default data folder — only a link, never a
        // real folder, and only when the data removed is the default one it points to.
        string lainJunction = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".lain-v2");
        bool isDefault = string.Equals(Path.GetFullPath(data).TrimEnd('\\'), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".noema"), StringComparison.OrdinalIgnoreCase);
        if (Directory.Exists(data)) { Directory.Delete(data, true); log("Removed your Noema data at " + data); }
        var info = new DirectoryInfo(lainJunction);
        if (isDefault && info.Exists && (info.Attributes & FileAttributes.ReparsePoint) != 0) { info.Delete(); log("Removed the LAIN compatibility link " + lainJunction); }
      } catch (Exception e) { log("Could not remove " + data + ": " + e.Message); }
    } else log("Kept your sessions, accounts, settings and usage history at " + data);
    if (console == null) MessageBox.Show(string.Join(Environment.NewLine, lines.ToArray()), "Noema — uninstalled", MessageBoxButtons.OK, MessageBoxIcon.Information);
    DeleteAfterExit(me, dir);
    return 0;
  }

  static void DeleteAfterExit(string me, string dir) {
    try {
      string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
      if (!Path.GetFullPath(me).StartsWith(root, StringComparison.OrdinalIgnoreCase)) return;   // a downloaded setup is never deleted
      string bat = Path.Combine(Path.GetTempPath(), "noema-cleanup-" + Guid.NewGuid().ToString("N") + ".bat");
      File.WriteAllText(bat, "@echo off\r\nping -n 3 127.0.0.1 >nul\r\ndel /q \"" + me + "\" >nul 2>&1\r\ndel /q \"" + dir + "\\*.delete-me\" >nul 2>&1\r\nrmdir \"" + dir + "\" >nul 2>&1\r\ndel \"%~f0\" >nul 2>&1\r\n", new UTF8Encoding(false));
      Process.Start(new ProcessStartInfo("cmd.exe", "/c \"" + bat + "\"") { UseShellExecute = false, CreateNoWindow = true });
    } catch { }
  }
}
