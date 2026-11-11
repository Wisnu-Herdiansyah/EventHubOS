import { NextResponse, type NextRequest } from 'next/server';
import { api, unwrap } from '@/lib/api';
import { ApiError, isTwoStepRequired, twoStepRequiredPath } from '@/lib/errors';
import { reportCsv, reportFilename, resolvePeriod, todayIn } from '@/lib/report-period';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Downloads the Reports events table for a period as CSV (ADR-0034). Counts only, so no audit
 * entry and a plain GET; the API checks report.read. An invalid period is refused rather than
 * silently widened to all time. Not cached: figures change, and the file is for this user.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) return new NextResponse('Not found', { status: 404 });
  const page = `/orgs/${orgId}/reports`;
  const back = (path: string) => NextResponse.redirect(new URL(path, request.url), 303);
  const search = Object.fromEntries(request.nextUrl.searchParams.entries());
  try {
    const client = await api();
    const path = { organizationId: orgId };
    const org = unwrap(
      await client.GET('/v1/organizations/{organizationId}', { params: { path } }),
    );
    const today = todayIn(org.timezone);
    const { period, invalid } = resolvePeriod(search, today);
    if (invalid) return back(`${page}?period=invalid`);
    const { from, to } = period;
    const report = unwrap(
      await client.GET('/v1/organizations/{organizationId}/report', {
        params: { path, query: from && to ? { from, to } : {} },
      }),
    );
    return new NextResponse(reportCsv(report), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${reportFilename(period, today)}"`,
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
    if (error instanceof ApiError && error.status === 403) return back(page);
    throw error;
  }
}
