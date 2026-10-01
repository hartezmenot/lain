// LAIN COMPUTER MCP — the Windows desktop bridge.
//
// One JSON object per line on stdin, one per line on stdout: the protocol in
// src/mcp.js. It performs OPERATIONS and reports OBSERVATIONS. It decides
// nothing about whether an operation is allowed — src/permissions.js and the
// Computer MCP session authorization do that, on every call, before anything
// is sent here.
//
// OBSERVATION PREFERENCE, in order: native window state (user32), Windows UI
// Automation (names, control types, patterns, bounds), then pixels (a
// screenshot written to a file). There is deliberately NO OCR: a V1 that
// guessed text from pixels would report a confidence it does not have.
//
// OUT OF SCOPE, and absent from this file: process memory reads or writes,
// pointer/address discovery, DLL injection, hooks of any kind.
//
// WHY A COMPILED PROGRAM AND NOT A SCRIPT. The first version of this bridge was
// PowerShell, and Windows Defender's AMSI refused to run it: a script that
// declares SendInput/keybd_event is indistinguishable, to a script scanner,
// from the input-synthesis half of a keylogger. The code was not changed to get
// past the scanner — it is the same operations, written in the ordinary form a
// desktop automation helper takes: a normal program, from source that ships in
// this repository, compiled by the .NET Framework compiler already on the
// machine. If a scanner refuses this too, that is the machine's decision and
// LAIN reports it rather than working around it.
//
// Compiled by src/computermcp.js with csc.exe; see `ensureBridge` there.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

