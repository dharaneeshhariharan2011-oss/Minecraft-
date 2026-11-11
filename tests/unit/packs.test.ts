import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContentRegistry } from '../../shared/packs/registry.js';
import { PackValidationError, parsePack } from '../../shared/packs/parser.js';

const samplePath = resolve(__dirname, '../../public/packs/dh_sample/pack.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as Record<string, unknown>;

describe('behaviour pack loading', () => {
  it('parses the bundled sample pack without errors', () => {
    const parsed = parsePack(sample);
    expect(parsed.manifest.name).toBe('DH Sample Pack');
    expect(parsed.blocks.map((b) => b.identifier)).toEqual(['dh:glow_lantern']);
    expect(parsed.errors).toEqual([]);
  });

  it('registers custom blocks alongside the built-in content', () => {
    const content = new ContentRegistry();
    const warnings = content.loadPackFiles(sample);
    expect(warnings).toEqual([]);
    const lantern = content.blocks.byIdentifier('dh:glow_lantern');
    expect(lantern?.light).toBe(12);
    expect(content.items.has('dh:glow_lantern')).toBe(true);
    expect(content.blocks.byIdentifier('minecraft:stone')).toBeDefined();
  });

  it('reports a broken file and still loads the rest of the pack', () => {
    const files: Record<string, unknown> = {
      ...sample,
      'blocks/broken.json': '{ not json',
      'blocks/bad_geometry.json': {
        format_version: '1.20.0',
        'minecraft:block': { description: { identifier: 'dh:bad' }, components: { 'minecraft:geometry': 'sphere' } },
      },
    };
    const content = new ContentRegistry();
    const warnings = content.loadPackFiles(files);
    expect(warnings.some((w) => w.includes('broken.json'))).toBe(true);
    expect(content.blocks.byIdentifier('dh:glow_lantern')).toBeDefined();
    expect(content.blocks.byIdentifier('dh:bad')).toBeUndefined();
  });

  it('throws only when the manifest is missing or invalid', () => {
    const { 'manifest.json': _drop, ...rest } = sample;
    void _drop;
    expect(() => parsePack(rest)).toThrow(PackValidationError);
    expect(() => parsePack({ ...sample, 'manifest.json': { format_version: '9.0.0' } })).toThrow(PackValidationError);
  });

  it('does not let a pack redefine a built-in block', () => {
    const files = {
      ...sample,
      'blocks/stone_copy.json': {
        format_version: '1.20.0',
        'minecraft:block': { description: { identifier: 'minecraft:stone' }, components: {} },
      },
    };
    const content = new ContentRegistry();
    const warnings = content.loadPackFiles(files);
    expect(warnings.some((w) => w.includes('minecraft:stone already exists'))).toBe(true);
  });
});
