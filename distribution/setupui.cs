// THE SETUP WINDOW — install (components + integrations), or maintain an installed LAIN (add/remove the Harness or Design,
// repair, upgrade, uninstall). Accounts and models are set up IN LAIN, where they can be tested.

using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

class Wizard : Form {
  public static int ExitCode = 0;
  readonly Setup.Options o;
  readonly TextBox logBox = new TextBox();
  readonly Button go = new Button();

  public Wizard(Setup.Options options, string installed) {
    o = options;
    Text = installed == null ? "Install LAIN " + PayloadInfo.Version() : "LAIN " + PayloadInfo.Version() + " — Setup";
    try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
    Width = 640; Height = 494; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
    Font = new Font("Segoe UI", 9f);
    int y = 16;
    Label title = new Label { Text = installed == null ? "LAIN CLI is the base; LAIN Harness is optional." : "LAIN is installed at " + installed, Left = 16, Top = y, Width = 600, Height = 20, Font = new Font("Segoe UI Semibold", 10f) };
    Controls.Add(title); y += 30;

    var cli = new CheckBox { Text = "LAIN CLI — Core, CLI, Model Dashboard, Preview window (always installed)", Left = 16, Top = y, Width = 600, Checked = true, Enabled = false }; Controls.Add(cli); y += 24;
    bool hasHarness = installed != null && Components.Read(installed).Harness;
    var harness = new CheckBox { Text = "LAIN Harness — the desktop environment (optional; can be added later)", Left = 16, Top = y, Width = 600, Checked = installed == null ? o.Harness : hasHarness }; Controls.Add(harness); y += 24;
    bool hasDesign = installed != null && Components.Read(installed).Design;
    var design = new CheckBox { Text = "LAIN Design — visual editing of app screens, in the Harness (optional; can be added later)", Left = 16, Top = y, Width = 600, Checked = installed == null ? o.Design : hasDesign }; Controls.Add(design); y += 34;

    var path = new CheckBox { Text = "Add `lain` to PATH (your account only)", Left = 16, Top = y, Width = 600, Checked = o.Path }; Controls.Add(path); y += 24;
    var openWith = new CheckBox { Text = "Windows \"Open with LAIN\" for code and text files (never changes your default apps)", Left = 16, Top = y, Width = 600, Checked = o.OpenWith }; Controls.Add(openWith); y += 24;
    var folder = new CheckBox { Text = "\"Open folder in LAIN\" on folders", Left = 16, Top = y, Width = 600, Checked = o.Folder }; Controls.Add(folder); y += 24;
    var menu = new CheckBox { Text = "Start Menu entries (LAIN CLI, Model Dashboard, Harness, Uninstall)", Left = 16, Top = y, Width = 600, Checked = o.StartMenu }; Controls.Add(menu); y += 30;

    var where = new Label { Text = "Location: " + o.Dir + "    Data: " + Setup.DataDir(), Left = 16, Top = y, Width = 600, Height = 18, ForeColor = Color.DimGray }; Controls.Add(where); y += 24;

    logBox.SetBounds(16, y + 40, 592, 150); logBox.Multiline = true; logBox.ReadOnly = true; logBox.ScrollBars = ScrollBars.Vertical; Controls.Add(logBox);

    go.Text = installed == null ? "Install" : "Apply"; go.SetBounds(508, y, 100, 30); Controls.Add(go);
    if (installed != null) {
      var repair = new Button { Text = "Repair" }; repair.SetBounds(296, y, 100, 30); Controls.Add(repair);
      var remove = new Button { Text = "Uninstall…" }; remove.SetBounds(402, y, 100, 30); Controls.Add(remove);
      repair.Click += (s, e) => { o.Repair = true; o.Harness = harness.Checked; o.Design = design.Checked; Run(); };
      remove.Click += (s, e) => { Hide(); ExitCode = Uninstaller.Run(o, null); Close(); };
    }
    go.Click += (s, e) => {
      o.Harness = harness.Checked; o.Design = design.Checked; o.Path = path.Checked; o.OpenWith = openWith.Checked; o.Folder = folder.Checked; o.StartMenu = menu.Checked;
      if (installed != null && !o.Repair && PayloadInfo.Version() == Pointer.Read(installed, "current") && (harness.Checked != hasHarness || design.Checked != hasDesign)) {
        // A COMPONENT ADDED OR REMOVED on the same version: no reinstall.
        ExitCode = 0;
        if (harness.Checked != hasHarness) ExitCode = Installer.SetHarness(o, harness.Checked, Say);
        if (ExitCode == 0 && design.Checked != hasDesign) ExitCode = Installer.SetDesign(o, design.Checked, Say);
        Done(); return;
      }
      Run();
    };
  }

  void Run() {
    go.Enabled = false; logBox.Text = "";
    ExitCode = Installer.Run(o, Say);
    Done();
  }
  void Done() {
    go.Enabled = true;
    if (ExitCode != 0) { go.Text = "Retry"; return; }
    go.Text = "Close";
    go.Click += (s, e) => Close();
  }
  void Say(string s) { logBox.AppendText(s + Environment.NewLine); Application.DoEvents(); }
}

class UninstallForm : Form {
  public bool RemoveData;
  public UninstallForm(string data) {
    Text = "Uninstall LAIN"; Width = 560; Height = 250; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;
    Font = new Font("Segoe UI", 9f);
    Controls.Add(new Label { Text = "Removes the LAIN program, its shortcuts, PATH entry, Open With entries and updater.\r\nYour accounts, API keys, sessions, projects, settings and usage history are kept.", Left = 16, Top = 16, Width = 520, Height = 40 });
    var cb = new CheckBox { Text = "Also remove LAIN user data", Left = 16, Top = 70, Width = 520 };
    var warn = new Label { Text = "Deletes " + data + " — every session, plan, checkpoint, account reference,\r\nsetting and usage record. This cannot be undone. Your project folders are not touched.", Left = 34, Top = 94, Width = 500, Height = 40, ForeColor = Color.Firebrick, Visible = false };
    cb.CheckedChanged += (s, e) => warn.Visible = cb.Checked;
    Controls.Add(cb); Controls.Add(warn);
    var ok = new Button { Text = "Uninstall", DialogResult = DialogResult.OK }; ok.SetBounds(338, 160, 90, 30);
    var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel }; cancel.SetBounds(434, 160, 90, 30);
    Controls.Add(ok); Controls.Add(cancel); AcceptButton = cancel; CancelButton = cancel;
    ok.Click += (s, e) => { RemoveData = cb.Checked; };
  }
}
