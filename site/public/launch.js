(() => {
  const video = document.querySelector('.launch-video video');
  if (!video) return;

  // With preload="none" Chrome draws no play button in the frame, and a click
  // on the poster does nothing: only the control bar's small ▶ starts it
  // (measured 2026-09-25). A real button in the middle of the frame gives
  // every engine the same way in. It goes on the first play, so the native
  // controls handle play and pause from then on; without JavaScript the page
  // is as the HTML made it, and the bar's ▶ still works.
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'launch-play';
  button.setAttribute('aria-label', 'Play the launch video');
  // An SVG in currentColor, not a ▶ character, which iOS draws as an emoji
  // and forced-colours mode cannot recolour.
  button.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
  button.addEventListener('click', () => { video.play().catch(() => {}); });
  video.after(button);
  video.addEventListener('play', () => {
    const focused = document.activeElement === button;
    button.remove();
    // Removing a focused button would drop keyboard focus onto <body>.
    if (focused) video.focus();
  }, { once: true });

  // <source media> is chosen once, at load, so after a rotation or a resize
  // across 760px the box's shape no longer matches the cut: follow the cut
  // that actually loaded, which only differs once the visitor pressed play.
  video.addEventListener('loadedmetadata', () => {
    if (video.videoWidth > 0 && video.videoHeight > 0) video.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  });
})();
