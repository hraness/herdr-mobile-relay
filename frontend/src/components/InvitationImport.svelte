<script lang="ts">
  import Button from '$components/ui/Button.svelte';
  import { InvitationImportError, invitationImportLocation } from '$lib/invitation-import';
  import { securityState } from '$lib/security';
  import { relayStore } from '$lib/store';

  const relays = relayStore.relayConfigs;
  let invitation = $state('');
  $effect(() => {
    if ($securityState.locked || $securityState.busy) invitation = '';
  });

  function importInvitation(event: SubmitEvent): void {
    event.preventDefault();
    const pasted = invitation;
    invitation = '';
    try {
      const setup = invitationImportLocation(pasted, location, $relays, {
        unlocked: !$securityState.locked && !$securityState.busy,
        installed: Boolean(navigator.standalone || window.matchMedia?.('(display-mode: standalone)').matches),
      });
      if (!relayStore.importSetupLink(setup)) {
        relayStore.showToast('Could not save the invitation on this device.', true);
      }
    } catch (error) {
      relayStore.showToast(error instanceof InvitationImportError ? error.message : 'Could not import this invitation.', true);
    }
  }
</script>

<h3>Add computer from invitation</h3>
<form class="form-stack" onsubmit={importInvitation}>
  <label for="computer-invitation">Invitation link</label>
  <input
    id="computer-invitation"
    type="password"
    bind:value={invitation}
    maxlength="4096"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    placeholder="Paste the invitation link"
    aria-describedby="computer-invitation-hint"
  />
  <p id="computer-invitation-hint" class="hint">Open the installed app and paste a fresh invitation from the computer you want to add.</p>
  <div class="form-actions">
    <Button type="submit" disabled={$securityState.locked || $securityState.busy || !invitation.trim()}>Add computer</Button>
  </div>
</form>
