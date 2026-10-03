# Frozen — Telegram gateway only

Since Simplify S7 (2026-10-03) LAIN runs background jobs in its own process
(`src/jobs.js`, output streamed to `sessions/<id>/jobs/<job>.log`) and no longer
submits, watches or lists jobs here. This crate is kept, unbuilt by the job path
and unreferenced by it, only for the Telegram gateway (`src/bot/`), which is itself
frozen in S9. Do not add new roles to it.
