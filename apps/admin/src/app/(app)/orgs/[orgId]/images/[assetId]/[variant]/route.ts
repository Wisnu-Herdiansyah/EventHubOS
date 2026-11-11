import { NextResponse } from 'next/server';
import { api } from '@/lib/api';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Library images for signed-in staff (ADR-0042): the library grid and page previews, including
 * drafts. The API checks the session and event.read; this only passes WebP bytes through, with
 * private caching, and answers a plain 404 for anything else.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; assetId: string; variant: string }> },
) {
  const { orgId, assetId, variant } = await params;
  if (!UUID.test(orgId) || !UUID.test(assetId) || (variant !== 'small' && variant !== 'large')) {
    return notFound();
  }
  const client = await api();
  const { response } = await client.GET(
    '/v1/organizations/{organizationId}/assets/{assetId}/{variant}',
    { params: { path: { organizationId: orgId, assetId, variant } }, parseAs: 'stream' },
  );
  if (!response.ok || response.headers.get('content-type') !== 'image/webp') {
    await response.body?.cancel();
    return notFound(response.status === 401 ? 401 : 404);
  }
  return new NextResponse(response.body, {
    headers: {
      'content-type': 'image/webp',
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}

function notFound(status = 404) {
  return new NextResponse(status === 401 ? 'Sign in again' : 'Not found', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
