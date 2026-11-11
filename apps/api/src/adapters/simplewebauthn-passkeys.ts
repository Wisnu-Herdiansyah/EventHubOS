import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { PasskeyRelyingParty, StoredPasskey } from '../modules/identity/passkeys.ts';

/**
 * SimpleWebAuthn (MIT) behind the PasskeyRelyingParty port (ADR-0033). Passkeys are a second
 * step after the password, so user verification (PIN or biometric) is preferred, not required:
 * a plain security key still proves possession. Attestation is not requested.
 */
export function simpleWebAuthnRelyingParty(config: {
  origin: string;
  rpId: string;
  rpName?: string;
}): PasskeyRelyingParty {
  const rpName = config.rpName ?? 'EventHub OS';
  return {
    origin: config.origin,
    rpId: config.rpId,

    async registrationOptions({ userId, userName, exclude }) {
      const options = await generateRegistrationOptions({
        rpName,
        rpID: config.rpId,
        userName,
        userID: new TextEncoder().encode(userId),
        attestationType: 'none',
        excludeCredentials: exclude.map((c) => ({ id: c.credentialId, transports: c.transports })),
        authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
        timeout: 120_000,
      });
      return {
        options: options as unknown as Record<string, unknown>,
        challenge: options.challenge,
      };
    },

    async verifyRegistration({ response, expectedChallenge }): Promise<StoredPasskey | null> {
      try {
        const r = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpId,
          requireUserVerification: false,
        });
        if (!r.verified) return null;
        const c = r.registrationInfo.credential;
        return {
          credentialId: c.id,
          publicKey: c.publicKey,
          counter: c.counter,
          transports: (c.transports ?? []).slice(0, 8),
        };
      } catch {
        // Malformed or forged responses are a failed verification, never a server error.
        return null;
      }
    },

    async authenticationOptions({ allow }) {
      const options = await generateAuthenticationOptions({
        rpID: config.rpId,
        allowCredentials: allow.map((c) => ({ id: c.credentialId, transports: c.transports })),
        userVerification: 'preferred',
        timeout: 120_000,
      });
      return {
        options: options as unknown as Record<string, unknown>,
        challenge: options.challenge,
      };
    },

    async verifyAuthentication({ response, expectedChallenge, credential }) {
      try {
        const r = await verifyAuthenticationResponse({
          response: response as AuthenticationResponseJSON,
          expectedChallenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpId,
          credential: {
            id: credential.credentialId,
            publicKey: new Uint8Array(credential.publicKey),
            counter: credential.counter,
            transports: credential.transports,
          },
          requireUserVerification: false,
        });
        return r.verified ? { newCounter: r.authenticationInfo.newCounter } : null;
      } catch {
        return null;
      }
    },
  };
}
