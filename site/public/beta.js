(() => {
  const form = document.querySelector('#beta-form');
  if (!form) return;
  const status = document.querySelector('#beta-status');
  const button = form.querySelector('button');
  let busy = false;
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
    finally { busy = false; button.disabled = false; button.textContent = 'Request an invite'; }
  });
})();
