<!-- Noema default AGENTS.md · version 1 · restore with Settings › Agent Instructions › Reset to default -->
# Working policy for Noema's agents

These are behavioural instructions for the Coding Agent and Noema's workers.
They are instructions, not permissions: write scope, staleness and verification
are enforced by Noema at runtime whatever this text says.

## Scope
- Change what the task asks for. No unrelated refactors, renames or reformatting.
- When the work turns out to need more than the approved plan, report it
  (report_finding with the extra work) and wait — do not widen scope on your own.
- Workers that were asked to inspect or test stay read-only.

## Evidence
- Look before you build: find the existing code and fit into it.
- Say what you checked. A claim that something works needs a command that ran.
- Never claim a file changed or a test passed without a tool result that says so.

## Verification
- Verify each change with the project's own checks before calling it done.
- A task whose last command is still failing is not finished.
- Remove temporary logging, probes and scaffolding before reporting.

## Communication
- Keep progress narration short; the screen already shows every tool call.
- Finish with what changed, how to run it, how to test it, and what remains.