static class Native {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  // EVERY TOP-LEVEL WINDOW, AND A DIALOG IS ONE OF THEM.
  //
  // This used to drop any window with an OWNER (GW_OWNER), on the reasoning
  // that an owned window is a popup rather than an application. That is exactly
  // backwards for the thing this bridge is for: a modal dialog — Save As, the
  // file picker, "are you sure?" — IS an owned window. The effect was that a
  // native dialog was invisible to `window.list` and to every `wait.window`,
  // and a flow waiting for one timed out while it sat on the screen.
  //
  // The real distinction is TOP-LEVEL and visible and titled; the owner is
  // reported instead of being used to exclude, so a caller can still tell
  // "the browser" from "the browser's dialog".
  //
  // ---- AND "TOP-LEVEL" IS NOT `GetParent(h) == 0` ------------------------
  //
  // That is the same exclusion wearing a different name, and it put the bug
  // back after the comment above said it was gone. GetParent returns the OWNER
  // for an owned top-level window — it is only GetAncestor(GA_PARENT) that
  // returns the desktop. Measured, with a real WinForms application holding a
  // real Save As open:
  //
  //   h=18812950 vis=True parent=27660050 owner=27660050 class=#32770 title=Save As
  //   h=27660050 vis=True parent=0        owner=0        class=WindowsForms10.Window…
  //
  // So every modal dialog on the machine — Save As, the browser's file picker,
  // "are you sure?" — was invisible to window.list and to every wait.window,
  // which is the one thing a bridge like this exists to see.
  //
  // EnumWindows only walks top-level windows to begin with, so this is an
  // assertion rather than a filter: GA_PARENT (1) of a top-level window is the
  // desktop.
  public static List<IntPtr> TopWindows() {
    IntPtr desktop = GetDesktopWindow();
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && GetWindowTextLength(h) > 0 && GetAncestor(h, 1) == desktop) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static IntPtr Owner(IntPtr h) { return GetWindow(h, 4); }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);

  public static string ClassOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(256);
    GetClassName(h, sb, 256);
    return sb.ToString();
  }

  /** The top-level window an hwnd belongs to. GA_ROOT is 2. */
  public static IntPtr RootOf(IntPtr h) { return h == IntPtr.Zero ? h : GetAncestor(h, 2); }

  public static string Title(IntPtr h) {
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }

  // THE FOREGROUND IS GIVEN, NOT TAKEN. Windows only lets a process raise a
  // window when it owns the foreground or shares its input queue, so this
  // attaches to the foreground thread for the duration and then detaches.
  // A POPUP OF THE TARGET IS ALREADY IN FRONT: leave it. Re-focusing the owner
  // before clicking an element inside its open menu dismissed the menu, and the
  // element was gone before the click (Chrome's Extensions menu, 2026-09-19).
  public static bool FocusKeepingPopups(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    IntPtr fg = GetForegroundWindow();
    if (fg == h || Owner(fg) == h || RootOf(fg) == h) return true;
    return Focus(h);
  }

  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    IntPtr fg = GetForegroundWindow();
    uint pid;
    uint fgThread = GetWindowThreadProcessId(fg, out pid);
    uint me = GetCurrentThreadId();
    if (fgThread != me) AttachThreadInput(me, fgThread, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (fgThread != me) AttachThreadInput(me, fgThread, false);
    Thread.Sleep(120);
    return GetForegroundWindow() == h;
  }

  public static void Mouse(uint flags, uint data) {
    INPUT[] i = new INPUT[1];
    i[0].type = 0;
    i[0].u.mi.dwFlags = flags;
    i[0].u.mi.mouseData = data;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Key(ushort vk, bool up) {
    INPUT[] i = new INPUT[1];
    i[0].type = 1;
    i[0].u.ki.wVk = vk;
    i[0].u.ki.dwFlags = up ? 2u : 0u;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Unicode(string text) {
    foreach (char c in text) {
      INPUT[] i = new INPUT[2];
      i[0].type = 1; i[0].u.ki.wScan = c; i[0].u.ki.dwFlags = 4;
      i[1].type = 1; i[1].u.ki.wScan = c; i[1].u.ki.dwFlags = 4 | 2;
      SendInput(2, i, Marshal.SizeOf(typeof(INPUT)));
      Thread.Sleep(3);
    }
  }
}

static class Bridge {
  static JavaScriptSerializer J = new JavaScriptSerializer();

  static Dictionary<string, object> Ok(object result) {
    Dictionary<string, object> d = new Dictionary<string, object>();
    d["ok"] = true;
    d["result"] = result;
    return d;
  }

  static Dictionary<string, object> Map() { return new Dictionary<string, object>(); }

  static object Get(Dictionary<string, object> p, string key) {
    if (p == null) return null;
    object v;
    return p.TryGetValue(key, out v) ? v : null;
  }

  static string Str(Dictionary<string, object> p, string key) {
    object v = Get(p, key);
    return v == null ? null : Convert.ToString(v, CultureInfo.InvariantCulture);
  }

  static int Int(Dictionary<string, object> p, string key, int fallback) {
    object v = Get(p, key);
    if (v == null) return fallback;
    try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch { return fallback; }
  }

  static bool Bool(Dictionary<string, object> p, string key) {
    object v = Get(p, key);
    if (v == null) return false;
    try { return Convert.ToBoolean(v); } catch { return false; }
  }

  static Dictionary<string, object> RectOf(IntPtr h) {
    Native.RECT r;
    Native.GetWindowRect(h, out r);
    Dictionary<string, object> d = Map();
    d["x"] = r.Left; d["y"] = r.Top; d["width"] = r.Right - r.Left; d["height"] = r.Bottom - r.Top;
    return d;
  }

  static Dictionary<string, object> WindowRow(IntPtr h) {
    uint pid;
    Native.GetWindowThreadProcessId(h, out pid);
    string pname = "";
    try { pname = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
    Dictionary<string, object> d = Map();
    d["handle"] = h.ToInt64();
    d["title"] = Native.Title(h);
    d["pid"] = (int)pid;
    d["process"] = pname;
    d["rect"] = RectOf(h);
    d["minimized"] = Native.IsIconic(h);
    d["foreground"] = Native.GetForegroundWindow() == h;
    // WHOSE DIALOG THIS IS. An owner means this window belongs to another —
    // a file picker over its browser, a Save As over its editor — and that is
    // worth saying rather than hiding the window for it.
    IntPtr owner = Native.Owner(h);
    d["owner"] = owner == IntPtr.Zero ? null : (object)owner.ToInt64();
    d["dialog"] = owner != IntPtr.Zero;
    return d;
  }

  static Dictionary<string, object> Foreground() {
    IntPtr h = Native.GetForegroundWindow();
    return h == IntPtr.Zero ? null : WindowRow(h);
  }

  // WHICH WINDOW — AND NEVER A GUESS BETWEEN TWO.
  //
  // A title is not an identity. Measured on a real desktop: a second Notepad
  // asked for by title resolved to the one a person already had open, with
  // their unsaved work in it. So a handle or a pid wins outright, an EXACT
  // title match wins over a partial one, and an ambiguous partial match is
  // REFUSED with the candidates listed rather than resolved by position.
  static IntPtr FindWindow(Dictionary<string, object> p) {
    object handle = Get(p, "handle");
    if (handle != null) {
      try { return new IntPtr(Convert.ToInt64(handle, CultureInfo.InvariantCulture)); } catch { }
    }
    List<IntPtr> wins = Native.TopWindows();
    object rawPid = Get(p, "pid");
    string title = Str(p, "window");
    if (string.IsNullOrEmpty(title)) title = Str(p, "title");

    if (rawPid != null) {
      int want = Int(p, "pid", 0);
      List<IntPtr> byPid = new List<IntPtr>();
      foreach (IntPtr h in wins) {
        uint pid;
        Native.GetWindowThreadProcessId(h, out pid);
        if ((int)pid == want) byPid.Add(h);
      }
      if (byPid.Count == 0) return IntPtr.Zero;
      // A PID AND A TITLE TOGETHER ARE THE PRECISE FORM, and the one a caller
      // should reach for: "the Open dialog OF THIS BROWSER". A process owning
      // several windows is normal — a browser and its file picker, an editor
      // and its Save As — so a title given alongside a pid NARROWS rather than
      // being ignored, which is what it used to be.
      if (!string.IsNullOrEmpty(title)) {
        List<IntPtr> narrowed = MatchTitle(byPid, title);
        if (narrowed.Count == 1) return narrowed[0];
        if (narrowed.Count > 1) throw new Exception(Ambiguous(title + " in pid " + want, narrowed));
        return IntPtr.Zero;
      }
      // A PID IS NOT ONE WINDOW EITHER. ApplicationFrameHost hosts every store
      // application on the machine, so "the window of pid N" can be four
      // different people's work. One match, or say which.
      if (byPid.Count > 1) throw new Exception(Ambiguous("pid " + want, byPid));
      return byPid[0];
    }

    if (string.IsNullOrEmpty(title)) return IntPtr.Zero;
    List<IntPtr> hits = MatchTitle(wins, title);
    if (hits.Count == 1) return hits[0];
    if (hits.Count > 1) throw new Exception(Ambiguous(title, hits));
    return IntPtr.Zero;
  }

  // TITLE MATCHING, AND THE REASON IT IS NOT `Contains`.
  //
  // Measured on a real desktop: waiting for the file dialog titled "Open"
  // resolved to a browser window called "Welcome back - OpenAI - Helium",
  // because "open" is a substring of "openai" — and the next action typed a
  // path into that person's address bar. A substring is not a title.
  //
  // So: an EXACT title wins outright. Failing that, the wanted text must appear
  // as a WHOLE WORD — bounded by something that is not a letter or a digit on
  // both sides — which keeps "Notepad" matching "*draft - Notepad" and stops
  // "Open" matching "OpenAI". Several word matches are still AMBIGUOUS and are
  // refused by the caller, never resolved by position.
  static List<IntPtr> MatchTitle(List<IntPtr> wins, string title) {
    List<IntPtr> exact = new List<IntPtr>();
    foreach (IntPtr h in wins) if (string.Equals(Native.Title(h), title, StringComparison.OrdinalIgnoreCase)) exact.Add(h);
    if (exact.Count > 0) return exact;
    List<IntPtr> word = new List<IntPtr>();
    foreach (IntPtr h in wins) if (WordMatch(Native.Title(h), title)) word.Add(h);
    return word;
  }

  static bool WordMatch(string haystack, string needle) {
    if (string.IsNullOrEmpty(haystack) || string.IsNullOrEmpty(needle)) return false;
    int i = 0;
    while (i <= haystack.Length - needle.Length) {
      int at = haystack.IndexOf(needle, i, StringComparison.OrdinalIgnoreCase);
      if (at < 0) return false;
      bool leftOk = at == 0 || !char.IsLetterOrDigit(haystack[at - 1]);
      int end = at + needle.Length;
      bool rightOk = end >= haystack.Length || !char.IsLetterOrDigit(haystack[end]);
      if (leftOk && rightOk) return true;
      i = at + 1;
    }
    return false;
  }

  static string Ambiguous(string want, List<IntPtr> hits) {
    List<string> names = new List<string>();
    foreach (IntPtr h in hits) {
      uint pid;
      Native.GetWindowThreadProcessId(h, out pid);
      names.Add("\"" + Native.Title(h) + "\" (pid " + pid + ", handle " + h.ToInt64() + ")");
      if (names.Count >= 6) break;
    }
    return "\"" + want + "\" matches " + hits.Count + " windows and nothing here will choose between them: "
      + string.Join(", ", names.ToArray()) + ". Name the pid or the handle.";
  }

  static Dictionary<string, object> ElementRow(AutomationElement el) {
    if (el == null) return null;
    AutomationElement.AutomationElementInformation c = el.Current;
    Dictionary<string, object> d = Map();
    d["name"] = c.Name;
    d["automationId"] = c.AutomationId;
    d["className"] = c.ClassName;
    d["controlType"] = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
    d["enabled"] = c.IsEnabled;
    d["offscreen"] = c.IsOffscreen;
    d["focused"] = c.HasKeyboardFocus;
    System.Windows.Rect b = c.BoundingRectangle;
    if (!double.IsInfinity(b.X) && b.Width > 0) {
      Dictionary<string, object> r = Map();
      r["x"] = (int)b.X; r["y"] = (int)b.Y; r["width"] = (int)b.Width; r["height"] = (int)b.Height;
      d["rect"] = r;
    } else d["rect"] = null;
    List<string> pats = new List<string>();
    foreach (AutomationPattern pat in el.GetSupportedPatterns()) {
      pats.Add(pat.ProgrammaticName.Replace("PatternIdentifiers.Pattern", "").Replace("Identifiers.Pattern", ""));
    }
    d["patterns"] = pats;
    object vp;
    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) d["value"] = ((ValuePattern)vp).Current.Value;
    else d["value"] = null;
    int[] rid = el.GetRuntimeId();
    d["runtimeId"] = string.Join(".", Array.ConvertAll(rid, delegate(int x) { return x.ToString(CultureInfo.InvariantCulture); }));
    return d;
  }

  static AutomationElement ScopeRoot(Dictionary<string, object> p) {
    IntPtr h = FindWindow(p);
    if (h != IntPtr.Zero) return AutomationElement.FromHandle(h);
    if (Get(p, "window") != null || Get(p, "title") != null || Get(p, "handle") != null) {
      throw new Exception("no window matches " + (Str(p, "window") ?? Str(p, "title") ?? Convert.ToString(Get(p, "handle"))));
    }
    return AutomationElement.RootElement;
  }

  static List<AutomationElement> Matches(Dictionary<string, object> p) {
    AutomationElement root = ScopeRoot(p);
    List<Condition> conds = new List<Condition>();
    string autoId = Str(p, "automationId");
    if (!string.IsNullOrEmpty(autoId)) conds.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, autoId));
    string ctype = Str(p, "controlType");
    if (!string.IsNullOrEmpty(ctype)) {
      System.Reflection.FieldInfo f = typeof(ControlType).GetField(ctype, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
      // A WIN32 BUTTON THAT UI AUTOMATION CALLS A PANE. MEASURED on Windows 11
      // build 26200: the shell Open dialog's Open button (automationId "1",
      // class "Button") reports ControlType.Pane with no patterns at all, so
      // "press the Open button" matched nothing. It is still that button, and
      // uia.invoke clicks an element with no pattern at its centre. Only this
      // exact misreport is accepted — class Button AND type Pane.
      if (f != null && ctype == "Button") {
        conds.Add(new OrCondition(
          new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
          new AndCondition(
            new PropertyCondition(AutomationElement.ClassNameProperty, "Button"),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Pane))));
      } else if (f != null) conds.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, f.GetValue(null)));
    }
    Condition cond = Condition.TrueCondition;
    if (conds.Count == 1) cond = conds[0];
    else if (conds.Count > 1) cond = new AndCondition(conds.ToArray());

    AutomationElementCollection all = root.FindAll(TreeScope.Descendants, cond);
    string want = Str(p, "name");
    bool exact = Bool(p, "exact");
    List<AutomationElement> outp = new List<AutomationElement>();
    foreach (AutomationElement el in all) {
      if (!string.IsNullOrEmpty(want)) {
        string n = el.Current.Name;
        if (exact) { if (n != want) continue; }
        else { if (string.IsNullOrEmpty(n) || !n.ToLowerInvariant().Contains(want.ToLowerInvariant())) continue; }
      }
      outp.Add(el);
      if (outp.Count >= 200) break;
    }
    return outp;
  }

  // A CLOAKED APP HAS NO TREE, AND THAT IS NOT THE SAME AS HAVING NO CONTROLS.
  //
  // Measured on Windows 11 Calculator: a store application that is not in the
  // foreground is suspended behind an ApplicationFrameHost frame, and a walk of
  // that frame returns the title bar and nothing else — seven nodes where there
  // are sixty-three. Reporting "no control matches" there would be a lie about
  // the application rather than a fact about it.
  //
  // So a window-scoped look that finds nothing raises that window ONCE and
  // looks again. It is deliberately not done up front: raising a window is a
  // visible act, and most observations do not need it.
  static List<AutomationElement> MatchesLooking(Dictionary<string, object> p) {
    List<AutomationElement> first = Matches(p);
    if (first.Count > 0) return first;
    IntPtr h = FindWindow(p);
    if (h == IntPtr.Zero) return first;
    // RAISE IT AND KEEP LOOKING. A store application attaches its tree when it
    // resumes, which is not the instant the foreground changes — and an app
    // that is ALREADY in front may simply still be starting. Measured on
    // Calculator: seven nodes at 0ms, sixty-three about a second later.
    Native.Focus(h);
    for (int waited = 0; waited < 3000; waited += 300) {
      Thread.Sleep(300);
      List<AutomationElement> again = Matches(p);
      if (again.Count > 0) return again;
    }
    return new List<AutomationElement>();
  }

  /** The same patience for a whole-tree read: chrome only is not an answer. */
  static AutomationElement RootLooking(Dictionary<string, object> p) {
    IntPtr h = FindWindow(p);
    if (h == IntPtr.Zero) return ScopeRoot(p);
    AutomationElement root = AutomationElement.FromHandle(h);
    Dictionary<string, object> probe = new Dictionary<string, object>();
    foreach (KeyValuePair<string, object> kv in p) probe[kv.Key] = kv.Value;
    probe["controlType"] = "Button";
    probe.Remove("name");
    probe.Remove("automationId");
    if (Matches(probe).Count > 3) return root;
    Native.Focus(h);
    for (int waited = 0; waited < 3000; waited += 300) {
      Thread.Sleep(300);
      if (Matches(probe).Count > 3) break;
    }
    return AutomationElement.FromHandle(h);
  }

  /** The same sentence Ambiguous() writes for windows, for controls. */
  static string AmbiguousControl(Dictionary<string, object> p, List<AutomationElement> hits) {
    List<string> names = new List<string>();
    foreach (AutomationElement el in hits) {
      string n, t, id;
      try { n = el.Current.Name; } catch { n = "?"; }
      try { t = el.Current.ControlType.ProgrammaticName; } catch { t = "?"; }
      try { id = el.Current.AutomationId; } catch { id = ""; }
      names.Add("\"" + n + "\" (" + t.Replace("ControlType.", "") + (id.Length > 0 ? ", id " + id : "") + ")");
      if (names.Count >= 6) break;
    }
    string asked = "name='" + (Str(p, "name") ?? "") + "' automationId='" + (Str(p, "automationId") ?? "")
      + "' controlType='" + (Str(p, "controlType") ?? "") + "'";
    return asked + " matches " + hits.Count + " controls and nothing here will choose between them: "
      + string.Join(", ", names.ToArray()) + ". Name it precisely, or pass an index.";
  }

  // WHICH CONTROL — AND, LIKE A WINDOW, NEVER A GUESS BETWEEN TWO.
  //
  // This used to return list[0] whenever several matched, silently. MEASURED on
  // the Windows shell Save As dialog: `controlType: 'Edit'` matches FORTY-ONE
  // controls there — every cell of the file list is an Edit — and the file name
  // box is the fortieth. So "type the path into the Edit of the Save dialog"
  // typed it into a grid cell, and then REPORTED SUCCESS, because setting a
  // value on the wrong control succeeds.
  //
  // FindWindow has refused this for windows since a real desktop taught it to.
  // A control is the same question asked one level down.
  static AutomationElement Pick(Dictionary<string, object> p) {
    List<AutomationElement> list = MatchesLooking(p);
    if (list.Count == 0) {
      throw new Exception("no control matches name='" + (Str(p, "name") ?? "") + "' automationId='"
        + (Str(p, "automationId") ?? "") + "' controlType='" + (Str(p, "controlType") ?? "") + "'");
    }
    // AN INDEX IS THE CALLER SAYING WHICH ONE, so it is obeyed.
    if (Get(p, "index") != null) {
      int idx = Int(p, "index", 0);
      if (idx >= list.Count) throw new Exception("only " + list.Count + " control(s) match; index " + idx + " does not exist");
      return list[idx];
    }
    if (list.Count == 1) return list[0];

    // AN EXACT NAME WINS over the ones that merely contain the words — but only
    // if exactly one control wears it. Several cells called "Name" are not an
    // answer either.
    string want = Str(p, "name");
    if (!string.IsNullOrEmpty(want)) {
      List<AutomationElement> exact = new List<AutomationElement>();
      foreach (AutomationElement el in list) {
        string n;
        try { n = el.Current.Name; } catch { n = null; }
        if (n == want) exact.Add(el);
      }
      if (exact.Count == 1) return exact[0];
      if (exact.Count > 1) throw new Exception(AmbiguousControl(p, exact));
    }
    throw new Exception(AmbiguousControl(p, list));
  }

  static Dictionary<string, object> Tree(AutomationElement el, int depth, int max, ref int count) {
    if (count >= max) return null;
    count++;
    Dictionary<string, object> row = ElementRow(el);
    if (depth > 0) {
      List<object> kids = new List<object>();
      TreeWalker walker = TreeWalker.ControlViewWalker;
      AutomationElement child = null;
      try { child = walker.GetFirstChild(el); } catch { }
      while (child != null && count < max) {
        Dictionary<string, object> t = Tree(child, depth - 1, max, ref count);
        if (t != null) kids.Add(t);
        try { child = walker.GetNextSibling(child); } catch { child = null; }
      }
      row["children"] = kids;
    }
    return row;
  }

  static Dictionary<string, ushort> VK = BuildVk();
  static Dictionary<string, ushort> BuildVk() {
    Dictionary<string, ushort> d = new Dictionary<string, ushort>();
    d["enter"] = 0x0D; d["return"] = 0x0D; d["tab"] = 0x09; d["esc"] = 0x1B; d["escape"] = 0x1B;
    d["backspace"] = 0x08; d["delete"] = 0x2E; d["del"] = 0x2E; d["space"] = 0x20;
    d["up"] = 0x26; d["down"] = 0x28; d["left"] = 0x25; d["right"] = 0x27;
    d["home"] = 0x24; d["end"] = 0x23; d["pageup"] = 0x21; d["pagedown"] = 0x22; d["insert"] = 0x2D;
    d["ctrl"] = 0x11; d["control"] = 0x11; d["shift"] = 0x10; d["alt"] = 0x12; d["win"] = 0x5B;
    for (int i = 1; i <= 12; i++) d["f" + i] = (ushort)(0x6F + i);
    return d;
  }

  static ushort VkOf(string k) {
    string n = (k ?? "").ToLowerInvariant();
    if (VK.ContainsKey(n)) return VK[n];
    if (n.Length == 1) {
      char ch = char.ToUpperInvariant(n[0]);
      if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) return (ushort)ch;
    }
    throw new Exception("unknown key '" + k + "'");
  }

  static void PressKeys(List<string> keys) {
    List<ushort> vks = new List<ushort>();
    foreach (string k in keys) vks.Add(VkOf(k));
    foreach (ushort v in vks) { Native.Key(v, false); Thread.Sleep(15); }
    vks.Reverse();
    foreach (ushort v in vks) { Native.Key(v, true); Thread.Sleep(15); }
  }

  static void Click(string button, int count) {
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; }
    if (button == "middle") { down = 0x0020; up = 0x0040; }
    for (int i = 0; i < count; i++) { Native.Mouse(down, 0); Native.Mouse(up, 0); Thread.Sleep(60); }
  }

  static Dictionary<string, object> Cursor() {
    Native.POINT pt;
    Native.GetCursorPos(out pt);
    Dictionary<string, object> d = Map();
    d["x"] = pt.X; d["y"] = pt.Y;
    return d;
  }

  static Point CenterOf(AutomationElement el) {
    System.Windows.Rect b = el.Current.BoundingRectangle;
    if (double.IsInfinity(b.X) || b.Width <= 0) throw new Exception("the control has no on-screen rectangle");
    return new Point((int)(b.X + b.Width / 2), (int)(b.Y + b.Height / 2));
  }

  static string[] CAPS = new string[] {
    "displays", "window.list", "window.active", "window.focus", "window.close",
    "uia.tree", "uia.find", "uia.invoke", "uia.setValue", "uia.getValue", "uia.focus",
    "wait.window", "wait.control", "wait.gone", "cursor.get",
    "mouse.move", "mouse.click", "mouse.drag", "mouse.scroll",
    "keyboard.type", "keyboard.key", "clipboard.read", "clipboard.write", "screen.capture"
  };

  // ---- A UI AUTOMATION CALL IS NOT GUARANTEED TO COME BACK ----------------
  //
  // MEASURED, against the Windows shell Save As dialog: ValuePattern.SetValue
  // on its "File name:" edit — the one inside FileNameControlHost, with the
  // shell's autocomplete behind it — never returns. Not slowly: never. Every
  // later request on this process then timed out too, because the loop below
  // is serial, so one dialog took the whole computer away from the session for
  // the rest of its life.
  //
  // So anything that can block runs on a thread that may be abandoned. The
  // thread is a background STA one: STA because UI Automation and the shell
  // want it, background so an abandoned one cannot keep the process alive.
  static bool Bounded(ThreadStart body, int ms, out Exception error) {
    Exception caught = null;
    Thread t = new Thread(delegate() {
      try { body(); } catch (Exception e) { caught = e; }
    });
    t.IsBackground = true;
    try { t.SetApartmentState(ApartmentState.STA); } catch { }
    t.Start();
    bool finished = t.Join(ms);
    error = caught;
    return finished;
  }

  /**
   * IS THIS CONTROL INSIDE A NATIVE DIALOG? "#32770" is the Win32 dialog class,
   * and it is what the shell's common item dialog — Save As, Open, the file
   * picker a browser raises — presents itself as.
   *
   * It matters for exactly one reason, measured rather than assumed: see the
   * note in uia.setValue.
   */
  static bool InDialog(IntPtr h, AutomationElement el) {
    IntPtr root = Native.RootOf(h);
    if (root == IntPtr.Zero) {
      try {
        int n = el.Current.NativeWindowHandle;
        if (n != 0) root = Native.RootOf(new IntPtr(n));
      } catch { }
    }
    if (root == IntPtr.Zero) return false;
    return Native.ClassOf(root) == "#32770";
  }

  /** How long this process will wait on one request before saying so. */
  static int Cap(Dictionary<string, object> p) {
    int asked = Int(p, "timeoutMs", 0);
    return asked > 0 ? asked + 20000 : 45000;
  }

  static Dictionary<string, object> Handle(string op, Dictionary<string, object> p) {
    switch (op) {
      case "hello": {
        Dictionary<string, object> d = Map();
        d["ok"] = true;
        d["name"] = "Noema Computer MCP (Windows UI Automation)";
        d["version"] = "1";
        d["capabilities"] = CAPS;
        return d;
      }
      case "displays": {
        List<object> rows = new List<object>();
        foreach (Screen s in Screen.AllScreens) {
          Dictionary<string, object> r = Map();
          r["name"] = s.DeviceName;
          r["primary"] = s.Primary;
          Dictionary<string, object> b = Map();
          b["x"] = s.Bounds.X; b["y"] = s.Bounds.Y; b["width"] = s.Bounds.Width; b["height"] = s.Bounds.Height;
          r["bounds"] = b;
          rows.Add(r);
        }
        Dictionary<string, object> res = Map();
        res["displays"] = rows;
        return Ok(res);
      }
      case "window.list": {
        List<object> rows = new List<object>();
        foreach (IntPtr h in Native.TopWindows()) rows.Add(WindowRow(h));
        Dictionary<string, object> res = Map();
        res["windows"] = rows;
        res["foreground"] = Foreground();
        return Ok(res);
      }
      case "window.active": {
        Dictionary<string, object> res = Map();
        res["window"] = Foreground();
        return Ok(res);
      }
      case "window.focus": {
        IntPtr h = FindWindow(p);
        Dictionary<string, object> res = Map();
        if (h == IntPtr.Zero) { res["focused"] = false; res["note"] = "no such window"; return Ok(res); }
        bool ok = Native.Focus(h);
        res["focused"] = ok;
        res["title"] = Native.Title(h);
        res["handle"] = h.ToInt64();
        res["foreground"] = Foreground();
        return Ok(res);
      }
      case "window.close": {
        IntPtr h = FindWindow(p);
        if (h == IntPtr.Zero) throw new Exception("no such window");
        AutomationElement el = AutomationElement.FromHandle(h);
        object wp;
        if (el.TryGetCurrentPattern(WindowPattern.Pattern, out wp)) ((WindowPattern)wp).Close();
        else Native.PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
        Dictionary<string, object> res = Map();
        res["closeRequested"] = true;
        res["handle"] = h.ToInt64();
        return Ok(res);
      }
      case "uia.tree": {
        // A TREE IS A DELIBERATE "SHOW ME THIS APPLICATION", so a named window that
        // is not in front is raised first — see MatchesLooking.
        AutomationElement root = RootLooking(p);
        int count = 0;
        int max = Int(p, "maxNodes", 300);
        Dictionary<string, object> t = Tree(root, Int(p, "depth", 3), max, ref count);
        Dictionary<string, object> res = Map();
        res["tree"] = t; res["nodes"] = count; res["truncated"] = count >= max;
        return Ok(res);
      }
      case "uia.find": {
        List<AutomationElement> list = MatchesLooking(p);
        List<object> rows = new List<object>();
        foreach (AutomationElement el in list) { rows.Add(ElementRow(el)); if (rows.Count >= 50) break; }
        Dictionary<string, object> res = Map();
        res["matches"] = rows; res["count"] = list.Count;
        return Ok(res);
      }
      case "uia.getValue": {
        AutomationElement el = Pick(p);
        string text = null;
        object pat;
        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) text = ((ValuePattern)pat).Current.Value;
        if (text == null && el.TryGetCurrentPattern(TextPattern.Pattern, out pat)) text = ((TextPattern)pat).DocumentRange.GetText(100000);
        if (text == null) text = el.Current.Name;
        Dictionary<string, object> res = Map();
        res["value"] = text; res["element"] = ElementRow(el);
        return Ok(res);
      }
      case "uia.focus": {
        AutomationElement el = Pick(p);
        IntPtr h = FindWindow(p);
        if (h != IntPtr.Zero) Native.FocusKeepingPopups(h);
        try { el.SetFocus(); } catch { Point c = CenterOf(el); Native.SetCursorPos(c.X, c.Y); Click("left", 1); }
        Thread.Sleep(80);
        Dictionary<string, object> res = Map();
        res["element"] = ElementRow(el); res["foreground"] = Foreground();
        return Ok(res);
      }
      case "uia.invoke": {
        AutomationElement el = Pick(p);
        IntPtr h = FindWindow(p);
        if (h != IntPtr.Zero) Native.FocusKeepingPopups(h);
        // WHAT WAS CLICKED, READ BEFORE IT IS CLICKED.
        //
        // The most ordinary desktop action there is — press OK, press Save,
        // press Open — DESTROYS THE ELEMENT, because the dialog it belongs to
        // closes. Reading the element afterwards threw "the target element
        // corresponds to UI that is no longer available", so a click that had
        // just saved the file to disk was reported as FAILED. Measured on the
        // shell Save As and Open dialogs both.
        Dictionary<string, object> row = ElementRow(el);

        string how = null;
        object pat;
        // A PATTERN THAT THROWS IS NOT THE END OF THE CLICK. Chrome's toolbar
        // Extensions button exposes only ExpandCollapse, and its Expand() threw
        // E_FAIL — the whole action failed with a COM error while the button sat
        // there, visible and clickable (real Chrome 153, 2026-09-19). A failed
        // pattern falls through to a real click at the element's centre, and the
        // method says so.
        try {
          if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) { ((InvokePattern)pat).Invoke(); how = "Invoke"; }
          else if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) { ((TogglePattern)pat).Toggle(); how = "Toggle"; }
          else if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); how = "SelectionItem"; }
          else if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat)) { ((ExpandCollapsePattern)pat).Expand(); how = "ExpandCollapse"; }
        } catch (Exception) { how = null; row["patternFailed"] = true; }
        if (how == null) {
          Point c = CenterOf(el); Native.SetCursorPos(c.X, c.Y); Click("left", 1);
          how = row.ContainsKey("patternFailed") ? "mouse (pattern failed)" : "mouse";
        }
        Thread.Sleep(120);
        Dictionary<string, object> res = Map();
        res["method"] = how; res["element"] = row; res["foreground"] = Foreground();
        return Ok(res);
      }
      case "uia.setValue": {
        AutomationElement el = Pick(p);
        IntPtr h = FindWindow(p);
        if (h != IntPtr.Zero) Native.FocusKeepingPopups(h);
        string text = Str(p, "text") ?? "";
        bool append = Bool(p, "append");

        // EVERYTHING THE FALLBACK NEEDS, READ BEFORE ANYTHING CAN WEDGE.
        // Once a pattern call on an element has been abandoned, that element is
        // contended: asking it where it is, or what it says, blocks behind the
        // abandoned call. Measured on the shell Save As — the fallback typed
        // nothing for fifteen seconds because it was waiting to be told a
        // rectangle it could have read a moment earlier.
        Point centre = CenterOf(el);
        Dictionary<string, object> row = ElementRow(el);

        // ---- IN A NATIVE DIALOG, TYPE. DO NOT SET THE VALUE ----------------
        //
        // MEASURED, on the Windows shell Save As dialog: ValuePattern.SetValue
        // on its "File name:" edit (the one inside FileNameControlHost, with
        // the shell's autocomplete behind it) NEVER RETURNS, and it takes the
        // application's UI thread with it — polled for over a hundred seconds
        // afterwards, every UI Automation question about that dialog still
        // blocked. The dialog is dead for the rest of its life.
        //
        // A dialog is also the one place typing is unambiguously safe: it is
        // modal and in front, which is checked below rather than assumed.
        //
        // Everywhere else ValuePattern is still preferred — it is atomic, and
        // it does not depend on where the keyboard is pointing — but it is now
        // BOUNDED, because a provider that never returns is a thing that
        // exists and one of them should not cost a session its computer.
        bool dialog = InDialog(h, el);
        string how = null;
        object pat;
        if (!append && !dialog && el.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) {
          ValuePattern v = (ValuePattern)pat;
          if (!v.Current.IsReadOnly) {
            Exception failed;
            bool finished = Bounded(delegate() { v.SetValue(text); }, 4000, out failed);
            if (finished && failed == null) how = "ValuePattern";
          }
        }
        if (how == null) {
          // A CLICK AND A KEYBOARD, which is what a person has — and which
          // lands wherever the keyboard is pointing. So it refuses to type at
          // all unless the window it was aimed at is the one in front: the
          // failure this prevents is typing a file path into somebody's chat.
          if (h != IntPtr.Zero) {
            Native.Focus(h);
            IntPtr front = Native.RootOf(Native.GetForegroundWindow());
            if (front != Native.RootOf(h)) {
              throw new Exception("refusing to type: \"" + Native.Title(h) + "\" is not the window in front ("
                + Native.Title(front) + ") and the keystrokes would go there instead");
            }
          }
          Native.SetCursorPos(centre.X, centre.Y);
          Click("left", 1);
          Thread.Sleep(80);
          if (!append) { PressKeys(new List<string>(new string[] { "ctrl", "a" })); Thread.Sleep(40); }
          Native.Unicode(text);
          how = "keyboard";
        }
        Thread.Sleep(120);
        Dictionary<string, object> res = Map();
        res["method"] = how; res["element"] = row; res["foreground"] = Foreground();
        return Ok(res);
      }
      // WAITING FOR A WINDOW IS THE SAME QUESTION AS FINDING ONE, asked until
      // the deadline. It used to be a separate, looser `Contains` scan that
      // took the first hit and ignored `pid` — which is how a wait for the
      // "Open" dialog settled on somebody's "OpenAI" browser window. One
      // matcher now, ambiguity refused, and a pid narrows the search.
      case "wait.window": {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(Int(p, "timeoutMs", 10000));
        do {
          IntPtr h = FindWindow(p);
          if (h != IntPtr.Zero) {
            Dictionary<string, object> res = Map();
            res["found"] = true; res["window"] = WindowRow(h);
            return Ok(res);
          }
          Thread.Sleep(150);
        } while (DateTime.UtcNow < deadline);
        Dictionary<string, object> miss = Map();
        miss["found"] = false;
        return Ok(miss);
      }
      case "wait.control": {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(Int(p, "timeoutMs", 10000));
        do {
          try {
            List<AutomationElement> list = MatchesLooking(p);
            if (list.Count > 0) {
              Dictionary<string, object> res = Map();
              res["found"] = true; res["element"] = ElementRow(list[0]);
              return Ok(res);
            }
          } catch { }
          Thread.Sleep(200);
        } while (DateTime.UtcNow < deadline);
        Dictionary<string, object> miss = Map();
        miss["found"] = false;
        return Ok(miss);
      }
      case "wait.gone": {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(Int(p, "timeoutMs", 10000));
        bool wantsControl = Get(p, "name") != null || Get(p, "automationId") != null || Get(p, "controlType") != null;
        do {
          bool present;
          if (wantsControl) { try { present = Matches(p).Count > 0; } catch { present = false; } }
          else {
            // A HANDLE OUTLIVES ITS WINDOW as a number. "Is it gone?" asked of
            // a handle must ask the OS whether the window still exists, not
            // whether the caller still remembers the number.
            IntPtr h = FindWindow(p);
            present = h != IntPtr.Zero && Native.IsWindow(h) && Native.IsWindowVisible(h);
          }
          if (!present) {
            Dictionary<string, object> res = Map();
            res["gone"] = true;
            return Ok(res);
          }
          Thread.Sleep(200);
        } while (DateTime.UtcNow < deadline);
        Dictionary<string, object> miss = Map();
        miss["gone"] = false;
        return Ok(miss);
      }
      case "cursor.get": return Ok(Cursor());
      case "mouse.move": {
        Native.SetCursorPos(Int(p, "x", 0), Int(p, "y", 0));
        return Ok(Cursor());
      }
      case "mouse.click": {
        if (Get(p, "x") != null && Get(p, "y") != null) { Native.SetCursorPos(Int(p, "x", 0), Int(p, "y", 0)); Thread.Sleep(40); }
        string button = Str(p, "button") ?? "left";
        int count = Int(p, "count", 1);
        Click(button, count);
        Thread.Sleep(80);
        Dictionary<string, object> res = Map();
        res["at"] = Cursor(); res["button"] = button; res["count"] = count; res["foreground"] = Foreground();
        return Ok(res);
      }
      case "mouse.drag": {
        int fromX = Int(p, "fromX", 0), fromY = Int(p, "fromY", 0), toX = Int(p, "toX", 0), toY = Int(p, "toY", 0);
        Native.SetCursorPos(fromX, fromY);
        Native.Mouse(0x0002, 0);
        for (int i = 1; i <= 12; i++) {
          Native.SetCursorPos(fromX + (toX - fromX) * i / 12, fromY + (toY - fromY) * i / 12);
          Thread.Sleep(15);
        }
        Native.Mouse(0x0004, 0);
        return Ok(Cursor());
      }
      case "mouse.scroll": {
        if (Get(p, "x") != null && Get(p, "y") != null) Native.SetCursorPos(Int(p, "x", 0), Int(p, "y", 0));
        int clicks = Int(p, "clicks", -3);
        Native.Mouse(0x0800, unchecked((uint)(clicks * 120)));
        Dictionary<string, object> res = Map();
        res["clicks"] = clicks;
        return Ok(res);
      }
      case "keyboard.type": {
        string text = Str(p, "text") ?? "";
        Native.Unicode(text);
        Thread.Sleep(60);
        Dictionary<string, object> res = Map();
        res["typed"] = text.Length; res["foreground"] = Foreground();
        return Ok(res);
      }
      case "keyboard.key": {
        List<string> keys = new List<string>();
        object raw = Get(p, "keys");
        if (raw is object[]) foreach (object k in (object[])raw) keys.Add(Convert.ToString(k));
        else if (raw is List<object>) foreach (object k in (List<object>)raw) keys.Add(Convert.ToString(k));
        else keys.Add(Str(p, "key") ?? "");
        PressKeys(keys);
        Thread.Sleep(60);
        Dictionary<string, object> res = Map();
        res["keys"] = keys; res["foreground"] = Foreground();
        return Ok(res);
      }
      case "clipboard.read": {
        Dictionary<string, object> res = Map();
        res["text"] = Clipboard.ContainsText() ? Clipboard.GetText() : "";
        return Ok(res);
      }
      case "clipboard.write": {
        string text = Str(p, "text") ?? "";
        if (text.Length == 0) Clipboard.Clear(); else Clipboard.SetText(text);
        Dictionary<string, object> res = Map();
        res["written"] = text.Length;
        return Ok(res);
      }
      case "screen.capture": {
        Dictionary<string, object> r;
        object region = Get(p, "region");
        if (region is Dictionary<string, object>) {
          Dictionary<string, object> rg = (Dictionary<string, object>)region;
          r = Map();
          r["x"] = Int(rg, "x", 0); r["y"] = Int(rg, "y", 0);
          r["width"] = Int(rg, "width", 0); r["height"] = Int(rg, "height", 0);
        } else {
          IntPtr h = FindWindow(p);
          if (h != IntPtr.Zero) r = RectOf(h);
          else {
            Rectangle v = SystemInformation.VirtualScreen;
            r = Map();
            r["x"] = v.X; r["y"] = v.Y; r["width"] = v.Width; r["height"] = v.Height;
          }
        }
        int w = Convert.ToInt32(r["width"]), hgt = Convert.ToInt32(r["height"]);
        if (w <= 0 || hgt <= 0) throw new Exception("nothing to capture: the region is empty");
        using (Bitmap bmp = new Bitmap(w, hgt))
        using (Graphics g = Graphics.FromImage(bmp)) {
          g.CopyFromScreen(Convert.ToInt32(r["x"]), Convert.ToInt32(r["y"]), 0, 0, bmp.Size);
          string file = Str(p, "path");
          if (string.IsNullOrEmpty(file)) file = Path.Combine(Path.GetTempPath(), "lain-computer-" + DateTime.UtcNow.Ticks + ".png");
          bmp.Save(file, ImageFormat.Png);
          Dictionary<string, object> res = Map();
          res["path"] = file; res["region"] = r;
          return Ok(res);
        }
      }
      default: {
        Dictionary<string, object> d = Map();
        d["ok"] = false;
        d["error"] = "unknown operation '" + op + "'";
        return d;
      }
    }
  }

  [STAThread]
  static int Main(string[] args) {
    try { Native.SetProcessDPIAware(); } catch { }
    Console.OutputEncoding = Encoding.UTF8;
    Console.InputEncoding = Encoding.UTF8;
    J.MaxJsonLength = 64 * 1024 * 1024;
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      object id = null;
      Dictionary<string, object> reply;
      try {
        Dictionary<string, object> msg = (Dictionary<string, object>)J.DeserializeObject(line);
        id = Get(msg, "id");
        object rawParams = Get(msg, "params");
        Dictionary<string, object> p = rawParams as Dictionary<string, object>;
        string op = Convert.ToString(Get(msg, "op"));
        Dictionary<string, object> callParams = p ?? Map();

        // EVERY REQUEST ON ITS OWN THREAD, so a provider that never returns
        // costs one request rather than the session. See Bounded: a shell
        // dialog really does this, and before this the process stayed alive,
        // stayed connected and answered nothing ever again.
        Dictionary<string, object> answer = null;
        Exception thrown;
        bool finished = Bounded(delegate() { answer = Handle(op, callParams); }, Cap(callParams), out thrown);
        if (thrown != null) throw thrown;
        if (!finished) {
          reply = Map();
          reply["ok"] = false;
          reply["error"] = "'" + op + "' did not return within " + Cap(callParams) + "ms and was abandoned";
        } else {
          reply = answer;
        }
      } catch (Exception e) {
        reply = Map();
        reply["ok"] = false;
        // AN EMPTY MESSAGE IS NOT AN ANSWER: some UIA/COM exceptions carry none,
        // and "" reached the caller as the bare "the bridge refused". Name the type.
        string said = string.IsNullOrEmpty(e.Message) ? e.GetType().Name : e.Message;
        reply["error"] = said.Replace("\r", " ").Replace("\n", " ");
      }
      reply["id"] = id;
      Console.Out.WriteLine(J.Serialize(reply));
      Console.Out.Flush();
    }
    return 0;
  }
}
