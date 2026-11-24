import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');

/** Reads `--name: light-dark(#aaa, #bbb);` into its two theme values. */
function token(name: string): { light: string; dark: string } {
  const match = css.match(new RegExp(`--${name}:\\s*light-dark\\(\\s*(#[0-9a-fA-F]{3,8})\\s*,\\s*(#[0-9a-fA-F]{3,8})\\s*\\)`));
  if (!match) throw new Error(`Token --${name} is not a light-dark() pair of hex values`);
  return { light: match[1]!, dark: match[2]! };
}

function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (high! + 0.05) / (low! + 0.05);
}

const themes = ['light', 'dark'] as const;
/** Reading surfaces. `--surface-3` is a control fill and only carries --text and --muted-1. */
const reading = ['paper', 'surface-1', 'surface-2'] as const;
const controls = ['paper', 'surface-1', 'surface-2', 'surface-3'] as const;

describe('the palette', () => {
  it.each(themes)('keeps body and secondary text readable on every surface in %s', (theme) => {
    for (const name of ['text', 'muted-1'] as const) {
      for (const surface of controls) {
        const ratio = contrast(token(name)[theme], token(surface)[theme]);
        expect(ratio, `--${name} on --${surface} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const surface of reading) {
      const ratio = contrast(token('muted-2')[theme], token(surface)[theme]);
      expect(ratio, `--muted-2 on --${surface} in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(themes)('keeps the quietest step above 3:1 in %s', (theme) => {
    for (const surface of reading) {
      const ratio = contrast(token('muted-3')[theme], token(surface)[theme]);
      expect(ratio, `--muted-3 on --${surface} in ${theme}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(themes)('keeps the accent readable as text in %s', (theme) => {
    for (const surface of reading) {
      const ratio = contrast(token('accent')[theme], token(surface)[theme]);
      expect(ratio, `--accent on --${surface} in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(themes)('keeps ink on the solid accent control readable in %s', (theme) => {
    expect(contrast(token('accent-ink')[theme], token('accent-fill')[theme])).toBeGreaterThanOrEqual(4.5);
  });

  it('reserves exactly one accent hue for both themes', () => {
    expect(token('accent')).toEqual(token('accent-fill'));
  });
});
