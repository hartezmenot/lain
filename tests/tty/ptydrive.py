"""
A REAL TERMINAL FOR LAIN — ConPTY in, a VT screen out.

Used by tests/smoke/realtty.test.js. Nothing here is a pipe pretending to be a
terminal: the child gets a real pseudo-console (process.stdout.isTTY is true,
resize events are real SIGWINCH/console resize), and what it writes is rendered
by `pyte`, a VT100/xterm screen emulator that measures East Asian wide
characters at two cells. A snapshot is therefore what a person would SEE.

Usage:  python ptydrive.py <scenario.json>   → JSON on stdout

Scenario:
  { "argv": [...], "cwd": "...", "env": {...}, "cols": 100, "rows": 30,
    "steps": [
      {"wait": 500},
      {"until": "regex", "timeout": 20000},
      {"send": "text"},                 raw text; \\r is Enter
      {"key": "ctrl-pagedown"},         a named key
      {"resize": [80, 24]},
      {"snap": "name"}
    ] }

Requires: pyte, and pywinpty on Windows or ptyprocess elsewhere (installed in an isolated venv; the test SKIPS without them).
"""

import json
import re
import sys
import threading
import time

import pyte
try:
    from winpty import PtyProcess          # Windows: ConPTY
except ImportError:                        # POSIX: a real pty (S12 — the same scenarios run on Linux and macOS)
    from ptyprocess import PtyProcessUnicode as PtyProcess

KEYS = {
    "enter": "\r",
    "escape": "\x1b",
    "pageup": "\x1b[5~",
    "pagedown": "\x1b[6~",
    "ctrl-pagedown": "\x1b[6;5~",
    "up": "\x1b[A",
    "down": "\x1b[B",
    "left": "\x1b[D",
    "right": "\x1b[C",
    "home": "\x1b[H",
    "end": "\x1b[F",
    "ctrl-c": "\x03",
    "shift-tab": "\x1b[Z",
    "ctrl-o": "\x0f",
}


def cells(screen):
    """Every row as a list of (char, width) cells. pyte stores the second half of a wide char as ''."""
    rows = []
    for y in range(screen.lines):
        line = screen.buffer[y]
        row = []
        for x in range(screen.columns):
            row.append(line[x].data)
        rows.append(row)
    return rows


def snapshot(screen, name):
    rows = cells(screen)
    text = []
    extents = []
    for row in rows:
        # A wide character occupies its cell and the next, whose data is ''.
        s = "".join(ch for ch in row)
        text.append(s.rstrip())
        # The second cell of a wide character ('') is occupied too.
        used = [i for i, ch in enumerate(row) if ch != " "]
        extents.append([used[0], used[-1]] if used else None)
    # WHERE A BACKGROUND IS PAINTED, per row. Stale grey cells are spaces, so the
    # text grid alone cannot see a composer ground left behind after the text on
    # it was deleted; this can.
    grounds = []
    for y in range(screen.lines):
        line = screen.buffer[y]
        painted = [x for x in range(screen.columns) if line[x].bg != "default" or line[x].reverse]
        grounds.append([painted[0], painted[-1]] if painted else None)
    # THE COLOURS a row's visible characters are drawn in (pyte names, e.g.
    # "green", or a hex for 256/truecolour), so semantics like a green `+` are testable.
    fg = []
    for y in range(screen.lines):
        line = screen.buffer[y]
        fg.append(sorted({line[x].fg for x in range(screen.columns) if line[x].data.strip()}))
    return {
        "name": name,
        "fg": fg,
        "cols": screen.columns,
        "rows": screen.lines,
        "cursor": [screen.cursor.x, screen.cursor.y],
        "text": text,
        "extents": extents,
        "grounds": grounds,
    }


def main():
    scenario = json.load(open(sys.argv[1], encoding="utf-8"))
    cols = int(scenario.get("cols", 100))
    rows = int(scenario.get("rows", 30))
    screen = pyte.Screen(cols, rows)
    stream = pyte.Stream(screen)
    lock = threading.Lock()
    raw = []

    env = dict(scenario.get("env", {}))
    proc = PtyProcess.spawn(scenario["argv"], cwd=scenario.get("cwd"), env=env, dimensions=(rows, cols))
    # ELAPSED TIME since the child was spawned, in ms, on every snapshot and on
    # every `until` that matched (out["marks"]) — for latency acceptance tests.
    t_spawn = time.time()

    def elapsed():
        return int((time.time() - t_spawn) * 1000)

    done = {"flag": False}

    def pump():
        while not done["flag"]:
            try:
                data = proc.read(65536)
            except EOFError:
                break
            except Exception:
                time.sleep(0.01)
                continue
            if not data:
                time.sleep(0.005)
                continue
            with lock:
                raw.append(data)
                stream.feed(data)

    t = threading.Thread(target=pump, daemon=True)
    t.start()

    out = {"snaps": [], "timeouts": [], "marks": [], "exit": None}
    for step in scenario.get("steps", []):
        if "wait" in step:
            time.sleep(step["wait"] / 1000.0)
        elif "until" in step:
            pat = re.compile(step["until"])
            end = time.time() + step.get("timeout", 20000) / 1000.0
            hit = False
            while time.time() < end:
                with lock:
                    visible = "\n".join(screen.display)
                if pat.search(visible):
                    hit = True
                    break
                time.sleep(0.05)
            if not hit:
                out["timeouts"].append(step["until"])
            else:
                out["marks"].append({"until": step["until"], "at": elapsed()})
        elif "send" in step:
            proc.write(step["send"])
        elif "key" in step:
            proc.write(KEYS[step["key"]])
        elif "resize" in step:
            c, r = step["resize"]
            with lock:
                proc.setwinsize(r, c)
                screen.resize(r, c)
        elif "snap" in step:
            time.sleep(step.get("settle", 250) / 1000.0)
            with lock:
                snap = snapshot(screen, step["snap"])
                snap["at"] = elapsed()
                out["snaps"].append(snap)
        elif "hardkill" in step:
            # A CRASH, not a close: TerminateProcess on the child itself. No
            # Ctrl+C, no console-close event, no chance to save anything.
            import os
            import signal
            try:
                os.kill(proc.pid, signal.SIGTERM)
            except Exception as e:
                out["hardkillError"] = str(e)
            time.sleep(0.8)
            out["hardkilled"] = True
            break

    done["flag"] = True
    try:
        proc.write("\x03")
        time.sleep(0.2)
        proc.write("\x03")
        time.sleep(0.3)
    except Exception:
        pass
    try:
        if proc.isalive():
            proc.terminate(force=True)
    except Exception:
        pass
    out["exit"] = proc.exitstatus if hasattr(proc, "exitstatus") else None
    out["rawBytes"] = sum(len(r) for r in raw)
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
