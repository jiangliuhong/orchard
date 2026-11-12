import { createReadStream, createWriteStream } from "node:fs";
import { MaintenanceBridgeClient } from "./maintenance-ipc-client.js";
import { MaintenanceMcpClient } from "./maintenance-mcp-client.js";
import { registerMaintenancePiTools, type MaintenancePiApi } from "./maintenance-pi-tools.js";

/** The launcher reserves fd 3 for the reader and fd 4/5 for MCP requests/results. */
export default function maintenancePiExtension(pi: MaintenancePiApi) {
  let started = false;
  pi.on("session_start", async () => {
    if (started) throw new Error("ORCHARD_MAINTENANCE_SESSION_ALREADY_STARTED");
    started = true;
    const reader = await MaintenanceBridgeClient.fromPrivateBootstrap(createReadStream("", { fd: 3 }), "reader");
    const mcp = new MaintenanceMcpClient(createReadStream("", { fd: 5 }), createWriteStream("", { fd: 4 }));
    try {
      await registerMaintenancePiTools(pi, { reader, mcp });
    } catch (error) {
      await Promise.allSettled([reader.close(), mcp.close()]);
      throw error;
    }
  });
}
