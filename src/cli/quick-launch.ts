import { randomUUID } from "node:crypto";
import { check } from "../domain/errors.js";
import { agentClient } from "../external-agent/client.js";
import { cardId, type Channel } from "../external-agent/policy.js";

const idPattern = new RegExp(cardId.pattern);

export function quickLaunchCommands(root: string, port: number, channel: Channel) {
  const client = agentClient(root, port, channel);
  return {
    async list(autoStart = true) {
      return { items: await client.list(autoStart) };
    },
    run(id: string, revision: number, requestId: string = randomUUID()) {
      check(idPattern.test(id), "INVALID_ID", "请提供有效的标识");
      check(Number.isSafeInteger(revision) && revision > 0, "INVALID_REVISION", "请提供卡片版本");
      return client.run(id, revision, requestId);
    },
    status(id: string, autoStart = true) {
      check(idPattern.test(id), "INVALID_ID", "请提供有效的标识");
      return client.status(id, autoStart);
    },
  };
}

export type QuickLaunchCommands = ReturnType<typeof quickLaunchCommands>;
