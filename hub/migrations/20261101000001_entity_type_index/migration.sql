-- Webhook relay: which spaces share a repository, looked up by json_extract(data, '$.githubId') among live `repo` entities. Without this the lookup scans the table.
CREATE INDEX entity_repo_github ON entity (json_extract(data, '$.githubId')) WHERE type = 'repo' AND deleted = 0;
