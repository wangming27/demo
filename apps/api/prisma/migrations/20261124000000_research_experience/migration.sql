CREATE TABLE "research_experience_usages" (
  "id" UUID PRIMARY KEY,
  "history_id" UUID NOT NULL REFERENCES "chat_histories"("id") ON DELETE CASCADE,
  "parent_call_id" VARCHAR(200) NOT NULL,
  "task" TEXT NOT NULL,
  "experience_id" VARCHAR(100) NOT NULL,
  "version" INTEGER NOT NULL,
  "source_id" VARCHAR(100) NOT NULL,
  "query" JSONB NOT NULL,
  "technical" JSONB,
  "evidence_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "findings" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "research_experience_usages_history_id_idx" ON "research_experience_usages"("history_id");
CREATE INDEX "research_experience_usages_experience_id_version_source_id_created_at_idx" ON "research_experience_usages"("experience_id", "version", "source_id", "created_at");
CREATE TABLE "research_experience_feedback" (
  "id" UUID PRIMARY KEY,
  "usage_id" UUID NOT NULL REFERENCES "research_experience_usages"("id") ON DELETE CASCADE,
  "actor" VARCHAR(20) NOT NULL,
  "outcome" VARCHAR(30) NOT NULL,
  "reason_code" VARCHAR(80) NOT NULL,
  "explanation" VARCHAR(1000) NOT NULL,
  "evidence_url" VARCHAR(2048),
  "updated_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE UNIQUE INDEX "research_experience_feedback_usage_id_actor_key" ON "research_experience_feedback"("usage_id", "actor");
