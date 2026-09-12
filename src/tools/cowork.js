'use strict';

const worker = require('../cowork/worker');
const artifacts = require('../cowork/artifacts');
const email = require('../cowork/email');
const personal = require('../cowork/personal');
const imageprovider = require('../cowork/imageprovider');

function rendered(result) {
  if (!result?.ok) return { output: `${result?.class || 'FAILED'}: ${result?.why || 'the operation did not finish'}`, isError: true,
    meta: { classification: result?.class || 'FAILED' } };
  if (result.artifact) return { output: `Done\nArtifact ${result.artifact.ref} · ${result.artifact.name} · ${result.artifact.bytes} bytes\nVerified: ${JSON.stringify(result.facts || {})}`,
    artifact: result.artifact, meta: { classification: 'DONE', changed: result.changed || 0 } };
  return { output: `Inspection\n${JSON.stringify(result.facts || {})}`, meta: { classification: 'DONE' } };
}

const operation = { type: 'object', properties: {
  op: { type: 'string' }, columns: { type: 'array', items: { type: 'string' } }, header_row: { type: 'number' },
  width: { type: 'number' }, height: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, degrees: { type: 'number' },
  factor: { type: 'number' }, radius: { type: 'number' }, color: { type: 'string' }, expand: { type: 'boolean' }, descending: { type: 'boolean' },
  chart_type: { type: 'string', enum: ['bar', 'line', 'pie'] }, title: { type: 'string' }, anchor: { type: 'string' },
  find: { type: 'string' }, replace: { type: 'string' }, text: { type: 'string' },
}, required: ['op'] };

function inputSchema(description) {
  return { name: description.name, description: description.description,
    parameters: { type: 'object', properties: { input_ref: { type: 'string' } }, required: ['input_ref'] } };
}

