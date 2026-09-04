/**
 * The last line of defence against a white screen.
 *
 * A render error anywhere below this unmounts the tree and leaves the app
 * blank — the exact "had to refresh the page" symptom the PWA fought. This
 * catches it, shows what happened, and offers a reset that remounts the tree
 * (which re-runs the session restore, so a transient bad state clears itself).
 * The reconciliation crash that this review found is precisely the shape it
 * exists for.
 */
import { Component, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "@/lib/theme";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>Something broke.</Text>
        <Text style={styles.detail} numberOfLines={4}>
          {this.state.error.message}
        </Text>
        <Pressable accessibilityRole="button" style={styles.button} onPress={this.reset}>
          <Text style={styles.buttonText}>Reload</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void, alignItems: "center", justifyContent: "center", padding: 32, gap: 14 },
  title: { color: theme.fg, fontFamily: theme.mono, fontSize: 18, fontWeight: "600" },
  detail: { color: theme.dim, fontSize: 13, textAlign: "center", lineHeight: 19 },
  button: {
    backgroundColor: theme.peach,
    borderRadius: 8,
    borderCurve: "continuous",
    minHeight: 48,
    paddingHorizontal: 28,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  buttonText: { color: theme.void, fontWeight: "600", fontSize: 16 },
});
