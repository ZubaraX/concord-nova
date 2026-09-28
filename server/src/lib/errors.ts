import type { FastifyError, FastifyInstance } from "fastify";
import { issuesToFields } from "@nova/shared";
import type { z } from "zod";

/** Error with an HTTP status and a stable machine-readable code (the client translates codes). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public fields?: Record<string, string>,
    public extra?: Record<string, unknown>
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code = "bad_request", message?: string, fields?: Record<string, string>) =>
  new ApiError(400, code, message, fields);
export const unauthorized = (code = "unauthorized") => new ApiError(401, code);
export const forbidden = (code = "missing_permissions") => new ApiError(403, code);
export const notFound = (code = "not_found") => new ApiError(404, code);
export const conflict = (code: string) => new ApiError(409, code);
export const tooMany = (retryAfterMs: number, code = "rate_limited") =>
  new ApiError(429, code, undefined, undefined, { retryAfter: Math.ceil(retryAfterMs / 1000) });

/** Validate input with a zod schema; throws a 400 with per-field codes. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, "validation_failed", "Invalid input", issuesToFields(r.error.issues));
  return r.data;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      if (err.extra?.retryAfter) reply.header("retry-after", String(err.extra.retryAfter));
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, fields: err.fields, ...err.extra } });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status === 429) {
      return reply.code(429).send({ error: { code: "rate_limited", message: "Too many requests" } });
    }
    if ((err as FastifyError).validation) {
      return reply.code(400).send({ error: { code: "validation_failed", message: err.message } });
    }
    if (status >= 500) req.log.error({ err }, "request failed");
    // Multipart limits, bad JSON, etc. keep their 4xx status.
    return reply.code(status).send({
      error: { code: status >= 500 ? "internal_error" : (err as FastifyError).code?.toLowerCase() ?? "bad_request", message: status >= 500 ? "Internal server error" : err.message },
    });
  });
}
