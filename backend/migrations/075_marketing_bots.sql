-- Automated visits (link previews, search engines, scanners, headless
-- browsers) are kept apart from real shoppers in the Marketing reports.
ALTER TABLE marketing_opens ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false;
-- Earlier opens that look automated: a Linux computer (not Android) with a
-- server clock (UTC) or no time zone at all.
UPDATE marketing_opens SET is_bot = true
 WHERE os = 'Linux' AND device_type = 'computer'
   AND (timezone IS NULL OR timezone = '' OR timezone IN ('UTC', 'GMT', 'Etc/UTC', 'Etc/GMT', 'Universal', 'Zulu') OR timezone LIKE 'Etc/%');
CREATE INDEX IF NOT EXISTS idx_mk_opens_human ON marketing_opens(created_at DESC) WHERE NOT is_bot;
