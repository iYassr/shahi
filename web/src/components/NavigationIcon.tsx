/** Consistent 18px navigation strokes; provider artwork belongs in AgentIcon. */
export function NavigationIcon({ name }: { name: "agents" | "spaces" | "settings" }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "agents" ? <>
      <rect x="5" y="5" width="14" height="14" rx="3" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" />
    </> : name === "spaces" ? <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
    </> : <>
      <path d="M4 7h3m4 0h9M4 17h9m4 0h3" />
      <circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" />
    </>}
  </svg>;
}
