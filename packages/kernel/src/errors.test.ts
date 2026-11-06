import { describe, expect, it } from 'vitest';
import { AppError, ERROR_DEFINITIONS, internalErrorBody, notFound } from './errors.ts';

describe('AppError', () => {
  it('serialises a consistent body with correlation ID and retryability', () => {
    const e = new AppError('validation_failed', 'Bad input.', {
      details: { fields: [{ path: 'name', message: 'Required' }] },
    });
    expect(e.status).toBe(400);
    expect(e.toBody('corr-123')).toEqual({
      error: {
        code: 'validation_failed',
        message: 'Bad input.',
        retryable: false,
        correlationId: 'corr-123',
        details: { fields: [{ path: 'name', message: 'Required' }] },
      },
    });
  });

  it('maps every code to a 4xx/5xx status', () => {
    for (const def of Object.values(ERROR_DEFINITIONS)) {
      expect(def.status).toBeGreaterThanOrEqual(400);
      expect(def.status).toBeLessThan(600);
    }
  });

  it('produces a generic internal error body', () => {
    const body = internalErrorBody('c-1');
    expect(body.error.code).toBe('internal_error');
    expect(body.error.retryable).toBe(true);
    expect(body.error.correlationId).toBe('c-1');
  });

  it('uses the same not_found shape for absent and inaccessible resources', () => {
    expect(notFound('Event').toBody('c').error).toMatchObject({
      code: 'not_found',
      message: 'Event not found.',
    });
  });
});
