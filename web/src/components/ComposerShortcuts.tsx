import { useLocale } from "../i18n";
/**
 * The composer's two shortcuts: the slash-command picker and the quick-reply
 * chips. Both only put text where the person's own typing goes — the picker
 * into the composer, a chip through the same send as the Send button — so
 * everything the send path guarantees (operation ids, receipts, refusals
 * while a menu is open) holds for them unchanged. The native app's
 * `composer-shortcuts.tsx` is the same pair.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { builtinCommands, QUICK_REPLIES, type SlashCommand } from "@shahi/shared";
import { useApi } from "../api";

/**
 * The commands to offer: the agent's built-ins at once, and the computer's
 * list — which adds the person's own — once it answers. Asked each time the
 * picker opens, so a command written on the computer a minute ago is there;
 * a computer without the `commands` capability is not asked at all. A failure
 * leaves the built-ins: this is a convenience, and the person can still type.
 * A 401 is the API client's to report, as it is for every request.
 */
export function usePaneCommands(paneId: string, agent: string | null | undefined, { capable, open }: { capable: boolean; open: boolean }): SlashCommand[] {
  const api = useApi();
  const builtins = useMemo(() => builtinCommands(agent), [agent]);
  const key = `${paneId}\n${agent ?? ""}`;
  const [fetched, setFetched] = useState<{ key: string; commands: SlashCommand[] } | null>(null);
  useEffect(() => {
    if (!capable || !open || !agent) return;
    let live = true;
    api.paneCommands(paneId).then(
      ({ commands }) => {
        if (!live || !Array.isArray(commands)) return;
        setFetched({ key, commands: commands.filter((c) => typeof c?.name === "string" && typeof c.description === "string") });
      },
      () => {},
    );
    return () => { live = false; };
  }, [api, paneId, agent, capable, open, key]);
  return fetched?.key === key ? fetched.commands : builtins;
}

const SOURCE_LABEL = { user: "personal", project: "project" } as const;

/**
 * The commands matching what follows the `/`, as a listbox the composer
 * controls: the arrow keys move through it and Enter chooses, while focus —
 * and a phone's keyboard — stays in the composer. Choosing puts `/name ` in
 * the composer, with the space since many take arguments, and sends nothing.
 */
export function CommandPicker({ id, commands, active, onPick }: { id: string; commands: SlashCommand[]; active: number; onPick: (command: SlashCommand) => void }) {
  const { t } = useLocale();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[aria-selected="true"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <div ref={list} className="commands" id={id} role="listbox" aria-label={t("Commands")}>
      {commands.map((command, i) => (
        <button
          key={command.name}
          id={`${id}-${i}`}
          type="button"
          role="option"
          aria-selected={i === active}
          tabIndex={-1}
          className="commands__option"
          // Keeps focus, and the phone's keyboard, in the composer.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(command)}
        >
          <span className="commands__name">/{command.name}</span>
          {command.source !== "builtin" && <span className="commands__source">{t(SOURCE_LABEL[command.source])}</span>}
          {command.description && <span className="commands__description">{command.description}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * One row: `/` to open the picker, then the quick replies, scrolling sideways
 * rather than wrapping at large sizes. It sits above the reply box, whose
 * place on screen does not change when the row comes and goes.
 */
export function ReplyChips({ slash, replies, onSlash, onReply }: { slash: boolean; replies: boolean; onSlash: () => void; onReply: (text: string) => void }) {
  const { t } = useLocale();
  if (!slash && !replies) return null;
  return (
    <div className="replies" role="group" aria-label={t("Quick replies")}>
      {slash && <button type="button" className="replies__slash" aria-label={t("Commands")} title={t("Start a slash command")} onClick={onSlash}>/</button>}
      {replies && QUICK_REPLIES.map((reply) => (
        <button key={reply} type="button" title={t("Sends this reply now")} onClick={() => onReply(t(reply))}>{t(reply)}</button>
      ))}
    </div>
  );
}
