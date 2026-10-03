// A GAME-LIKE TARGET for tests/acceptance/computer-real.js: a window that reads RAW INPUT (WM_INPUT) the way games do
// and writes what it received to a log — raw keyboard make/break scan codes and summed raw mouse deltas. It proves
// LAIN's raw input mode delivers what a raw-input reader sees, with ordinary SendInput: no injection, no driver.
//
// Usage: rawinputtarget.exe <logfile>
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class RawTarget : Form {
  [StructLayout(LayoutKind.Sequential)] struct RAWINPUTDEVICE { public ushort UsagePage, Usage; public uint Flags; public IntPtr Target; }
  [StructLayout(LayoutKind.Sequential)] struct RAWINPUTHEADER { public uint Type, Size; public IntPtr Device, wParam; }
  [DllImport("user32.dll")] static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] d, uint n, uint size);
  [DllImport("user32.dll")] static extern uint GetRawInputData(IntPtr h, uint cmd, IntPtr data, ref uint size, uint headerSize);
  readonly string log; int dx, dy, keys;

  RawTarget(string log) {
    this.log = log;
    Text = "LAIN Raw Input Target";
    Width = 520; Height = 320;
    StartPosition = FormStartPosition.CenterScreen;
    File.WriteAllText(log, "ready\n");
  }

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    RAWINPUTDEVICE[] d = new RAWINPUTDEVICE[2];
    d[0].UsagePage = 1; d[0].Usage = 2; d[0].Target = Handle;   // mouse (foreground only, as a game)
    d[1].UsagePage = 1; d[1].Usage = 6; d[1].Target = Handle;   // keyboard
    RegisterRawInputDevices(d, 2, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x00FF) {   // WM_INPUT
      uint size = 0; uint hs = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
      GetRawInputData(m.LParam, 0x10000003, IntPtr.Zero, ref size, hs);
      IntPtr buf = Marshal.AllocHGlobal((int)size);
      try {
        if (GetRawInputData(m.LParam, 0x10000003, buf, ref size, hs) == size) {
          uint type = (uint)Marshal.ReadInt32(buf, 0);
          int off = (int)hs;
          if (type == 0) {   // RIM_TYPEMOUSE: usFlags(2) pad(2) buttons(4) rawButtons(4) lLastX(4) lLastY(4)
            int x = Marshal.ReadInt32(buf, off + 12), y = Marshal.ReadInt32(buf, off + 16);
            ushort flags = (ushort)Marshal.ReadInt16(buf, off);
            ushort btn = (ushort)Marshal.ReadInt16(buf, off + 4);
            if ((flags & 1) == 0) { dx += x; dy += y; }
            File.AppendAllText(log, "mouse " + x + " " + y + " flags " + flags + " buttons " + btn + " sum " + dx + " " + dy + "\n");
          } else if (type == 1) {   // RIM_TYPEKEYBOARD: MakeCode(2) Flags(2) Reserved(2) VKey(2) Message(4)
            ushort make = (ushort)Marshal.ReadInt16(buf, off), kf = (ushort)Marshal.ReadInt16(buf, off + 2), vk = (ushort)Marshal.ReadInt16(buf, off + 6);
            keys++;
            File.AppendAllText(log, "key make 0x" + make.ToString("X2") + " vk 0x" + vk.ToString("X2") + ((kf & 1) != 0 ? " up" : " down") + "\n");
          }
        }
      } finally { Marshal.FreeHGlobal(buf); }
    }
    base.WndProc(ref m);
  }

  [STAThread]
  static void Main(string[] args) { Application.EnableVisualStyles(); Application.Run(new RawTarget(args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "lain-rawtarget.log"))); }
}
