import { check } from "../domain/errors.js";
import { canonicalJson } from "../persistence/files.js";
import type { KnowledgeProfile } from "./knowledge-bundle.js";
import type { KnowledgeService, KnowledgeWorkspaceLease } from "./knowledge-service.js";
import { multiCapabilityBlockers, validateSessionReference, type ProviderCapabilityReport, type ProviderSessionReference, type ReferenceValidator } from "./provider-contract.js";
import type { RuntimeSession, RuntimeTurnHost } from "./runtime.js";

type TurnContext = Parameters<RuntimeTurnHost["withSession"]>[0];

export interface MultiProviderSession {
  reference: ProviderSessionReference;
  fingerprint: string;
  send: RuntimeSession["send"];
  /** Wait for verified process exit before releasing the workspace lease. */
  close(): Promise<void>;
}

export interface MultiProvider {
  installedVersion: string;
  report: ProviderCapabilityReport;
  validator: ReferenceValidator;
  open(context: TurnContext, workspace: KnowledgeWorkspaceLease, resume?: ProviderSessionReference): Promise<MultiProviderSession>;
}

/** Runs a maintenance turn against the exact native session under a shared knowledge lease. */
export class MultiProviderHost implements RuntimeTurnHost {
  constructor(
    private readonly knowledge: Pick<KnowledgeService, "withWorkspace">,
    readonly authorize: RuntimeTurnHost["authorize"],
    private readonly profileFor: (scenario: string) => KnowledgeProfile,
    private readonly resolveProvider: (context: TurnContext) => Promise<MultiProvider>,
  ) {}

  async withSession<T>(context: TurnContext, action: (session: RuntimeSession) => Promise<T>): Promise<T> {
    const { conversation, signal, backend } = context;
    check(conversation.mode === "multi" && conversation.knowledge_hash, "INVALID_STATE", "维护会话缺少固定知识版本", 409);
    return this.knowledge.withWorkspace(this.profileFor(conversation.scenario), conversation.knowledge_hash, signal, async workspace => {
      check(workspace.contractVersion === conversation.contract_version && workspace.toolPolicyVersion === conversation.tool_policy_version,
        "KNOWLEDGE_UNAVAILABLE", "会话与工作区契约版本不一致", 409);
      const provider = await this.resolveProvider(context);
      check(provider.report.providerId === conversation.provider_id && provider.validator.providerId === conversation.provider_id,
        "BACKEND_PROVIDER_MISMATCH", "原生适配器与对话 Provider 不一致", 409);
      const blockers = multiCapabilityBlockers(provider.report, provider.installedVersion);
      check(!blockers.length, "MULTI_CAPABILITY_UNAVAILABLE", `Provider 多轮能力未通过验证：${blockers.join(", ")}`, 503);
      const resume = backend ? validateSessionReference(JSON.parse(backend.reference_json), provider.validator) : undefined;
      const generation = (backend?.generation ?? 0) + 1;
      check(Number.isSafeInteger(generation), "BACKEND_BINDING_CONFLICT", "无法分配原生连接代次", 409);
      signal.throwIfAborted();
      const session = await provider.open(context, workspace, resume);
      let closing: Promise<void> | undefined;
      const close = () => closing ??= Promise.resolve().then(() => session.close());
      try {
        const reference = validateSessionReference(session.reference, provider.validator);
        check(!resume || canonicalJson(reference) === canonicalJson(resume),
          "BACKEND_BINDING_CONFLICT", "原生恢复返回了不同的会话引用", 409);
        return await action({
          generation,
          binding: { reference, fingerprint: session.fingerprint, validator: provider.validator },
          async send(request) {
            const result = await session.send(request);
            await close();
            return result;
          },
          async stop() {
            await close();
            return true;
          },
        });
      } finally {
        await close();
      }
    });
  }
}
