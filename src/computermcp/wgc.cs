// LAIN WINDOW CAPTURE — ONE frame of ONE window through Windows Graphics Capture, then exit (Phase CU).
//
// Usage: wgccapture.exe <hwnd> <out.png>    → prints {"ok":true,"width":…,"height":…} or {"ok":false,"error":"…"}
//
// ON DEMAND, NEVER A STREAM: a frame pool of one, the first frame arriving is copied to a SoftwareBitmap, encoded as a
// PNG, and the session is closed. Windows draws its own yellow capture border while it runs — the person can see it.
// No hook, no injection: the same public API the Snipping Tool uses. Built by src/computermcp.js only when asked.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using System.Threading.Tasks;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

static class Wgc {
  [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IGraphicsCaptureItemInterop {
    IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
    IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
  }

  [DllImport("d3d11.dll", EntryPoint = "D3D11CreateDevice")]
  static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint nLevels, uint sdk, out IntPtr device, out int level, out IntPtr context);
  [DllImport("d3d11.dll", EntryPoint = "CreateDirect3D11DeviceFromDXGIDevice")]
  static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
  [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr classId, [In] ref Guid iid, out IntPtr factory);
  [DllImport("combase.dll")] static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string s, int len, out IntPtr hstring);

  static readonly Guid IID_IDXGIDevice = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
  static readonly Guid IID_IGraphicsCaptureItem = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
  static readonly Guid IID_IInspectable = new Guid("AF86E2E0-B12D-4c6a-9C5A-D7AA65101E90");

  static IDirect3DDevice Device() {
    IntPtr dev, ctx; int level;
    int hr = D3D11CreateDevice(IntPtr.Zero, 1 /* HARDWARE */, IntPtr.Zero, 0x20 /* BGRA_SUPPORT */, IntPtr.Zero, 0, 7, out dev, out level, out ctx);
    if (hr < 0) hr = D3D11CreateDevice(IntPtr.Zero, 5 /* WARP */, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out dev, out level, out ctx);
    if (hr < 0) throw new Exception("D3D11CreateDevice failed 0x" + hr.ToString("X8"));
    IntPtr dxgi; Guid g = IID_IDXGIDevice;
    Marshal.ThrowExceptionForHR(Marshal.QueryInterface(dev, ref g, out dxgi));
    IntPtr inspectable;
    Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out inspectable));
    Marshal.Release(dxgi); Marshal.Release(ctx); Marshal.Release(dev);
    return (IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable);
  }

  static GraphicsCaptureItem ItemFor(IntPtr hwnd) {
    IntPtr hs; string cls = "Windows.Graphics.Capture.GraphicsCaptureItem";
    WindowsCreateString(cls, cls.Length, out hs);
    Guid iid = typeof(IGraphicsCaptureItemInterop).GUID; IntPtr f;
    Marshal.ThrowExceptionForHR(RoGetActivationFactory(hs, ref iid, out f));
    IGraphicsCaptureItemInterop interop = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(f);
    Guid item = IID_IGraphicsCaptureItem;
    IntPtr p = interop.CreateForWindow(hwnd, ref item);
    return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(p);
  }

  static int Main(string[] args) {
    try {
      if (args.Length < 2) throw new Exception("usage: wgccapture <hwnd> <out.png>");
      if (!GraphicsCaptureSession.IsSupported()) throw new Exception("Windows Graphics Capture is not supported here");
      IntPtr hwnd = new IntPtr(Convert.ToInt64(args[0]));
      string step = "device";
      try {
      IDirect3DDevice device = Device();
      step = "item";
      GraphicsCaptureItem item = ItemFor(hwnd);
      step = "pool " + item.Size.Width + "x" + item.Size.Height;
      Direct3D11CaptureFramePool pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, item.Size);
      step = "session";
      GraphicsCaptureSession session = pool.CreateCaptureSession(item);
      try { session.IsCursorCaptureEnabled = false; } catch { }
      // THE FIRST FRAME, asked for — the in-box compiler cannot subscribe to WinRT events, and one frame needs none.
      session.StartCapture();
      Direct3D11CaptureFrame frame = null;
      for (int i = 0; i < 250 && frame == null; i++) { frame = pool.TryGetNextFrame(); if (frame == null) Thread.Sleep(20); }
      if (frame == null) throw new Exception("no frame within 5 s (is the window minimized?)");
      step = "bitmap";
      SoftwareBitmap bmp = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Premultiplied).AsTask().GetAwaiter().GetResult();
      int w = bmp.PixelWidth, h = bmp.PixelHeight;
      using (InMemoryRandomAccessStream ms = new InMemoryRandomAccessStream()) {
        BitmapEncoder enc = BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, ms).AsTask().GetAwaiter().GetResult();
        enc.SetSoftwareBitmap(bmp);
        enc.FlushAsync().AsTask().GetAwaiter().GetResult();
        byte[] bytes = new byte[ms.Size];
        ms.Seek(0);
        DataReader r = new DataReader(ms.GetInputStreamAt(0));
        r.LoadAsync((uint)ms.Size).AsTask().GetAwaiter().GetResult();
        r.ReadBytes(bytes);
        File.WriteAllBytes(args[1], bytes);
      }
      frame.Dispose(); session.Dispose(); pool.Dispose();
      Console.WriteLine("{\"ok\":true,\"width\":" + w + ",\"height\":" + h + "}");
      return 0;
      } catch (Exception inner) { throw new Exception(step + ": " + inner.Message); }
    } catch (Exception e) {
      Console.WriteLine("{\"ok\":false,\"error\":\"" + (e.Message ?? e.GetType().Name).Replace("\\", "/").Replace("\"", "'").Replace("\r", " ").Replace("\n", " ") + "\"}");
      return 1;
    }
  }
}
