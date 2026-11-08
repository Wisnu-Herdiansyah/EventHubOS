import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { AppError, internalErrorBody, LOG_REDACT_PATHS } from '@eventhub/kernel';
import { canonicalJson, type Pool } from '@eventhub/db';
import { parseInput, type AnyRoute, type RouteResult } from './http/route.ts';
import { parseBearerToken, type SessionAuthenticator } from './modules/identity/authenticator.ts';
import type { PasswordHasher } from './modules/identity/password.ts';
import { identityRoutes, type IdentitySettings } from './modules/identity/routes.ts';
import { auditRoutes } from './modules/audit/routes.ts';
import { eventManagementRoutes } from './modules/event/management-routes.ts';
import { eventRoutes } from './modules/event/routes.ts';
import { DEFAULT_INVITATION_TTL_SECONDS, membershipRoutes } from './modules/membership/routes.ts';
import { organizationRoutes } from './modules/organization/routes.ts';
import { pageRoutes } from './modules/page/routes.ts';
import { publicSiteRoutes } from './modules/public-site/routes.ts';

export interface AppDependencies {
  pool: Pool;
  authenticator: SessionAuthenticator;
  passwordHasher: PasswordHasher;
  identity: IdentitySettings;
  /** Invitation lifetime; defaults to 7 days. */
  invitationTtlSeconds?: number;
  logger: FastifyServerOptions['logger'];
  /** Custom logger instance (tests capture output to assert redaction). */
  loggerInstance?: FastifyServerOptions['loggerInstance'];
  trustProxy?: boolean | string[];
  rateLimitPerMinute?: number;
  /** Validate responses against their contract (enable outside production). */
  validateResponses?: boolean;
}

const CORRELATION_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const BODY_LIMIT_BYTES = 64 * 1024;

export interface RouteFactoryDeps {
  pool: Pool;
  passwordHasher: PasswordHasher;
  identity: IdentitySettings;
  invitationTtlSeconds?: number;
}

export function allRoutes(deps: RouteFactoryDeps): AnyRoute[] {
  return [
    ...identityRoutes(deps.pool, deps.passwordHasher, deps.identity),
    ...organizationRoutes(deps.pool),
    ...membershipRoutes(deps.pool, deps.invitationTtlSeconds ?? DEFAULT_INVITATION_TTL_SECONDS),
    ...eventRoutes(deps.pool),
    ...eventManagementRoutes(deps.pool),
    ...pageRoutes(deps.pool),
    ...publicSiteRoutes(deps.pool),
    ...auditRoutes(deps.pool),
  ];
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    ...(deps.loggerInstance
      ? { loggerInstance: deps.loggerInstance }
      : { logger: deps.logger ?? false }),
    trustProxy: deps.trustProxy ?? false,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    genReqId: (req) => {
      const supplied = req.headers['x-correlation-id'];
      return typeof supplied === 'string' && CORRELATION_RE.test(supplied)
        ? supplied
        : randomUUID();
    },
  });

  await app.register(rateLimit, {
    max: deps.rateLimitPerMinute ?? 300,
    timeWindow: '1 minute',
    // TODO(platform): move to a shared Redis store once the cache provider is approved (D11).
    errorResponseBuilder: () => new AppError('rate_limited', 'Too many requests. Retry later.'),
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('x-correlation-id', request.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    done(null, payload);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(new AppError('not_found', 'Route not found.').toBody(request.id));
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    const correlationId = request.id;
    if (error instanceof AppError) {
      return reply.status(error.status).send(error.toBody(correlationId));
    }
    const status = error.statusCode ?? 500;
    let mapped: AppError | null = null;
    if (status === 413) mapped = new AppError('payload_too_large', 'Request body is too large.');
    else if (status === 415)
      mapped = new AppError('unsupported_media_type', 'Use Content-Type: application/json.');
    else if (status === 429)
      mapped = new AppError('rate_limited', 'Too many requests. Retry later.');
    else if (status >= 400 && status < 500)
      mapped = new AppError('validation_failed', 'Malformed request.');
    if (mapped) return reply.status(mapped.status).send(mapped.toBody(correlationId));

    // Unexpected: log server-side with correlation ID; return a generic body with no internals.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(internalErrorBody(correlationId));
  });

  app.get('/health/live', (_request, reply) => reply.send({ status: 'ok' }));
  app.get('/health/ready', async (request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch (error) {
      request.log.warn({ err: error }, 'readiness check failed');
      return reply
        .status(503)
        .send(new AppError('service_unavailable', 'Not ready.').toBody(request.id));
    }
  });

  for (const route of allRoutes(deps)) registerRoute(app, route, deps);
  return app;
}

