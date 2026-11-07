import { rm } from 'node:fs/promises';
import sharp from 'sharp';

/** Image formats generate_image can save; the model makes a PNG and we convert it. */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

/** Converts a PNG to the format the output path asks for, then removes the PNG. */
export async function convertImage(png: string, out: string): Promise<void> {
  const ext = out.toLowerCase().slice(out.lastIndexOf('.'));
  const image = sharp(png);
  if (ext === '.jpg' || ext === '.jpeg') {
    // JPEG has no transparency: put the image on white first.
    await image.flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true }).toFile(out);
  } else if (ext === '.webp') {
    await image.webp({ quality: 88 }).toFile(out);
  } else {
    return;
  }
  await rm(png, { force: true });
}
