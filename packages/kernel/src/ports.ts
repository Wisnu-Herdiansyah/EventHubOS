import type { DomainEvent } from './domain-event.ts';

/**
 * Provider ports. Domain code depends only on these interfaces; concrete providers live in
 * adapter modules selected by configuration and are verified with shared contract tests
 * (see `@eventhub/kernel/testing`).
 */

/** Durable message broker used by the outbox relay. Must be at-least-once. */
export interface EventPublisher {
  readonly name: string;
  publish(event: DomainEvent): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** In-memory publisher: a local/test fake only. Refused by config in staging/production. */
export class InMemoryEventPublisher implements EventPublisher {
  readonly name = 'in_memory';
  readonly published: DomainEvent[] = [];
  #failNext = 0;

  /** Test hook: make the next `count` publishes reject (simulates broker outage). */
  failNext(count: number): void {
    this.#failNext = count;
  }

  publish(event: DomainEvent): Promise<void> {
    if (this.#failNext > 0) {
      this.#failNext -= 1;
      return Promise.reject(new Error('in-memory publisher: simulated outage'));
    }
    this.published.push(structuredClone(event));
    return Promise.resolve();
  }
}

/**
 * Transactional email delivery. The provider is an open decision (D4); adapters must be
 * idempotent per `messageId` where the provider supports it, and must never log `text`
 * (it can contain single-use tokens).
 */
export interface EmailMessage {
  /** Stable ID (e.g. derived from the domain event) for provider-side deduplication. */
  messageId: string;
  to: string;
  template: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** In-memory sender: a local/test fake only. Refused by config in staging/production. */
export class InMemoryEmailSender implements EmailSender {
  readonly name = 'in_memory';
  readonly sent: EmailMessage[] = [];
  #failNext = 0;

  failNext(count: number): void {
    this.#failNext = count;
  }

  send(message: EmailMessage): Promise<void> {
    if (this.#failNext > 0) {
      this.#failNext -= 1;
      return Promise.reject(new Error('in-memory email sender: simulated outage'));
    }
    this.sent.push(structuredClone(message));
    return Promise.resolve();
  }
}

/**
 * Object storage for uploaded files (ADR-0042). The production provider (bucket, region) is
 * an open decision (D1, D7); until it is made only the local adapters exist, and configuration
 * refuses them in staging/production. Keys are server-generated (`OBJECT_KEY`), never taken from
 * a client. `get` of a missing key returns null; `delete` of a missing key succeeds (deletion is
 * retried by the outbox, so it must be idempotent).
 */
export interface StoredObject {
  data: Buffer;
  contentType: string;
}

export interface ObjectStore {
  readonly name: string;
  put(key: string, object: StoredObject): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

/** Lowercase path segments of letters, digits and hyphens, an optional extension; no `..`. */
export const OBJECT_KEY = /^[a-z0-9-]+(\/[a-z0-9-]+)*(\.[a-z0-9]+)?$/;

export function assertObjectKey(key: string): void {
  if (!OBJECT_KEY.test(key) || key.length > 300) throw new Error('Invalid object key');
}

/** In-memory store: a local/test fake only. Refused by config in staging/production. */
export class InMemoryObjectStore implements ObjectStore {
  readonly name = 'in_memory';
  readonly #objects = new Map<string, StoredObject>();
  #failNext = 0;

  /** Test hook: make the next `count` operations reject (simulates a storage outage). */
  failNext(count: number): void {
    this.#failNext = count;
  }

  #maybeFail(): void {
    if (this.#failNext > 0) {
      this.#failNext -= 1;
      throw new Error('in-memory object store: simulated outage');
    }
  }

  keys(): string[] {
    return [...this.#objects.keys()].sort();
  }

  put(key: string, object: StoredObject): Promise<void> {
    try {
      assertObjectKey(key);
      this.#maybeFail();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.#objects.set(key, { data: Buffer.from(object.data), contentType: object.contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<StoredObject | null> {
    try {
      assertObjectKey(key);
      this.#maybeFail();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const found = this.#objects.get(key);
    return Promise.resolve(
      found ? { data: Buffer.from(found.data), contentType: found.contentType } : null,
    );
  }

  delete(key: string): Promise<void> {
    try {
      assertObjectKey(key);
      this.#maybeFail();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.#objects.delete(key);
    return Promise.resolve();
  }
}
