/** Shared, decorative controls; the adjacent text supplies the accessible name. */
export function UiIcon({ name, size = 20 }: { name: "computer" | "folder" | "search" | "chevron" | "check" | "bell" | "shield" | "file" | "close" | "read" | "screen"; size?: number }) {
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === "computer" && <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>}
    {name === "folder" && <path d="M3 7V5a1 1 0 0 1 1-1h5l3 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />}
    {name === "search" && <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>}
    {name === "chevron" && <path d="m8 10 4 4 4-4" />}
    {name === "check" && <path d="m5 12 4 4L19 6" />}
    {name === "bell" && <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>}
    {name === "shield" && <><path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>}
    {name === "file" && <><path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8M8 16h6" /></>}
    {name === "close" && <path d="m6 6 12 12M6 18 18 6" />}
    {name === "read" && <><path d="M3 5h7l2 2 2-2h7v15h-7l-2 1-2-1H3ZM12 7v14" /></>}
    {name === "screen" && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>}
  </svg>;
}
