import { randomUUID } from 'node:crypto';

/**
 * Asynchronous domain-event envelope (Technical Architecture §3 contract rule 2).
 * Consumers must deduplicate on `eventId` and be safe to retry.
 */
export interface Actor {
  type: 'user' | 'system' | 'platform_support';
  id: string | null;
}

export interface DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: Date;
  actor: Actor;
  organizationId: string | null;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  causationId: string | null;
  payload: TPayload;
}

export function createDomainEvent<TPayload extends Record<string, unknown>>(
  input: Omit<DomainEvent<TPayload>, 'eventId' | 'occurredAt' | 'causationId'> & {
    occurredAt?: Date;
    causationId?: string | null;
  },
): DomainEvent<TPayload> {
  return {
    ...input,
    eventId: randomUUID(),
    occurredAt: input.occurredAt ?? new Date(),
    causationId: input.causationId ?? null,
  };
}
