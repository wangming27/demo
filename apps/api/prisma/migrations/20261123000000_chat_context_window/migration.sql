ALTER TABLE "chat_models" ADD COLUMN "context_window" INTEGER;
ALTER TABLE "chat_models" ADD CONSTRAINT "chat_models_context_window_check"
  CHECK ("context_window" IS NULL OR "context_window" > 0);
