import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageEditor } from '@/components/patterns/builder';
import { ToastDemo } from '@/components/patterns/gallery-demos';
import { SAMPLE_SECTIONS, SitePreview } from '@eventhub/microsite';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, Stat } from '@/components/ui/card';
import { BarChart, Meter } from '@/components/ui/chart';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogCancel } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner, Skeleton } from '@/components/ui/loading';
import { Menu } from '@/components/ui/menu';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { SearchField } from '@/components/ui/search-field';
import { Tabs } from '@/components/ui/tabs';
import { ThemePicker } from '@/components/ui/theme-picker';
import { Tooltip } from '@/components/ui/tooltip';
import { adminConfig } from '@/lib/config';

export const metadata: Metadata = { title: 'Design system' };

const COLORS = [
  ['bg', 'Background', '#F5F5F7 · #000000'],
  ['surface', 'Surface', '#FFFFFF · #1C1C1E'],
  ['text', 'Primary text', '#1D1D1F · #F5F5F7'],
  ['text-secondary', 'Secondary text', '#6E6E73 · #98989D'],
  ['accent', 'Accent', '#007AFF · #0A84FF'],
  ['accent-fill', 'Accent fill (buttons)', '#0066CC · #0071E3'],
  ['success', 'Success', '#34C759 · #30D158'],
  ['warning', 'Warning', '#FF9F0A'],
  ['danger', 'Danger', '#FF3B30 · #FF453A'],
  ['divider', 'Divider', '#E5E5EA · #38383A'],
] as const;

const ROWS = [
  { id: '1', name: 'Jakarta Summit 2027', starts: '1 Mar 2027, 09:00', status: 'Scheduled' },
  { id: '2', name: 'Partner Breakfast', starts: '14 Apr 2027, 07:30', status: 'Draft' },
  { id: '3', name: 'Design Week Closing', starts: '2 Jun 2027, 18:00', status: 'Draft' },
];

/**
 * Component gallery: every shared component and pattern in its states, with sample content.
 * Served only when ADMIN_DESIGN_GALLERY allows it (default: development builds).
 */
