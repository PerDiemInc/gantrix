import { z } from 'zod';

/** An error with an HTTP status and a message that is safe to show the client. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found.`);

/** Validates a request part with Zod; failures become a 400 with every problem listed. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

export const IdParams = z.object({ id: z.uuid() });