const tools = {
  cowork_artifacts: {
    mutates: false,
    schema: { name: 'cowork_artifacts', description: 'List files owned by this Cowork session as opaque references. No host paths are returned.', parameters: { type: 'object', properties: {} } },
    async run(_input, ctx) {
      const rows = artifacts.list(ctx.app);
      return { output: rows.length ? rows.map((row) => `${row.ref} · ${row.name} · ${row.mime} · ${row.bytes} bytes · ${row.taskState}`).join('\n') : 'No artifacts owned by this Cowork session.' };
    },
  },
  cowork_spreadsheet_inspect: {
    mutates: false,
    schema: inputSchema({ name: 'cowork_spreadsheet_inspect', description: 'Inspect an owned CSV/XLSX/XLSM spreadsheet deterministically. Returns dimensions, headers and bounded numeric summaries.' }),
    async run(input, ctx) { return rendered(await worker.run(ctx.app, { kind: 'spreadsheet', inputRef: input.input_ref, action: 'inspect', signal: ctx.signal })); },
  },
  cowork_spreadsheet_transform: {
    mutates: false,
    schema: { name: 'cowork_spreadsheet_transform', description: 'Create a new owned spreadsheet with deterministic cleanup, sorting, formatting or chart operations. Input remains unchanged.',
      parameters: { type: 'object', properties: { input_ref: { type: 'string' }, sheets: { type: 'array', items: { type: 'string' } }, operations: { type: 'array', items: operation, minItems: 1, maxItems: 12 } }, required: ['input_ref', 'operations'] } },
    async run(input, ctx) { return rendered(await worker.run(ctx.app, { kind: 'spreadsheet', inputRef: input.input_ref, action: 'transform', operations: input.operations, sheets: input.sheets, signal: ctx.signal })); },
  },
  cowork_spreadsheet_create: {
    mutates: false,
    schema: { name: 'cowork_spreadsheet_create', description: 'Create an XLSX artifact from bounded rows. Formula strings beginning with = remain formulas.', parameters: { type: 'object', properties: {
      name: { type: 'string' }, sheets: { type: 'array', maxItems: 20, items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: {} } } }, required: ['name', 'rows'] } },
    }, required: ['sheets'] } },
    async run(input, ctx) { return rendered(await worker.run(ctx.app, { kind: 'spreadsheet', action: 'create', name: input.name || 'workbook.xlsx', sheetsData: input.sheets, signal: ctx.signal })); },
  },
  cowork_image_inspect: {
    mutates: false,
    schema: inputSchema({ name: 'cowork_image_inspect', description: 'Inspect an owned image deterministically and return measured format, dimensions and mode.' }),
    async run(input, ctx) { return rendered(await worker.run(ctx.app, { kind: 'image', inputRef: input.input_ref, action: 'inspect', signal: ctx.signal })); },
  },
  cowork_image_transform: {
    mutates: false,
    schema: { name: 'cowork_image_transform', description: 'Create a new owned image using resize, upscale, crop, rotate, sharpen, denoise, grayscale, background flattening or configured background removal. Input remains unchanged.', parameters: { type: 'object', properties: {
      input_ref: { type: 'string' }, operations: { type: 'array', items: operation, minItems: 1, maxItems: 12 }, format: { type: 'string', enum: ['png', 'jpg', 'webp', 'gif'] }, quality: { type: 'number' },
    }, required: ['input_ref', 'operations'] } },
    async run(input, ctx) { return rendered(await worker.run(ctx.app, { kind: 'image', inputRef: input.input_ref, action: 'transform', operations: input.operations, format: input.format, quality: input.quality, signal: ctx.signal })); },
  },
  cowork_image_generate: {
    mutates: false, effect: 'NETWORK',
    schema: { name: 'cowork_image_generate', description: 'Generate a new task-owned PNG or JPG with a configured image service; returns measured dimensions and never claims success without valid image bytes.', parameters: { type: 'object', properties: {
      prompt: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, format: { type: 'string', enum: ['png', 'jpg'] },
    }, required: ['prompt'] } },
    async run(input, ctx) { return rendered(await imageprovider.run(ctx.app, 'generate', input, ctx.signal)); },
  },
  cowork_image_inpaint: {
    mutates: false, effect: 'NETWORK',
    schema: { name: 'cowork_image_inpaint', description: 'Inpaint an owned image, optionally using an owned mask, through a configured image service. Creates a new measured artifact and keeps inputs unchanged.', parameters: { type: 'object', properties: {
      input_ref: { type: 'string' }, mask_ref: { type: 'string' }, prompt: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, format: { type: 'string', enum: ['png', 'jpg'] },
    }, required: ['input_ref', 'prompt'] } },
    async run(input, ctx) { return rendered(await imageprovider.run(ctx.app, 'inpaint', input, ctx.signal)); },
  },
  cowork_document_inspect: {
    mutates: false,
    schema: inputSchema({ name: 'cowork_document_inspect', description: 'Extract bounded text and measured facts from an owned TXT, Markdown, CSV, DOCX or PDF for summarization.' }),
    async run(input, ctx) { return rendered(await worker.run(ctx.app, { kind: 'document', inputRef: input.input_ref, action: 'inspect', signal: ctx.signal })); },
  },
  cowork_document_transform: {
    mutates: false,
    schema: { name: 'cowork_document_transform', description: 'Reflow an owned document into a new DOCX or PDF artifact, with deterministic text replacement or append operations.', parameters: { type: 'object', properties: {
      input_ref: { type: 'string' }, title: { type: 'string' }, format: { type: 'string', enum: ['docx', 'pdf'] }, operations: { type: 'array', items: operation, minItems: 1, maxItems: 12 },
    }, required: ['input_ref', 'operations', 'format'] } },
    async run(input, ctx) { return rendered(await worker.run(ctx.app, { kind: 'document', inputRef: input.input_ref, action: 'transform', operations: input.operations, title: input.title, format: input.format, signal: ctx.signal })); },
  },
  cowork_document_create: {
    mutates: false,
    schema: { name: 'cowork_document_create', description: 'Create a task-owned DOCX or PDF from a title and bounded paragraphs.', parameters: { type: 'object', properties: {
      name: { type: 'string' }, title: { type: 'string' }, paragraphs: { type: 'array', maxItems: 500, items: { type: 'string' } }, format: { type: 'string', enum: ['docx', 'pdf'] },
    }, required: ['paragraphs', 'format'] } },
    async run(input, ctx) { return rendered(await worker.run(ctx.app, { kind: 'document', action: 'create', name: input.name || 'document', title: input.title, paragraphs: input.paragraphs, format: input.format, signal: ctx.signal })); },
  },
  cowork_deliver_artifact: {
    mutates: false,
    schema: { name: 'cowork_deliver_artifact', description: 'Deliver an owned artifact to the originating messaging conversation. In local Harness Cowork, the artifact is already available and this reports that no remote delivery is needed.', parameters: { type: 'object', properties: { input_ref: { type: 'string' } }, required: ['input_ref'] } },
    async run(input, ctx) {
      if (!artifacts.find(ctx.app, input.input_ref)) return rendered({ ok: false, class: 'PERMISSION_REQUIRED', why: 'that artifact is not owned by this Cowork session' });
      const port = require('../interaction').port(ctx.app);
      if (!port?.deliverArtifact) return { output: `Artifact ${input.input_ref} is ready in this local Cowork session.`, meta: { classification: 'DONE' } };
      try {
        const rows = await port.deliverArtifact(input.input_ref);
        const states = (rows || []).map((row) => row.state);
        if (states.length && states.every((state) => state === 'delivered')) return { output: `Artifact ${input.input_ref} delivered.`, meta: { classification: 'DONE' } };
        return rendered({ ok: false, class: 'INCONCLUSIVE', why: 'delivery status is unknown; the file may have been sent' });
      } catch { return rendered({ ok: false, class: 'FAILED', why: 'the originating transport could not deliver the artifact' }); }
    },
  },
  cowork_email_search: {
    mutates: false, effect: 'NETWORK',
    schema: { name: 'cowork_email_search', description: 'Search the connected email account. This reads account data and does not change messages.', parameters: { type: 'object', properties: {
      query: { type: 'string' }, limit: { type: 'number' },
    }, required: ['query'] } },
    async run(input, ctx) { return email.rendered(await email.search(ctx.app, input, ctx.signal)); },
  },
  cowork_email_read: {
    mutates: false, effect: 'NETWORK',
    schema: { name: 'cowork_email_read', description: 'Read one message from the connected email account by its provider message ID.', parameters: { type: 'object', properties: {
      message_id: { type: 'string' },
    }, required: ['message_id'] } },
    async run(input, ctx) { return email.rendered(await email.read(ctx.app, input, ctx.signal)); },
  },
  cowork_email_draft: {
    mutates: false, effect: 'WRITE',
    schema: { name: 'cowork_email_draft', description: 'Create a reviewable, task-owned email draft artifact. This does not send email.', parameters: { type: 'object', properties: {
      name: { type: 'string' }, to: { type: 'array', maxItems: 50, items: { type: 'string' } }, cc: { type: 'array', maxItems: 50, items: { type: 'string' } },
      bcc: { type: 'array', maxItems: 50, items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string' },
      attachment_refs: { type: 'array', maxItems: 8, items: { type: 'string' } },
    }, required: ['to', 'subject', 'body'] } },
    async run(input, ctx) { return email.rendered(email.createDraft(ctx.app, input)); },
  },
  cowork_email_send: {
    mutates: false, effect: 'EXTERNAL', approval: email.previewDraft,
    schema: { name: 'cowork_email_send', description: 'Send a task-owned email draft through the connected account after per-action approval. Returns a durable receipt artifact.', parameters: { type: 'object', properties: {
      draft_ref: { type: 'string' },
    }, required: ['draft_ref'] } },
    async run(input, ctx) { return email.rendered(await email.send(ctx.app, input, ctx.signal)); },
  },
  cowork_email_archive: {
    mutates: false, effect: 'EXTERNAL', approval: email.previewMessage('Archive'),
    schema: { name: 'cowork_email_archive', description: 'Archive one message in the connected email account after per-action approval.', parameters: { type: 'object', properties: {
      message_id: { type: 'string' },
    }, required: ['message_id'] } },
    async run(input, ctx) { return email.rendered(await email.mutate(ctx.app, 'archive', input, ctx.signal)); },
  },
  cowork_email_delete: {
    mutates: false, effect: 'EXTERNAL', approval: email.previewMessage('Delete'),
    schema: { name: 'cowork_email_delete', description: 'Delete one message in the connected email account after per-action approval.', parameters: { type: 'object', properties: {
      message_id: { type: 'string' },
    }, required: ['message_id'] } },
    async run(input, ctx) { return email.rendered(await email.mutate(ctx.app, 'delete', input, ctx.signal)); },
  },
};

