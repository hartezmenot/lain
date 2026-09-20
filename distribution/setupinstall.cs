// WHAT INSTALLING ACTUALLY DOES — and what it refuses to do.
//
// The order matters and is not arbitrary:
//
//   1. Node, BEFORE anything is written. An install that completes and then
//      fails to start is the failure this whole file exists to prevent.
//   2. A running LAIN is shut down through its OWN shutdown sequence, not
//      killed — a tray window, a Bot and a Core may be holding durable state,
//      and partially overwriting live binaries is how an update corrupts an
//      install.
//   3. The payload, extracted whole.
//   4. Shortcuts, PATH and the uninstall entry — each of which is undone by
//      the uninstaller, and none of which is duplicated on a second install.

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using Microsoft.Win32;

static class Install {
  public static int Run(string dir, bool addPath, bool desktopShortcut, Action<string> say, bool shortcuts = true) {
    Action<string> log = say ?? (s => Console.WriteLine(s));

    // ---- 1. THE RUNTIME, FIRST ------------------------------------------
    string node = Setup.FindNode();
    if (node == null) {
      log("LAIN needs Node.js 18 or newer, and none was found.");
      log("Looked in %ProgramFiles%\\nodejs, %ProgramFiles(x86)%\\nodejs and on PATH.");
      log("Install it from https://nodejs.org and run this again.");
      return 2;
    }
    string version = Setup.NodeVersion(node);
    if (Setup.MajorOf(version) < 18) {
      log("LAIN needs Node.js 18 or newer. Found " + (version ?? "an unreadable version") + " at " + node + ".");
      return 2;
    }
    log("Node " + version + " at " + node);

    // ---- 2. A RUNNING LAIN GOES DOWN THE WAY IT KNOWS HOW ---------------
    int stopped = Live.ShutDown(dir, node, log);
    if (stopped > 0) log("Closed " + stopped + " running LAIN process(es) before updating.");

    // ---- 3. THE PAYLOAD -------------------------------------------------
    if (!Setup.Writable(Path.GetDirectoryName(dir.TrimEnd('\\')) ?? dir) && !Setup.Writable(dir)) {
      log("Cannot write to " + dir + ".");
      log(Setup.Elevated() ? "Choose another location." : "Choose a location you can write to, or run this as administrator.");
      return 3;
    }
    try {
      Directory.CreateDirectory(dir);
      // AN UPGRADE REPLACES THE PROGRAM AND KEEPS NOTHING STALE. Files from a
      // previous version that this one no longer ships would otherwise sit
      // there being loaded — so the program directory is emptied first, and it
      // is safe to empty precisely because nothing mutable is kept in it.
      foreach (string sub in new string[] { "bin", "src", "distribution", "native", "docs" }) {
        string p = Path.Combine(dir, sub);
        if (Directory.Exists(p)) Directory.Delete(p, true);
      }
      using (Stream z = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")) {
        if (z == null) { log("This installer has no payload embedded in it."); return 4; }
        string tmp = Path.Combine(Path.GetTempPath(), "lain-payload-" + Guid.NewGuid().ToString("N") + ".zip");
        using (FileStream f = File.Create(tmp)) z.CopyTo(f);
        try { Extract(tmp, dir); }
        finally { try { File.Delete(tmp); } catch { } }
      }
    } catch (Exception e) {
      log("Could not install the files: " + e.Message);
      return 5;
    }
    log("Installed to " + dir);

    // ---- 4. THE TWO ENTRYPOINTS -----------------------------------------
    string lainExe = Path.Combine(dir, "LAIN.exe");
    string cli = Path.Combine(dir, "lain.cmd");
    try {
      // The CLI shim. Quoted throughout, because an install path with a space
      // in it is the ordinary case and not an edge one.
      File.WriteAllText(cli,
        "@echo off\r\n" +
        "\"" + node + "\" \"" + Path.Combine(dir, "bin", "lain.js") + "\" %*\r\n",
        new UTF8Encoding(false));
      // And the native window, built by the product itself: it is the same
      // launcher `lain --desktop` uses, so there is one way in.
      int rc = RunNode(node, Path.Combine(dir, "distribution", "postinstall.js"), dir, log);
      if (rc != 0) { log("The native launcher could not be built (see above)."); return 6; }
    } catch (Exception e) {
      log("Could not write the launchers: " + e.Message);
      return 6;
    }

    // ---- 5. WHERE A PERSON FINDS IT --------------------------------------
    if (shortcuts) {
      Shortcuts.StartMenu(lainExe, dir, log);
      if (desktopShortcut) Shortcuts.Desktop(lainExe, dir, log);
    } else log("Shortcuts: none, as asked");
    if (addPath) {
      PathEntry.Add(dir, log);
      // ADDING A DIRECTORY TO PATH DOES NOT MAKE IT WIN. Reported, never
      // fixed by force: the other copy belongs to the person.
      string shadow = PathEntry.Shadowing(dir);
      if (shadow != null) {
        log("");
        log("NOTE: `lain` still resolves to " + shadow + ",");
        log("      which is earlier on PATH and will run instead of this install.");
        log("      Remove it, or put " + dir + " ahead of it.");
        log("      This install always works by its full path: " + Path.Combine(dir, "lain.cmd"));
      }
    } else log("PATH: left alone as asked");

    // ---- 6. THE WAY BACK OUT, ALWAYS -------------------------------------
    //
    // The uninstaller is PART OF THE PROGRAM, not part of the system
    // integration: an install with no Start Menu entry still has to be
    // removable. Skipping it with --no-shortcuts left installs that could only
    // be deleted by hand.
    string self = Path.Combine(dir, "Uninstall LAIN.exe");
    try { File.Copy(Assembly.GetExecutingAssembly().Location, self, true); }
    catch (Exception e) { log("(no uninstaller was written: " + e.Message + ")"); }

    // ---- 7. ADD/REMOVE PROGRAMS ------------------------------------------
    //
    // The REGISTRATION is system integration, and that is what --no-shortcuts
    // declines — a managed deployment and the test suite both want the program
    // without an entry in somebody's Settings app.
    if (!shortcuts) {
      log("");
      log("LAIN is installed at " + dir + ".");
      log("  " + cli + "   the CLI");
      log("  " + lainExe + "   the Harness window");
      return 0;
    }
    try {
      using (RegistryKey k = Registry.CurrentUser.CreateSubKey(Setup.REG_KEY)) {
        k.SetValue("DisplayName", "LAIN");
        k.SetValue("DisplayVersion", Payload.Version(dir));
        k.SetValue("InstallLocation", dir);
        k.SetValue("UninstallString", "\"" + self + "\" --uninstall --dir \"" + dir + "\"");
        k.SetValue("DisplayIcon", lainExe);
        k.SetValue("NoModify", 1, RegistryValueKind.DWord);
        k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        k.SetValue("Publisher", "LAIN");
        k.SetValue("LainAddedPath", addPath ? 1 : 0, RegistryValueKind.DWord);
      }
    } catch (Exception e) { log("(not registered in Add/Remove Programs: " + e.Message + ")"); }

    log("");
    log("LAIN is installed.");
    log("  Start Menu > LAIN      opens the Harness window");
    log("  lain                   opens the CLI" + (addPath ? " (in a NEW terminal)" : " — " + cli));
    return 0;
  }

