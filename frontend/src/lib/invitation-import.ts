import { normalizeRelayConfig, quickSetupConfig, quickSetupInvitation } from './config';
import type { RelayConfig } from './types';

export class InvitationImportError extends Error {}

/** Validate before importSetupLink can persist a relay or replace a credential. */
export function invitationImportLocation(
  input: string,
  current: Pick<Location, 'href'>,
  relays: readonly RelayConfig[],
  access: { unlocked: boolean; installed: boolean },
  now = Date.now(),
): URL {
  if (!access.unlocked) throw new InvitationImportError('Unlock Herdr before adding a computer.');
  if (!access.installed) throw new InvitationImportError('Open Herdr from your Home Screen to import an invitation.');
  const invalid = () => new InvitationImportError('Paste a valid, unexpired invitation link for this app.');
  const value = input.trim();
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  let page: URL;
  let pasted: URL;
  try {
    page = new URL(current.href);
    pasted = value.startsWith('#') ? new URL(value, page) : new URL(value);
  } catch { throw invalid(); }
  if (page.protocol !== 'https:' || page.username || page.password
    || pasted.protocol !== 'https:' || pasted.origin !== page.origin || pasted.username || pasted.password) throw invalid();
  const fields = new URLSearchParams(pasted.hash.slice(1));
  const allowed = new Set(['setup', 'invite', 'invite_version', 'invite_expires', 'label', 'relay']);
  if ([...fields.keys()].some((key) => !allowed.has(key) || fields.getAll(key).length !== 1)
    || !fields.get('relay')) throw invalid();
  // Keep this installed app's path and query. Never navigate to, or store, the
  // pasted URL; its fragment is consumed directly by the existing importer.
  page.hash = pasted.hash;
  const invitation = quickSetupInvitation(page);
  const setup = quickSetupConfig(page);
  if (!invitation || invitation.expiresAt <= now || !setup || !setup.url.startsWith('wss://') || setup.transport === 'hybrid') throw invalid();
  const next = normalizeRelayConfig({ ...setup, paired: true });
  const saved = relays.some((relay) => {
    if (relay.id === next.id) return true;
    try { return new URL(relay.url).origin === setup.url; } catch { return false; }
  });
  if (saved) throw new InvitationImportError('This computer is already saved. Its pairing has not been changed.');
  return page;
}
