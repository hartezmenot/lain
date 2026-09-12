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
denoise, brightness, contrast, saturation, automatic contrast, grayscale and
background flattening. Background removal uses a
configured provider, the detected local BiRefNet runner, or `rembg` when
available. Images are bounded to 40 megapixels and the finished file is reopened
and measured before it is registered.

Generation and inpainting use an optional `cowork.services.image` connector
with the same one-request JSON protocol and isolated `envFrom` credential
mapping described below. The service receives a bounded prompt and, for
inpainting, exact owned image/mask bytes. LAIN accepts only canonical base64
that parses as a supported image within the 2 MiB artifact and 40 megapixel
limits, then stores a new artifact and reports measured dimensions. When no
service is configured, capability state is `UNCONFIGURED`; no edit is claimed.

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

## Connected email

Email search, read, draft, send, archive and delete use the same Cowork tools in
local Harness and messaging sessions. Drafting creates a reviewable
`*.email-draft.json` artifact and does not contact an account. Send accepts only
an owned draft reference. Send, archive and delete are marked `EXTERNAL` in the
shared capability registry, pause at the existing interaction approval gate on
every call, and keep a task-owned receipt after the provider acknowledges the
action. Dismissing or denying the prompt invokes no account service.

LAIN supplies a narrow connector protocol rather than storing account secrets.
Configure `cowork.services.email.command` as an argv array for a program that
reads one JSON request from stdin and writes one JSON response to stdout. The
request is `{version, domain, operation, input}`. A success response is
`{"ok":true,"data":{...}}`; a failure uses one of the public failure classes.
`envFrom` maps a connector environment variable to the name of an existing
process environment variable. Only that mapping and a minimal operating-system
environment reach the connector; credential values never enter the request,
model context, transcript, artifacts or public errors.

```json
{
  "cowork": {
    "services": {
      "email": {
        "command": ["C:/Program Files/My Connector/email-bridge.exe"],
        "envFrom": { "EMAIL_TOKEN": "MY_EMAIL_TOKEN" },
        "timeoutMs": 30000
      }
    }
  }
}
```

The connector operations are `search`, `read`, `send`, `archive` and `delete`.
Search/read results and provider errors are normalized and bounded before they
return to the model. Attachments are materialized only from exact artifacts
owned by the current Cowork session, with a 2 MiB combined connector limit.

Calendar, contacts, reminders and notes use the same connector configuration
shape under their respective `cowork.services` key. Each exposes a bounded
list/search tool and a change tool. Calendar, contacts and notes support create,
update and delete; reminders also support complete. Every change has a concrete
preview, requires “Approve once,” and creates a receipt artifact. Reads return
only the documented item fields rather than forwarding a provider payload.

## Capability and failure states

The Cowork projection reports each capability as `AVAILABLE`, `CONFIGURED`,
`UNCONFIGURED` or `UNSUPPORTED`. A real operation promotes its observed file
capability to `AVAILABLE`. Ordinary failures are returned to the model as one of
`AUTH_REQUIRED`, `PERMISSION_REQUIRED`, `UNSUPPORTED`, `RATE_LIMITED`, `FAILED`,
`CANCELLED` or `INCONCLUSIVE`; raw worker exceptions are not public output.

Email, calendar, contacts, reminders and notes each report `CONFIGURED` when
their injected or configured Cowork service is present and otherwise report
`UNCONFIGURED`. The user-facing Add Account manager is still future work; this
connector seam does not claim to be an account store.
Computer control likewise remains dependent on the existing configured desktop
bridge.

## Verification boundary

Unit tests cover binding, attachment promotion, ownership, resume, projection,
Harness routes, conditional tool exposure, external approval and remote delivery. Integration tests
run real CSV, XLSX, image, DOCX and PDF bytes and drive a Telegram Cowork turn
through the existing App, model loop, Harness task, spreadsheet tool, artifact
store and delivery queue. A process-backed email fixture verifies credential
isolation and durable receipts, and a Telegram fixture verifies an in-conversation
approval followed by exactly one send. These are local and fixture-backed checks. They are not
live Telegram/Discord/WhatsApp certification or live account-provider proof.
Calendar, contact, reminder and note fixtures also exercise their shared list,
approval, provider invocation, receipt and capability contracts.
Configured generation and inpainting fixtures verify exact image-byte
promotion and measured outputs; they do not constitute live image-provider
certification.

On the measured development machine, the detected local BiRefNet provider also
completed a real owned-artifact removal: its reopened 256×256 RGBA output had an
alpha range of 0–255. This proves that configured local provider on this machine;
other installations still report their own observed capability state.
