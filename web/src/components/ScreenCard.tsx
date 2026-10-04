import { useLocale } from "../i18n";
import { SCREEN_CARD_KEYS, screenTail } from "@shahi/shared";

interface Props {
  /** The pane's screen, escapes stripped (`PaneFrame.text`). */
  text: string;
  /** True when herdr says the agent waits on it (`PaneFrame.unrecognised`). */
  waiting: boolean;
  disabled: boolean;
  onKeys: (keys: string[], label: string) => void;
  onOpenScreen: () => void;
}

/**
 * The bottom of the terminal, as it is, with the keys that answer menus: for
 * an agent waiting on something no parser recognised, and for a new agent
 * whose startup screens come before any conversation. See `screen-card.ts`.
 */
export function ScreenCard({ text, waiting, disabled, onKeys, onOpenScreen }: Props) {
  const { t } = useLocale();
  const rows = screenTail(text);
  if (rows.length === 0) return null;
  const heading = t(waiting ? "Waiting on something Shahi cannot read" : "On the computer's screen");
  // Amber only when the agent waits on it: an idle Claude after its folder
  // trust, waiting for nothing but a first message, carried a question's
  // border and read as something that needed you (first-task test of build
  // 32, October 2026). The native card is the same.
  return (
    <section className={waiting ? "blocked screencard" : "blocked screencard screencard--idle"} aria-label={heading}>
      <p className="blocked__question" style={{ borderTop: "none" }}>
        {heading}
        {waiting && <span className="screencard__hint"> {" "}{t("Messages are not sent until it is answered.")}</span>}
      </p>
      {/* Not wrapped: the agent laid these rows out for its terminal's width,
          and a menu's rows only read as a menu in their own columns. */}
      <pre dir="ltr" className="screencard__screen" tabIndex={0} aria-label={t("Terminal screen")}>{rows.join("\n")}</pre>
      <div className="keys screencard__keys" role="group" aria-label={t("Keys")}>
        {SCREEN_CARD_KEYS.map(({ label, keys, name }) => (
          <button key={label} disabled={disabled} aria-label={t(name)} onClick={() => onKeys(keys, label)}>{t(label)}</button>
        ))}
        <button className="screencard__open" onClick={onOpenScreen}>{t("Open Screen")}</button>
      </div>
    </section>
  );
}
