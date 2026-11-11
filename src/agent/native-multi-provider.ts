import { isAbsolute, join, relative } from "node:path";
import type { BackendRef, ProviderSetting } from "../domain/types.js";
import { check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { connectionFingerprint, type SessionProvider } from "../providers/session.js";
import { ManagedSessionStore } from "../providers/managed-session-store.js";
import type { ProviderResult, TurnRequest } from "../providers/registry.js";
import type { MultiProvider } from "./multi-provider-host.js";
import type { ProviderSessionReference, ReferenceValidator } from "./provider-contract.js";

interface NativeReferenceCodec extends ReferenceValidator {
  encode(reference: BackendRef, storage: ManagedSessionStore): ProviderSessionReference;
  decode(reference: ProviderSessionReference, storage: ManagedSessionStore, cwd: string): BackendRef;
}

type OpenContext = Parameters<MultiProvider["open"]>[0];

/** Adapt a native transport to the maintenance Runtime. Capability evidence and
 * scenario-specific tool and proposal handling are supplied by the host.
 */
export function nativeMultiProvider(options: {
  report: MultiProvider["report"];
  installedVersion: string;
  setting: ProviderSetting;
  provider: SessionProvider;
  storage: ManagedSessionStore;
  codec: NativeReferenceCodec;
  prepare(context: OpenContext): Promise<{
    request: Pick<TurnRequest, "prompt" | "schema" | "timeoutMs" | "emit">;
    proposal(result: ProviderResult): Promise<{ proposalRef?: string; baseRevision?: string }>;
  }>;
}): MultiProvider {
  return {
    installedVersion: options.installedVersion,
    report: options.report,
    validator: options.codec,
    async open(context, workspace, resume) {
      const { turn, signal } = context;
      const { request, proposal } = await options.prepare(context);
      const cwd = workspace.cwd;
      options.storage.assert();
      signal.throwIfAborted();
      const resumeRef = resume && options.codec.decode(resume, options.storage, cwd);
      const handle = await options.provider.openSession(options.setting, {
        key: context.conversation.id,
        modelId: turn.requested_model_id,
        cwd,
        persistent: true,
        signal,
        resumeRef,
        managedStorageRoot: options.storage.root,
      });
      try {
        check(handle.ref, "BACKEND_REFERENCE_INVALID", "Provider 未返回持久原生引用", 409);
        const reference = options.codec.encode(handle.ref, options.storage);
        return {
          reference,
          fingerprint: connectionFingerprint(options.setting),
          async send({ signal, accepted }) {
            const result = await options.provider.sendTurn(handle, {
              ...request, signal, cwd,
              modelId: turn.requested_model_id,
              hostTurnId: turn.id,
              onAccepted: async () => accepted(),
            });
            signal.throwIfAborted();
            if (request.schema !== undefined) assertSchema(result.output, request.schema, "Agent 输出");
            return {
              ...await proposal(result),
              actualModelId: result.modelId,
              modelSource: result.modelSource ?? "requested",
            };
          },
          close: () => options.provider.releaseSession(handle),
        };
      } catch (error) {
        await options.provider.releaseSession(handle);
        throw error;
      }
    },
  };
}

export function piReferenceCodec(storage: ManagedSessionStore): NativeReferenceCodec {
  const providerId = storage.providerId;
  const payload = (value: ProviderSessionReference["opaque"]) => {
    check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 4 &&
      typeof value.file === "string" && value.file.length > 0 && value.file.endsWith(".jsonl") && !value.file.includes("\\") &&
      !isAbsolute(value.file) && !value.file.split("/").some(part => !part || part === "." || part === "..") &&
      typeof value.sessionId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.sessionId) &&
      typeof value.cwd === "string" && isAbsolute(value.cwd) && typeof value.storeId === "string",
    "BACKEND_REFERENCE_INVALID", "Pi 原生引用无效", 409);
    storage.assert(value.storeId);
    return value as { file: string; sessionId: string; cwd: string; storeId: string };
  };
  return {
    providerId, supportedVersions: [1],
    validatePayload(value) { payload(value); },
    encode(reference) {
      check(reference.kind === "pi", "BACKEND_PROVIDER_MISMATCH", "需要 Pi 会话引用", 409);
      const opaque = { file: relative(storage.root, reference.sessionFile), sessionId: reference.sessionId, cwd: reference.cwd, storeId: storage.id };
      payload(opaque);
      return { providerId, version: 1, opaque };
    },
    decode(reference, _storage, cwd) {
      const value = payload(reference.opaque);
      check(value.cwd === cwd, "BACKEND_BINDING_CONFLICT", "Pi 引用不属于此工作区", 409);
      return { version: 1, kind: "pi", sessionId: value.sessionId, sessionFile: join(storage.root, value.file), cwd };
    },
  };
}

export function codexReferenceCodec(storage: ManagedSessionStore): NativeReferenceCodec {
  const providerId = storage.providerId;
  return {
    providerId,
    supportedVersions: [1],
    validatePayload(value) {
      check(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 3 &&
        typeof value.threadId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.threadId) &&
        value.storageHome === storage.root && typeof value.storeId === "string",
      "BACKEND_REFERENCE_INVALID", "Codex 原生引用无效", 409);
      storage.assert(value.storeId);
    },
    encode(reference) {
      check(reference.kind === "codex", "BACKEND_PROVIDER_MISMATCH", "需要 Codex 会话引用", 409);
      return { providerId, version: 1, opaque: { threadId: reference.threadId, storageHome: storage.root, storeId: storage.id } };
    },
    decode(reference, _storage, cwd) {
      const { threadId } = reference.opaque as { threadId: string };
      return { version: 1, kind: "codex", threadId, cwd };
    },
  };
}
