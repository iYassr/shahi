/**
 * A bottom sheet.
 *
 * Forms rise from the bottom rather than landing in the middle of the screen,
 * because that is where a thumb is and where the keyboard will push them
 * anyway. Dismissed by the backdrop, the close control, or Escape.
 */
import { useEffect, type ReactNode } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Sheet({ title, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);

    // The sheet scrolls itself; the page behind it must not.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
      <button className="sheet__backdrop" onClick={onClose} aria-label="Close" />
      <div className="sheet__panel">
        <div className="sheet__grip" aria-hidden="true" />
        <h2 className="sheet__title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
