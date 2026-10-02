---
name: migrate
description: Move a project from an old implementation to a new one (a library, an API, a data format, a module) without leaving the old half behind.
---
# Migrate

A migration is finished when nothing still depends on the old implementation and it has been removed (or deliberately
kept, said so). Most migrations fail on the half nobody checks: a caller, a config key, a test, a doc still on the old way.

1. **Decide the end state with the person.** Ask (ask_user) only what the code cannot tell you: what replaces the old
   thing, whether the old code is deleted or kept behind a flag, and what happens to existing data or saved files.
2. **Map every use of the old implementation** before changing anything: grep for its names, imports, config keys,
   file formats, CLI flags and docs. Write the list down (todo_write) — it is the migration's checklist.
3. **Move one use at a time**, keeping the project working between steps. Run the tests that cover each part you move.
4. **Check the half nobody checks:** grep again for every name on the list. Anything left is either moved now or named
   in your report as deliberately left.
5. **Retire the old implementation** last, in its own change, so it can be reverted alone. Run the full test suite.
6. **Report:** what moved, what was removed, what was verified and how, and anything still on the old way.
