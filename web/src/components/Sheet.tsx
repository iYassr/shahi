/**
 * A bottom sheet.
 *
 * Forms rise from the bottom rather than landing in the middle of the screen,
 * because that is where a thumb is and where the keyboard will push them
 * anyway. Dismissed by the backdrop, the close control, or Escape.
 */
import { type ReactNode } from "react";
import { useDialog } from "../use-dialog";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Sheet({ title, onClose, children }: Props) {
  const dialog = useDialog(onClose);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
      <button className="sheet__backdrop" tabIndex={-1} onClick={onClose} aria-label="Close" />
      <div className="sheet__panel" ref={dialog} tabIndex={-1}>
        <div className="sheet__grip" aria-hidden="true" />
        <h2 className="sheet__title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
