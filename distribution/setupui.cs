// THE INSTALLER WINDOW — three choices, and then it installs.
//
// Provider accounts, model sources and connections are configured IN LAIN,
// where they can be tested against the thing they configure. An installer that
// asks for them is asking before it can verify anything, and leaves somebody
// stuck at a wizard page instead of in the product.

using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

class Wizard : Form {
  public static int ExitCode = 0;

  readonly TextBox pathBox = new TextBox();
  readonly Button browse = new Button();
  readonly CheckBox onPath = new CheckBox();
  readonly CheckBox onDesktop = new CheckBox();
  readonly Button install = new Button();
  readonly Label note = new Label();
  readonly TextBox logBox = new TextBox();

  public Wizard(string dir, bool addPath, bool desktop) {
    Text = "Install LAIN";
    Width = 620; Height = 360;
    FormBorderStyle = FormBorderStyle.FixedDialog;
    MaximizeBox = false; MinimizeBox = false;
    StartPosition = FormStartPosition.CenterScreen;

    Label where = new Label { Text = "Install location", Left = 16, Top = 16, Width = 200 };
    Controls.Add(where);

    pathBox.Left = 16; pathBox.Top = 38; pathBox.Width = 480; pathBox.Text = dir;
    Controls.Add(pathBox);

    browse.Text = "Browse…"; browse.Left = 504; browse.Top = 36; browse.Width = 80;
    browse.Click += (s, e) => {
      using (FolderBrowserDialog f = new FolderBrowserDialog()) {
        f.Description = "Where should LAIN be installed?";
        if (f.ShowDialog(this) == DialogResult.OK) pathBox.Text = Path.Combine(f.SelectedPath, "LAIN");
      }
    };
    Controls.Add(browse);

    onPath.Text = "Add the LAIN CLI to PATH  (so `lain` works in a new terminal)";
    onPath.Left = 16; onPath.Top = 74; onPath.Width = 520; onPath.Checked = addPath;
    Controls.Add(onPath);

    onDesktop.Text = "Create a desktop shortcut";
    onDesktop.Left = 16; onDesktop.Top = 100; onDesktop.Width = 520; onDesktop.Checked = desktop;
    Controls.Add(onDesktop);

    // WHAT IT IS ABOUT TO DO, said before it does it. The Node requirement is
    // the one thing that can stop an install, so it is on screen from the
    // start rather than arriving as a failure.
    note.Left = 16; note.Top = 128; note.Width = 570; note.Height = 34;
    string node = Setup.FindNode();
    string v = node == null ? null : Setup.NodeVersion(node);
    if (node == null || Setup.MajorOf(v) < 18) {
      note.ForeColor = Color.Firebrick;
      note.Text = node == null
        ? "LAIN needs Node.js 18 or newer — none found in Program Files or on PATH. Install it from nodejs.org."
        : "LAIN needs Node.js 18 or newer. Found " + v + " at " + node + ".";
      install.Enabled = false;
    } else {
      note.ForeColor = Color.DimGray;
      note.Text = "Installs the LAIN Harness (LAIN.exe) and the LAIN CLI (lain) together."
        + Environment.NewLine + "Using Node " + v + " at " + node + ".";
    }
    Controls.Add(note);

    install.Text = "Install"; install.Left = 496; install.Top = 168; install.Width = 88;
    install.Click += OnInstall;
    Controls.Add(install);

    logBox.Left = 16; logBox.Top = 200; logBox.Width = 568; logBox.Height = 108;
    logBox.Multiline = true; logBox.ReadOnly = true; logBox.ScrollBars = ScrollBars.Vertical;
    logBox.Text = "";
    Controls.Add(logBox);

    AcceptButton = install;
  }

  void Say(string s) {
    logBox.AppendText(s + Environment.NewLine);
    logBox.SelectionStart = logBox.TextLength;
    logBox.ScrollToCaret();
    Application.DoEvents();
  }

  void OnInstall(object sender, EventArgs e) {
    install.Enabled = false; browse.Enabled = false; pathBox.ReadOnly = true;
    logBox.Text = "";
    string dir = pathBox.Text.Trim().Trim('"');
    if (dir.Length == 0) { Say("Choose a location."); install.Enabled = true; browse.Enabled = true; pathBox.ReadOnly = false; return; }

    int rc = Install.Run(dir, onPath.Checked, onDesktop.Checked, Say);
    ExitCode = rc;
    if (rc != 0) {
      install.Enabled = true; browse.Enabled = true; pathBox.ReadOnly = false;
      install.Text = "Retry";
      return;
    }
    install.Text = "Open LAIN";
    install.Enabled = true;
    install.Click -= OnInstall;
    install.Click += (s2, e2) => {
      try { System.Diagnostics.Process.Start(Path.Combine(dir, "LAIN.exe")); } catch (Exception ex) { Say(ex.Message); }
      Close();
    };
  }
}
