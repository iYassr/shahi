/** Decorative setup cues using the same strokes as the app's navigation. */
export function SetupIcon({ name, size = 24 }: { name: "install" | "qr" | "devices"; size?: number }) {
  return <svg className="setup-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === "install" ? <>
      <path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </> : name === "qr" ? <>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="15" width="6" height="6" rx="1" />
      <path d="M14 14h3v3h4v4h-7v-3M21 13v1" />
      <path d="M6 6h.01M18 6h.01M6 18h.01" strokeWidth="2.5" />
    </> : <>
      <rect x="2" y="3" width="15" height="12" rx="2" />
      <path d="M9 15v5m-4 0h8" />
      <rect x="15" y="10" width="7" height="12" rx="1.5" fill="var(--surface)" />
      <path d="M18.5 19h.01" strokeWidth="2" />
    </>}
  </svg>;
}
