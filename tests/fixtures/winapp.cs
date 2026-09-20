// A NATIVE WINDOWS APPLICATION THE TEST SUITE OWNS.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS: THE SUITE USED TO DRIVE NOTEPAD.
//
// Driving a real application is the whole point of Computer MCP, and Notepad was
// the nearest one. But it runs on a DEVELOPER'S OWN MACHINE: Windows 11 Notepad
// is single-instance, so a second launch becomes a TAB in the one already open,
// and typing into it is typing into somebody's unsaved document. The suite was
// right to skip itself when a Notepad was open — and a case that skips itself
// whenever the machine is in normal use is a case that mostly does not run.
//
// So the fixture is OURS: started by the test, aimed at by PID, closed by the
// test, and incapable of colliding with anything a person has open. It is
// deliberately plain — a text box, two buttons, and the two real shell file
// dialogs — because what is under test is the BRIDGE, not the application.
//
// ---------------------------------------------------------------------------
// WHAT IT GIVES THE SUITE, and each one is a real capability:
//
//   WINDOW DISCOVERY     a titled top-level window with a known PID
//   UI AUTOMATION TREE   named controls, found structurally rather than by
//                        pixel position
//   TEXT INPUT           a box whose value can be read back for verification
//   NATIVE DIALOGS       SaveFileDialog and OpenFileDialog are real OS pickers,
//                        owned by this process — the same OS boundary a
//                        browser's file picker crosses, and reachable without
//                        depending on a browser deciding to raise one under
//                        automation
//   EVIDENCE ON DISK     what it writes is what was typed, and what it opens
//                        it reports back by name and size
//
// Compiled by the csc.exe that is part of Windows, exactly as the Computer MCP
// bridge and the desktop host are. No dependency is added to LAIN.

using System;
using System.IO;
using System.Windows.Forms;

static class LainFixture {
  // A LOG, BECAUSE A FIXTURE THAT FAILS SILENTLY IS WORSE THAN NO FIXTURE.
  // When the suite cannot explain what the application did, it reads this
  // rather than guessing from the outside.
  internal static string LogPath;
  internal static void Log(string s) {
    if (LogPath == null) return;
    try { File.AppendAllText(LogPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + Environment.NewLine); } catch { }
  }

  [STAThread]
  static void Main(string[] argv) {
    string title = "LAIN Fixture";
    for (int i = 0; i < argv.Length; i++) {
      if (argv[i] == "--title" && i + 1 < argv.Length) title = argv[++i];
      else if (argv[i] == "--log" && i + 1 < argv.Length) LogPath = argv[++i];
    }
    Application.ThreadException += delegate(object s, System.Threading.ThreadExceptionEventArgs e) {
      Log("THREAD EXCEPTION " + e.Exception);
    };
    AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e) {
      Log("UNHANDLED " + e.ExceptionObject);
    };
    Application.EnableVisualStyles();
    Log("start " + title);
    Application.Run(new FixtureForm(title));
    Log("exit");
  }
}

class FixtureForm : Form {
  readonly TextBox box = new TextBox();
  readonly Button save = new Button();
  readonly Button pick = new Button();
  // A READ-ONLY TEXT BOX, not a Label, and the difference matters to the test:
  // a WinForms Label with an AccessibleName reports that name and hides its
  // text, so what it says would be invisible to UI Automation. A TextBox
  // carries a stable name AND a live ValuePattern, which is the thing a caller
  // reads back.
  readonly TextBox echo = new TextBox();

  public FixtureForm(string title) {
    Text = title;
    Width = 520;
    Height = 240;
    StartPosition = FormStartPosition.CenterScreen;

    // NAMED, because the bridge finds controls structurally. A test that had to
    // click a coordinate would be testing the screen resolution.
    box.Name = "inputBox";
    box.AccessibleName = "inputBox";
    box.Left = 16; box.Top = 20; box.Width = 470;
    Controls.Add(box);

    save.Name = "saveButton";
    save.AccessibleName = "saveButton";
    save.Text = "Save";
    save.Left = 16; save.Top = 60; save.Width = 100;
    save.Click += OnSave;
    Controls.Add(save);

    // THE OTHER HALF OF THE OS BOUNDARY: choosing a file that already exists.
    // This is the shape a browser's upload picker has — a dialog titled "Open"
    // with a filename Edit and a Button called "Open" — reached deterministically
    // instead of by hoping a browser raises one under automation.
    pick.Name = "openButton";
    pick.AccessibleName = "openButton";
    pick.Text = "Choose";
    pick.Left = 128; pick.Top = 60; pick.Width = 100;
    pick.Click += OnOpen;
    Controls.Add(pick);

    // WHAT HAPPENED, READABLE FROM THE TREE. The test verifies against this
    // rather than against a screenshot: a value read out of the UI Automation
    // tree is a fact; a picture of it is an impression.
    echo.Name = "statusBox";
    echo.AccessibleName = "statusBox";
    echo.ReadOnly = true;
    echo.Multiline = true;
    echo.Left = 16; echo.Top = 100; echo.Width = 470; echo.Height = 60;
    echo.Text = "ready";
    Controls.Add(echo);
  }

  void OnSave(object sender, EventArgs e) {
    LainFixture.Log("OnSave entered");
    // A REAL OS DIALOG, owned by this process — the same boundary a browser's
    // file picker crosses. Nothing about it is simulated.
    using (var dlg = new SaveFileDialog()) {
      dlg.Title = "Save As";
      dlg.Filter = "Text files (*.txt)|*.txt|All files (*.*)|*.*";
      dlg.FileName = "fixture.txt";
      dlg.OverwritePrompt = false;   // a second dialog is not what is under test
      LainFixture.Log("OnSave showing");
      DialogResult dr = dlg.ShowDialog(this);
      LainFixture.Log("OnSave dialog returned " + dr);
      if (dr != DialogResult.OK) { echo.Text = "cancelled"; return; }
      try {
        File.WriteAllText(dlg.FileName, box.Text);
        echo.Text = "saved " + dlg.FileName;
      } catch (Exception ex) {
        echo.Text = "failed " + ex.Message;
      }
    }
  }

  void OnOpen(object sender, EventArgs e) {
    LainFixture.Log("OnOpen entered");
    using (var dlg = new OpenFileDialog()) {
      dlg.Title = "Open";
      dlg.Filter = "All files (*.*)|*.*";
      dlg.CheckFileExists = true;
      LainFixture.Log("OnOpen showing");
      DialogResult dr = dlg.ShowDialog(this);
      LainFixture.Log("OnOpen dialog returned " + dr);
      if (dr != DialogResult.OK) { echo.Text = "cancelled"; return; }
      try {
        // THE SAME SENTENCE A BROWSER'S CHANGE HANDLER WRITES, so the test
        // asserts the same fact on either side of the boundary: a named file of
        // a known size arrived because somebody chose it.
        var info = new FileInfo(dlg.FileName);
        echo.Text = "chosen: " + info.Name + " (" + info.Length + " bytes)";
      } catch (Exception ex) {
        echo.Text = "failed " + ex.Message;
      }
    }
  }
}
