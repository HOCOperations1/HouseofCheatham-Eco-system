-- ===================================================================
-- HOC-OES COMPLETE SETUP (v1 + v2 combined)
-- Run this ONCE in the Supabase SQL Editor.
-- Safe to re-run — all statements use "if not exists" / "on conflict".
-- ===================================================================

-- -------------------------------------------------------------------
-- STEP 1: Drop any partial v2 tables from previous failed attempts.
-- Safe even if they don't exist.
-- DOES NOT touch hoc_schedule or hoc_batches (real production data).
-- -------------------------------------------------------------------
drop table if exists public.hoc_qc_tests cascade;
drop table if exists public.hoc_qc_specs cascade;
drop table if exists public.hoc_events cascade;
drop table if exists public.hoc_event_config cascade;


-- ===================================================================
-- V1 TABLES (schedule broadcast + floor updates)
-- ===================================================================

-- -------------------------------------------------------------------
-- hoc_schedule: master schedule broadcast (one row, id=1).
-- Written by Data Upload Hub when someone pastes the schedule.
-- Read by every dashboard every 30 seconds.
-- -------------------------------------------------------------------
create table if not exists hoc_schedule (
  id          int primary key default 1,
  data        text,
  updated_at  timestamptz default now()
);
alter table hoc_schedule enable row level security;
drop policy if exists "anon all" on hoc_schedule;
create policy "anon all" on hoc_schedule
  for all to anon using (true) with check (true);

-- -------------------------------------------------------------------
-- hoc_batches: floor updates keyed by batch_id.
-- Each row carries floor-level state (status, actqty, qc_status, etc).
-- Written by Compound Coordinator, Production Supervisor, Quality Lab.
-- -------------------------------------------------------------------
create table if not exists hoc_batches (
  batch_id    text primary key,
  data        text,
  updated_at  timestamptz default now()
);
alter table hoc_batches enable row level security;
drop policy if exists "anon all" on hoc_batches;
create policy "anon all" on hoc_batches
  for all to anon using (true) with check (true);


-- ===================================================================
-- V2 TABLES (Quality Lab + Event Engine)
-- ===================================================================

-- -------------------------------------------------------------------
-- hoc_qc_tests: append-only chronological log of every QC test.
-- Retests create new rows; nothing is overwritten.
-- -------------------------------------------------------------------
create table if not exists hoc_qc_tests (
  id              bigserial primary key,
  batch_id        text not null,
  item_id         text,
  description     text,
  ph              numeric,
  viscosity       numeric,
  density_top     numeric,
  density_bottom  numeric,
  density_avg     numeric,
  color_pass      boolean,
  texture_pass    boolean,
  consistency_pass boolean,
  smell_pass      boolean,
  disposition     text check (disposition in ('RELEASED','HOLD','REJECTED')),
  hold_reason     text,
  reject_reason   text,
  tested_by       text,
  tested_at       timestamptz default now(),
  notes           text,
  spec_check      jsonb,
  retest_of       bigint
);
create index if not exists idx_qc_tests_batch on hoc_qc_tests(batch_id);
create index if not exists idx_qc_tests_at    on hoc_qc_tests(tested_at desc);

alter table hoc_qc_tests enable row level security;
drop policy if exists "anon all" on hoc_qc_tests;
create policy "anon all" on hoc_qc_tests
  for all to anon using (true) with check (true);

-- -------------------------------------------------------------------
-- hoc_qc_specs: per-formula pH/viscosity/density min-max ranges.
-- -------------------------------------------------------------------
create table if not exists hoc_qc_specs (
  item_id         text primary key,
  description     text,
  ph_min          numeric,
  ph_max          numeric,
  viscosity_min   numeric,
  viscosity_max   numeric,
  density_min     numeric,
  density_max     numeric,
  visual_notes    text,
  updated_at      timestamptz default now(),
  updated_by      text
);

alter table hoc_qc_specs enable row level security;
drop policy if exists "anon all" on hoc_qc_specs;
create policy "anon all" on hoc_qc_specs
  for all to anon using (true) with check (true);

