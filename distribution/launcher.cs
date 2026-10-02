// LAIN LAUNCHER — lain.exe (console) and "LAIN Harness.exe" (GUI, compiled with /define:GUI).
// ---------------------------------------------------------------------------
// WHY A LAUNCHER. LAIN is installed side by side:
//     <root>\versions\<version>\runtime\node.exe
//     <root>\versions\<version>\app\bin\lain.js
//     <root>\current      the version that runs      (one line)
//     <root>\previous     the last known-good version (one line)
// An update is a NEW directory plus a one-line pointer change — nothing that is running is ever overwritten, so
// there is no "replace a running executable" problem to solve. This program is the small separate process that
// makes that safe:
//   RESTART   the app exits with code 75 after writing <root>\restart.json ({ args, cwd }) — the launcher starts the
//             (new) current version with those arguments, in the SAME console: the person's terminal is never lost.
//   HEALTH    a version switched to by the updater is "pending" (<root>\pending names it). The app writes
//             <root>\health-<version> once it has started properly. A pending version that exits before that, with
//             a failure code, is ROLLED BACK: current <- previous, and the previous version is started instead.
// The launcher itself never changes the app; it only reads pointers, starts, waits, and rolls back.
// ---------------------------------------------------------------------------
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
#if GUI
using System.Windows.Forms;
#endif

static class Launcher {
  const int RESTART = 75;
  const int HEALTH_WAIT_MS = 60000;

