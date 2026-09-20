// A REAL WINDOWS PSEUDOCONSOLE, spoken to over stdio.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SEPARATE PROGRAM AND NOT PART OF THE HOST.
//
// The Terminal drawer needs a REAL terminal: a shell that believes it is
// attached to a console, so it prints colour, redraws a progress bar, answers
// Ctrl+C, and reflows when the panel is resized. A pipe cannot do any of that —
// a program that detects a pipe turns all of it off, which is why "run a command
// and show the output" is not a terminal.
//
// Windows offers exactly one way to get that: ConPTY (`CreatePseudoConsole`,
// Windows 10 1809+). Node cannot call it without a native addon, and LAIN has
// ZERO runtime dependencies and intends to keep them. So this follows the
// pattern the Computer MCP bridge already established: a small C# program
// compiled on demand by the `csc.exe` that is part of Windows, cached by the
// hash of its own source.
//
// IT IS NOT IN native/host.cs, deliberately. The host is a PRESENTATION host
// that owns a window and no authority. A shell running under the window would
// be process ownership living in the wrong place — Core owns processes
// (harness/processes.js, jobs.js), Core spawns this, and Core decides what it
// may do. The renderer only ever sees bytes.
//
// ---------------------------------------------------------------------------
// THE PROTOCOL, which is deliberately tiny.
//
//   in  (stdin, one JSON object per line)
//       {"op":"input","data":"<base64>"}     keystrokes, verbatim
//       {"op":"resize","cols":N,"rows":N}    the panel changed size
//       {"op":"signal","name":"int"}         Ctrl+C, as a console event
//       {"op":"kill"}                        end it now
//
//   out (stdout, one JSON object per line)
//       {"ev":"ready","pid":N}
//       {"ev":"data","data":"<base64>"}      whatever the shell wrote
//       {"ev":"exit","code":N}
//       {"ev":"error","why":"..."}
//
// BASE64 BOTH WAYS. A terminal emits control sequences, partial UTF-8 and
// arbitrary bytes; putting those through JSON as text corrupts them, and
// corrupting the one channel whose job is fidelity defeats the point.

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class Pty {
  const int STILL_ACTIVE = 259;

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CreatePipe(out IntPtr hRead, out IntPtr hWrite, IntPtr attrs, int size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr hPC);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern void ClosePseudoConsole(IntPtr hPC);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);

  // ---- THE STARTUP INFO IS PASSED AS RAW MEMORY ---------------------------
  //
  // `ref STARTUPINFOEX` marshalled through the CLR was the bug that cost this
  // file an afternoon: `CreateProcessW` returned TRUE with GetLastError 0, the
  // attribute list was well-formed, `cb` was the right 112 bytes — and the
  // child was NOT attached to the pseudoconsole. It inherited the bridge's own
  // stdout instead, so the shell's banner came back as raw text on the wrong
  // channel while the pty emitted only its two handshake sequences.
  //
  // Passing a pointer to memory this code laid out itself removes every
  // question about how the CLR chose to marshal a nested struct.
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(
    string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string cwd, IntPtr si, out PROCESS_INFORMATION pi);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(
    IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern void DeleteProcThreadAttributeList(IntPtr list);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr h, uint ms);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr h, uint code);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GenerateConsoleCtrlEvent(uint evt, uint groupId);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool FreeConsole();

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AttachConsole(uint pid);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);

  [StructLayout(LayoutKind.Sequential)]
  struct COORD { public short X; public short Y; }

  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

  // ---- BLITTABLE ON PURPOSE, AND THIS WAS A REAL BUG -----------------------
  //
  // These were declared with `string` fields for lpReserved/lpDesktop/lpTitle,
  // which is how the Win32 headers read — and it silently broke the whole
  // thing. A struct containing `string` is NON-BLITTABLE: the CLR marshals it
  // field by field into a temporary copy, and the layout of the copy did not
  // match what `CreateProcessW` expects for an EXTENDED_STARTUPINFO. The call
  // SUCCEEDED and quietly ignored the attribute list, so the shell was never
  // attached to the pseudoconsole — it inherited the bridge's own stdout
  // instead, and its output came back as raw text on the wrong channel while
  // the pty produced nothing but its two init sequences.
  //
  // Nothing here ever sets those three fields, so they are IntPtr. Both structs
  // are now blittable, marshalled as-is, and the attribute takes effect.
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFO {
    public int cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  static IntPtr hPC = IntPtr.Zero;
  static IntPtr toChild = IntPtr.Zero;      // we write, the shell reads
  static IntPtr toConsole = IntPtr.Zero;    // we write, the PSEUDOCONSOLE reads
  static FileStream consoleOut;
  static IntPtr fromChild = IntPtr.Zero;    // the shell writes, we read
  static PROCESS_INFORMATION child;
  static readonly object outLock = new object();
  static volatile bool ending;

  static void Emit(Dictionary<string, object> o) {
    string line = new JavaScriptSerializer().Serialize(o);
    lock (outLock) { Console.Out.Write(line + "\n"); Console.Out.Flush(); }
  }

  static void Fail(string why) {
    var d = new Dictionary<string, object>();
    d["ev"] = "error"; d["why"] = why;
    Emit(d);
    Environment.Exit(3);
  }

  static int Main(string[] argv) {
    // ---- WHAT TO RUN, AND WHERE ----------------------------------------
    //
    // Given by Core on the command line. Nothing is defaulted from the
    // environment here: the shell and the working directory are decisions the
    // session owns, and a terminal that guessed its own cwd would be a second
    // answer to "which project is this".
    string shell = null, cwd = null;
    short cols = 120, rows = 30;
    for (int i = 0; i < argv.Length; i++) {
      if (argv[i] == "--shell" && i + 1 < argv.Length) shell = argv[++i];
      else if (argv[i] == "--cwd" && i + 1 < argv.Length) cwd = argv[++i];
      else if (argv[i] == "--cols" && i + 1 < argv.Length) cols = short.Parse(argv[++i]);
      else if (argv[i] == "--rows" && i + 1 < argv.Length) rows = short.Parse(argv[++i]);
    }
    if (String.IsNullOrEmpty(shell)) { Fail("no shell was named"); return 3; }
    if (String.IsNullOrEmpty(cwd) || !Directory.Exists(cwd)) { Fail("the working directory does not exist: " + cwd); return 3; }

    // ---- INHERITABLE, BECAUSE THE SHELL IS GIVEN THESE ENDS DIRECTLY -----
    //
    // See the note at CreateProcessW below for why the child receives the
    // pseudoconsole's own ends as its std handles rather than being left to
    // pick them up from the console it is attached to.
    var sa = new SECURITY_ATTRIBUTES();
    sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
    sa.bInheritHandle = 1;
    IntPtr saPtr = Marshal.AllocHGlobal(sa.nLength);
    Marshal.StructureToPtr(sa, saPtr, false);

    IntPtr inRead, inWrite, outRead, outWrite;
    if (!CreatePipe(out inRead, out inWrite, saPtr, 0)) { Fail("the console input pipe could not be created"); return 3; }
    if (!CreatePipe(out outRead, out outWrite, saPtr, 0)) { Fail("the output pipe could not be created"); return 3; }

    // ---- THE SHELL GETS ITS OWN STDIN, AND THIS IS NOT A DETAIL ----------
    //
    // The console-input pipe above belongs to the pseudoconsole: ConPTY reads
    // it and turns keystrokes into console input events. The shell is ALSO
    // handed explicit std handles (see below), so if it were given that same
    // read end the two would race for every byte — measured: a prompt appeared
    // and then no command ever ran, because ConPTY and cmd.exe were each
    // consuming half the keystrokes.
    //
    // So the shell reads from a pipe of its own. Output still travels through
    // the pseudoconsole, which is where colour, redraw and reflow come from;
    // resize is a direct ResizePseudoConsole call and needs no keystrokes.
    IntPtr shellIn, shellInWrite;
    if (!CreatePipe(out shellIn, out shellInWrite, saPtr, 0)) { Fail("the shell input pipe could not be created"); return 3; }

    toChild = shellInWrite;
    toConsole = inWrite;
    fromChild = outRead;

    COORD size; size.X = cols; size.Y = rows;
    int hr = CreatePseudoConsole(size, inRead, outWrite, 0, out hPC);
    if (hr != 0) {
      // THE ONE PLATFORM BOUNDARY WORTH NAMING. ConPTY arrived in Windows 10
      // 1809; on anything older there is no pseudoconsole to create, and the
      // honest answer is to say so rather than fall back to a pipe pretending
      // to be a terminal.
      Fail("this Windows has no pseudoconsole (ConPTY needs Windows 10 1809 or newer): 0x" + hr.ToString("X8"));
      return 3;
    }
    // THE PSEUDOCONSOLE OWNS THESE ENDS, AND SO DOES THE CHILD. The reference
    // implementation closes them here; this one cannot, because the shell is
    // handed the same ends as its std handles — see CreateProcessW below.

    IntPtr attrSize = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
    IntPtr attrList = Marshal.AllocHGlobal(attrSize);
    if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) { Fail("the process attribute list could not be built"); return 3; }
    // 0x00020016 = PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
    if (!UpdateProcThreadAttribute(attrList, 0, (IntPtr)0x00020016, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) {
      Fail("the pseudoconsole could not be attached to the process");
      return 3;
    }

    // THE STRUCT, LAID OUT BY HAND. 104 bytes of STARTUPINFO followed by the
    // attribute-list pointer; `cb` is the size of the whole thing.
    int sizeofStartupInfo = 104;                 // x64 STARTUPINFO
    int sizeofEx = sizeofStartupInfo + IntPtr.Size;
    IntPtr siPtr = Marshal.AllocHGlobal(sizeofEx);
    for (int z = 0; z < sizeofEx; z++) Marshal.WriteByte(siPtr, z, 0);
    Marshal.WriteInt32(siPtr, 0, sizeofEx);      // StartupInfo.cb
    // ---- THE SHELL IS GIVEN THE CONSOLE'S ENDS EXPLICITLY ----------------
    //
    // THIS IS THE LINE THAT MADE IT WORK, and it is worth recording why.
    //
    // The documented arrangement is: attach PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
    // and let the child pick up std handles from the console it lands on. On
    // this machine (Windows 11 26200) that half does not happen. Measured, with
    // a minimal standalone program built the same way: CreatePseudoConsole
    // returns S_OK, the attribute list is well-formed, UpdateProcThreadAttribute
    // and CreateProcessW both succeed with GetLastError 0, the pty emits its
    // client handshake — and the shell's output still goes to whatever std
    // handles the PARENT had. Under Core (stdio pipes) that meant the shell's
    // banner arrived as raw text on the bridge's own stdout while the terminal
    // stayed blank.
    //
    // So the child is told, explicitly, that its console ends ARE its std
    // handles: STARTF_USESTDHANDLES with the pseudoconsole's own read/write
    // ends, and inheritable pipes so it can receive them. The attribute stays —
    // it is what makes the shell believe it has a console at all, which is
    // where resize, Ctrl+C and colour come from.
    //
    // ---- WHAT THIS COSTS, AND WHAT WAS TRIED INSTEAD (2026-09-16) -------
    //
    // A shell given a PIPE for stdin is not interactive: it reads no console
    // input, so a keystroke cannot arrive as a Ctrl+C. Four arrangements were
    // measured on Windows 11 26200 against `Start-Sleep -Seconds 20`, and NONE
    // of them interrupted PowerShell:
    //
    //   pipe stdin (this)            the sleep ran to completion
    //   no STARTF_USESTDHANDLES      the shell inherited the BRIDGE'S stdin and
    //                                began parsing LAIN's own protocol JSON as
    //                                PowerShell — the attribute gives the child
    //                                a console for OUTPUT but not for input
    //   stdin NULL, so it opens      typing, prompts and reflow all worked;
    //   CONIN$ for itself            the sleep still ran to completion
    //   + CREATE_NEW_PROCESS_GROUP   CTRL_BREAK aimed at the shell's own group:
    //                                no change
    //
    // In every case AttachConsole and GenerateConsoleCtrlEvent SUCCEEDED. The
    // event is raised and PowerShell does not act on it. So this stays on the
    // arrangement that is known to work for typing, colour, reflow and width,
    // and the panel offers End shell as the action that actually stops things.
    // See Interrupt below, which now says when it could not raise the event.
    Marshal.WriteInt32(siPtr, 60, 0x00000100);   // dwFlags = STARTF_USESTDHANDLES
    Marshal.WriteIntPtr(siPtr, 80, shellIn);     // hStdInput — its own, never the console's
    Marshal.WriteIntPtr(siPtr, 88, outWrite);    // hStdOutput
    Marshal.WriteIntPtr(siPtr, 96, outWrite);    // hStdError
    Marshal.WriteIntPtr(siPtr, sizeofStartupInfo, attrList);

    // ---- THE BRIDGE MUST NOT SHARE A CONSOLE WITH THE SHELL IT HOSTS -----
    //
    // THIS WAS THE BUG. Core spawns this bridge as an ordinary console program,
    // so it inherits whatever console its parent had. A child created with the
    // pseudoconsole attribute is supposed to attach to the PTY — but a process
    // that already has a console hands that console down instead, and the
    // attribute is quietly ignored. `CreateProcessW` returned TRUE, the
    // attribute list was well-formed, `cb` was right, GetLastError was 0, and
    // the shell's banner came back on the bridge's own stdout while the pty
    // emitted nothing but its two handshake sequences.
    //
    // Detaching first leaves nothing to inherit, so the pseudoconsole is the
    // only console the shell can have. The bridge's OWN stdio is unaffected:
    // those are pipes from Core, not the console.
    FreeConsole();

    // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT
    uint flags = 0x00080000 | 0x00000400;
    // (CREATE_NEW_PROCESS_GROUP, so a control event could be aimed at the shell
    // as a group leader, was measured and made no difference — see Interrupt.)
    bool started = CreateProcessW(null, shell, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, cwd, siPtr, out child);
    int lastErr = Marshal.GetLastWin32Error();
    if (Environment.GetEnvironmentVariable("LAIN_PTY_DEBUG") == "1") {
      var dbg = new Dictionary<string, object>();
      dbg["ev"] = "debug";
      dbg["sizeofEx"] = sizeofEx;
      dbg["cb"] = Marshal.ReadInt32(siPtr, 0);
      dbg["attrList"] = attrList.ToInt64();
      dbg["attrSize"] = attrSize.ToInt64();
      dbg["hPC"] = hPC.ToInt64();
      dbg["started"] = started;
      dbg["lastError"] = lastErr;
      COORD probe; probe.X = cols; probe.Y = rows;
      dbg["resizeHr"] = ResizePseudoConsole(hPC, probe);
      dbg["ptrSize"] = IntPtr.Size;
      dbg["is64"] = Environment.Is64BitProcess;
      Emit(dbg);
    }
    if (!started) {
      Fail("the shell could not be started: " + lastErr + " (" + shell + ")");
      return 3;
    }

    var ready = new Dictionary<string, object>();
    ready["ev"] = "ready"; ready["pid"] = child.dwProcessId;
    Emit(ready);

    // ---- THE SHELL'S OUTPUT, AS BYTES ----------------------------------
    var pump = new Thread(delegate () {
      var buf = new byte[8192];
      using (var fs = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(fromChild, false), FileAccess.Read)) {
        while (!ending) {
          int n;
          try { n = fs.Read(buf, 0, buf.Length); } catch { break; }
          if (n <= 0) break;
          var d = new Dictionary<string, object>();
          d["ev"] = "data";
          d["data"] = Convert.ToBase64String(buf, 0, n);
          Emit(d);
        }
      }
    });
    pump.IsBackground = true;
    pump.Start();

    // ---- WHAT CORE SAYS -------------------------------------------------
    var writer = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(toChild, false), FileAccess.Write);
    consoleOut = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(toConsole, false), FileAccess.Write);
    var ser = new JavaScriptSerializer();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      Dictionary<string, object> msg;
      try { msg = ser.DeserializeObject(line) as Dictionary<string, object>; } catch { continue; }
      if (msg == null) continue;
      object opv;
      if (!msg.TryGetValue("op", out opv)) continue;
      string op = Convert.ToString(opv);

      if (op == "input") {
        object dv;
        if (!msg.TryGetValue("data", out dv)) continue;
        byte[] bytes;
        try { bytes = Convert.FromBase64String(Convert.ToString(dv)); } catch { continue; }
        try { writer.Write(bytes, 0, bytes.Length); writer.Flush(); } catch { break; }
      } else if (op == "resize") {
        COORD s2;
        s2.X = (short)Convert.ToInt32(msg.ContainsKey("cols") ? msg["cols"] : 120);
        s2.Y = (short)Convert.ToInt32(msg.ContainsKey("rows") ? msg["rows"] : 30);
        if (s2.X > 0 && s2.Y > 0) ResizePseudoConsole(hPC, s2);
      } else if (op == "signal") {
        // ---- CTRL+C GOES TO THE CONSOLE, NOT TO THE SHELL'S STDIN --------
        //
        // A shell reading 0x03 from a PIPE sees a byte; a shell attached to a
        // console sees an INTERRUPT. The pseudoconsole is what performs that
        // translation, so the byte is written to ITS input — which is also why
        // the two inputs are separate pipes (see the note where they are made).
        // Measured: written to the shell's stdin instead, `Start-Sleep 30` ran
        // to completion and Ctrl+C did nothing at all.
        Interrupt();
      } else if (op == "kill") {
        break;
      }
    }

    End();
    return 0;
  }

  /**
   * CTRL+C, AS A REAL CONSOLE CONTROL EVENT.
   *
   * A shell reading 0x03 from a pipe sees a byte; a shell attached to a console
   * sees an INTERRUPT, and only the second one stops the command it is running.
   * Measured: writing 0x03 to the shell's stdin left `Start-Sleep 30` running to
   * completion, and writing it to the pseudoconsole's input did the same —
   * modern ConPTY negotiates win32-input-mode (it sends ESC[?9001h at startup),
   * so a lone control byte is not what it is listening for.
   *
   * So the event is generated properly: attach to the console the shell is in,
   * send CTRL_C to that console's group, and detach again. The bridge ignores
   * the event itself first — it is attached at that moment, and a handler that
   * let it through would make Ctrl+C in the panel kill the terminal rather than
   * the command running in it.
   */
  static void Interrupt() {
    // 1. WIN32-INPUT-MODE, which is what ConPTY announced at startup with
    //    ESC[?9001h. A key event is ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _ —
    //    here 'C' (0x43) with LEFT_CTRL_PRESSED (0x8) and the control char 3,
    //    pressed then released.
    try {
      byte[] down = Encoding.ASCII.GetBytes("[67;46;3;1;8;1_");
      byte[] up = Encoding.ASCII.GetBytes("[67;46;3;0;8;1_");
      consoleOut.Write(down, 0, down.Length);
      consoleOut.Write(up, 0, up.Length);
      consoleOut.Flush();
    } catch { }
    // 2. AND A REAL CONSOLE CONTROL EVENT, for a shell that is not listening in
    //    win32-input-mode. Attaching to the shell's own console is the only way
    //    to raise one for it; the bridge ignores the event itself first, or
    //    Ctrl+C in the panel would kill the terminal rather than the command.
    //
    //    AND IT SAYS WHEN IT COULD NOT. This swallowed every failure, so an
    //    interrupt that did nothing looked exactly like an interrupt that
    //    worked — which is how it stayed broken through a whole pass while the
    //    panel offered a Ctrl+C button. A person pressing it deserves to know
    //    it did not land.
    try {
      FreeConsole();
      if (!AttachConsole((uint)child.dwProcessId)) {
        Console.Error.WriteLine("Ctrl+C: could not attach to the shell's console (error "
          + Marshal.GetLastWin32Error() + ")");
        return;
      }
      SetConsoleCtrlHandler(IntPtr.Zero, true);
      bool raised = GenerateConsoleCtrlEvent(0, 0);
      int err = raised ? 0 : Marshal.GetLastWin32Error();
      Thread.Sleep(50);
      SetConsoleCtrlHandler(IntPtr.Zero, false);
      if (!raised) Console.Error.WriteLine("Ctrl+C: the console refused the event (error " + err + ")");
    } catch (Exception e) { Console.Error.WriteLine("Ctrl+C: " + e.Message); }
    finally { try { FreeConsole(); } catch { } }
  }

  static void End() {
    if (ending) return;
    ending = true;
    // THE SHELL FIRST, THEN THE CONSOLE. Closing the pseudoconsole while the
    // shell is still attached leaves it writing into a handle nobody owns.
    uint code = 0;
    try {
      if (child.hProcess != IntPtr.Zero) {
        if (WaitForSingleObject(child.hProcess, 1500) != 0) { try { TerminateProcess(child.hProcess, 1); } catch { } }
        GetExitCodeProcess(child.hProcess, out code);
        if (code == STILL_ACTIVE) code = 1;
      }
    } catch { }
    try { if (hPC != IntPtr.Zero) ClosePseudoConsole(hPC); } catch { }
    var d = new Dictionary<string, object>();
    d["ev"] = "exit"; d["code"] = (int)code;
    Emit(d);
  }
}
