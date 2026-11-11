import { configCoordinator } from "../config-git/coordinator.js";
import { check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { ProviderRegistry, type ProviderResult, type TurnRequest } from "../providers/registry.js";
import type { RuntimeSession, RuntimeTurnHost } from "./runtime.js";

/** Native, ephemeral Provider sessions for single scenarios. The scenario owns
 * authorization, task inputs, private project leases and result persistence.
 */
export class SingleProviderHost implements RuntimeTurnHost {
  constructor(
    private readonly providers: ProviderRegistry,
    readonly authorize: RuntimeTurnHost["authorize"],
    private readonly prepare: (
      input: Parameters<RuntimeTurnHost["withSession"]>[0],
    ) => Promise<{
      request: Omit<TurnRequest, "modelId" | "signal">;
      recordResult(result: ProviderResult): Promise<void>;
    }>,
  ) {}

  async withSession<T>(
    input: Parameters<RuntimeTurnHost["withSession"]>[0],
    action: (session: RuntimeSession) => Promise<T>,
  ): Promise<T> {
    const { conversation, turn, signal } = input;
    check(conversation.mode === "single" && !input.backend, "INVALID_STATE", "该宿主仅支持一次性原生会话", 409);
    return configCoordinator(this.providers.store).withActivity("SingleProviderHost.withSession", async () => {
      const effective = await this.providers.ready({ providerId: conversation.provider_id, modelId: turn.requested_model_id });
      const { request, recordResult } = await this.prepare(input);
      signal.throwIfAborted();
      const nativeRequest = { ...request, modelId: effective.modelId, signal };
      return this.providers.withSingleSession(effective.setting, nativeRequest, session => action({
        generation: session.generation,
        send: async ({ signal, accepted }) => {
          const result = await session.send({ ...nativeRequest, signal }, turn.id, async () => accepted());
          await session.close();
          signal.throwIfAborted();
          if (request.schema !== undefined) assertSchema(result.output, request.schema, "Agent 输出");
          await recordResult(result);
          return { actualModelId: result.modelId, modelSource: result.modelSource ?? "requested" };
        },
        stop: async () => {
          await session.close();
          return true;
        },
      }));
    });
  }
}