  static string Root { get { return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'); } }
  static string Read(string name) { try { return File.ReadAllText(Path.Combine(Root, name)).Trim(); } catch { return null; } }
  static void Write(string name, string value) {
    string p = Path.Combine(Root, name), t = p + ".tmp";
    File.WriteAllText(t, value);
    if (File.Exists(p)) File.Replace(t, p, null); else File.Move(t, p);
  }
  static bool Usable(string v) {
    return !string.IsNullOrEmpty(v) && v.IndexOfAny(Path.GetInvalidFileNameChars()) < 0
      && File.Exists(Path.Combine(Root, "versions", v, "runtime", "node.exe"))
      && Entry(Path.Combine(Root, "versions", v)) != null;
  }
  /// The version's entry point: bin/lain.js, or bin/noema.js for a Noema-era version kept for rollback.
  static string Entry(string vdir) {
    foreach (string n in new[] { "lain.js", "noema.js" }) { string p = Path.Combine(vdir, "app", "bin", n); if (File.Exists(p)) return p; }
    return null;
  }
  static void Say(string s) {
#if GUI
    MessageBox.Show(s, "LAIN", MessageBoxButtons.OK, MessageBoxIcon.Warning);
#else
    Console.Error.WriteLine("lain: " + s);
#endif
  }
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int bs = 0;
    foreach (char c in a) {
      if (c == '\\') { bs++; continue; }
      if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
      sb.Append('\\', bs); bs = 0; sb.Append(c);
    }
    sb.Append('\\', bs * 2); sb.Append('"');
    return sb.ToString();
  }

  static int Run(string version, IList<string> args, string cwd) {
    string vdir = Path.Combine(Root, "versions", version);
    var psi = new ProcessStartInfo(Path.Combine(vdir, "runtime", "node.exe")) { UseShellExecute = false, WorkingDirectory = cwd };
    var all = new List<string> { Entry(vdir) };
#if HARNESS
    all.Add("--desktop");
#endif
#if GUI
    psi.CreateNoWindow = true;
    psi.EnvironmentVariables["LAIN_NO_CONSOLE"] = "1";
#endif
    all.AddRange(args);
    psi.Arguments = string.Join(" ", all.Select(Quote));
    psi.EnvironmentVariables["LAIN_INSTALL_ROOT"] = Root;
    psi.EnvironmentVariables["NOEMA_INSTALL_ROOT"] = Root;   // a Noema-era version (rollback) reads only this name
    psi.EnvironmentVariables["LAIN_VERSION_DIR"] = vdir;
    psi.EnvironmentVariables["LAIN_LAUNCHER"] = Process.GetCurrentProcess().MainModule.FileName;
    psi.EnvironmentVariables["LAIN_HEALTH_FILE"] = Path.Combine(Root, "health-" + version);
    using (var p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
  }

  [STAThread]
  static int Main(string[] argv) {
#if !GUI
    // THE CHILD HAS THE CONSOLE: Ctrl+C is the app's to handle; the launcher just waits for it.
    Console.CancelKeyPress += (s, e) => { e.Cancel = true; };
#endif
    // A PREVIOUS SELF-UPDATE left the old launcher behind (a running image can be renamed, not deleted).
    try { foreach (var old in Directory.GetFiles(Root, "*.old.exe")) File.Delete(old); } catch { }
    var args = new List<string>(argv);
    // THE FOLDER LAIN WAS STARTED IN. .NET Framework refuses some legal Windows forms (a \\?\ path); then the
    // person's profile folder is used rather than failing to start at all.
    string cwd;
    try { cwd = Environment.CurrentDirectory; } catch { cwd = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile); }
    // AT WINDOWS SIGN-IN (`--startup`, src/startup.js) nothing of LAIN is running yet: a verified update the
    // updater STAGED (src/update/updater.js) becomes current HERE, before anything starts — one launch of the new
    // version, never "start the old one, then replace it, then restart". It is still `pending`, so a version that
    // fails before reporting healthy rolls back to `previous` exactly as after any other update.
    if (args.Contains("--startup")) {
      string staged = Read("staged"), cur = Read("current");
      if (Usable(staged) && staged != cur) {
        if (Usable(cur)) Write("previous", cur);
        Write("current", staged);
        Write("pending", staged);
      }
      try { File.Delete(Path.Combine(Root, "staged")); } catch { }
    }
    for (int round = 0; round < 20; round++) {
      string current = Read("current"), previous = Read("previous"), pending = Read("pending");
      if (!Usable(current)) {
        if (Usable(previous)) { Say("the current version is missing; starting " + previous); Write("current", previous); current = previous; }
        else { Say("no usable LAIN version is installed under " + Root + ". Reinstall LAIN."); return 1; }
      }
      string health = Path.Combine(Root, "health-" + current);
      bool isPending = pending == current;
      var started = DateTime.UtcNow;
      // HEALTHY IS DECIDED WHILE IT RUNS: the moment the new version reports healthy, it stops being "pending" — a
      // long session (or a machine that shuts down under it) never leaves a healthy version marked for rollback.
      System.Threading.Timer watch = null;
      if (isPending) {
        watch = new System.Threading.Timer(_ => {
          try { if (File.Exists(health)) { File.Delete(Path.Combine(Root, "pending")); if (watch != null) watch.Change(System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite); } } catch { }
        }, null, 500, 500);
      }
      int code = Run(current, args, cwd);
      if (watch != null) watch.Dispose();
      if (isPending) {
        if (File.Exists(health)) { try { File.Delete(Path.Combine(Root, "pending")); } catch { } }
        else if (code != 0 && code != RESTART && (DateTime.UtcNow - started).TotalMilliseconds < HEALTH_WAIT_MS && Usable(previous) && previous != current) {
          // ROLLBACK: the new version never became healthy. The previous one is still on disk, untouched.
          Write("current", previous);
          try { File.Delete(Path.Combine(Root, "pending")); } catch { }
          try { File.WriteAllText(Path.Combine(Root, "rolled-back"), current + " -> " + previous + " at " + DateTime.UtcNow.ToString("o")); } catch { }
          Say("LAIN " + current + " did not start; rolled back to " + previous + ".");
          continue;
        }
      }
      if (code != RESTART) return code;
      // RESTART: arguments and directory the app asked for (its session and task to resume), else the same ones.
      string req = Read("restart.json");
      try { File.Delete(Path.Combine(Root, "restart.json")); } catch { }
      if (req != null) {
        var parsed = ParseRestart(req);
        if (parsed.Item1 != null) args = parsed.Item1;
        if (parsed.Item2 != null && Directory.Exists(parsed.Item2)) cwd = parsed.Item2;
      }
    }
    Say("restarted too many times in a row; stopping.");
    return 1;
  }

  /// { "args": ["--resume","abcd"], "cwd": "D:\\proj" } — a tiny reader for exactly this shape (no JSON library in .NET 4 core).
  static Tuple<List<string>, string> ParseRestart(string json) {
    List<string> args = null; string cwd = null;
    try {
      int a = json.IndexOf("\"args\"");
      if (a >= 0) {
        int s = json.IndexOf('[', a), e = json.IndexOf(']', s);
        args = new List<string>();
        foreach (var item in Strings(json.Substring(s + 1, e - s - 1))) args.Add(item);
      }
      int c = json.IndexOf("\"cwd\"");
      if (c >= 0) { var v = Strings(json.Substring(json.IndexOf(':', c) + 1)).FirstOrDefault(); cwd = v; }
    } catch { }
    return Tuple.Create(args, cwd);
  }
  static IEnumerable<string> Strings(string s) {
    int i = 0;
    while (true) {
      int q = s.IndexOf('"', i); if (q < 0) yield break;
      var sb = new StringBuilder(); int j = q + 1;
      for (; j < s.Length && s[j] != '"'; j++) {
        if (s[j] == '\\' && j + 1 < s.Length) { j++; char n = s[j]; sb.Append(n == 'n' ? '\n' : n == 't' ? '\t' : n); } else sb.Append(s[j]);
      }
      yield return sb.ToString(); i = j + 1;
    }
  }
}
