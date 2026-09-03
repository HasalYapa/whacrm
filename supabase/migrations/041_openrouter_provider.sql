-- ============================================================
-- 041_openrouter_provider.sql
--
-- Allow 'openrouter' as an AI provider (free-tier community models).
-- Migration 029 added CHECK constraints limiting `provider` to
-- ('openai', 'anthropic') on both `ai_configs` and `ai_usage_log`;
-- OpenRouter speaks the OpenAI Chat Completions dialect, so only the
-- allow-lists need widening. Idempotent: safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));
