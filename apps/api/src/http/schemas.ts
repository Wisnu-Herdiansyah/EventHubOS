import { z } from 'zod';
import { ERROR_DEFINITIONS } from '@eventhub/kernel';

export const uuid = z.uuid();

export const errorBodySchema = z
  .object({
    error: z.object({
      code: z.enum(Object.keys(ERROR_DEFINITIONS) as [keyof typeof ERROR_DEFINITIONS]),
      message: z.string(),
      retryable: z.boolean(),
      correlationId: z.string(),
      details: z
        .object({
          reason: z.string().optional(),
          fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
        })
        .optional(),
    }),
  })
  .meta({ id: 'ErrorBody' });

/** Validates an IANA time zone name (rejects raw offsets so schedules stay DST-aware). */
export const ianaTimeZone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/, 'Must be an IANA time zone, e.g. Asia/Jakarta')
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

/** BCP 47 language/locale tag, canonicalised. */
export const languageTag = z
  .string()
  .min(2)
  .max(35)
  .transform((v, ctx) => {
    try {
      const [canonical] = Intl.getCanonicalLocales(v);
      if (canonical) return canonical;
    } catch {
      // fall through
    }
    ctx.addIssue({ code: 'custom', message: 'Must be a BCP 47 language tag, e.g. en or id-ID' });
    return z.NEVER;
  });
