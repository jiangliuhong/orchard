
CREATE TABLE agent_model_configs (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 100),
 description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision > 0),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX agent_model_configs_by_provider ON agent_model_configs(provider_id);
CREATE TABLE agent_model_config_revisions (
 config_id TEXT NOT NULL REFERENCES agent_model_configs(id),
 revision INTEGER NOT NULL CHECK(revision > 0),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 description TEXT NOT NULL CHECK(length(description) <= 2000),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(config_id,revision)
);
CREATE TABLE run_agent_bindings (
 run_id TEXT NOT NULL, node_id TEXT NOT NULL,
 config_id TEXT NOT NULL, config_revision INTEGER NOT NULL CHECK(config_revision > 0),
 provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,node_id),
 FOREIGN KEY(run_id,node_id) REFERENCES node_runs(run_id,node_id) ON DELETE CASCADE,
 FOREIGN KEY(config_id,config_revision) REFERENCES agent_model_config_revisions(config_id,revision)
);
CREATE INDEX run_agent_bindings_by_config ON run_agent_bindings(config_id,config_revision);
 PRAGMA user_version = 8;