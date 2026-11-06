export type MediaKind = 'image' | 'video';
export type ProviderId = 'ltx-desktop' | 'comfyui';

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

/** Every model Gantrix knows how to run, with its licence shown to agents. */
export const CATALOG: readonly ModelInfo[] = [
  {
    id: 'z-image-turbo',
    kind: 'image',
    provider: 'ltx-desktop',
    license: 'Apache-2.0',
    osiOpenSource: true,
    inputs: ['text', 'image'],
    notes:
      'Stills up to 2048 px. About 50 s for 1024x1024 on an M5 Pro, first call (model load included).',
    licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo',
  },
  {
    id: 'ltx-2.5',
    kind: 'video',
    provider: 'ltx-desktop',
    license: 'LTX-2 Community License',
    osiOpenSource: false,
    inputs: ['text', 'image'],
    notes:
      'Clips of 2-20 s, with sound. On an M5 Pro a 4 s 720p clip took about 4.5 min from an image and 6 min from text.',
    usageLimit:
      'Free for organisations under $10M annual revenue; above that you need a paid licence from Lightricks. It also restricts products that compete with Lightricks.',
    licenseUrl: 'https://static.lightricks.com/legal/ltx-2-open-weights-license-0.X.pdf',
  },
  {
    id: 'wan-2.2-5b',
    kind: 'video',
    provider: 'comfyui',
    license: 'Apache-2.0',
    osiOpenSource: true,
    inputs: ['text', 'image'],
    notes: 'Wan2.2-TI2V-5B through a local ComfyUI.',
    licenseUrl: 'https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B',
  },
];

export const findModel = (id: string): ModelInfo | undefined => CATALOG.find((m) => m.id === id);

/** The warning shown wherever a non-OSI model appears or is used; null for open-source models. */
export const licenseWarning = (m: ModelInfo): string | null =>
  m.osiOpenSource
    ? null
    : `⚠ ${m.id} is not open source (${m.license}). ${m.usageLimit ?? 'Check the licence before use.'} ${m.licenseUrl}`;
