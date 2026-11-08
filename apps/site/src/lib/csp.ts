/**
 * Content Security Policy for public event sites (pure, unit-tested). No forms, no framing. Scripts and styles must carry
 * the per-request nonce; 'strict-dynamic' lets Next.js load its chunks. 'unsafe-eval' is added
 * only in development (React debugging). upgrade-insecure-requests only when served over HTTPS,
 * so plain-HTTP local and test runs still load same-origin assets.
 */
export interface CspOptions {
  development: boolean;
  https: boolean;
}

export function buildCsp(nonce: string, options: CspOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    ...(options.https ? ['upgrade-insecure-requests'] : []),
  ];
  return directives.join('; ');
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
