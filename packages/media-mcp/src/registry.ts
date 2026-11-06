export type MediaKind = 'image' | 'video';
export type ProviderId = 'comfyui';

export interface ModelInfo {
  id: string;
  kind: MediaKind;
  provider: ProviderId;
  license: string;
  /** False for open-weights licences that aren't OSI open source; agents see this. */
  osiOpenSource: boolean;
  inputs: ('text' | 'image')[];
  notes: string;
  /** Shown with every warning for a non-OSI model: who may use it free, and the limit. */
  usageLimit?: string;
  licenseUrl: string;
}

/**
 * Every model Gantrix knows how to run, all through a local ComfyUI. Both are Apache-2.0 today;
 * a non-OSI model added here gets the warning and needs MEDIA_ACCEPT_LICENSES to be enabled.
 */
export const CATALOG: readonly ModelInfo[] = [
  {
    id: 'z-image-turbo',
    kind: 'image',
    provider: 'comfyui',
    license: 'Apache-2.0',
    osiOpenSource: true,
    inputs: ['text', 'image'],
    notes: 'Z-Image-Turbo, 8 steps. Stills up to 2048 px.',
    licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo',
  },
  {
    id: 'wan-2.2-5b',
    kind: 'video',
    provider: 'comfyui',
    license: 'Apache-2.0',
    osiOpenSource: true,
    inputs: ['text', 'image'],
    notes:
      'Wan2.2-TI2V-5B, 24 fps, no sound. A 2 s clip on a 48 GB M5 Pro: fast 640x352 ~1.5 min, standard 832x480 ~3.5 min, high 1280x704 ~12 min.',
    licenseUrl: 'https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B',
  },
];

export const findModel = (id: string): ModelInfo | undefined => CATALOG.find((m) => m.id === id);

/** The warning shown wherever a non-OSI model appears or is used; null for open-source models. */
export const licenseWarning = (m: ModelInfo): string | null =>
  m.osiOpenSource
    ? null
    : `⚠ ${m.id} is not open source (${m.license}). ${m.usageLimit ?? 'Check the licence before use.'} ${m.licenseUrl}`;