  /// ---- EXTRACT, OVERWRITING --------------------------------------------
  ///
  /// `ZipFile.ExtractToDirectory` REFUSES to replace a file that is already
  /// there, which makes it exactly wrong for an upgrade: the directories are
  /// cleared first, but `package.json`, `README.md` and the launchers are loose
  /// in the root and survive. The first real upgrade failed on
  /// "The file 'package.json' already exists."
  ///
  /// Entry by entry, so replacing is the normal case. Each destination is
  /// checked to be inside the install directory — a zip is a file format, and a
  /// file format with paths in it can name `..`.
  static void Extract(string zipPath, string dir) {
    string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
    using (ZipArchive zip = ZipFile.OpenRead(zipPath)) {
      foreach (ZipArchiveEntry entry in zip.Entries) {
        string dest = Path.GetFullPath(Path.Combine(dir, entry.FullName));
        if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) {
          throw new IOException("the payload names a path outside the install directory: " + entry.FullName);
        }
        if (entry.Name.Length == 0) { Directory.CreateDirectory(dest); continue; }
        Directory.CreateDirectory(Path.GetDirectoryName(dest));
        entry.ExtractToFile(dest, true);
      }
    }
  }

  static int RunNode(string node, string script, string dir, Action<string> log) {
    try {
      ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + script + "\" \"" + dir + "\"");
      psi.UseShellExecute = false; psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
      psi.CreateNoWindow = true; psi.WorkingDirectory = dir;
      using (Process p = Process.Start(psi)) {
        string o = p.StandardOutput.ReadToEnd();
        string e = p.StandardError.ReadToEnd();
        p.WaitForExit(240000);
        foreach (string line in (o + e).Split('\n')) if (line.Trim().Length > 0) log("  " + line.Trim());
        return p.ExitCode;
      }
    } catch (Exception e) { log("  " + e.Message); return 1; }
  }
}

static class Payload {
  public static string Version(string dir) {
    try {
      string json = File.ReadAllText(Path.Combine(dir, "package.json"));
      int i = json.IndexOf("\"version\"");
      if (i < 0) return "0";
      int a = json.IndexOf('"', json.IndexOf(':', i)) + 1;
      int b = json.IndexOf('"', a);
      return json.Substring(a, b - a);
    } catch { return "0"; }
  }
}
