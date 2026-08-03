import * as Haptics from "expo-haptics";

/**
 * The taps a phone gives back.
 *
 * Three moments in this app send a real keystroke into a live session — an
 * answer, a message, a new agent — and each one has a wait behind it that the
 * screen cannot fill: herdr blocks, the agent thinks, the frame arrives a beat
 * later. A tap at the moment of commit is what says "that went", and on a phone
 * it is most of the difference between an app and a page.
 *
 * iOS only, and quietly. Android's generic vibration is a buzz rather than a
 * tap and reads as an error wherever it fires; there is no third state to
 * report here, so silence is better than the wrong texture.
 */
const on = process.env.EXPO_OS === "ios";

/** A keystroke left for a live session. */
export const committed = () => {
  if (on) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};

/** Something the agent will now act on — an answer, a started session. */
export const landed = () => {
  if (on) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

/** It did not go. Paired with a message; never the only signal. */
export const refused = () => {
  if (on) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
};
