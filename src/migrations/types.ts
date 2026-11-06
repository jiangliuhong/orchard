export type State = 'checking' | 'initializing' | 'ready' | 'migration_required' | 'migrating' | 'verifying' | 'installing' | 'restoring' | 'failed' | 'recovery_required' | 'initialization_failed' | 'blocked';
export type Phase = 'accepted' | 'backing_up' | 'backup_complete' | 'transforming' | 'verifying' | 'prepared' | 'installing' | 'installed' | 'committed' | 'failed' | 'restoring' | 'restored' | 'recovery_required';
export interface PublicError { code: string; message: string; retryable: boolean; nextAction: string; fieldErrors?: Record<string, string> }
export interface Question { key: string; type: 'string' | 'secret' | 'boolean' | 'enum' | 'integer'; label: string; description: string; required?: boolean; default?: string | boolean | number; min?: number; max?: number; pattern?: string; options?: { value: string; label: string }[]; when?: { key: string; equals: string | number | boolean } }
export interface MigrationDeclaration extends Step {kind:'database'|'configuration';from:number;to:number;requires:string[];questions:Question[]}
export interface Step { id: string; checksum: string; summary: string; affectedResources: string[] }
export interface Plan { status: 'ready' | 'needs_input' | 'blocked'; planHash: string; basePlanHash?:string; sourceFingerprint: string; sourceVersions: { database: number; webBridge: number | null }; targetVersions: { database: number; webBridge: number }; steps: Step[]; resources: string[]; questions: Question[]; estimates: { bytes: number; requiredBytes: number }; blockers: PublicError[] }
export interface Status { state: State; ready: boolean; revision: number; activeJobId?: string; initializationAttemptId?: string; actions?: string[]; error?: PublicError; dataDir?: string }
export interface Submission { requestId: string; planHash: string; confirmationHash: string; answers: Record<string, unknown> }
export interface FileRecord { path: string; type: 'file' | 'directory'; mode: number; size: number; hash: string }
export interface Snapshot { formatVersion: 1; files: FileRecord[]; missing: string[]; fingerprint: string }
export interface InstallItem { path: string; before: string | null; target: string; installed?: boolean; restored?: boolean }
export interface Job { formatVersion: 1; jobId: string; attemptOf?: string; requestId: string; requestScope: string; inputHmac: string; plan: Plan; phase: Phase; revision: number; startedAt: string; updatedAt: string; steps: { id: string; state: string }[]; processed: number; install: InstallItem[]; ledgerBefore: unknown; error?: PublicError; result?: { committed: boolean; ready: boolean; backup: string; bytes: number } }
export interface Ledger { formatVersion: 1; baseline: { database: number; webBridge: number | null; applicationId: number; source: string }; completed: { jobId: string; migrations: Step[]; source: Plan['sourceVersions']; target: Plan['targetVersions'] }[] }
export const resourceRoots = ['workbench.db', 'config', 'artifacts', 'runs', 'script-agent', 'agent-sessions', 'agent-workspaces'] as const;
export class MigrationError extends Error {
  constructor(readonly code: string, readonly nextAction = '重新检查数据后重试') { super(code); }
}
const messages: Record<string, string> = {
  MIGRATION_PACKAGE_CHANGED:'迁移程序与锁定发布内容不一致，请恢复完整构建包后重启。', INVALID_ANSWERS: '填写的信息不符合要求，请检查标记字段。', IO_ERROR: '无法读写数据目录，请检查权限与磁盘状态。', CHAIN_UNSUPPORTED: '迁移链缺失或依赖不匹配。',
  OLD_DATA_DIRECTORY: '发现旧产品数据，无法自动导入。', MIXED_DATA_DIRECTORY: '旧数据库与工作台数据库并存。', INCOMPLETE_DATA_DIRECTORY: '目录中存在无法归属的数据，不能创建新工作台。', UNKNOWN_DATABASE: '数据库身份或版本无法识别。', DATABASE_CORRUPT: '数据库完整性校验失败。', SCHEMA_MISMATCH: '数据库结构与登记版本不匹配。', DATA_VERSION_TOO_NEW: '数据版本高于本程序支持范围。', SOURCE_CHANGED: '数据已被外部修改，请重新预览。', PLAN_STALE: '数据或计划已变化，请重新预览并确认。', INSTANCE_LOCKED: '此数据目录已有实例，或无法证明锁的所有权。', RECOVERY_CONFLICT: '检测到未知正式内容，自动恢复已暂停。', BACKUP_CORRUPT: '备份校验失败，无法安全恢复。', UNKNOWN_PROTOCOL: '迁移记录协议无法识别。', INSUFFICIENT_SPACE: '磁盘空间不足。', CONFIRMATION_EXPIRED: '确认已失效，请重新验证。', MIGRATION_BUSY: '已有迁移任务正在执行。', INITIALIZATION_FAILED: '业务初始化失败，请重试初始化。', INVALID_REQUEST: '请求字段或类型无效。', REQUEST_CONFLICT: '相同请求标识已用于不同内容。', INVALID_STATE: '当前状态不允许此操作。', PRIVATE_KEY_MISSING: '迁移请求密钥缺失，不能接受新写操作。', MIGRATION_FAILED: '迁移失败，查看恢复状态后重试。', INVALID_PATH: '受控资源包含链接、特殊文件或越界路径。', LEDGER_MISMATCH: '迁移账本与当前数据不一致。', SCHEMA_REVIEW_REQUIRED: '迁移缺少有效审核记录。', UNAUTHORIZED: '启动会话已失效。', INVALID_ORIGIN: '来源与本服务不一致。', INVALID_HOST: '无效的本地服务地址。', NOT_FOUND: '任务或接口不存在。'
};
export function publicError(error: unknown): PublicError {
  const rawCode=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  const code = error instanceof MigrationError ? error.code : rawCode.startsWith('CONFIG_')?rawCode:rawCode==='ENOSPC'?'INSUFFICIENT_SPACE':['EACCES','EPERM','EROFS','EIO'].includes(rawCode)?'IO_ERROR':'MIGRATION_FAILED';
  const details=error&&typeof error==='object'?error as {fieldErrors?:Record<string,string>;path?:string;public?:PublicError}:undefined;
  const fieldErrors=details?.fieldErrors??details?.public?.fieldErrors??(code.startsWith('CONFIG_')&&details?.path?{[details.path]:'字段格式无效'}:undefined);
  return { ...(fieldErrors?{fieldErrors}:{}), code, message: messages[code] ?? (code.startsWith('CONFIG_') ? '配置格式无效，请检查对应字段。' : messages.MIGRATION_FAILED), retryable: !['MIGRATION_PACKAGE_CHANGED','UNKNOWN_PROTOCOL','DATA_VERSION_TOO_NEW','OLD_DATA_DIRECTORY','UNKNOWN_DATABASE','SCHEMA_MISMATCH'].includes(code), nextAction: error instanceof MigrationError ? error.nextAction : '查看诊断报告后重试' };
}
