/** An error the agent should read and react to (returned as tool text, not a crash). */
export class MediaError extends Error {
  override name = 'MediaError';
}

export interface ImageRequest {
  model: string;
  prompt: string;
  width: number;
  height: number;
  steps?: number;
  /** Absolute path of an image to edit (image to image). */
  fromImage?: string;
  /** 0-1: how much of the input image to change. */
  strength?: number;
}

export interface VideoRequest {
  model: string;
  prompt: string;
  seconds: number;
  /** Absolute path of a start frame (image to video). */
  fromImage?: string;
  aspectRatio: string;
  camera: string;
  seed?: number;
  negativePrompt?: string;
  quality: VideoQuality;
}

export type VideoQuality = 'fast' | 'standard' | 'high';

export interface ImageResult {
  width: number;
  height: number;
}

export interface VideoResult {
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
}

export interface Provider {
  image(req: ImageRequest, out: string): Promise<ImageResult>;
  video(req: VideoRequest, out: string): Promise<VideoResult>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
