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

/** Context for unauthenticated routes: there is deliberately no principal. */
export interface PublicRouteContext<TParams, TQuery, TBody> {
  params: TParams;
  query: TQuery;
  body: TBody;
  correlationId: string;
}

export interface RouteResult {
  status: number;
  body: unknown;
  replayed?: boolean;
}

interface RouteBase<TParams, TQuery, TBody> {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  idempotent: boolean;
  /**
   * Required for a mutating route that does not take an Idempotency-Key: why retries are safe
   * without one (e.g. login must never store issued tokens in the idempotency table).
   */
  idempotencyExempt?: string;
  /** Stricter per-route limit (per client IP) in addition to the global limit. */
  rateLimit?: { max: number; timeWindow: string };
  schemas: {
    params?: z.ZodType<TParams>;
    query?: z.ZodType<TQuery>;
    body?: z.ZodType<TBody>;
    /** `schema` omitted means an empty response (e.g. 204). */
    response: { status: number; schema?: z.ZodType };
  };
}

export interface RouteDefinition<
  TParams = unknown,
  TQuery = unknown,
  TBody = unknown,
> extends RouteBase<TParams, TQuery, TBody> {
  /** 'authenticated' = any signed-in user (e.g. listing their own memberships). */
  requires: Permission | 'authenticated';
  handler(ctx: RouteContext<TParams, TQuery, TBody>): Promise<RouteResult>;
}

export interface PublicRouteDefinition<
  TParams = unknown,
  TQuery = unknown,
  TBody = unknown,
> extends RouteBase<TParams, TQuery, TBody> {
  handler(ctx: PublicRouteContext<TParams, TQuery, TBody>): Promise<RouteResult>;
}

export type SessionRoute = RouteDefinition<unknown, unknown, unknown> & { auth: 'session' };
export type PublicRoute = PublicRouteDefinition<unknown, unknown, unknown> & {
  auth: 'public';
  requires: 'public';
};
export type AnyRoute = SessionRoute | PublicRoute;

export function defineRoute<TParams = unknown, TQuery = unknown, TBody = unknown>(
  def: RouteDefinition<TParams, TQuery, TBody>,
): AnyRoute {
  return { ...(def as RouteDefinition), auth: 'session' };
}

/** Unauthenticated route. Use only for pre-session flows (sign-up, login, email verification). */
export function definePublicRoute<TParams = unknown, TQuery = unknown, TBody = unknown>(
  def: PublicRouteDefinition<TParams, TQuery, TBody>,
): AnyRoute {
  return { ...(def as PublicRouteDefinition), auth: 'public', requires: 'public' };
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
