'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { NavOrganization, SectionKey } from '@/lib/navigation';
import { activeNav, initials } from '@/lib/nav-match';
import { SIDEBAR_COOKIE, preferenceCookie, type SidebarState } from '@/lib/preferences';
import { Icon, type IconName } from '../ui/icons';
import { Menu } from '../ui/menu';
import { SearchField } from '../ui/search-field';
import { Tooltip } from '../ui/tooltip';

const SECTION_ICONS: Record<SectionKey, IconName> = {
  overview: 'overview',
  reports: 'chart',
  images: 'image',
  team: 'users',
  settings: 'gear',
  audit: 'history',
};

/** Show a filter once the organization list is long enough to need one. */
const FILTER_THRESHOLD = 6;

/** A small spinner beside a sidebar link while its page loads. */
function PendingMark() {
  const { pending } = useLinkStatus();
  return pending ? (
    <span className="spinner spinner--sm nav-link__pending" aria-hidden="true" />
  ) : null;
}

function NavLink({
  href,
  label,
  current,
  icon,
  avatar,
  activeParent,
}: {
  href: string;
  label: string;
  current: boolean;
  icon?: IconName;
  avatar?: string;
  activeParent?: boolean;
}) {
  return (
    <Tooltip label={label}>
      <Link
        href={href}
        className={activeParent ? 'nav-link nav-link--active-parent' : 'nav-link'}
        aria-current={current ? 'page' : undefined}
      >
        {avatar ? (
          <span className="nav-link__avatar" aria-hidden="true">
            {avatar}
          </span>
        ) : icon ? (
          <span className="nav-link__icon">
            <Icon name={icon} size={18} />
          </span>
        ) : null}
        <span className="nav-link__text">{label}</span>
        <PendingMark />
      </Link>
    </Tooltip>
  );
}

/**
 * The signed-in frame: sidebar (collapsible to an icon rail on desktop, a drawer below 64rem),
 * top bar with the account menu, and the main content region.
 */
export function AppShell({
  email,
  organizations,
  platform = false,
  sidebar,
  logout,
  children,
}: {
  email: string;
  organizations: NavOrganization[];
  /** EventHub staff (ADR-0045): show the Platform link. */
  platform?: boolean;
  sidebar: SidebarState;
  logout: () => Promise<void>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = activeNav(pathname);
  const [collapsed, setCollapsed] = useState(sidebar === 'collapsed');
  const [drawer, setDrawer] = useState(false);
  const [filter, setFilter] = useState('');
  const drawerButton = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);

  // Navigating closes the drawer.
  useEffect(() => setDrawer(false), [pathname]);

  useEffect(() => {
    if (!drawer) {
      // The content column is inert while the drawer is open, so focus it back only afterwards.
      if (restoreFocus.current) drawerButton.current?.focus();
      restoreFocus.current = false;
      return;
    }
    sidebarRef.current?.querySelector<HTMLElement>('a, button, input')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        restoreFocus.current = true;
        setDrawer(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  const toggleRail = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = preferenceCookie(
      SIDEBAR_COOKIE,
      next ? 'collapsed' : 'expanded',
      window.location.protocol === 'https:',
    );
  };

  const query = filter.trim().toLowerCase();
  const shown = query
    ? organizations.filter((o) => o.name.toLowerCase().includes(query))
    : organizations;

  return (
    <div
      className="shell"
      data-sidebar={collapsed ? 'collapsed' : 'expanded'}
      data-drawer={drawer ? 'open' : undefined}
    >
      <aside className="sidebar" id="app-sidebar" ref={sidebarRef} aria-label="Sidebar">
        <Link href="/" className="sidebar__brand">
          {/* The link text names the app; the monogram is decorative. */}
          <img
            className="sidebar__logo"
            src="/brand/awh-monogram.svg"
            alt=""
            width={44}
            height={32}
          />
          <span className="sidebar__brand-text">EventHub OS</span>
        </Link>
        <nav className="sidebar__scroll" aria-label="Main">
          <div className="nav-group">
            <ul className="nav-list">
              <li>
                <NavLink href="/" label="Organizations" icon="home" current={active.home} />
              </li>
              {platform ? (
                <li>
                  <NavLink
                    href="/platform"
                    label="Platform"
                    icon="lock"
                    current={pathname.startsWith('/platform')}
                  />
                </li>
              ) : null}
            </ul>
          </div>
          {organizations.length > 0 ? (
            <div className="nav-group">
              <span className="nav-group__label" id="nav-orgs-label">
                Your organizations
              </span>
              {organizations.length >= FILTER_THRESHOLD ? (
                <div className="sidebar__search">
                  <SearchField
                    label="Filter organizations"
                    placeholder="Filter"
                    size="sm"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
              ) : null}
              <ul className="nav-list" aria-labelledby="nav-orgs-label">
                {shown.map((org) => {
                  const isActive = active.orgId === org.id;
                  return (
                    <li key={org.id}>
                      <NavLink
                        href={`/orgs/${org.id}`}
                        label={org.name}
                        avatar={initials(org.name)}
                        current={false}
                        activeParent={isActive}
                      />
                      {isActive ? (
                        <ul
                          className="nav-list nav-list--nested"
                          aria-label={`${org.name} sections`}
                        >
                          {org.sections.map((s) => (
                            <li key={s.key}>
                              <NavLink
                                href={s.href}
                                label={s.label}
                                icon={SECTION_ICONS[s.key]}
                                current={active.section === s.key}
                              />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
                {shown.length === 0 ? (
                  <li className="nav-group__label">No organizations match.</li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </nav>
        <div className="sidebar__footer">
          <ul className="nav-list">
            <li>
              <NavLink href="/account" label="Account" icon="person" current={active.account} />
            </li>
          </ul>
        </div>
      </aside>

      <button
        type="button"
        className="shell__scrim"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => {
          restoreFocus.current = true;
          setDrawer(false);
        }}
      />

      <div className="shell__main-column" inert={drawer ? true : undefined}>
        <header className="topbar">
          <button
            type="button"
            className="btn btn--plain btn--sm btn--icon sidebar-toggle--rail"
            aria-controls="app-sidebar"
            aria-expanded={!collapsed}
            onClick={toggleRail}
          >
            <Icon name="sidebar" size={18} />
            <span className="visually-hidden">Sidebar</span>
          </button>
          <button
            ref={drawerButton}
            type="button"
            className="btn btn--plain btn--sm btn--icon sidebar-toggle--drawer"
            aria-controls="app-sidebar"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Icon name="menu" size={18} />
            <span className="visually-hidden">Open navigation</span>
          </button>
          <Link href="/" className="topbar__brand">
            <img src="/brand/awh-monogram.svg" alt="" width={44} height={32} />
            <span>EventHub OS</span>
          </Link>
          <span className="topbar__spacer" />
          <Menu
            label="Account"
            buttonClassName="account-button"
            button={
              <>
                <span className="avatar" aria-hidden="true">
                  {Array.from(email)[0] ?? '?'}
                </span>
                <span className="account-button__email">
                  {email}
                  <span className="visually-hidden"> – account menu</span>
                </span>
                <Icon name="chevronDown" size={14} />
              </>
            }
            items={[
              { kind: 'link', href: '/account', label: 'Account settings', icon: 'person' },
              { kind: 'separator' },
              { kind: 'form', action: logout, label: 'Sign out', icon: 'signOut' },
            ]}
          />
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
