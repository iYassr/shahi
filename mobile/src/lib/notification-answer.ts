/**
 * Answering an agent from its notification.
 *
 * A computer offering `push-actions` seals the prompt into the notification,
 * and the Notification Service Extension opens it and offers its answers as
 * actions (`plugins/notification-service`). The opened answer reaches the app
 * as the notification's `answer` data: the option exactly as the server
 * parsed it, and the prompt id that names this appearance of the question.
 * The extension removes any `answer` that arrived outside the box, so the
 * push services cannot put one there.
 *
 * The actions open the app (`.foreground`): measured on the simulator, a
 * background action never reached an app that had been killed, and one that
 * was only suspended was suspended again within a second, before a relay
 * request could finish (docs/notifications.md). So the tap selects the
 * computer, opens the pane, and posts here, with the person watching. The server answers it as it answers a card: against a
 * fresh read of the screen, pressing nothing when the question has moved on.
 */
import { answerRefused } from "@shahi/shared";
import { UnauthorizedError, type Api } from "./api";

/** An action's identifier is this and the option's index (`AnswerCategories` in NotificationService.swift). */
export const ANSWER_ACTION = "shahi.option.";

export interface NotificationAnswer {
  index: number;
  label: string;
  promptId: string;
  /** With `context`, only when they fitted beside the rest; the prompt id alone already names the question. */
  question?: string;
  context?: string[];
}

const text = (value: unknown): value is string => typeof value === "string";

/** The answer an action chose, or nothing for a tap, another action, or data that is not an opened answer. */
export function chosenAnswer(actionIdentifier: string | undefined, data: unknown): NotificationAnswer | undefined {
  if (!actionIdentifier?.startsWith(ANSWER_ACTION)) return undefined;
  const index = Number(actionIdentifier.slice(ANSWER_ACTION.length));
  const answer = (data as { answer?: unknown } | null | undefined)?.answer as
    { promptId?: unknown; question?: unknown; context?: unknown; options?: unknown } | undefined;
  if (!answer || !text(answer.promptId) || !Array.isArray(answer.options)) return undefined;
  const option = (answer.options as { index?: unknown; label?: unknown }[]).find((o) => o?.index === index);
  if (!Number.isInteger(index) || !option || !text(option.label)) return undefined;
  const context = Array.isArray(answer.context) && answer.context.every(text) ? answer.context : undefined;
  return {
    index,
    label: option.label,
    promptId: answer.promptId,
    ...(text(answer.question) ? { question: answer.question, ...(context ? { context } : {}) } : {}),
  };
}

export type AnswerOutcome =
  | { sent: true }
  | { sent: false; message: string; unauthorized?: boolean };

/**
 * Posts the chosen option as the card would, with the occupant the
 * notification named. A refusal is told in the server's words, which already
 * say that nothing was pressed and why.
 */
export async function postNotificationAnswer(client: Api, paneId: string, answer: NotificationAnswer, instanceId?: string): Promise<AnswerOutcome> {
  const { index, label, promptId, question, context } = answer;
  try {
    await client.answerPrompt(paneId, { index, label }, { promptId, ...(question !== undefined ? { question, context } : {}) }, instanceId);
    return { sent: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof UnauthorizedError) return { sent: false, message, unauthorized: true };
    if (answerRefused(e)) return { sent: false, message };
    // Not "nothing was pressed": a request that timed out may have reached
    // the computer, and only the screen can say.
    return { sent: false, message: `${message} Check the question on screen before answering again.` };
  }
}
