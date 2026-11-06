import { fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InvitationImport from '$components/InvitationImport.svelte';
import { normalizeRelayConfig, saveRelayConfigs } from '$lib/config';
import { BrowserDeviceCredentialStore } from '$lib/device-auth';
import { invitationImportLocation } from '$lib/invitation-import';
import { securityState } from '$lib/security';
import { relayStore } from '$lib/store';

const current = new URL('https://app.example/installed-entry.html?existing=1');
const target = 'wss://herdr-core.ladder88.com';
const access = { unlocked: true, installed: true };
function link(overrides: Record<string, string> = {}): string {
  const fields = new URLSearchParams({ setup: 'A'.repeat(43), invite: 'invitation-new-computer', invite_version: '1',
    invite_expires: String(Date.now() + 60_000), label: 'Mac core', relay: target, ...overrides });
  return `https://app.example/ignored-path?ignored=query#${fields}`;
}

describe('pasted invitation validation', () => {
  it('copies only the fragment onto the current app path and query without navigating', () => {
    const href = location.href;
    const parsed = invitationImportLocation(link(), current, [], access);
    expect(parsed.origin).toBe(current.origin);
    expect(parsed.pathname).toBe(current.pathname);
    expect(parsed.search).toBe(current.search);
    expect(parsed.hash).toContain('invite=invitation-new-computer');
    expect(location.href).toBe(href);
    expect(invitationImportLocation(new URL(link()).hash, current, [], access).pathname).toBe(current.pathname);
  });

  it.each([
    ['cross-origin', () => link().replace('https://app.example/', 'https://other.example/')],
    ['insecure app', () => link().replace('https:', 'http:')],
    ['URL credentials', () => link().replace('https://', 'https://user:password@')],
    ['bootstrap only', () => `https://app.example/#setup=${'A'.repeat(43)}&relay=${encodeURIComponent(target)}`],
    ['expired', () => link({ invite_expires: String(Date.now() - 1) })],
    ['invalid invitation', () => link({ invite: 'short' })],
    ['invalid secret', () => link({ setup: 'invalid' })],
    ['insecure relay', () => link({ relay: 'ws://herdr-core.ladder88.com' })],
    ['relay URL credentials', () => link({ relay: 'wss://user:password@relay.example' })],
    ['relay URL path', () => link({ relay: 'wss://relay.example/private' })],
    ['missing target', () => link({ relay: '' })],
    ['gateway invitation', () => `${link()}&gateways=wss%3A%2F%2Fgateway.example`],
    ['duplicate fields', () => `${link()}&invite=invitation-second-computer`],
    ['oversized input', () => `${link()}${'a'.repeat(4096)}`],
    ['control characters', () => `${link()}\nother`],
  ])('rejects %s before any importer can run', (_name, input) => {
    expect(() => invitationImportLocation(input(), current, [], access)).toThrow();
  });

  it('requires the installed unlocked HTTPS app', () => {
    expect(() => invitationImportLocation(link(), current, [], { ...access, unlocked: false })).toThrow('Unlock');
    expect(() => invitationImportLocation(link(), current, [], { ...access, installed: false })).toThrow('Home Screen');
    expect(() => invitationImportLocation(link(), new URL('http://app.example'), [], access)).toThrow();
  });

  it('rejects saved target origins, including manually entered trailing slashes and default ports', () => {
    const relay = normalizeRelayConfig({ id: 'existing', label: 'Saved', url: `${target}:443/`, paired: true });
    expect(() => invitationImportLocation(link(), current, [relay], access)).toThrow('already saved');
  });

  it('rejects a distinct target whose generated id would collide with an old credential', () => {
    const label = 'x'.repeat(48);
    const prefix = 'y'.repeat(40);
    const relay = normalizeRelayConfig({ label, url: `wss://${prefix}.old.example`, paired: true });
    const replacement = normalizeRelayConfig({ label, url: `wss://${prefix}.new.example`, paired: true });
    expect(relay.id).toBe(replacement.id);
    expect(() => invitationImportLocation(link({ label, relay: replacement.url }), current, [relay], access)).toThrow('already saved');
  });
});

describe('Settings invitation importer', () => {
  const oldRelay = normalizeRelayConfig({ id: 'old-tui', label: 'Mac TUI', url: '', token: '', paired: true,
    transport: 'hybrid', gatewayUrl: 'wss://gw2.herdr.dev', gatewayUrls: ['wss://gw2.herdr.dev', 'wss://gw1.herdr.dev'] });
  let credentials: BrowserDeviceCredentialStore;

  beforeEach(() => {
    relayStore.destroy();
    relayStore.relayConfigs.set([oldRelay]);
    saveRelayConfigs([oldRelay]);
    credentials = new BrowserDeviceCredentialStore(localStorage);
    credentials.saveInvitation(oldRelay.id, { id: 'invitation-old-tui', version: 1, secret: 'B'.repeat(43), expiresAt: Date.now() + 60_000 });
    credentials.replaceInvitation(oldRelay.id, 'invitation-old-tui', { deviceId: 'old-device', credentialId: 'old-credential',
      credentialVersion: 1, credentialSecret: 'C'.repeat(43), role: 'controller', locale: 'en' });
    localStorage.setItem('herdr_theme', 'nord');
    localStorage.setItem('herdr_default_agent_view', 'conversation');
    localStorage.setItem('herdr_pane_agent_view_overrides', '{"old-pane":"terminal"}');
    securityState.update((state) => ({ ...state, locked: false, busy: false }));
    vi.stubGlobal('location', new URL(current));
    vi.stubGlobal('navigator', { standalone: true, userAgent: 'iPhone', maxTouchPoints: 5 });
    vi.spyOn(relayStore, 'connectAll').mockImplementation(() => {});
    vi.spyOn(relayStore, 'showToast').mockImplementation(() => {});
  });

  afterEach(() => {
    relayStore.destroy();
    relayStore.relayConfigs.set([]);
    securityState.update((state) => ({ ...state, locked: false, busy: false }));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function submit(value: string): Promise<HTMLInputElement> {
    render(InvitationImport);
    const input = screen.getByLabelText('Invitation link') as HTMLInputElement;
    await fireEvent.input(input, { target: { value } });
    await fireEvent.submit(input.closest('form')!);
    return input;
  }

  it('imports through the existing store while preserving every old pairing and preference', async () => {
    const originalCredential = credentials.get(oldRelay.id);
    const prefs = ['herdr_theme', 'herdr_default_agent_view', 'herdr_pane_agent_view_overrides'];
    const originalPreferences = prefs.map((key) => localStorage.getItem(key));
    const historyWrite = vi.spyOn(history, 'replaceState');
    const importer = vi.spyOn(relayStore, 'importSetupLink');
    const input = await submit(link());
    expect(input.value).toBe('');
    expect(importer).toHaveBeenCalledOnce();
    const relays = get(relayStore.relayConfigs);
    expect(relays).toHaveLength(2);
    expect(relays[0]).toEqual(oldRelay);
    expect(credentials.get(oldRelay.id)).toEqual(originalCredential);
    expect(prefs.map((key) => localStorage.getItem(key))).toEqual(originalPreferences);
    expect(credentials.get(relays[1].id)).toMatchObject({ kind: 'invitation', id: 'invitation-new-computer' });
    expect(location.href).toBe(current.href);
    expect(historyWrite.mock.calls.every((call) => call[2] === current.pathname + current.search)).toBe(true);
    expect(relayStore.connectAll).toHaveBeenCalledWith(true);
  });

  it.each(['locked', 'busy', 'Safari tab', 'expired', 'existing target'])('refuses %s and clears the secret without writes', async (reason) => {
    if (reason === 'locked') securityState.update((state) => ({ ...state, locked: true }));
    if (reason === 'busy') securityState.update((state) => ({ ...state, busy: true }));
    if (reason === 'Safari tab') vi.stubGlobal('navigator', { standalone: false, userAgent: 'iPhone' });
    if (reason === 'existing target') {
      const saved = normalizeRelayConfig({ id: 'already-core', label: 'Saved', url: target, paired: true });
      relayStore.relayConfigs.set([oldRelay, saved]);
      saveRelayConfigs([oldRelay, saved]);
    }
    const before = Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => {
      const key = localStorage.key(i)!;
      return [key, localStorage.getItem(key)];
    }));
    const importer = vi.spyOn(relayStore, 'importSetupLink');
    const input = await submit(reason === 'expired' ? link({ invite_expires: '1' }) : link());
    expect(input.value).toBe('');
    expect(importer).not.toHaveBeenCalled();
    expect(Object.fromEntries(Object.keys(before).map((key) => [key, localStorage.getItem(key)]))).toEqual(before);
    expect(localStorage.length).toBe(Object.keys(before).length);
    expect(relayStore.showToast).toHaveBeenCalledWith(expect.not.stringContaining('AAAA'), true);
  });

  it('hides arbitrary import failure details and clears the pasted secret', async () => {
    vi.spyOn(relayStore, 'importSetupLink').mockImplementation(() => { throw new Error(`private ${link()}`); });
    const input = await submit(link());
    expect(input.value).toBe('');
    expect(relayStore.showToast).toHaveBeenCalledWith('Could not import this invitation.', true);
  });
});
