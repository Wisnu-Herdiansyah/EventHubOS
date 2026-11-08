import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, newNonce } from './lib/csp';
import { handleFromHost, internalPath } from './lib/host';

/**
 * Every request: resolve {handle}.{SITE_DOMAIN}/{slug} to the internal page route and attach a
 * per-request CSP nonce. Unknown hosts and paths are 404 before any API call; the internal /s/
 * routes cannot be requested directly.
 */
export function proxy(request: NextRequest) {
  const domain = (process.env.SITE_DOMAIN ?? '').toLowerCase();
  const handle = domain ? handleFromHost(request.headers.get('host'), domain) : null;
  const target = handle ? internalPath(handle, request.nextUrl.pathname) : null;

  const nonce = newNonce();
  const csp = buildCsp(nonce, {
    development: process.env.NODE_ENV === 'development',
    https: process.env.SITE_HTTPS !== '0',
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const url = request.nextUrl.clone();
  url.pathname = target ?? '/s/_/_';
  const response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
};
