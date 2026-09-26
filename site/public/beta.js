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
  // The status answers one request. It was cleared only when a valid form was
  // sent, so an old error, or "we'll email <the previous address>", sat above
  // a reopened, empty form, and beside the browser's own bubble for a box left
  // unticked (pre-release bug hunt, B97). An answer still on its way is kept.
  const clearStatus = () => { if (!busy) { status.textContent = ''; status.dataset.success = 'false'; } };
  form.addEventListener('input', clearStatus);
  // A form the browser refuses never fires submit, so its bubble sat beside
  // the last answer. `invalid` does not bubble, hence the capture.
  form.addEventListener('invalid', clearStatus, true);

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
        clearStatus();
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
    clearStatus();
    // aria-disabled, not disabled: disabling the focused button moved focus to
    // <body>, outside the modal, in both engines; busy already refuses a second submit.
    busy = true; button.setAttribute('aria-disabled', 'true'); button.textContent = 'Sending…';
    const fields = new FormData(form);
    let response;
    try {
      response = await fetch('/api/ios-beta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: fields.get('email'), website: fields.get('website'), consent: fields.get('consent') === 'on' }),
      });
    } catch { response = null; }
    try {
      // A server that answered is not unreachable: an HTML error page from the
      // edge failed to parse and was reported as "Couldn't reach Shahi" (B97).
      const result = response && await response.json().catch(() => null);
      if (!response) status.textContent = 'Couldn’t reach Shahi. Please try again, or email support@getshahi.dev.';
      else if (typeof result?.message !== 'string') status.textContent = `Shahi couldn’t take your request (error ${response.status}). Please try again, or email support@getshahi.dev.`;
      else {
        status.textContent = result.message;
        if (response.ok) { status.dataset.success = 'true'; form.reset(); }
      }
    }
    finally {
      busy = false; button.removeAttribute('aria-disabled'); button.textContent = label;
      // On a small or zoomed screen the answer lands below the dialog's fold,
      // so a sighted visitor saw no sign the request went through. "nearest"
      // scrolls only the dialog's own box, and focus stays on the button.
      if (status.textContent) status.scrollIntoView({ block: 'nearest' });
    }
  });
})();
