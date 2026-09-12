'use strict';

const artifacts = require('./artifacts');
const contract = require('./contract');
const services = require('./services');

function decode(value) {
  const raw = String(value || '');
  if (!raw || raw.length > Math.ceil(artifacts.MAX_BODY / 3) * 4 + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4) return null;
  const bytes = Buffer.from(raw, 'base64');
  return bytes.length && bytes.toString('base64') === raw ? bytes : null;
}
function formatOf(bytes) {
  if (bytes?.length > 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG') return 'png';
  if (bytes?.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpg';
  return null;
}
function source(app, ref) {
  const rec = artifacts.find(app, ref), bytes = artifacts.bytes(app, ref);
  return rec && bytes ? { ok: true, value: { name: rec.name, mime: rec.mime, data: bytes.toString('base64') }, bytes: bytes.length } : { ok: false, class: contract.FAILURE.PERMISSION_REQUIRED, why: 'that image is not owned by this Cowork session' };
}
async function run(app, action, input, signal) {
  const prompt = contract.safeText(input.prompt, 8000);
  if (!prompt) return { ok: false, class: contract.FAILURE.FAILED, why: `${action} needs a prompt` };
  const payload = { prompt, width: Math.max(64, Math.min(Number(input.width) || 1024, 4096)), height: Math.max(64, Math.min(Number(input.height) || 1024, 4096)), format: input.format === 'jpg' ? 'jpg' : 'png' };
  if (payload.width * payload.height > 40_000_000) return { ok: false, class: contract.FAILURE.UNSUPPORTED, why: 'requested image exceeds 40 megapixels' };
  if (action === 'inpaint') {
    const image = source(app, input.input_ref); if (!image.ok) return image; payload.image = image.value;
    if (input.mask_ref) { const mask = source(app, input.mask_ref); if (!mask.ok) return mask; if (image.bytes + mask.bytes > artifacts.MAX_BODY) return { ok: false, class: contract.FAILURE.UNSUPPORTED, why: 'image and mask exceed the 2 MiB connector limit' }; payload.mask = mask.value; }
  }
  const result = await services.invoke(app, 'image', action, payload, { signal }); if (!result.ok) return result;
  const bytes = decode(result.data?.data), actualFormat = formatOf(bytes), name = artifacts.safeName(result.data?.name || `${action}.${payload.format}`);
  const dim = bytes && require('../ui/images').dimensions(bytes.subarray(0, 4096));
  if (!bytes || !dim || !actualFormat || !name.toLowerCase().endsWith(`.${actualFormat}`) || dim.width * dim.height > 40_000_000) return { ok: false, class: contract.FAILURE.FAILED, why: 'the configured image service returned an invalid, mislabeled or oversized image' };
  const artifact = artifacts.keep(app, { name, mime: artifacts.mimeFor(name), body: bytes, note: `Cowork ${action} output` });
  return artifact ? { ok: true, artifact, facts: { width: dim.width, height: dim.height, bytes: bytes.length }, output: `${action === 'generate' ? 'Image generated' : 'Image inpainted'}\nArtifact ${artifact.ref} · ${artifact.name}\nVerified: ${dim.width}×${dim.height}` }
    : { ok: false, class: contract.FAILURE.FAILED, why: 'the generated image could not be stored as a task artifact' };
}

module.exports = { decode, formatOf, source, run };
