import { API_SUPPORT, CAPABILITIES, CONTROL_VERSION, type BackendState, type ControlHandshake, updateInProgress } from "@shahi/shared";
import { requestUpdate, updateStatus, type UpdateRequest } from "../../plugin/releases/storage";
import { buildId } from "./build";

export class ComputerControl {
  constructor(private serverId: string, private backend: () => BackendState, private managerRoot = process.env.SHAHI_MANAGER_ROOT) {}
  handshake(): ControlHandshake {
    const update = this.managerRoot ? updateStatus(this.managerRoot) : null;
    return {
      control: CONTROL_VERSION, serverId: this.serverId, buildId,
      api: { min: API_SUPPORT.min, max: API_SUPPORT.max },
      capabilities: CAPABILITIES.filter(c => c !== "computer-updates" || !!update?.managed),
      backend: this.backend(),
      update: update ?? { managed: false, channel: "stable", phase: "idle", current: buildId ?? "development", message: "Install the managed Shahi service on this computer to enable app updates." },
    };
  }
  request(value: unknown) {
    if (!this.managerRoot) throw new Error("This computer needs the managed Shahi installer first.");
    const r = value as Partial<UpdateRequest> | null;
    if (!r || (r.action !== "check" && r.action !== "install") || (r.channel !== undefined && r.channel !== "stable" && r.channel !== "beta")) throw new Error("Invalid update request.");
    const status = updateStatus(this.managerRoot);
    if (!status?.managed || updateInProgress(status.phase)) throw new Error("An update is already in progress, or the manager is not ready.");
    requestUpdate(this.managerRoot, { action: r.action, ...(r.channel ? { channel: r.channel } : {}) });
  }
}
