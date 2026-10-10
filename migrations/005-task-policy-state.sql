ALTER TABLE workflow_tasks ADD COLUMN retry_backoff TEXT NOT NULL DEFAULT 'exponential';
ALTER TABLE workflow_tasks ADD COLUMN retry_initial_delay_ms INTEGER NOT NULL DEFAULT 250;
ALTER TABLE workflow_tasks ADD COLUMN retry_max_delay_ms INTEGER NOT NULL DEFAULT 60000;
PRAGMA user_version = 5;
