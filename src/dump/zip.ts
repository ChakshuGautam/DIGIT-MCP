import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import type { Manifest } from './types.js';

const MANIFEST_FILE = 'manifest.json';

/**
 * Create a zip buffer from a manifest + per-entry content. `entries` maps
 * file name (e.g. "mdms-data.jsonl") to an array of lines (no trailing newline).
 * The sha256 in the manifest is computed over the concatenated entry bodies
 * in sorted-by-key order, then written into the manifest before the zip is
 * finalized.
 *
 * `entries` values are arrays of non-empty strings (typically jsonl rows).
 * Each row is joined with `\n` on write and split back on read. Empty arrays
 * produce an empty body that round-trips as an empty array. The shape `[""]`
 * is not a supported input — an empty body is coerced to `[]` on read, so
 * round-tripping `[""]` will yield `[]` (no bijection for that edge case).
 */
export async function createDumpZip(
  manifest: Manifest,
  entries: Map<string, string[]>,
): Promise<Buffer> {
  const zip = new JSZip();

  const sortedKeys = Array.from(entries.keys()).sort();
  const hash = createHash('sha256');
  const lenBuf = Buffer.alloc(4);
  for (const key of sortedKeys) {
    const body = entries.get(key) ?? [];
    const joined = body.join('\n');

    lenBuf.writeUInt32BE(Buffer.byteLength(key), 0);
    hash.update(lenBuf);
    hash.update(key);

    lenBuf.writeUInt32BE(Buffer.byteLength(joined), 0);
    hash.update(lenBuf);
    hash.update(joined);
  }
  const sha256 = hash.digest('hex');

  const finalManifest: Manifest = { ...manifest, sha256 };
  zip.file(MANIFEST_FILE, JSON.stringify(finalManifest, null, 2));

  for (const key of sortedKeys) {
    zip.file(key, (entries.get(key) ?? []).join('\n'));
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Read a zip buffer. Verifies sha256 in the manifest against the recomputed
 * value over the entry bodies. Throws on mismatch.
 */
export async function readDumpZip(
  buf: Buffer,
): Promise<{ manifest: Manifest; entries: Map<string, string[]> }> {
  const zip = await JSZip.loadAsync(buf);
  const manifestRaw = zip.file(MANIFEST_FILE);
  if (!manifestRaw) throw new Error('zip is missing manifest.json');
  const manifest = JSON.parse(await manifestRaw.async('string')) as Manifest;

  const entries = new Map<string, string[]>();
  for (const [name, file] of Object.entries(zip.files)) {
    if (name === MANIFEST_FILE || file.dir) continue;
    const body = await file.async('string');
    entries.set(name, body === '' ? [] : body.split('\n'));
  }

  const sortedKeys = Array.from(entries.keys()).sort();
  const hash = createHash('sha256');
  const lenBuf = Buffer.alloc(4);
  for (const key of sortedKeys) {
    const body = entries.get(key) ?? [];
    const joined = body.join('\n');

    lenBuf.writeUInt32BE(Buffer.byteLength(key), 0);
    hash.update(lenBuf);
    hash.update(key);

    lenBuf.writeUInt32BE(Buffer.byteLength(joined), 0);
    hash.update(lenBuf);
    hash.update(joined);
  }
  const computed = hash.digest('hex');
  if (computed !== manifest.sha256) {
    throw new Error(`manifest_checksum_mismatch: expected ${manifest.sha256}, got ${computed}`);
  }

  return { manifest, entries };
}
