import type { Permission } from '@eventhub/kernel';
import { AppError, type FieldIssue } from '@eventhub/kernel';
import type { z } from 'zod';
import type { Principal } from '../modules/identity/authenticator.ts';

/**
 * Single source of truth for an API operation: HTTP binding, input/output schemas,
 * required permission (documentation; enforced in the service layer), and whether an
 * Idempotency-Key is mandatory. The OpenAPI document is generated from these definitions.
 */
export interface RouteContext<TParams, TQuery, TBody> {
  params: TParams;
  query: TQuery;
  body: TBody;
  principal: Principal;
  correlationId: string;
  idempotencyKey: string | undefined;
  /** Operation + validated params; scopes idempotency keys independent of URL spelling. */
  idempotencyScope: string;
}

export interface RouteResult {
  status: number;
  body: unknown;
  replayed?: boolean;
}

export interface RouteDefinition<TParams = unknown, TQuery = unknown, TBody = unknown> {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  /** 'authenticated' = any signed-in user (e.g. listing their own memberships). */
  requires: Permission | 'authenticated';
  idempotent: boolean;
  schemas: {
    params?: z.ZodType<TParams>;
    query?: z.ZodType<TQuery>;
    body?: z.ZodType<TBody>;
    response: { status: number; schema: z.ZodType };
  };
  handler(ctx: RouteContext<TParams, TQuery, TBody>): Promise<RouteResult>;
}

export type AnyRoute = RouteDefinition<unknown, unknown, unknown>;

export function defineRoute<TParams = unknown, TQuery = unknown, TBody = unknown>(
  def: RouteDefinition<TParams, TQuery, TBody>,
): AnyRoute {
  return def;
}

export function zodIssues(error: z.ZodError, prefix: string): FieldIssue[] {
  return error.issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].filter(Boolean).join('.'),
    message: i.message,
  }));
}

export function parseInput<T>(
  schema: z.ZodType<T> | undefined,
  value: unknown,
  location: string,
): T {
  if (!schema) return undefined as T;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', `Invalid request ${location}.`, {
      details: { fields: zodIssues(result.error, location) },
    });
  }
  return result.data;
}