-- -------------------------------------------------------------------
-- hoc_events: central event queue for the Event Engine.
-- -------------------------------------------------------------------
create table if not exists hoc_events (
  id              bigserial primary key,
  event_type      text not null,
  severity        text default 'info',
  batch_id        text,
  item_id         text,
  payload         jsonb,
  source          text,
  created_at      timestamptz default now(),
  sent_at         timestamptz,
  send_attempts   int default 0,
  last_error      text,
  pdf_url         text
);
create index if not exists idx_events_pending on hoc_events(sent_at) where sent_at is null;
create index if not exists idx_events_type    on hoc_events(event_type, created_at desc);

alter table hoc_events enable row level security;
drop policy if exists "anon all" on hoc_events;
create policy "anon all" on hoc_events
  for all to anon using (true) with check (true);

-- -------------------------------------------------------------------
-- hoc_event_config: distribution lists + schedules + thresholds.
-- -------------------------------------------------------------------
create table if not exists hoc_event_config (
  event_type      text primary key,
  enabled         boolean default true,
  recipients      text,
  cc_recipients   text,
  subject_tpl     text,
  schedule        text,
  threshold       jsonb,
  updated_at      timestamptz default now()
);

insert into hoc_event_config (event_type, recipients, subject_tpl, schedule, threshold) values
  ('qc_release',
   '',
   'HOC QC Releases - {{date}} ({{count}} batches)',
   '5pm+12am',
   '{}'),
  ('qc_hold',
   '',
   'QC HOLD - Batch {{batch_id}} needs adjustment',
   'immediate',
   '{}'),
  ('qc_reject',
   '',
   'QC REJECT - Batch {{batch_id}} to R&D Notice of Assist',
   'immediate',
   '{}'),
  ('compound_critical',
   '',
   'Compound CRITICAL - {{count}} batches need attention',
   '11am+4pm',
   '{"include_overdue": true}'),
  ('downtime',
   '',
   'Extended Downtime - Batch {{batch_id}}',
   'immediate',
   '{"hours": 4}'),
  ('schedule_slip',
   '',
   'Schedule Slip - {{count}} batches behind plan',
   '11am+4pm',
   '{"days_late": 1}'),
  ('fg_discrepancy',
   '',
   'FG Discrepancy - Batch {{batch_id}} ({{variance}}%)',
   'immediate',
   '{"variance_pct": 10}')
on conflict (event_type) do nothing;

alter table hoc_event_config enable row level security;
drop policy if exists "anon all" on hoc_event_config;
create policy "anon all" on hoc_event_config
  for all to anon using (true) with check (true);


-- ===================================================================
-- STORAGE BUCKET for QC release PDFs
-- ===================================================================
insert into storage.buckets (id, name, public)
  values ('qc-release-pdfs', 'qc-release-pdfs', true)
  on conflict (id) do nothing;

drop policy if exists "Public Access" on storage.objects;
create policy "Public Access" on storage.objects
  for select to anon using (bucket_id = 'qc-release-pdfs');

drop policy if exists "Anon insert" on storage.objects;
create policy "Anon insert" on storage.objects
  for insert to anon with check (bucket_id = 'qc-release-pdfs');


-- -------------------------------------------------------------------
-- hoc_sync_bus: cross-device sync heartbeat used by Data Upload Hub.
-- One row (id=1), updated_at bumps whenever a dashboard pushes data.
-- Other dashboards poll updated_at to know when to refresh.
-- -------------------------------------------------------------------
create table if not exists hoc_sync_bus (
  id          int primary key default 1,
  updated_at  timestamptz default now(),
  payload     jsonb
);
alter table hoc_sync_bus enable row level security;
drop policy if exists "anon all" on hoc_sync_bus;
create policy "anon all" on hoc_sync_bus
  for all to anon using (true) with check (true);

insert into hoc_sync_bus (id, payload) values (1, '{}'::jsonb)
on conflict (id) do nothing;


-- ===================================================================
-- SANITY CHECK
-- ===================================================================
select 'setup complete' as status,
  (select count(*) from hoc_schedule)     as schedule_rows,
  (select count(*) from hoc_batches)      as batches_rows,
  (select count(*) from hoc_qc_tests)     as qc_tests_rows,
  (select count(*) from hoc_qc_specs)     as qc_specs_rows,
  (select count(*) from hoc_events)       as events_rows,
  (select count(*) from hoc_event_config) as event_config_rows,
  (select count(*) from hoc_sync_bus)     as sync_bus_rows;
