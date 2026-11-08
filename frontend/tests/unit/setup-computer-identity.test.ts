import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeRelayConfig, RELAYS_KEY, saveRelayConfigs } from '$lib/config';
import { BrowserDeviceCredentialStore, DEVICE_AUTH_STORAGE_KEY } from '$lib/device-auth';
import { relayStore } from '$lib/store';
import type { RelayConfig } from '$lib/types';

const gateway = 'wss://gateway.example';
const oldRendezvous = 'Ccy3nT9AULlAceTEnhTvoQ';
const newRendezvous = 'Ccy3nT9AULlAceTEnhTvoR';
const token = '0123456789abcdef0123456789abcdef';
type Entry = 'initialize' | 'import';

function computer(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return normalizeRelayConfig({ id: 'old-computer', label: 'Shared name', url: '', token: '', paired: true,
    transport: 'hybrid', gatewayUrl: gateway, gatewayRelayId: oldRendezvous, rendezvousKey: 'R'.repeat(43), ...overrides });
}

function invitation(fields: Record<string, string> = {}): URL {
  const url = new URL('https://app.example/installed-entry.html?existing=1');
  url.hash = new URLSearchParams({ setup: 'A'.repeat(43), invite: 'invitation-new-computer', invite_version: '1',
    invite_expires: String(Date.now() + 60_000), label: 'Shared name', gateways: gateway,
    relay_id: newRendezvous, rendezvous: 'S'.repeat(43), ...fields }).toString();
  return url;
}

function seedCredential(relayId: string): void {
  const credentials = new BrowserDeviceCredentialStore(localStorage, () => Date.now() - 5_000);
  credentials.saveInvitation(relayId, { id: 'invitation-old-computer', version: 1, secret: 'B'.repeat(43), expiresAt: Date.now() + 60_000 });
  credentials.replaceInvitation(relayId, 'invitation-old-computer', { deviceId: 'old-device', credentialId: 'old-credential',
    credentialVersion: 1, credentialSecret: 'C'.repeat(43), role: 'controller', locale: 'en' });
}

function saveComputers(relays: RelayConfig[]): void {
  relayStore.relayConfigs.set(relays);
  saveRelayConfigs(relays);
  for (const relay of relays) seedCredential(relay.id);
}

function credentialBytes(id: string): string {
  return JSON.stringify(JSON.parse(localStorage.getItem(DEVICE_AUTH_STORAGE_KEY)!).relays[id]);
}

function storageSnapshot(): Record<string, string | null> {
  return Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!;
    return [key, localStorage.getItem(key)];
  }));
}

function openSetup(entry: Entry, url: URL): boolean {
  vi.stubGlobal('location', url);
  if (entry === 'import') return relayStore.importSetupLink(url, false);
  relayStore.initialize();
  return true;
}