const personalFields = {
  id: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' },
  description: { type: 'string' }, attendees: { type: 'array', maxItems: 50, items: { type: 'string' } }, name: { type: 'string' },
  emails: { type: 'array', maxItems: 50, items: { type: 'string' } }, phones: { type: 'array', maxItems: 50, items: { type: 'string' } },
  organization: { type: 'string' }, notes: { type: 'string' }, due: { type: 'string' }, completed: { type: 'boolean' }, body: { type: 'string' },
  tags: { type: 'array', maxItems: 50, items: { type: 'string' } },
};
for (const domain of personal.DOMAINS) {
  tools[`cowork_${domain}_list`] = {
    mutates: false, effect: 'NETWORK',
    schema: { name: `cowork_${domain}_list`, description: `List or search bounded items in the connected ${domain} account without changing them.`, parameters: {
      type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } },
    } },
    async run(input, ctx) { return personal.rendered(await personal.list(ctx.app, domain, input, ctx.signal)); },
  };
  tools[`cowork_${domain}_change`] = {
    mutates: false, effect: 'EXTERNAL', approval: personal.preview(domain),
    schema: { name: `cowork_${domain}_change`, description: `Create, update or delete an item in the connected ${domain} account after per-action approval; reminders can also be completed.`, parameters: {
      type: 'object', properties: { action: { type: 'string', enum: [...personal.ACTIONS[domain]] }, ...personalFields }, required: ['action'],
    } },
    async run(input, ctx) { return personal.rendered(await personal.change(ctx.app, domain, input, ctx.signal)); },
  };
}

module.exports = { tools, rendered, operation };
