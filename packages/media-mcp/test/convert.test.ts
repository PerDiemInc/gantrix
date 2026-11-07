import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertImage } from '../src/convert.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'convert-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const png = async (name: string) => {
  const path = join(dir, name);
  await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
  })
    .png()
    .toFile(path);
  return path;
};

describe('convertImage', () => {
  it('turns a PNG into a JPEG on white and removes the PNG', async () => {
    const src = await png('a.jpg.tmp.png');
    await convertImage(src, join(dir, 'a.jpg'));
    const bytes = await readFile(join(dir, 'a.jpg'));
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(await stat(src).catch(() => null)).toBeNull();
  });

  it('turns a PNG into WebP', async () => {
    const src = await png('b.webp.tmp.png');
    await convertImage(src, join(dir, 'b.webp'));
    const bytes = await readFile(join(dir, 'b.webp'));
    expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
  });
});
