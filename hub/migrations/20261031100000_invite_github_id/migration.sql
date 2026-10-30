-- Invites resolve the login to the numeric GitHub id at invite time, so a renamed account cannot claim someone else's invite.
-- Rows created before this column exist with NULL and still match by login (legacy).
ALTER TABLE invite ADD COLUMN github_id INTEGER;
