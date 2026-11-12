import { NextResponse, type NextRequest } from 'next/server';
import { api, unwrap } from '@/lib/api';
import { auditHref, auditQuery, parseAuditFilters } from '@/lib/audit';
import { auditCsv, auditFilename } from '@/lib/audit-export';
import { ApiError, isTwoStepRequired, twoStepRequiredPath } from '@/lib/errors';
import { can } from '@/lib/permissions';
import { isSameOriginPost } from '@/lib/registration-export';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Downloads the audit log as CSV with the page's filters (ADR-0047). The API checks audit.read,
 * refuses support access and audits every export; this handler refuses cross-site requests and
 * formats the file. Not cached: the file is for this user.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) return new NextResponse('Not found', { status: 404 });
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
  const raw: Record<string, string> = {};
  for (const key of ['category', 'actorId', 'targetType', 'targetId', 'from', 'to']) {
    const v = form.get(key);
    if (typeof v === 'string') raw[key] = v;
  }
  const { filters } = parseAuditFilters(raw);
  const page = auditHref(orgId, filters);
  const back = (path: string) => NextResponse.redirect(new URL(path, request.url), 303);
  try {
    const client = await api();
    const path = { organizationId: orgId };
    const org = unwrap(
      await client.GET('/v1/organizations/{organizationId}', { params: { path } }),
    );
    // The list's filters without paging: the export starts from the newest entry.
    const { limit: _limit, ...body } = auditQuery({ ...filters, cursor: undefined }, org.timezone);
    const [exported, memberList, eventList] = await Promise.all([
      client.POST('/v1/organizations/{organizationId}/audit-events/export', {
        params: { path },
        body,
      }),
      can(org.role, 'membership.read')
        ? client.GET('/v1/organizations/{organizationId}/members', { params: { path } })
        : null,
      can(org.role, 'event.read')
        ? client.GET('/v1/organizations/{organizationId}/events', {
            params: { path, query: { limit: 100 } },
          })
        : null,
    ]);
    const data = unwrap(exported);
    const names = {
      members: new Map(
        (memberList ? unwrap(memberList).data : []).map((m) => [m.membershipId, m.email]),
      ),
      events: new Map((eventList ? unwrap(eventList).data : []).map((e) => [e.id, e.name])),
    };
    return new NextResponse(auditCsv(data, names), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${auditFilename(data)}"`,
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
    if (error instanceof ApiError && error.status === 403) {
      return back(`${page}${page.includes('?') ? '&' : '?'}notice=export_denied`);
    }
    throw error;
  }
}
