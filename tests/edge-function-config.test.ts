// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const configPath = join(root, 'supabase/config.toml');

// Both handlers authenticate callers themselves (device credential / forwarded JWT), so the
// gateway JWT precheck must stay off across redeploys; a plain deploy would otherwise re-enable it.
const selfAuthenticatingFunctions = ['gate-attendance-events', 'private-academic-file'];

function functionBlock(toml: string, name: string) {
  const start = toml.indexOf(`[functions.${name}]`);
  if (start < 0) return null;
  const rest = toml.slice(start + 1);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('Edge Function gateway config stored in the repo', () => {
  it.each(selfAuthenticatingFunctions)('pins verify_jwt = false for %s', (name) => {
    expect(existsSync(join(root, 'supabase/functions', name, 'index.ts'))).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    const block = functionBlock(readFileSync(configPath, 'utf8'), name);
    expect(block).not.toBeNull();
    expect(block).toMatch(/^verify_jwt\s*=\s*false\s*$/m);
  });
});
