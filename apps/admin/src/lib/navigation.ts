import 'server-only';
import { ROLE_LABELS } from './options';
import { can, settingsAbilities, teamAbilities } from './permissions';

export type SectionKey = 'overview' | 'reports' | 'team' | 'settings' | 'audit';

export interface NavSection {
  key: SectionKey;
  href: string;
  label: string;
}

export interface NavOrganization {
  id: string;
  name: string;
  roleLabel: string;
  sections: NavSection[];
}

/**
 * The sidebar entry for each organization, with only the sections the role can open. This only
 * decides what to show; the API authorizes every request on its own.
 */
export function navOrganization(org: {
  organizationId: string;
  displayName: string;
  role: string;
}): NavOrganization {
  const base = `/orgs/${org.organizationId}`;
  const sections: NavSection[] = [{ key: 'overview', href: base, label: 'Overview' }];
  if (can(org.role, 'report.read'))
    sections.push({ key: 'reports', href: `${base}/reports`, label: 'Reports' });
  if (teamAbilities(org.role).canRead)
    sections.push({ key: 'team', href: `${base}/team`, label: 'Team' });
  if (settingsAbilities(org.role).canOpen)
    sections.push({ key: 'settings', href: `${base}/settings`, label: 'Settings' });
  if (can(org.role, 'audit.read'))
    sections.push({ key: 'audit', href: `${base}/audit`, label: 'Audit log' });
  return {
    id: org.organizationId,
    name: org.displayName,
    roleLabel: ROLE_LABELS[org.role] ?? org.role,
    sections,
  };
}
