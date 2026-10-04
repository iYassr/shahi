import { useLocale } from "../i18n";
import { agentIdentity } from "@shahi/shared/brand";
import { agentLabel } from "@shahi/shared";

interface Props {
  kind: string | null | undefined;
  size?: number;
}

export function agentColor(kind: string | null | undefined) { return agentIdentity(kind).color; }

export function AgentIcon({ kind, size = 14 }: Props) {
  const { t } = useLocale();
  const { d, filled, color } = agentIdentity(kind);
  return <svg className="agenticon" width={size} height={size} viewBox="0 0 24 24"
    fill="none" role="img" aria-label={kind && kind !== "shell" ? agentLabel(kind) : t("Shell")}>
    <path d={d} fill={filled ? color : "none"} stroke={filled ? undefined : color}
      strokeWidth={filled ? undefined : 2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
