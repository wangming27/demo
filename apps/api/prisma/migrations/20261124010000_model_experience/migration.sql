CREATE TABLE "research_experiences" (
  "id" UUID PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "topic" VARCHAR(80) NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "content" JSONB NOT NULL,
  UNIQUE ("user_id", "topic")
);
CREATE TABLE "research_experience_revisions" (
  "id" UUID PRIMARY KEY,
  "experience_id" UUID NOT NULL REFERENCES "research_experiences"("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "history_id" UUID REFERENCES "chat_histories"("id") ON DELETE SET NULL,
  "feedback" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("experience_id", "version")
);
