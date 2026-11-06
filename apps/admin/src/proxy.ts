import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, newNonce } from './lib/csp';

/** Per-request CSP nonce (Next.js 16 `proxy`, formerly middleware). */
export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp(nonce, {
    development: process.env.NODE_ENV === 'development',
    https: (process.env.ADMIN_ORIGIN ?? '').startsWith('https://'),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
};
