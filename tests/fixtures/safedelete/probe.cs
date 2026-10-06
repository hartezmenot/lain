// Test probe for distribution/safedelete.cs and Setup.RemovableData's rule (tests/unit/safedelete.test.js).
//   probe tree <path>        remove a tree with SafeDelete.Tree; prints ok|failed files dirs links why
//   probe refusal <path>     print SafeDelete.Refusal(path) (never deletes)
using System;
static class Probe {
  static int Main(string[] a) {
    if (a.Length == 2 && a[0] == "tree") {
      var r = SafeDelete.Tree(a[1]);
      Console.WriteLine((r.Ok ? "ok" : "failed") + "|" + r.Files + "|" + r.Dirs + "|" + r.Links + "|" + (r.Why ?? "") + "|" + string.Join(";", r.Errors.ToArray()));
      return r.Ok ? 0 : 1;
    }
    if (a.Length == 2 && a[0] == "refusal") { Console.WriteLine(SafeDelete.Refusal(a[1]) ?? "(allowed)"); return 0; }
    Console.Error.WriteLine("usage: probe tree|refusal <path>");
    return 2;
  }
}
