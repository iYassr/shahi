(() => {
  const dialog = document.querySelector('#beta-dialog');
  const form = document.querySelector('#beta-form');
  if (!dialog || !form) return;
  const email = form.querySelector('#beta-email');
  const status = document.querySelector('#beta-status');
  const button = form.querySelector('button[type="submit"]');
  const label = button.textContent;
  let busy = false;
  let opener = null;

  // Without <dialog> (Safari before 15.4) the page stays as the HTML made it:
  // the opener links lead to #ios-beta, where the email address is still
  // shown, and the section's own button stays hidden.
  if (typeof dialog.showModal === 'function') {
    for (const control of document.querySelectorAll('[data-beta-open]')) {
      control.hidden = false;
      control.setAttribute('aria-haspopup', 'dialog');
      control.addEventListener('click', (event) => {
        event.preventDefault();
        if (dialog.open) return;
        opener = control;
        dialog.showModal();
        email.focus();
      });
    }
    for (const fallback of document.querySelectorAll('[data-beta-fallback]')) fallback.hidden = true;
    dialog.querySelector('[data-beta-close]').addEventListener('click', () => dialog.close());
    // Safari does not focus a link or button that is clicked or tapped, so the
    // browser's own restore would leave focus on the page, not the opener.
    dialog.addEventListener('close', () => { opener?.focus(); opener = null; });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true; button.disabled = true; button.textContent = 'Sending…';
    status.textContent = ''; status.dataset.success = 'false';
    const fields = new FormData(form);
    try {
      const response = await fetch('/api/ios-beta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: fields.get('email'), website: fields.get('website'), consent: fields.get('consent') === 'on' }),
      });
      const result = await response.json();
      status.textContent = result.message;
      if (response.ok) { status.dataset.success = 'true'; form.reset(); }
    } catch { status.textContent = 'Couldn’t reach Shahi. Please try again, or email support@getshahi.dev.'; }
    finally { busy = false; button.disabled = false; button.textContent = label; }
  });
})();
