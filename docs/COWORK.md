# LAIN Cowork

Cowork is the general work lane of the existing LAIN App and Harness. A Cowork
session uses the same Session, turn loop, tool registry, permission gate,
background jobs and Harness artifact authority as local engineering work. The
Harness application and Telegram, Discord or WhatsApp are entry points to that
same session contract; messaging does not run a second Cowork agent.

## Files and artifacts

The Harness application can bind an empty session to Cowork, stage up to eight
attachments, start a turn, inspect the resulting activity and task state, and
retrieve its finished artifacts. Messaging adapters download their platform
attachment references through their existing guarded media path. In both cases,
bytes become artifacts owned by the active Harness task before a tool can use
them.

Public surfaces receive an opaque `cwa_...` reference, safe filename, media type,
byte count and task state. They never receive a host path or Harness task ID.
Retrieval checks the exact session, workspace and persisted task ownership. A
reference survives an exact session resume and cannot export another session's
file. Inputs remain unchanged; every transformation creates a new artifact.
The existing Harness limit is 2 MiB per input or finished artifact.

## Available deterministic work

Spreadsheet tools inspect CSV, XLSX and XLSM files. They can trim text, remove
blank rows, keep the first duplicate, normalize dates, sort rows, format tables,
autofit columns and add bar, line or pie charts. Cowork can also create bounded
XLSX workbooks and preserves formula strings as formulas. Legacy XLS files must
first be converted to XLSX. Spreadsheet creation and XLSX editing need a Python
runtime with `openpyxl`; Cowork probes configured and PATH runtimes for the
required package rather than assuming the first Python can do the work.

Image tools inspect measured format, dimensions and color mode. Transformations
include resize, deterministic Lanczos upscale, crop, rotate, sharpen, median
denoise, grayscale and background flattening. Background removal uses a
configured provider, the detected local BiRefNet runner, or `rembg` when
available. Images are bounded to 40 megapixels and the finished file is reopened
and measured before it is registered.

Document tools inspect TXT, Markdown, CSV, DOCX and PDF; create DOCX or PDF; and
reflow an owned document with deterministic replacement or appended text. PDF
inspection needs `pypdf`. Creation uses a local deterministic writer and makes
no network request.

The model sees this vocabulary only in a bound Cowork session. These operations
write task-owned `.lain` artifacts, so they do not request permission to mutate
the user's workspace. Existing file tools remain available when the user asks
to place or organize a result in the workspace, and those tools retain the
normal directory trust gate.

## Local and messaging behavior

In local Harness Cowork, finished artifacts appear in the Cowork state and can
be retrieved through the application API. In a messaging turn the model can use
`cowork_deliver_artifact` to upload an owned result to the originating
conversation through the existing idempotent delivery ledger. `/artifacts` and
`/send <cwa-reference>` remain explicit recovery controls. Delivery never accepts
an arbitrary local path.

`/bg <task>` in messaging and the Cowork background endpoint both call the same
`App.startBackground` authority. Each session permits at most two secondary
jobs. State reports current activity, terminal result, outstanding approval and
job settlement without returning prompts, credentials, raw tool output or
paths.

## Capability and failure states

The Cowork projection reports each capability as `AVAILABLE`, `CONFIGURED`,
`UNCONFIGURED` or `UNSUPPORTED`. A real operation promotes its observed file
capability to `AVAILABLE`. Ordinary failures are returned to the model as one of
`AUTH_REQUIRED`, `PERMISSION_REQUIRED`, `UNSUPPORTED`, `RATE_LIMITED`, `FAILED`,
`CANCELLED` or `INCONCLUSIVE`; raw worker exceptions are not public output.

Email, calendar, contacts, reminders and personal notes currently report
`UNCONFIGURED`. No account authority or secret store has been invented for this
slice, and LAIN does not claim those actions until the shared Add Account layer
exists. Computer control likewise remains dependent on the existing configured
desktop bridge.

## Verification boundary

Unit tests cover binding, attachment promotion, ownership, resume, projection,
Harness routes, conditional tool exposure and remote delivery. Integration tests
run real CSV, XLSX, image, DOCX and PDF bytes and drive a Telegram Cowork turn
through the existing App, model loop, Harness task, spreadsheet tool, artifact
store and delivery queue. These are local and fixture-backed checks. They are not
live Telegram/Discord/WhatsApp certification or live account-provider proof.

On the measured development machine, the detected local BiRefNet provider also
completed a real owned-artifact removal: its reopened 256×256 RGBA output had an
alpha range of 0–255. This proves that configured local provider on this machine;
other installations still report their own observed capability state.
