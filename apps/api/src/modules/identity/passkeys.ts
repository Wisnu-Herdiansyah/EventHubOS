/**
 * The WebAuthn relying party (ADR-0033), as the identity module needs it. The cryptography lives
 * in an adapter (SimpleWebAuthn); routes only see JSON options, verification results and bytes
 * to store. Credential IDs travel as base64url strings, as WebAuthn JSON does.
 */
export interface StoredPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}

export interface PasskeyRelyingParty {
  readonly origin: string;
  readonly rpId: string;
  /** Options for navigator.credentials.create(), and the challenge to keep. */
  registrationOptions(input: {
    userId: string;
    userName: string;
    exclude: Array<Pick<StoredPasskey, 'credentialId' | 'transports'>>;
  }): Promise<{ options: Record<string, unknown>; challenge: string }>;
  /** The new credential, or null when the response does not check out. */
  verifyRegistration(input: {
    response: unknown;
    expectedChallenge: string;
  }): Promise<StoredPasskey | null>;
  /** Options for navigator.credentials.get(), limited to the user's passkeys. */
  authenticationOptions(input: {
    allow: Array<Pick<StoredPasskey, 'credentialId' | 'transports'>>;
  }): Promise<{ options: Record<string, unknown>; challenge: string }>;
  /** The authenticator's new signature counter, or null when the assertion does not check out. */
  verifyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
    credential: StoredPasskey;
  }): Promise<{ newCounter: number } | null>;
}

/** The credential ID a WebAuthn JSON response names, if well-formed. */
export function credentialIdOf(response: unknown): string | null {
  const id = (response as { id?: unknown } | null)?.id;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{16,1400}$/.test(id) ? id : null;
}