export default function DesignSystemPage() {
  if (!adminConfig().designGallery) notFound();
  return (
    <div className="stack">
      <PageHeader
        breadcrumbs={[{ label: 'Organizations', href: '/' }, { label: 'Design system' }]}
        eyebrow="Reference"
        title="Design system"
        description="Tokens, components and patterns used across EventHub OS. All content on this page is sample content."
        actions={<ThemePicker initial="system" />}
      />

      <Card title="Colour" titleId="ds-colour" description="Semantic tokens, light · dark.">
        <ul className="swatches">
          {COLORS.map(([token, label, hex]) => (
            <li key={token} className="swatch">
              <span className={`swatch__chip swatch__chip--${token}`} aria-hidden="true" />
              <strong>{label}</strong>
              <span className="text-mono text-secondary">--color-{token}</span>
              <span className="text-secondary">{hex}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Typography"
        titleId="ds-type"
        description="System font stack, SF Pro where available."
      >
        <div className="type-scale">
          <span className="type-scale__3xl">Display 40</span>
          <span className="type-scale__2xl">Large title 28</span>
          <span className="type-scale__xl">Title 22</span>
          <span className="type-scale__lg">Headline 17</span>
          <span className="type-scale__md">Body 15. Clear, calm and easy to scan.</span>
          <span className="type-scale__sm text-secondary">Footnote 13</span>
          <span className="type-scale__xs text-secondary">Caption 12</span>
        </div>
      </Card>

      <Card title="Buttons" titleId="ds-buttons">
        <div className="stack-sm">
          <div className="gallery-row">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="plain">Plain</Button>
            <Button variant="danger">Delete</Button>
            <Button variant="danger-secondary">Remove…</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="gallery-row">
            <Button size="sm" icon="plus">
              Small with icon
            </Button>
            <ButtonLink variant="secondary" size="sm" href="/">
              Link styled as a button
            </ButtonLink>
            <Tooltip label="Search" placement="top">
              <Button variant="secondary" icon="search" iconOnly>
                Search
              </Button>
            </Tooltip>
            <button type="button" className="btn" disabled aria-busy="true">
              <span className="spinner spinner--sm" aria-hidden="true" />
              Saving…
            </button>
          </div>
        </div>
      </Card>

      <div className="grid">
        <Card title="Inputs" titleId="ds-inputs">
          <div className="form">
            <div className="field">
              <label className="field__label" htmlFor="ds-name">
                Event name
              </label>
              <input id="ds-name" className="input" defaultValue="Jakarta Summit 2027" />
              <span className="field__hint">Shown on the microsite and in emails.</span>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="ds-slug">
                URL slug
              </label>
              <input
                id="ds-slug"
                className="input"
                defaultValue="Not A Slug!"
                aria-invalid="true"
                aria-describedby="ds-slug-error"
              />
              <div className="field__error" id="ds-slug-error">
                Use lowercase letters, digits and hyphens.
              </div>
            </div>
            <div className="form__row">
              <div className="field">
                <label className="field__label" htmlFor="ds-format">
                  Format
                </label>
                <select id="ds-format" className="select" defaultValue="hybrid">
                  <option value="in_person">In person</option>
                  <option value="virtual">Virtual</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="ds-date">
                  Date
                </label>
                <div className="date-field">
                  <input id="ds-date" type="date" className="input" defaultValue="2027-03-01" />
                </div>
              </div>
            </div>
            <SearchField label="Search events" placeholder="Search" />
            <label className="checkbox">
              <input type="checkbox" defaultChecked />
              <span>Send a confirmation email</span>
            </label>
          </div>
        </Card>

        <Card title="Status and messages" titleId="ds-status">
          <div className="stack-sm">
            <div className="gallery-row">
              <Badge>Draft</Badge>
              <Badge tone="accent" dot>
                Scheduled
              </Badge>
              <Badge tone="success" dot>
                Live
              </Badge>
              <Badge tone="warning">Pending</Badge>
              <Badge tone="danger">Failed</Badge>
            </div>
            <Notice role={null}>Information that helps the next step.</Notice>
            <Notice tone="success" role={null}>
              Settings saved.
            </Notice>
            <Notice tone="warning" role={null} title="Recommended">
              Add a terms URL before publishing.
            </Notice>
            <Notice tone="danger" role={null} reference="req_01HX">
              Check the highlighted fields.
            </Notice>
            <ToastDemo />
          </div>
        </Card>
      </div>

      <div className="grid">
        <Stat label="Registrations" value="1,284" hint="Sample figure" />
        <Stat label="Check-ins" value="932" />
        <Card title="Progress" titleId="ds-meter">
          <Meter value={3} max={5} label="Checklist" />
        </Card>
      </div>

      <div className="grid">
        <Card title="Chart" titleId="ds-chart">
          <BarChart
            caption="Events by status (sample)"
            valueHeader="Events"
            data={[
              { label: 'Draft', value: 4 },
              { label: 'Scheduled', value: 7 },
              { label: 'Live', value: 2 },
              { label: 'Ended', value: 11 },
            ]}
            footnote="Every bar is also a number in a table, for screen readers."
          />
        </Card>
        <Card title="Empty and loading" titleId="ds-empty">
          <div className="stack-sm">
            <EmptyState
              icon="calendar"
              title="No events yet"
              description="Create your first event to get started."
              action={<Button icon="plus">New event</Button>}
            />
            <Spinner label="Loading events…" />
            <Skeleton variant="w-80" />
            <Skeleton variant="w-60" />
          </div>
        </Card>
      </div>

      <Card
        flush
        title="Data table"
        titleId="ds-table"
        description="Rows stack into cards under 40rem."
      >
        <DataTable
          caption="Sample events"
          rows={ROWS}
          rowKey={(r) => r.id}
          columns={[
            { key: 'name', header: 'Event', lead: true, cell: (r) => <strong>{r.name}</strong> },
            { key: 'starts', header: 'Starts', cell: (r) => r.starts },
            {
              key: 'status',
              header: 'Status',
              align: 'end',
              cell: (r) => (
                <Badge tone={r.status === 'Scheduled' ? 'accent' : 'neutral'} dot>
                  {r.status}
                </Badge>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Overlays and navigation" titleId="ds-overlays">
        <div className="stack">
          <div className="gallery-row">
            <Dialog
              trigger={{ label: 'Open dialog', variant: 'secondary' }}
              title="Archive this event?"
              description="It becomes read-only. You can restore it later."
            >
              <div className="form__actions form__actions--end">
                <DialogCancel />
                <Button variant="danger">Archive</Button>
              </div>
            </Dialog>
            <Dialog
              kind="sheet"
              trigger={{ label: 'Open slide-over', variant: 'secondary' }}
              title="New event"
              description="Slide-over panels hold creation forms."
            >
              <div className="form">
                <div className="field">
                  <label className="field__label" htmlFor="ds-sheet-name">
                    Event name
                  </label>
                  <input id="ds-sheet-name" className="input" />
                </div>
                <div className="form__actions">
                  <Button>Create event</Button>
                  <DialogCancel />
                </div>
              </div>
            </Dialog>
            <Menu
              label="Event actions"
              buttonClassName="btn btn--secondary"
              button={<>Actions</>}
              items={[
                { kind: 'link', href: '/', label: 'Open organizations', icon: 'home' },
                { kind: 'link', href: '/account', label: 'Account settings', icon: 'person' },
              ]}
            />
          </div>
          <Tabs
            label="Sample tabs"
            tabs={[
              { id: 'ds-tab-overview', label: 'Overview', panel: <p>Overview content.</p> },
              { id: 'ds-tab-schedule', label: 'Schedule', panel: <p>Schedule content.</p> },
              { id: 'ds-tab-settings', label: 'Settings', panel: <p>Settings content.</p> },
            ]}
          />
        </div>
      </Card>

      <section className="stack-sm" aria-labelledby="ds-builder">
        <h2 id="ds-builder" className="section-title">
          Microsite builder
        </h2>
        <p className="text-secondary">
          Section navigator, live preview and configuration. Sample content; nothing is saved.
        </p>
        <PageEditor initialSections={SAMPLE_SECTIONS} eventName="Operations Summit" />
      </section>

      <section className="stack-sm" aria-labelledby="ds-microsites">
        <h2 id="ds-microsites" className="section-title">
          Public microsite themes
        </h2>
        <p className="text-secondary">
          The same sections in three event brands. The platform style never limits a client’s
          identity.
        </p>
        <div className="grid">
          {(['navy-gold', 'forest', 'ember'] as const).map((brand) => (
            <div key={brand} className="preview">
              <SitePreview
                brand={brand}
                name="Operations Summit"
                sections={SAMPLE_SECTIONS.filter((s) => s.type === 'hero' || s.type === 'register')}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
