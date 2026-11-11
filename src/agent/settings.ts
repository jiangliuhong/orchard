import { loadKnowledgeBundle } from "./knowledge-bundle.js";

/** Package contents, not an assertion that a Provider loaded them or that the
 * production Runtime has been activated. Never read arbitrary caller paths.
 */
export function agentKnowledgeSettings() {
  const bundle = loadKnowledgeBundle();
  return {
    hash: bundle.hash,
    bundleVersion: bundle.manifest.bundleVersion,
    contractVersion: bundle.manifest.contractVersion,
    toolPolicyVersion: bundle.manifest.toolPolicyVersion,
    profiles: bundle.manifest.profiles,
    runtime: { active: false, reason: "统一运行时尚未完成生产切换；此处展示安装包内置知识，不代表 Provider 已加载。" },
    files: [
      { path: "manifest.json", content: bundle.manifestText },
      ...bundle.manifest.files.map(file => ({ path: file.path, content: bundle.files[file.path]! })),
    ],
  };
}
export type AgentKnowledgeSettings = ReturnType<typeof agentKnowledgeSettings>;
