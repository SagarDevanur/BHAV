-- =============================================================
-- BHAV Acquisition Corp — initial schema
-- Apply via: supabase db push
-- =============================================================

-- UUID generation
create extension if not exists "pgcrypto";

-- =============================================================
-- Shared trigger function: keep updated_at current on every row update
-- =============================================================
create or replace function update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================
-- companies
-- =============================================================
create table if not exists companies (
  id                  uuid        primary key default gen_random_uuid(),
  name                text        not null,
  website             text,
  sector              text,
  sub_sector          text,
  blurb               text,
  last_round          text,
  estimated_valuation text,
  despac_score        integer     check (despac_score >= 0 and despac_score <= 100),
  status              text        not null default 'sourced'
                                  check (status in (
                                    'sourced','scoring','reviewed',
                                    'approved','rejected','loi_sent'
                                  )),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists companies_status_idx      on companies(status);
create index if not exists companies_sector_idx      on companies(sector);
create index if not exists companies_despac_score_idx on companies(despac_score desc);

create trigger companies_updated_at
  before update on companies
  for each row execute function update_updated_at_column();

alter table companies enable row level security;

-- Service role (used by agents and admin API routes) has full access.
-- The anon/authenticated keys are intentionally denied — all dashboard
-- reads go through API routes that use the service role client.
create policy "service role full access" on companies
  for all
  to service_role
  using (true)
  with check (true);

-- =============================================================
-- contacts
-- =============================================================
create table if not exists contacts (
  id           uuid        primary key default gen_random_uuid(),
  company_id   uuid        references companies(id) on delete cascade,
  name         text,
  title        text,
  email        text,
  linkedin_url text,
  phone        text,
  enriched_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists contacts_company_id_idx on contacts(company_id);
create index if not exists contacts_email_idx      on contacts(email);

alter table contacts enable row level security;

create policy "service role full access" on contacts
  for all
  to service_role
  using (true)
  with check (true);

-- =============================================================
-- agent_tasks
-- =============================================================
create table if not exists agent_tasks (
  id           uuid        primary key default gen_random_uuid(),
  agent_name   text        not null,
  status       text        not null default 'queued'
                           check (status in ('queued','running','completed','failed')),
  input        jsonb       not null default '{}',
  output       jsonb,
  error        text,
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists agent_tasks_status_idx     on agent_tasks(status);
create index if not exists agent_tasks_agent_name_idx on agent_tasks(agent_name);
create index if not exists agent_tasks_created_at_idx on agent_tasks(created_at desc);

alter table agent_tasks enable row level security;

create policy "service role full access" on agent_tasks
  for all
  to service_role
  using (true)
  with check (true);

-- =============================================================
-- agent_results
-- =============================================================
create table if not exists agent_results (
  id          uuid        primary key default gen_random_uuid(),
  task_id     uuid        references agent_tasks(id) on delete cascade,
  company_id  uuid        references companies(id) on delete set null,
  agent_name  text        not null,
  result_type text        not null
                          check (result_type in (
                            'score','contact','loi_draft',
                            'outreach_email','sec_draft','narrative'
                          )),
  content     jsonb       not null default '{}',
  created_at  timestamptz not null default now()
);

create index if not exists agent_results_company_id_idx  on agent_results(company_id);
create index if not exists agent_results_task_id_idx     on agent_results(task_id);
create index if not exists agent_results_result_type_idx on agent_results(result_type);

alter table agent_results enable row level security;

create policy "service role full access" on agent_results
  for all
  to service_role
  using (true)
  with check (true);

-- =============================================================
-- deal_pipeline
-- =============================================================
create table if not exists deal_pipeline (
  id           uuid        primary key default gen_random_uuid(),
  company_id   uuid        unique references companies(id) on delete cascade,
  stage        text        not null default 'sourced'
                           check (stage in (
                             'sourced','scored','loi',
                             'diligence','pipe','announced'
                           )),
  despac_score integer     check (despac_score >= 0 and despac_score <= 100),
  approved_by  text,
  notes        text,
  updated_at   timestamptz not null default now()
);

create index if not exists deal_pipeline_company_id_idx on deal_pipeline(company_id);
create index if not exists deal_pipeline_stage_idx      on deal_pipeline(stage);

create trigger deal_pipeline_updated_at
  before update on deal_pipeline
  for each row execute function update_updated_at_column();

alter table deal_pipeline enable row level security;

create policy "service role full access" on deal_pipeline
  for all
  to service_role
  using (true)
  with check (true);
