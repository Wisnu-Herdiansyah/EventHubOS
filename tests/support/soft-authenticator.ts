import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * A software WebAuthn authenticator for tests (ADR-0033): real P-256 keys, real signatures, and
 * "none" attestation, so the server's verification runs exactly as it would for a phone or a
 * security key. Only what EventHub uses is implemented.
 */
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([cborHead(3, s.length), s]);
  }
  if (v instanceof Map) {
    const parts = [cborHead(5, v.size)];
    for (const [k, val] of v) parts.push(cbor(k), cbor(val));
    return Buffer.concat(parts);
  }
  return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly cose: Buffer;
  counter = 0;
  private readonly rpId: string;
  private readonly origin: string;

  constructor(rpId: string, origin: string) {
    this.rpId = rpId;
    this.origin = origin;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** A navigator.credentials.create() result for these options. */
  register(options: { challenge: string }) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credentialId.length);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([0x45]), // user present, user verified, attested credential data
      count,
      Buffer.alloc(16), // AAGUID
      len,
      this.credentialId,
      this.cose,
    ]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /**
   * A navigator.credentials.get() result. `tamper` produces the failures tests need: another
   * origin, a counter that does not move forward (a cloned key), or a signature by another key.
   */
  authenticate(
    options: { challenge: string },
    tamper: { origin?: string; keepCounter?: boolean; signWith?: KeyObject } = {},
  ) {
    if (!tamper.keepCounter) this.counter += 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), count]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, tamper.origin);
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      tamper.signWith ?? this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

export const otherKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
