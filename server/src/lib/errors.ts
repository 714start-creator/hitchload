export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const bad = (code: string, message?: string, details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'Sign in required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const conflict = (code: string, message?: string) => new HttpError(409, code, message);
export const paymentRequired = (code: string, message?: string) => new HttpError(402, code, message);
