-- =============================================================
-- Migration 002: add 'sourcing' to agent_results.result_type
--
-- The inline CHECK constraint created in 001 did not include the
-- 'sourcing' result_type needed by the Sourcing agent.
-- PostgreSQL does not support ALTER CONSTRAINT — we must drop and
-- recreate the constraint.
-- =============================================================

ALTER TABLE agent_results
  DROP CONSTRAINT IF EXISTS agent_results_result_type_check;

ALTER TABLE agent_results
  ADD CONSTRAINT agent_results_result_type_check
  CHECK (result_type IN (
    'score',
    'contact',
    'loi_draft',
    'outreach_email',
    'sec_draft',
    'narrative',
    'sourcing'
  ));
