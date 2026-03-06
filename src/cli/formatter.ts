/**
 * Output formatter for CLI results.
 *
 * Three modes:
 * - json:  Raw JSON (default when piped)
 * - table: Formatted key-value or tabular output (default on TTY)
 * - plain: Minimal output for scripting
 */

export type OutputFormat = 'json' | 'table' | 'plain';

/** Detect default output format based on TTY. */
export function defaultFormat(): OutputFormat {
  return process.stdout.isTTY ? 'table' : 'json';
}

/** Format and print a tool handler's JSON result string. */
export function formatOutput(jsonStr: string, format: OutputFormat): string {
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    // Not JSON — return raw
    return jsonStr;
  }

  switch (format) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'plain':
      return formatPlain(data);
    case 'table':
      return formatTable(data);
  }
}

/** Plain mode: extract the most useful single value. */
function formatPlain(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data !== 'object') return String(data);

  const obj = data as Record<string, unknown>;

  // Error case
  if (obj.success === false && obj.error) {
    return `ERROR: ${obj.error}`;
  }

  // If there's a primary data array, count it
  const arrayKey = findArrayKey(obj);
  if (arrayKey) {
    const arr = obj[arrayKey] as unknown[];
    return `${arr.length} ${arrayKey}`;
  }

  // Single value responses
  if (obj.success === true && Object.keys(obj).length === 2) {
    const valueKey = Object.keys(obj).find((k) => k !== 'success');
    if (valueKey) return String(obj[valueKey]);
  }

  return JSON.stringify(data);
}

/** Table mode: format as bordered key-value pairs or tabular data. */
function formatTable(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data !== 'object') return String(data);

  const obj = data as Record<string, unknown>;

  // Error case — red
  if (obj.success === false) {
    const lines = [`\x1b[31mError:\x1b[0m ${obj.error || 'Unknown error'}`];
    if (obj.hint) lines.push(`\x1b[33mHint:\x1b[0m ${obj.hint}`);
    if (obj.suggestions) lines.push(`\x1b[33mSuggestions:\x1b[0m ${(obj.suggestions as string[]).join(', ')}`);
    return lines.join('\n');
  }

  // Find the primary data array for tabular display
  const arrayKey = findArrayKey(obj);
  if (arrayKey) {
    const arr = obj[arrayKey] as Record<string, unknown>[];
    if (arr.length === 0) return `No ${arrayKey} found.`;
    return formatArrayAsTable(arr, arrayKey);
  }

  // Key-value display for single-object responses
  return formatKeyValue(obj);
}

/** Find the first array-valued key in a response object (skip metadata). */
function findArrayKey(obj: Record<string, unknown>): string | undefined {
  const skip = new Set(['success', 'error', 'hint', 'suggestions', 'truncated', 'total', 'limit', 'offset', 'page_count']);
  for (const [key, value] of Object.entries(obj)) {
    if (skip.has(key)) continue;
    if (Array.isArray(value)) return key;
  }
  return undefined;
}

/** Format an array of objects as an aligned table. */
function formatArrayAsTable(arr: Record<string, unknown>[], label: string): string {
  if (arr.length === 0) return `No ${label}.`;

  // Pick columns: use keys from first item, prefer short scalar values
  const allKeys = Object.keys(arr[0]);
  const columns = allKeys.filter((k) => {
    const sample = arr[0][k];
    return sample === null || sample === undefined || typeof sample !== 'object';
  }).slice(0, 8); // max 8 columns

  if (columns.length === 0) {
    // All values are objects — fall back to JSON
    return JSON.stringify(arr, null, 2);
  }

  // Build rows
  const rows: string[][] = [columns.map((c) => c.toUpperCase())];
  for (const item of arr) {
    rows.push(columns.map((c) => formatCell(item[c])));
  }

  // Calculate column widths
  const widths = columns.map((_, i) =>
    Math.min(40, Math.max(...rows.map((r) => r[i].length)))
  );

  // Render
  const lines: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map((cell, i) => cell.padEnd(widths[i]));
    lines.push(cells.join('  '));
    if (r === 0) {
      lines.push(widths.map((w) => '─'.repeat(w)).join('──'));
    }
  }

  const countLine = arr.length > 1 ? `\n\x1b[2m${arr.length} ${label}\x1b[0m` : '';
  return lines.join('\n') + countLine;
}

/** Format a key-value object for display. */
function formatKeyValue(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  const skip = new Set(['success']);

  for (const [key, value] of Object.entries(obj)) {
    if (skip.has(key)) continue;
    if (value === null || value === undefined) continue;

    if (typeof value === 'object' && !Array.isArray(value)) {
      // Nested object — inline JSON
      lines.push(`\x1b[1m${key}:\x1b[0m`);
      lines.push(indent(JSON.stringify(value, null, 2), '  '));
    } else if (Array.isArray(value)) {
      lines.push(`\x1b[1m${key}:\x1b[0m ${value.length} items`);
    } else {
      lines.push(`\x1b[1m${key}:\x1b[0m ${value}`);
    }
  }
  return lines.join('\n');
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length > 40 ? value.slice(0, 37) + '...' : value;
  return String(value);
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((line) => prefix + line).join('\n');
}
