import { connection, createApi } from "./api";
import { chosenAnswer, postNotificationAnswer } from "./notification-answer";

/**
 * Approving from the notification ends in the same request a card makes:
 * the server compares it with a fresh read of the screen and presses nothing
 * when the question has moved on. These hold the request to that body, and
 * the refusal to the computer's own words.
 */
const opened = {
  promptId: "prompt-1",
  question: "Do you want to proceed?",
  context: ["Bash command", "python3 tip.py\nRun the tip calculator"],
  options: [
    { index: 1, label: "Yes", title: "Yes" },
    { index: 2, label: "Yes, and don't ask again for python3 commands (shift+tab)", title: "Yes, and don't ask again for python3 commands" },
    { index: 3, label: "No", title: "No" },
  ],
};

describe("chosenAnswer", () => {
  test("an action names its option by index, and posts the parser's label, not the button's", () => {
    expect(chosenAnswer("shahi.option.2", { answer: opened })).toEqual({
      index: 2,
      label: "Yes, and don't ask again for python3 commands (shift+tab)",
      promptId: "prompt-1",
      question: opened.question,
      context: opened.context,
    });
  });

  test("a tap, another action, or data that is not an opened answer chooses nothing", () => {
    expect(chosenAnswer("expo.modules.notifications.actions.DEFAULT", { answer: opened })).toBeUndefined();
    expect(chosenAnswer("shahi.option.9", { answer: opened })).toBeUndefined();
    expect(chosenAnswer("shahi.option.1", { paneId: "w1:p1" })).toBeUndefined();
    expect(chosenAnswer("shahi.option.1", { answer: { ...opened, promptId: 7 } })).toBeUndefined();
    expect(chosenAnswer(undefined, { answer: opened })).toBeUndefined();
  });

  // A diff too long to seal beside the rest leaves the question and context
  // out of the box; the prompt id alone names that appearance of the question.
  test("without the question, the answer carries neither, rather than half", () => {
    const { question: _, ...bare } = opened;
    expect(chosenAnswer("shahi.option.1", { answer: bare })).toEqual({ index: 1, label: "Yes", promptId: "prompt-1" });
  });
});

describe("postNotificationAnswer", () => {
  const fetchMock = jest.fn();
  const client = createApi(connection);
  beforeEach(() => {
    connection.baseUrl = "http://127.0.0.1:7272";
    connection.cookie = "shahi_session=x";
    fetchMock.mockReset();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });
  const reply = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue({ ok: status < 300, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });

  test("posts exactly what a card posts: index, label, question, context, prompt id and occupant", async () => {
    reply(200, { ok: true });
    const answer = chosenAnswer("shahi.option.1", { answer: opened })!;
    expect(await postNotificationAnswer(client, "w3:p1", answer, "term_a")).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7272/api/panes/w3%3Ap1/answer");
    expect(JSON.parse(init.body)).toEqual({
      index: 1, label: "Yes", question: opened.question, context: opened.context, promptId: "prompt-1", instanceId: "term_a",
    });
  });

  test("without the question it sends the prompt id and the option alone", async () => {
    reply(200, { ok: true });
    await postNotificationAnswer(client, "w3:p1", { index: 3, label: "No", promptId: "prompt-1" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ index: 3, label: "No", promptId: "prompt-1" });
  });

  test("a question that moved on is told in the computer's words: nothing was pressed", async () => {
    reply(409, { error: "That question has already been answered or closed. Nothing was sent.", code: "prompt_gone" });
    expect(await postNotificationAnswer(client, "w3:p1", { index: 1, label: "Yes", promptId: "prompt-1" })).toEqual({
      sent: false, message: "That question has already been answered or closed. Nothing was sent.",
    });
    reply(409, { error: "The agent is asking something else now. Nothing was sent; check the new question.", code: "prompt_changed" });
    expect(await postNotificationAnswer(client, "w3:p1", { index: 1, label: "Yes", promptId: "prompt-1" })).toEqual({
      sent: false, message: "The agent is asking something else now. Nothing was sent; check the new question.",
    });
  });

  // A request that failed some other way may have reached the computer, so
  // the words never claim nothing was pressed.
  test("any other failure sends the person to the screen, without claiming nothing happened", async () => {
    reply(500, { error: "herdr did not answer." });
    const outcome = await postNotificationAnswer(client, "w3:p1", { index: 1, label: "Yes", promptId: "prompt-1" });
    expect(outcome).toEqual({ sent: false, message: "herdr did not answer. Check the question on screen before answering again." });
  });

  test("a refused session is reported as one, for the session to decide", async () => {
    reply(401, { error: "unauthorized" });
    expect(await postNotificationAnswer(client, "w3:p1", { index: 1, label: "Yes", promptId: "prompt-1" })).toMatchObject({ sent: false, unauthorized: true });
  });
});
