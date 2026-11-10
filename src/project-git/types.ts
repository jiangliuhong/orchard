export const PROJECT_RISK_VERSION = 1;
export interface GitProject {
  id: string; name: string; remoteUrl: string; branch: string; sshProfileId: string;
  enabled: boolean; revision: number; acceptedRiskVersion?: number;
}
export interface SshProfile {
  id: string; name: string; host: string; port: number; user: string;
  identityFile: string; knownHostsFile: string; useAgent: boolean; revision: number;
}
export interface ProjectBinding { project: GitProject; profile: SshProfile }
export interface ProjectSource {
  projectId: string; projectName: string; revision: number; branch: string; sha: string;
  preparationMs: number; toolPolicyVersion: number; unexpanded: { symlinks: number; submodules: number; lfs: number } | null;
}
export interface ProjectOperation {
  id: string; projectId: string; status: "running" | "completed" | "failed";
  phase: string; branches?: string[]; error?: { code: string; message: string }; startedAt: number; completedAt?: number;
}
