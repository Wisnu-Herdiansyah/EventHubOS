import { describe, expect, it } from 'vitest';
import { activeNav, initials } from './nav-match';

const ORG = '0b7c5a4e-5f8f-4a51-9f53-0c7f2a3e9b11';

describe('activeNav', () => {
  it('marks the workspace home and the account page', () => {
    expect(activeNav('/')).toMatchObject({ home: true, orgId: null, section: null });
    expect(activeNav('/account')).toMatchObject({ account: true, home: false });
  });

  it('maps organization pages to their section', () => {
    expect(activeNav(`/orgs/${ORG}`)).toMatchObject({ orgId: ORG, section: 'overview' });
    expect(activeNav(`/orgs/${ORG}/`)).toMatchObject({ section: 'overview' });
    expect(activeNav(`/orgs/${ORG}/team`)).toMatchObject({ section: 'team' });
    expect(activeNav(`/orgs/${ORG}/settings`)).toMatchObject({ section: 'settings' });
    expect(activeNav(`/orgs/${ORG}/audit`)).toMatchObject({ section: 'audit' });
    expect(activeNav(`/orgs/${ORG}/reports`)).toMatchObject({ section: 'reports' });
    expect(activeNav(`/orgs/${ORG}/images`)).toMatchObject({ section: 'images' });
  });

  it('files event pages under Overview', () => {
    expect(activeNav(`/orgs/${ORG}/events/x`)).toMatchObject({ orgId: ORG, section: 'overview' });
  });

  it('does not claim unknown sections', () => {
    expect(activeNav(`/orgs/${ORG}/billing`)).toMatchObject({ orgId: ORG, section: null });
  });
});

describe('initials', () => {
  it('takes the first letters of the first two words', () => {
    expect(initials('Systematic Elegance Events')).toBe('SE');
    expect(initials('acme')).toBe('A');
    expect(initials('  ')).toBe('?');
    expect(initials('Événements Paris')).toBe('ÉP');
  });
});
