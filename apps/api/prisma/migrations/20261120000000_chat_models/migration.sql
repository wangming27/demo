CREATE TABLE "chat_models" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "base_url" VARCHAR(2048) NOT NULL,
    "api_key" VARCHAR(4096) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "chat_models_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_models_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "chat_models_user_id_created_at_id_idx" ON "chat_models"("user_id", "created_at", "id");
