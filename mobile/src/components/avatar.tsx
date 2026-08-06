/**
 * The avatar an agent signs its row with — and its dance.
 *
 * A working agent's circle bobs: a small lift and swell on a slow loop, the
 * list's version of the terminal's spinner, asked for from the phone in
 * exactly those words ("the icon should keep dancing a bit"). The loop runs
 * on the UI thread via reanimated, so a screenful of rows costs the JS
 * thread nothing, and it settles back to rest — not mid-bob — the moment
 * the agent stops.
 */
import { useEffect } from "react";
import { StyleSheet, Text } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import type { DashboardPane } from "@shahi/shared";
import { AGENT_COLORS, theme } from "@/lib/theme";
import { AGENT_ICONS, Icon } from "@/components/icons";

export function Avatar({ pane }: { pane: DashboardPane }) {
  const color = AGENT_COLORS[pane.agent ?? ""] ?? theme.dim;
  const dancing = pane.status === "working";
  const t = useSharedValue(0);
  useEffect(() => {
    if (dancing) {
      t.value = withRepeat(
        withSequence(withTiming(1, { duration: 420 }), withTiming(0, { duration: 420 })),
        -1,
      );
    } else {
      cancelAnimation(t);
      t.value = withTiming(0, { duration: 180 });
    }
  }, [dancing, t]);
  const dance = useAnimatedStyle(() => ({
    transform: [{ translateY: -3 * t.value }, { scale: 1 + t.value * 0.06 }],
  }));

  return (
    <Animated.View style={[styles.avatar, { borderColor: color }, dance]}>
      {pane.agent && AGENT_ICONS[pane.agent] ? (
        <Icon name={AGENT_ICONS[pane.agent]!} color={color} size={20} />
      ) : (
        <Text style={[styles.glyph, { color }]}>{pane.isAgent ? "✳" : "❯"}</Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.surface,
  },
  glyph: { fontFamily: theme.mono, fontSize: 16 },
});
