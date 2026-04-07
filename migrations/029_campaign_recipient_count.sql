-- Add recipient_count to b2b_campaigns to store how many members were targeted when activated
ALTER TABLE gold.b2b_campaigns
  ADD COLUMN IF NOT EXISTS recipient_count INTEGER;
