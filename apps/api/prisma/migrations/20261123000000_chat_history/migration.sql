-- CreateEnum
CREATE TYPE "ChatRecordStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED');

-- AlterTable
ALTER TABLE "chat_models" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "chat_histories" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "previous_history_id" UUID,
    "retry_of_history_id" UUID,
    "request_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "query" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "next_sequence" INTEGER NOT NULL DEFAULT 1,
    "context_used_tokens" BIGINT,
    "context_window_tokens" INTEGER,
    "context_window_source" VARCHAR(20) NOT NULL DEFAULT 'unknown',
    "status" "ChatRecordStatus" NOT NULL DEFAULT 'PENDING',
    "resources" JSONB NOT NULL DEFAULT '[]',
    "timings" JSONB NOT NULL DEFAULT '{}',
    "error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" BIGINT,
    "heartbeat_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "chat_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_replies" (
    "id" UUID NOT NULL,
    "history_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "content" TEXT,
    "finish_reason" VARCHAR(200),
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "input_tokens" BIGINT,
    "output_tokens" BIGINT,
    "status" "ChatRecordStatus" NOT NULL DEFAULT 'PENDING',
    "resources" JSONB NOT NULL DEFAULT '[]',
    "timings" JSONB NOT NULL DEFAULT '{}',
    "error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" BIGINT,

    CONSTRAINT "chat_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_tool_calls" (
    "id" UUID NOT NULL,
    "history_id" UUID NOT NULL,
    "reply_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "tool_call_id" VARCHAR(200) NOT NULL,
    "tool_name" VARCHAR(100) NOT NULL,
    "arguments_raw" TEXT NOT NULL,
    "arguments" JSONB,
    "output" JSONB,
    "status" "ChatRecordStatus" NOT NULL DEFAULT 'PENDING',
    "resources" JSONB NOT NULL DEFAULT '[]',
    "timings" JSONB NOT NULL DEFAULT '{}',
    "error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" BIGINT,

    CONSTRAINT "chat_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_histories_user_id_created_at_id_idx" ON "chat_histories"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "chat_histories_conversation_id_created_at_id_idx" ON "chat_histories"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "chat_histories_status_heartbeat_at_idx" ON "chat_histories"("status", "heartbeat_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_histories_user_id_request_id_key" ON "chat_histories"("user_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_replies_history_id_round_key" ON "chat_replies"("history_id", "round");

-- CreateIndex
CREATE UNIQUE INDEX "chat_replies_history_id_sequence_key" ON "chat_replies"("history_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "chat_replies_id_history_id_key" ON "chat_replies"("id", "history_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_tool_calls_reply_id_tool_call_id_key" ON "chat_tool_calls"("reply_id", "tool_call_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_tool_calls_history_id_sequence_key" ON "chat_tool_calls"("history_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "chat_models_id_user_id_key" ON "chat_models"("id", "user_id");

-- AddForeignKey
ALTER TABLE "chat_histories" ADD CONSTRAINT "chat_histories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_histories" ADD CONSTRAINT "chat_histories_model_id_user_id_fkey" FOREIGN KEY ("model_id", "user_id") REFERENCES "chat_models"("id", "user_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_histories" ADD CONSTRAINT "chat_histories_previous_history_id_fkey" FOREIGN KEY ("previous_history_id") REFERENCES "chat_histories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_histories" ADD CONSTRAINT "chat_histories_retry_of_history_id_fkey" FOREIGN KEY ("retry_of_history_id") REFERENCES "chat_histories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_replies" ADD CONSTRAINT "chat_replies_history_id_fkey" FOREIGN KEY ("history_id") REFERENCES "chat_histories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_tool_calls" ADD CONSTRAINT "chat_tool_calls_history_id_fkey" FOREIGN KEY ("history_id") REFERENCES "chat_histories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_tool_calls" ADD CONSTRAINT "chat_tool_calls_reply_id_history_id_fkey" FOREIGN KEY ("reply_id", "history_id") REFERENCES "chat_replies"("id", "history_id") ON DELETE CASCADE ON UPDATE CASCADE;
