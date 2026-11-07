
CREATE TABLE agent_conversations_v7 (
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES drafts(id),
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native')),
 status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),
 model_id TEXT NOT NULL,
 transport TEXT NOT NULL CHECK(transport = 'native'),
 connection_fingerprint TEXT NOT NULL,
 cli_version TEXT,
 backend_ref_json TEXT,
 backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),
 synced_revision INTEGER CHECK(synced_revision >= 0),
 rebuild_from_id TEXT REFERENCES agent_conversations_v7(id),
 title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),
 archived_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 last_used_at INTEGER,
 CHECK (
  (mode='single' AND context_mode='isolated')
  OR (mode='multi' AND context_mode='native')
 ),
 CHECK (status != 'archived' OR archived_at IS NOT NULL)
);
INSERT INTO agent_conversations_v7
 SELECT id,draft_id,mode,
   CASE mode WHEN 'single' THEN 'isolated' ELSE 'native' END,
   CASE WHEN transport='legacy' AND mode='multi' AND status!='archived'
     THEN 'needs_rebuild' ELSE status END,
   provider_id,provider_revision,model_id,'native',
   CASE WHEN transport='legacy' THEN '' ELSE connection_fingerprint END,
   cli_version,
   CASE WHEN transport='legacy' THEN NULL ELSE backend_ref_json END,
   backend_generation + CASE WHEN transport='legacy' THEN 1 ELSE 0 END,
   CASE WHEN transport='legacy' THEN NULL ELSE synced_revision END,
   rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at
 FROM agent_conversations;
DROP TABLE agent_conversations;
ALTER TABLE agent_conversations_v7 RENAME TO agent_conversations;
CREATE UNIQUE INDEX one_current_conversation
 ON agent_conversations(draft_id) WHERE status='current';
CREATE INDEX conversations_by_draft
 ON agent_conversations(draft_id,created_at,id);
CREATE INDEX conversations_by_activity
 ON agent_conversations(draft_id,updated_at DESC,id);
UPDATE provider_settings
 SET config_json=json_set(config_json,'$.transport','native'),
     revision=revision+1
 WHERE id IN ('codex-cli','pi-cli')
   AND (json_extract(config_json,'$.transport') IS NULL
     OR json_extract(config_json,'$.transport')!='native');
PRAGMA user_version = 7;
