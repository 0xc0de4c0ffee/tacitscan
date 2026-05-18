-- Resolve `image_uri` (which may be either a direct image or metadata JSON
-- with an inner `image` field, NFT-style) into a final HTTPS URL once,
-- per asset, so the frontend doesn't fetch IPFS on every render.

ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "resolved_image_url" text;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "image_resolved_at" timestamptz;
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "image_resolve_error" text;

-- Resolver picks rows that have an image_uri but haven't been attempted yet.
CREATE INDEX IF NOT EXISTS "assets_unresolved_idx"
  ON "assets" ("etch_height")
  WHERE image_uri IS NOT NULL AND image_resolved_at IS NULL;
