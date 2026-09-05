/* Automatic motion respects preferences; the replay control is an explicit opt-in. */
(() => {
  const key = "shahi.brand-welcome";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let played = false;
  let animation;
  try { played = sessionStorage.getItem(key) === "1"; } catch { /* Memory-only when storage is unavailable. */ }

  function mount() {
    const mark = document.querySelector("[data-brand-welcome]");
    if (!mark || !mark.getClientRects().length) return false;
    function greet(manual = false) {
      if (!manual && (played || reduced.matches)) return;
      played = true;
      try { sessionStorage.setItem(key, "1"); } catch { /* Memory-only greeting. */ }
      animation?.cancel();
      animation = mark.animate([
        { transform: "translateY(0) rotate(0deg)", offset: 0 },
        { transform: "translateY(-5px) rotate(-12deg)", offset: .25 },
        { transform: "translateY(-6px) rotate(10deg)", offset: .48 },
        { transform: "translateY(-1px) rotate(-4deg)", offset: .7 },
        { transform: "translateY(0) rotate(0deg)", offset: 1 },
      ], { duration: 1200, delay: manual ? 0 : 300, easing: "ease-in-out", iterations: 1 });
      const current = animation;
      const stop = () => { if (reduced.matches) current.cancel(); };
      reduced.addEventListener("change", stop);
      current.finished.catch(() => {}).finally(() => reduced.removeEventListener("change", stop));
    }
    const replay = document.querySelector("[data-replay-greeting]");
    if (replay) {
      replay.hidden = false;
      replay.addEventListener("click", () => greet(true));
    }
    greet();
    return true;
  }
  if (mount()) return;
  // React may mount sign-in or the main header after this static script loads.
  const observer = new MutationObserver(() => { if (mount()) observer.disconnect(); });
  observer.observe(document.body, { childList: true, subtree: true });
})();
