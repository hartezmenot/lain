// LAIN SAFE DELETE — the only way setup and the uninstaller remove a folder tree.
// ---------------------------------------------------------------------------
// WHY (2026-10-06): .NET Framework's Directory.Delete(dir, true) entered junctions inside LAIN's data folder (account
// homes link into ~\.codex) and deleted what they pointed at. Here:
//   * A LINK — symlink, junction, mount point, any reparse point — is removed AS A LINK. It is never entered, so what
//     it points at is never read, changed or deleted.
//   * Every path removed is proven to be inside the root: the walk only ever descends into real (non-reparse)
//     directories, and each such directory's canonical path (GetFinalPathNameByHandle) must still be under the root's.
//   * The root itself must be a real directory with a provable canonical path, and never a drive root, the Windows
//     folder, the user's profile or any folder that contains the profile. Anything unproven is refused, not guessed.
// ---------------------------------------------------------------------------
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class SafeDelete {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder buf, uint len, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool RemoveDirectoryW(string path);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeleteFileW(string path);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetFileAttributesW(string path, uint attrs);

  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint OPEN_EXISTING = 3, SHARE_ALL = 7, INVALID_ATTRS = 0xFFFFFFFF;
  const uint ATTR_READONLY = 0x1, ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400, ATTR_NORMAL = 0x80;
  static readonly IntPtr INVALID = new IntPtr(-1);

  public class Result { public bool Ok; public string Why; public int Files, Dirs, Links, Failed; public List<string> Errors = new List<string>(); }

  /// The canonical real path of an EXISTING path, without following it when it is itself a link (null = unprovable).
  public static string Canonical(string path, bool followLink) {
    IntPtr h = CreateFileW(@"\\?\" + Path.GetFullPath(path), 0, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | (followLink ? 0 : FILE_FLAG_OPEN_REPARSE_POINT), IntPtr.Zero);
    if (h == INVALID) return null;
    try {
      var sb = new StringBuilder(1024);
      uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
      if (n == 0 || n >= sb.Capacity) return null;
      string s = sb.ToString();
      if (s.StartsWith(@"\\?\UNC\")) s = @"\\" + s.Substring(8); else if (s.StartsWith(@"\\?\")) s = s.Substring(4);
      return s.TrimEnd('\\');
    } finally { CloseHandle(h); }
  }

  static bool Under(string child, string root) {
    return child.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
  }

  /// Why `root` may not be removed at all, or null when it may.
  public static string Refusal(string root) {
    if (string.IsNullOrEmpty(root)) return "no folder was named";
    string full;
    try { full = Path.GetFullPath(root).TrimEnd('\\'); } catch (Exception e) { return "the path is not valid: " + e.Message; }
    uint a = GetFileAttributesW(full);
    if (a == INVALID_ATTRS) return null;                                   // nothing there: nothing to refuse
    if ((a & ATTR_DIRECTORY) == 0) return full + " is not a folder";
    if ((a & ATTR_REPARSE) != 0) return null;                              // a link: only the link is removed (Tree)
    string real = Canonical(full, false);
    if (real == null) return "the real location of " + full + " could not be proven";
    if (Path.GetPathRoot(real).TrimEnd('\\').Equals(real, StringComparison.OrdinalIgnoreCase)) return real + " is a drive";
    foreach (var sf in new[] { Environment.SpecialFolder.UserProfile, Environment.SpecialFolder.Windows, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.ApplicationData, Environment.SpecialFolder.Desktop, Environment.SpecialFolder.MyDocuments }) {
      string p = Environment.GetFolderPath(sf);
      if (string.IsNullOrEmpty(p)) continue;
      string rp = Canonical(p, true) ?? Path.GetFullPath(p).TrimEnd('\\');
      if (rp.Equals(real, StringComparison.OrdinalIgnoreCase) || Under(rp, real)) return real + " is (or contains) " + rp;
    }
    return null;
  }

  /// Remove `root` and everything under it, never entering a link. Refuses (and removes nothing) when unproven.
  public static Result Tree(string root) {
    var r = new Result();
    string why = Refusal(root);
    if (why != null) { r.Why = "refused: " + why; return r; }
    string full = Path.GetFullPath(root).TrimEnd('\\');
    uint a = GetFileAttributesW(full);
    if (a == INVALID_ATTRS) { r.Ok = true; return r; }
    if ((a & ATTR_REPARSE) != 0) { Unlink(full, a, r); r.Ok = r.Failed == 0; return r; }   // the root is a link: the link goes
    string real = Canonical(full, false);
    Walk(full, real, real, r, 0);
    r.Ok = r.Failed == 0 && GetFileAttributesW(full) == INVALID_ATTRS;
    if (!r.Ok && r.Why == null) r.Why = r.Failed + " item(s) could not be removed (in use?)";
    return r;
  }

  static void Unlink(string p, uint attrs, Result r) {
    if ((attrs & ATTR_READONLY) != 0) SetFileAttributesW(p, attrs & ~ATTR_READONLY);
    bool ok = (attrs & ATTR_DIRECTORY) != 0 ? RemoveDirectoryW(p) : DeleteFileW(p);   // removes the LINK itself
    if (ok) r.Links++; else { r.Failed++; r.Errors.Add("link " + p + ": " + Marshal.GetLastWin32Error()); }
  }

  static void Walk(string dir, string realDir, string realRoot, Result r, int depth) {
    // CONTAINMENT, proven: this real directory is the root or strictly inside it.
    if (depth > 0 && !Under(realDir, realRoot)) { r.Failed++; r.Errors.Add("outside the root, not entered: " + realDir); return; }
    if (depth > 256) { r.Failed++; r.Errors.Add("too deep: " + dir); return; }
    string[] names;
    try { names = Directory.GetFileSystemEntries(dir); } catch (Exception e) { r.Failed++; r.Errors.Add(dir + ": " + e.Message); return; }
    foreach (string child in names) {
      uint a = GetFileAttributesW(child);
      if (a == INVALID_ATTRS) continue;
      if ((a & ATTR_REPARSE) != 0) { Unlink(child, a, r); continue; }          // never entered
      if ((a & ATTR_DIRECTORY) != 0) {
        string rc = Canonical(child, false);
        if (rc == null || !Under(rc, realRoot)) { r.Failed++; r.Errors.Add("containment not proven, left alone: " + child); continue; }
        Walk(child, rc, realRoot, r, depth + 1);
        continue;
      }
      if ((a & ATTR_READONLY) != 0) SetFileAttributesW(child, ATTR_NORMAL);
      if (DeleteFileW(child)) r.Files++; else { r.Failed++; r.Errors.Add(child + ": " + Marshal.GetLastWin32Error()); }
    }
    uint da = GetFileAttributesW(dir);
    if (da != INVALID_ATTRS && (da & ATTR_READONLY) != 0) SetFileAttributesW(dir, da & ~ATTR_READONLY);
    if (RemoveDirectoryW(dir)) r.Dirs++; else { r.Failed++; r.Errors.Add(dir + ": " + Marshal.GetLastWin32Error()); }
  }
}
