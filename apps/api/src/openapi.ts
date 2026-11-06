import { z } from 'zod';
import { PERMISSION_CATALOG_VERSION } from '@eventhub/kernel';
import type { AnyRoute } from './http/route.ts';
import { errorBodySchema } from './http/schemas.ts';

type Json = Record<string, unknown>;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
  }) as Json;
  return rest;
}

function parameters(schema: z.ZodType | undefined, location: 'path' | 'query'): Json[] {
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = schema.shape as Record<string, z.ZodType>;
  return Object.entries(shape).map(([name, field]) => ({
    name,
    in: location,
    required: location === 'path' ? true : !field.safeParse(undefined).success,
    schema: jsonSchema(field, 'input'),
  }));
}

const ERROR_STATUSES: Record<string, string> = {
  '400': 'Validation failed or Idempotency-Key missing',
  '401': 'Unauthenticated',
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
  for (const route of routes) {
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const errorResponses = Object.fromEntries(
      Object.entries(ERROR_STATUSES).map(([status, description]) => [
        status,
        {
          description,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } },
        },
      ]),
    );
    const params: Json[] = [
      ...parameters(route.schemas.params, 'path'),
      ...parameters(route.schemas.query, 'query'),
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
      security: [{ sessionToken: [] }],
      'x-eventhub-requires': route.requires,
      parameters: params,
      ...(route.schemas.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: jsonSchema(route.schemas.body, 'input') } },
            },
          }
        : {}),
      responses: {
        [String(route.schemas.response.status)]: {
          description: 'Success',
          content: {
            'application/json': { schema: jsonSchema(route.schemas.response.schema, 'output') },
          },
        },
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
      schemas: { ErrorBody: jsonSchema(errorBodySchema, 'output') },
    },
  };
}