function registerRoute(app: FastifyInstance, route: AnyRoute, deps: AppDependencies): void {
  app.route({
    method: route.method,
    url: route.path,
    ...(route.rateLimit ? { config: { rateLimit: route.rateLimit } } : {}),
    handler: async (request, reply) => {
      let result: RouteResult;
      const rawAgent = request.headers['user-agent'];
      const userAgent =
        typeof rawAgent === 'string' && rawAgent.trim() ? rawAgent.trim().slice(0, 256) : undefined;
      if (route.auth === 'public') {
        const params = parseInput(route.schemas.params, request.params, 'params');
        const query = parseInput(route.schemas.query, request.query, 'query');
        const body = parseInput(route.schemas.body, request.body ?? {}, 'body');
        result = await route.handler({
          params,
          query,
          body,
          correlationId: request.id,
          userAgent,
        });
      } else {
        const token = parseBearerToken(request.headers.authorization);
        const principal = token ? await deps.authenticator.authenticate(token) : null;
        if (!principal) {
          throw new AppError('unauthenticated', 'A valid session is required.');
        }

        let idempotencyKey: string | undefined;
        if (route.idempotent) {
          const header = request.headers['idempotency-key'];
          if (typeof header !== 'string' || header.length === 0) {
            throw new AppError(
              'idempotency_key_required',
              'This operation requires an Idempotency-Key header.',
            );
          }
          idempotencyKey = header;
        }

        const params = parseInput(route.schemas.params, request.params, 'params');
        const query = parseInput(route.schemas.query, request.query, 'query');
        const body = parseInput(route.schemas.body, request.body ?? {}, 'body');
        result = await route.handler({
          params,
          query,
          body,
          principal,
          correlationId: request.id,
          userAgent,
          idempotencyKey,
          idempotencyScope: `${route.operationId}:${canonicalJson(params ?? {})}`,
        });
      }

      const responseSchema = route.schemas.response.schema;
      if (
        deps.validateResponses &&
        responseSchema &&
        !result.replayed &&
        result.status === route.schemas.response.status
      ) {
        const parsed: unknown = responseSchema.parse(result.body);
        // Zod drops unknown keys silently; an undocumented field means the OpenAPI contract
        // (and the clients generated from it) no longer describe what the API sends.
        const extra = undocumentedPaths(result.body, parsed);
        if (extra.length > 0) {
          throw new Error(`Response has fields missing from its schema: ${extra.join(', ')}`);
        }
      }
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      if (result.status === 204) return reply.status(204).send();
      return reply.status(result.status).send(result.body);
    },
  });
}

/** Paths present in `actual` but absent from the schema-parsed `documented` value. */
export function undocumentedPaths(actual: unknown, documented: unknown, path = '$'): string[] {
  if (Array.isArray(actual) && Array.isArray(documented)) {
    return actual.flatMap((item, i) => undocumentedPaths(item, documented[i], `${path}[${i}]`));
  }
  if (actual && typeof actual === 'object' && documented && typeof documented === 'object') {
    const doc = documented as Record<string, unknown>;
    return Object.entries(actual as Record<string, unknown>).flatMap(([key, value]) =>
      key in doc
        ? undocumentedPaths(value, doc[key], `${path}.${key}`)
        : value === undefined
          ? []
          : [`${path}.${key}`],
    );
  }
  return [];
}

export function loggerOptions(level: string): FastifyServerOptions['logger'] {
  return {
    level,
    redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' },
  };
}
