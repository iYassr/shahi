/**
 * Settings' Agents section: how much of the Claude Code and Codex plans is
 * used, from the computer on screen (`/api/plan-usage`, capability
 * `plan-usage`). Codex reports its limits after every turn, so its group needs
 * nothing from the person. Claude Code reports them only to a status line, so
 * its group carries the switch that installs one, and says what that costs.
 */
import { planWindowNow, relativeTime, type PlanUsage, type ProviderUsage } from "@shahi/shared";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Switch, View } from "react-native";
import { AgentIcon } from "@/components/icons";
import { Text } from "@/components/text";
import type { Api } from "@/lib/api";
import { theme } from "@/lib/theme";

export function AgentUsage({ api, focused, live, computer }: { api: Api; focused: boolean; live: boolean; computer: string }) {
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const load = useCallback(async () => {
    try { setUsage(await api.planUsage()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : "Usage could not be read."); }
  }, [api]);
  // Read when the screen is looked at, and again while it stays open: both
  // agents report after their own turns, not on a clock.
  useEffect(() => {
    if (!focused || !live) return;
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [focused, live, load]);

  const toggle = async (enabled: boolean) => {
    setSwitching(true);
    try { setUsage(await api.setClaudePlanUsage(enabled)); setError(null); } catch (e) { setError(e instanceof Error ? e.message : "Claude Code's settings could not be changed."); }
    finally { setSwitching(false); }
  };

  if (!usage) {
    return (
      <View style={styles.group}>
        {error ? <Text style={styles.note}>{error}</Text> : <ActivityIndicator style={styles.loading} color={theme.dim} />}
      </View>
    );
  }
  const claude = usage.claude;
  return (
    <>
      <View style={styles.group} testID="usage-claude">
        <Heading kind="claude" title="Claude Code" />
        {claude.enabled && <Windows usage={claude.usage} empty={`Appears after Claude Code's next reply on ${computer}. Claude Code reports plan limits for Pro and Max plans.`} source="Claude Code's last reply" />}
        <View style={styles.separator} />
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Show plan usage</Text>
          <Switch
            accessibilityLabel="Show Claude Code plan usage"
            value={claude.enabled}
            disabled={switching || !live}
            onValueChange={(on) => void toggle(on)}
            trackColor={{ true: theme.mint, false: theme.raised }}
          />
        </View>
        <Text style={styles.note}>
          {claude.enabled
            ? "Shahi's status line in Claude Code reports these. Turn this off to put back the status line you had before."
            : "Adds a status line to Claude Code on this computer that reports your 5-hour and weekly limits. Claude Code then hides its footer hints, such as \"esc to interrupt\"; a status line you already have keeps working."}
        </Text>
      </View>
      <View style={styles.group} testID="usage-codex">
        <Heading kind="codex" title="Codex" plan={usage.codex.usage?.plan} />
        <Windows usage={usage.codex.usage} empty={`Appears after Codex's next turn on ${computer}.`} source="Codex's last turn" />
      </View>
      {error && <Text style={[styles.note, styles.error]}>{error}</Text>}
    </>
  );
}

function Heading({ kind, title, plan }: { kind: string; title: string; plan?: string }) {
  return (
    <View style={styles.heading}>
      <View style={styles.badge}><AgentIcon kind={kind} size={16} /></View>
      <Text style={styles.title} accessibilityRole="header">{title}</Text>
      {plan ? <Text style={styles.plan}>{plan.charAt(0).toUpperCase() + plan.slice(1)}</Text> : null}
    </View>
  );
}

function Windows({ usage, empty, source }: { usage: ProviderUsage | null; empty: string; source: string }) {
  if (!usage) return <Text style={styles.note}>{empty}</Text>;
  const now = Date.now();
  return (
    <>
      {usage.windows.map((window) => {
        const { percent, reset } = planWindowNow(window, now);
        const high = percent !== null && percent >= 80;
        return (
          <View key={window.label} style={styles.window} accessible accessibilityLabel={`${window.label} limit, ${percent === null ? "no current reading" : `${percent}% used`}${reset ? `. ${reset}` : ""}`}>
            <View style={styles.windowLine}>
              <Text style={styles.windowLabel}>{window.label}</Text>
              <Text style={[styles.windowValue, high && { color: theme.rose }]}>{percent === null ? "—" : `${percent}% used`}</Text>
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.min(100, percent ?? 0)}%`, backgroundColor: high ? theme.rose : theme.mint }]} />
            </View>
            {reset ? <Text style={styles.reset}>{reset}</Text> : null}
          </View>
        );
      })}
      <Text style={styles.note}>Updated {relativeTime(usage.observedAt, now)}, from {source}.</Text>
    </>
  );
}

const styles = StyleSheet.create({
  // The same inset-grouped card as the rest of Settings.
  group: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.line, borderRadius: 14, borderCurve: "continuous", marginHorizontal: 16, marginTop: 16, overflow: "hidden", paddingBottom: 10 },
  loading: { padding: 16 },
  heading: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 },
  badge: { width: 28, height: 28, borderRadius: 7, borderCurve: "continuous", backgroundColor: theme.raised, alignItems: "center", justifyContent: "center" },
  title: { color: theme.fg, fontSize: 15, fontWeight: "600", flex: 1 },
  plan: { color: theme.dim, fontSize: 12 },
  window: { paddingHorizontal: 12, paddingLeft: 50, paddingTop: 8, gap: 4 },
  windowLine: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  windowLabel: { color: theme.fg, fontSize: 14 },
  windowValue: { color: theme.dim, fontSize: 13, fontVariant: ["tabular-nums"] },
  track: { height: 6, borderRadius: 3, backgroundColor: theme.raised, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  reset: { color: theme.dim, fontSize: 12 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginLeft: 50, marginTop: 10 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 50, paddingRight: 12, minHeight: 44 },
  switchLabel: { color: theme.fg, fontSize: 15 },
  note: { color: theme.dim, fontSize: 12, paddingHorizontal: 12, paddingLeft: 50, paddingTop: 6 },
  error: { color: theme.rose, paddingLeft: 30 },
});
