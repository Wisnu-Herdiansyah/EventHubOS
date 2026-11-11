import { z } from 'zod';
import { PERMISSION_CATALOG_VERSION } from '@eventhub/kernel';
import type { AnyRoute } from './http/route.ts';
import { errorBodySchema } from './http/schemas.ts';

type Json = Record<string, unknown>;

/** Rewrites Zod's local `#/$defs/X` references to `#/components/schemas/X`. */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node as Json).map(([k, v]) =>
      k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')
        ? [k, `#/components/schemas/${v.slice('#/$defs/'.length)}`]
        : [k, rewriteRefs(v)],
    ),
  );
}

/**
 * Converts a Zod schema to JSON Schema for embedding in the OpenAPI document. Named schemas
 * (`.meta({ id })`) are hoisted into `components.schemas` so every `$ref` resolves against the
 * document root; two different shapes under one name are a contract error.
 */
function jsonSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
  components: Record<string, Json>,
): Json {
  const raw = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Json;
  const { $schema: _schema, $defs, ...rest } = raw;
  for (const [name, def] of Object.entries(($defs ?? {}) as Record<string, Json>)) {
    const rewritten = rewriteRefs(def) as Json;
    const existing = components[name];
    if (existing && JSON.stringify(existing) !== JSON.stringify(rewritten)) {
      throw new Error(`OpenAPI: conflicting definitions for schema "${name}"`);
    }
    components[name] = rewritten;
  }
  return rewriteRefs(rest) as Json;
}

function parameters(
  schema: z.ZodType | undefined,
  location: 'path' | 'query',
  components: Record<string, Json>,
): Json[] {
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = schema.shape as Record<string, z.ZodType>;
  return Object.entries(shape).map(([name, field]) => ({
    name,
    in: location,
    required: location === 'path' ? true : !field.safeParse(undefined).success,
    schema: jsonSchema(field, 'input', components),
  }));
}

const ERROR_STATUSES: Record<string, string> = {
  '400': 'Validation failed or Idempotency-Key missing',
  '401': 'Unauthenticated, or invalid credentials on login',
  '403': 'Forbidden (missing permission or unverified email)',
  '404': 'Not found (also returned for resources in other organizations)',
  '409': 'Conflict',
  '422': 'Idempotency-Key reused with a different payload',
  '429': 'Rate limited',
  '500': 'Internal error (generic body with correlation ID)',
};

/** Builds the OpenAPI 3.1 document from route definitions (single source of truth). */
export function buildOpenApiDocument(routes: AnyRoute[]): Json {
  const paths: Record<string, Json> = {};
  const components: Record<string, Json> = {};
  const errorBodyRef = jsonSchema(errorBodySchema, 'output', components);
  for (const route of routes) {
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const errorResponses = Object.fromEntries(
      Object.entries(ERROR_STATUSES).map(([status, description]) => [
        status,
        {
          description,
          content: { 'application/json': { schema: errorBodyRef } },
        },
      ]),
    );
    const params: Json[] = [
      ...parameters(route.schemas.params, 'path', components),
      ...parameters(route.schemas.query, 'query', components),
      {
        name: 'X-Correlation-Id',
        in: 'header',
        required: false,
        schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,128}$' },
      },
    ];
    if (route.idempotent) {
      params.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{8,255}$' },
      });
    }
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
      security: route.auth === 'public' ? [] : [{ sessionToken: [] }],
      'x-eventhub-requires': route.requires,
      ...(route.idempotencyExempt
        ? { 'x-eventhub-idempotency-exempt': route.idempotencyExempt }
        : {}),
      ...(route.rateLimit ? { 'x-eventhub-rate-limit': route.rateLimit } : {}),
      parameters: params,
      ...(route.schemas.body
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: jsonSchema(route.schemas.body, 'input', components) },
              },
            },
          }
        : {}),
      responses: {
        [String(route.schemas.response.status)]: route.schemas.response.contentType
          ? {
              description: 'Success (bytes)',
              content: {
                [route.schemas.response.contentType]: {
                  schema: { type: 'string', format: 'binary' },
                },
              },
            }
          : route.schemas.response.schema
            ? {
                description: 'Success',
                content: {
                  'application/json': {
                    schema: jsonSchema(route.schemas.response.schema, 'output', components),
                  },
                },
              }
            : { description: 'Success (no content)' },
        ...errorResponses,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'EventHub OS API',
      version: '0.1.0',
      description: `Control-plane API. Permission catalog version ${PERMISSION_CATALOG_VERSION}. Organization IDs in paths are locators only; access is resolved from the caller's membership.`,
    },
    paths,
    components: {
      securitySchemes: {
        sessionToken: { type: 'http', scheme: 'bearer', description: 'Opaque session token' },
      },
      schemas: Object.fromEntries(
        Object.entries(components).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
  };
}
