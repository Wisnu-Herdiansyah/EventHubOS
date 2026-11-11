import { siteConfig } from '@/lib/config';
import { HANDLE } from '@/lib/host';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A library image on a public event site (ADR-0042), reached as /images/{id}/{variant}.webp on
 * the organization's own host. The API answers only for images that a published public page of
 * this organization uses; everything else is a plain 404 here. Only WebP bytes are passed on,
 * with headers that stop the browser treating them as anything else.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string; assetId: string; variant: string }> },
) {
  const { handle, assetId, variant } = await params;
  if (!HANDLE.test(handle) || !ID.test(assetId) || (variant !== 'small' && variant !== 'large')) {
    return notFound();
  }
  const { apiUrl } = siteConfig();
  const res = await fetch(`${apiUrl}/v1/public/sites/${handle}/assets/${assetId}/${variant}`, {
    cache: 'no-store',
  });
  if (res.status === 404 || res.status === 400) return notFound();
  if (!res.ok || res.headers.get('content-type') !== 'image/webp') {
    return new Response('Image unavailable', { status: 502, headers: plain() });
  }
  return new Response(await res.arrayBuffer(), {
    status: 200,
    headers: {
      'content-type': 'image/webp',
      'cache-control': res.headers.get('cache-control') ?? 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}

function plain() {
  return { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
}

function notFound() {
  return new Response('Not found', { status: 404, headers: plain() });
}