describe('setup computer identity and credential custody', () => {
  beforeEach(() => {
    relayStore.destroy();
    relayStore.relayConfigs.set([]);
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('navigator', { standalone: true, userAgent: 'iPhone', maxTouchPoints: 5 });
    vi.spyOn(relayStore, 'connectAll').mockImplementation(() => {});
    vi.spyOn(relayStore, 'connectRelay').mockImplementation(() => {});
  });

  afterEach(() => {
    relayStore.destroy();
    relayStore.relayConfigs.set([]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each<Entry>(['initialize', 'import'])('%s saves a same-name, shared-gateway invitation only under the new computer', (entry) => {
    const old = computer();
    saveComputers([old]);
    const oldConfig = localStorage.getItem(RELAYS_KEY)!;
    const oldCredential = credentialBytes(old.id);
    expect(openSetup(entry, invitation())).toBe(true);

    const saved = get(relayStore.relayConfigs);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toEqual(old);
    expect(saved[1].gatewayRelayId).toBe(newRendezvous);
    expect(saved[1].id).not.toBe(old.id);
    expect(localStorage.getItem(RELAYS_KEY)!.startsWith(`${oldConfig.slice(0, -1)},`)).toBe(true);
    expect(credentialBytes(old.id)).toBe(oldCredential);
    const auth = JSON.parse(localStorage.getItem(DEVICE_AUTH_STORAGE_KEY)!);
    expect(Object.keys(auth.relays)).toEqual([old.id, saved[1].id]);
    expect(new BrowserDeviceCredentialStore(localStorage).get(saved[1].id)).toMatchObject({ kind: 'invitation', id: 'invitation-new-computer' });
  });

  it.each<Entry>(['initialize', 'import'])('%s defers and explicitly pairs only the new rendezvous computer', (entry) => {
    const old = computer();
    saveComputers([old]);
    const oldCredential = credentialBytes(old.id);
    const beforeAuth = localStorage.getItem(DEVICE_AUTH_STORAGE_KEY);
    vi.stubGlobal('navigator', { standalone: false, userAgent: 'iPhone', maxTouchPoints: 5 });
    openSetup(entry, invitation());
    const added = get(relayStore.relayConfigs)[1];
    expect(added.gatewayRelayId).toBe(newRendezvous);
    expect(localStorage.getItem(DEVICE_AUTH_STORAGE_KEY)).toBe(beforeAuth);
    expect(get(relayStore.connections).get(added.id)?.pairingDeferred).toBe(true);
    expect(relayStore.pairDeferredRelay(old.id)).toBe(false);
    expect(localStorage.getItem(DEVICE_AUTH_STORAGE_KEY)).toBe(beforeAuth);
    expect(relayStore.pairDeferredRelay(added.id)).toBe(true);
    expect(relayStore.connectRelay).toHaveBeenCalledWith(added);
    expect(credentialBytes(old.id)).toBe(oldCredential);
    expect(new BrowserDeviceCredentialStore(localStorage).get(added.id)).toMatchObject({ kind: 'invitation', id: 'invitation-new-computer' });
  });

  it.each<Entry>(['initialize', 'import'])('%s refreshes a proved computer despite a changed label and keeps its ID', (entry) => {
    const old = computer({ label: 'My saved label' });
    saveComputers([old]);
    openSetup(entry, invitation({ relay_id: oldRendezvous, label: 'Different incoming label' }));
    expect(get(relayStore.relayConfigs)).toHaveLength(1);
    expect(get(relayStore.relayConfigs)[0]).toMatchObject({ id: old.id, label: old.label });
    expect(new BrowserDeviceCredentialStore(localStorage).get(old.id)).toMatchObject({ kind: 'invitation', id: 'invitation-new-computer' });
  });

  it.each<Entry>(['initialize', 'import'])('%s preserves the credential when a persistent key moves a quick tunnel', (entry) => {
    const old = normalizeRelayConfig({ id: 'quick-computer', label: 'Quick', url: 'wss://old.trycloudflare.com', token, paired: true });
    saveComputers([old]);
    const beforeAuth = localStorage.getItem(DEVICE_AUTH_STORAGE_KEY);
    const url = new URL('https://app.example/installed-entry.html');
    url.hash = new URLSearchParams({ setup: token, label: 'Quick', relay: 'wss://new.trycloudflare.com' }).toString();
    openSetup(entry, url);
    expect(get(relayStore.relayConfigs)).toHaveLength(1);
    expect(get(relayStore.relayConfigs)[0]).toMatchObject({ id: old.id, url: 'wss://new.trycloudflare.com' });
    expect(localStorage.getItem(DEVICE_AUTH_STORAGE_KEY)).toBe(beforeAuth);
  });

  const refusals = [
    ['one legacy label match', () => [computer({ gatewayRelayId: undefined, rendezvousKey: undefined, token })]],
    ['ambiguous legacy label matches', () => [computer({ id: 'legacy-one', gatewayRelayId: undefined, rendezvousKey: undefined, token }),
      computer({ id: 'legacy-two', gatewayRelayId: undefined, rendezvousKey: undefined, token: 'f'.repeat(32) })]],
    ['duplicate rendezvous matches', () => [computer({ id: 'one', gatewayRelayId: newRendezvous }), computer({ id: 'two', gatewayRelayId: newRendezvous })]],
    ['duplicate credential IDs', () => [computer({ gatewayRelayId: newRendezvous }), computer({ gatewayRelayId: oldRendezvous })]],
  ] as const;

  for (const [reason, relays] of refusals) {
    it.each<Entry>(['initialize', 'import'])(`%s refuses ${reason} without storage writes or hiding saved computers`, (entry) => {
      const saved = relays();
      saveComputers(saved);
      const before = storageSnapshot();
      const writes = vi.spyOn(localStorage, 'setItem');
      const result = openSetup(entry, invitation());
      if (entry === 'import') expect(result).toBe(false);
      else expect(relayStore.connectAll).toHaveBeenCalledOnce();
      expect(get(relayStore.relayConfigs)).toEqual(saved);
      expect(storageSnapshot()).toEqual(before);
      expect(writes).not.toHaveBeenCalled();
    });
  }

  it.each(['initialize', 'import'] as const)('%s refuses truncated or case-folded generated-ID collisions', (entry) => {
    for (const collision of ['truncated', 'case-folded'] as const) {
      localStorage.clear();
      const label = collision === 'truncated' ? 'x'.repeat(48) : 'Shared name';
      const sharedGateway = collision === 'truncated' ? `wss://${'y'.repeat(40)}.example` : gateway;
      const nextRendezvous = collision === 'truncated' ? newRendezvous : oldRendezvous.toLowerCase();
      const old = computer({ id: undefined, label, gatewayUrl: sharedGateway });
      const proposed = computer({ id: undefined, label, gatewayUrl: sharedGateway, gatewayRelayId: nextRendezvous });
      expect(proposed.id).toBe(old.id);
      saveComputers([old]);
      const before = storageSnapshot();
      const writes = vi.spyOn(localStorage, 'setItem');
      const result = openSetup(entry, invitation({ label, gateways: sharedGateway, relay_id: nextRendezvous }));
      if (entry === 'import') expect(result).toBe(false);
      expect(get(relayStore.relayConfigs)).toEqual([old]);
      expect(storageSnapshot()).toEqual(before);
      expect(writes).not.toHaveBeenCalled();
      writes.mockRestore();
    }
  });

  it.each<Entry>(['initialize', 'import'])('%s leaves an orphan credential or expired invitation byte-exact', (entry) => {
    for (const expired of [false, true]) {
      localStorage.clear();
      const old = computer();
      saveComputers([old]);
      const orphan = computer({ id: undefined, gatewayRelayId: newRendezvous });
      if (expired) {
        new BrowserDeviceCredentialStore(localStorage, () => Date.now() - 120_000).saveInvitation(orphan.id,
          { id: 'invitation-expired-computer', version: 1, secret: 'D'.repeat(43), expiresAt: Date.now() - 60_000 });
      } else seedCredential(orphan.id);
      const before = storageSnapshot();
      const writes = vi.spyOn(localStorage, 'setItem');
      const result = openSetup(entry, invitation());
      if (entry === 'import') expect(result).toBe(false);
      expect(get(relayStore.relayConfigs)).toEqual([old]);
      expect(storageSnapshot()).toEqual(before);
      expect(writes).not.toHaveBeenCalled();
      writes.mockRestore();
    }
  });

  it('keeps manual computer additions from adopting a different rendezvous or colliding credential key', () => {
    const old = computer();
    saveComputers([old]);
    const beforeCredential = credentialBytes(old.id);
    relayStore.addRelay(computer({ id: undefined, gatewayRelayId: newRendezvous }));
    expect(get(relayStore.relayConfigs)).toHaveLength(2);
    expect(credentialBytes(old.id)).toBe(beforeCredential);
    const before = storageSnapshot();
    relayStore.addRelay(computer({ id: old.id, gatewayRelayId: 'A'.repeat(22) }));
    expect(storageSnapshot()).toEqual(before);
  });
});
