import { NextResponse, type NextRequest } from 'next/server';
import { api, unwrap } from '@/lib/api';
import { ApiError, isTwoStepRequired, twoStepRequiredPath } from '@/lib/errors';
import { exportFilename, isSameOriginPost, registrationsCsv } from '@/lib/registration-export';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Downloads the attendee list as CSV (ADR-0027). The API checks registration.export_pii and
 * audits every export; this handler only refuses cross-site requests and formats the file.
 * Nothing is cached: the file is personal data.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; eventId: string }> },
) {
  const { orgId, eventId } = await params;
  if (!UUID.test(orgId) || !UUID.test(eventId)) {
    return new NextResponse('Not found', { status: 404 });
  }
  if (
    !isSameOriginPost({
      origin: request.headers.get('origin'),
      host: request.headers.get('x-forwarded-host') ?? request.headers.get('host'),
      secFetchSite: request.headers.get('sec-fetch-site'),
    })
  ) {
    return new NextResponse('Forbidden', { status: 403 });
  }
  const form = await request.formData();
  const raw = form.get('status');
  const status = raw === 'confirmed' || raw === 'cancelled' ? raw : undefined;
  const page = `/orgs/${orgId}/events/${eventId}/registrations`;
  const back = (path: string) => NextResponse.redirect(new URL(path, request.url), 303);
  try {
    const client = await api();
    const data = unwrap(
      await client.POST(
        '/v1/organizations/{organizationId}/events/{eventId}/registrations/export',
        { params: { path: { organizationId: orgId, eventId } }, body: status ? { status } : {} },
      ),
    );
    return new NextResponse(registrationsCsv(data), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFilename(data)}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return back(`/login?next=${encodeURIComponent(page)}&ended=1`);
    }
    if (isTwoStepRequired(error)) return back(twoStepRequiredPath(page));
    if (error instanceof ApiError && error.status === 404) {
      return new NextResponse('Not found', { status: 404 });
    }
    if (error instanceof ApiError && error.status === 403)
      return back(`${page}?notice=export_denied`);
    throw error;
  }
}
