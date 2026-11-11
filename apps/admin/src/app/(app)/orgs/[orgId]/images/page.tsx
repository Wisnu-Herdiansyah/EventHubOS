import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DeleteImageDialog, EditImageDialog, UploadImageForm } from '@/components/image-library';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Toast } from '@/components/ui/toast';
import { api, newIdempotencyKey, signInOn401, unwrap } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { adminImageUrl, formatBytes } from '@/lib/images';
import { can } from '@/lib/permissions';

export const metadata: Metadata = { title: 'Images' };

const UUID = /^[0-9a-f-]{36}$/i;
const NOTICES: Record<string, string> = {
  uploaded: 'Image uploaded. Choose it as a speaker photo in the page editor.',
  deleted: 'Image deleted.',
};

/** The organization's image library (ADR-0042). */
export default async function ImagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  if (!UUID.test(orgId)) notFound();
  const sp = await searchParams;
  const notice = typeof sp.notice === 'string' ? NOTICES[sp.notice] : undefined;
  let org, library;
  try {
    const client = await api();
    const path = { organizationId: orgId };
    org = unwrap(await client.GET('/v1/organizations/{organizationId}', { params: { path } }));
    library = unwrap(
      await client.GET('/v1/organizations/{organizationId}/assets', { params: { path } }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    if (error instanceof ApiError && error.status === 403) notFound();
    signInOn401(error, `/orgs/${orgId}/images`);
  }
  const canManage = can(org.role, 'asset.manage');
  const full = library.data.length >= library.limit;

  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[
          { label: 'Organizations', href: '/' },
          { label: org.displayName, href: `/orgs/${orgId}` },
          { label: 'Images' },
        ]}
        eyebrow={org.displayName}
        title="Images"
        description="Upload images once and use them on your event pages, such as speaker photos."
      />
      <Toast message={notice} />
      {canManage ? (
        <Card title="Upload" titleId="upload-heading">
          {!library.uploadsAvailable ? (
            <Notice tone="warning">
              Image storage is not set up on this server yet, so uploads are turned off.
            </Notice>
          ) : full ? (
            <Notice tone="warning">
              {`Your library is full (${library.limit} images). Delete images you no longer use.`}
            </Notice>
          ) : (
            <UploadImageForm organizationId={orgId} idempotencyKey={newIdempotencyKey()} />
          )}
        </Card>
      ) : null}
      <Card title="Library" titleId="library-heading">
        {library.data.length === 0 ? (
          <EmptyState
            icon="image"
            title="No images yet"
            description="Uploaded images appear here, ready to use on your pages."
          />
        ) : (
          <>
            <p className="text-secondary text-sm">
              {`${library.data.length} of ${library.limit} images`}
            </p>
            <ul className="image-grid" aria-label="Image library">
              {library.data.map((img) => (
                <li key={img.id} className="image-card">
                  {/* The text alternative is shown below, so the thumbnail itself is decorative. */}
                  <img
                    className="image-card__thumb"
                    src={adminImageUrl(orgId, img.id, 'small')}
                    alt=""
                    width={240}
                    height={Math.max(1, Math.round((240 * img.height) / img.width))}
                    loading="lazy"
                  />
                  <div className="stack-sm image-card__body">
                    <strong className="wrap-anywhere">{img.name}</strong>
                    <span className="text-secondary text-sm wrap-anywhere">
                      {img.altText ? `Text: ${img.altText}` : 'No text alternative (decorative)'}
                    </span>
                    <span className="text-secondary text-sm">
                      {`${img.width} × ${img.height} · ${formatBytes(img.byteSize)}`}
                    </span>
                    {canManage ? (
                      <div className="cluster">
                        <EditImageDialog
                          organizationId={orgId}
                          assetId={img.id}
                          name={img.name}
                          altText={img.altText}
                          idempotencyKey={newIdempotencyKey()}
                        />
                        <DeleteImageDialog
                          organizationId={orgId}
                          assetId={img.id}
                          name={img.name}
                          idempotencyKey={newIdempotencyKey()}
                        />
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
