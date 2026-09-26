import { API_SUPPORT, CAPABILITIES, CONTROL_VERSION, type BackendState, type ComputerUpdate, type ControlHandshake, updateInProgress } from "@shahi/shared";
import { installation, requestUpdate, updateStatus, type UpdateRequest } from "../../plugin/releases/storage";
import { buildId } from "./build";

export class ComputerControl {
  constructor(private serverId: string, private backend: () => BackendState, private managerRoot = process.env.SHAHI_MANAGER_ROOT) {}
  handshake(): ControlHandshake {
    const update = this.managerRoot ? updateStatus(this.managerRoot) ?? this.firstStart(this.managerRoot) : null;
    return {
      control: CONTROL_VERSION, serverId: this.serverId, buildId,
      api: { min: API_SUPPORT.min, max: API_SUPPORT.max },
      capabilities: CAPABILITIES.filter(c => c !== "computer-updates" || !!update?.managed),
      backend: this.backend(),
      // No message: both clients show a card with a message on every screen,
      // and this one said "Install the managed Shahi service…" on the Agents
      // list and in every conversation of a development checkout that worked
      // perfectly well (compatibility bug hunt). Settings says it, from
      // `managed: false`.
      update: update ?? { managed: false, channel: "stable", phase: "idle", current: buildId ?? "development" },
    };
  }
  /**
   * A managed install whose manager has not written its first status yet:
   * it writes one once this service is ready, then checks the catalog. Until
   * then this was reported as unmanaged, and a fresh install briefly told the
   * person to install the managed service it was running.
   */
  private firstStart(root: string): ComputerUpdate | null {
    const record = installation(root);
    return record ? { managed: true, channel: record.channel, phase: "checking", current: record.active.version } : null;
  }
  request(value: unknown) {
    if (!this.managerRoot) throw new Error("This computer needs the managed Shahi installer first.");
    const r = value as Partial<UpdateRequest> | null;
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some(k => k !== "action" && k !== "channel") || (r.action !== "check" && r.action !== "install") || (r.channel !== undefined && r.channel !== "stable" && r.channel !== "beta")) throw new Error("Invalid update request.");
    const status = updateStatus(this.managerRoot);
    if (!status?.managed || updateInProgress(status.phase)) throw new Error("An update is already in progress, or the manager is not ready.");
    requestUpdate(this.managerRoot, { action: r.action, ...(r.channel ? { channel: r.channel } : {}) });
  }
}
