-- Up Migration

create extension if not exists pgcrypto;

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  content_rewards_campaign_id text not null unique,
  content_rewards_url text not null,
  title text,
  brand text,
  platforms text[] not null default '{}',
  guideline_doc_url text,
  drive_folder_url text,
  drive_folder_id text,

  status text not null default 'discovered'
    check (status in (
      'discovered', 'ingesting', 'requirements_drafted',
      'pending_confirmation', 'active', 'paused', 'archived'
    )),

  config jsonb not null default '{}'::jsonb,
  config_confirmed_at timestamptz,
  config_confirmed_by text
);

create table source_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  campaign_id uuid not null references campaigns(id),
  drive_file_id text not null,
  drive_file_name text,
  size_bytes bigint,
  md5_checksum text,
  source_url text not null,

  status text not null default 'detected'
    check (status in (
      'detected', 'validating', 'validation_failed', 'queued',
      'submitting', 'submit_failed', 'project_created', 'processing',
      'candidates_ready', 'needs_attention', 'completed'
    )),
  status_reason text,

  opusclip_project_id text,
  retry_count int not null default 0,

  unique (campaign_id, drive_file_id)
);

create index source_jobs_status_idx on source_jobs (status);

create table candidate_clips (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  source_job_id uuid not null references source_jobs(id),
  opusclip_clip_id text not null unique,
  title text,
  duration_ms int,
  preview_url text,
  export_url text,
  hashtags text,

  status text not null default 'generated'
    check (status in (
      'generated', 'checking', 'awaiting_review', 'needs_edit',
      'approved', 'exporting', 'ready_to_post', 'posted', 'rejected', 'archived'
    )),
  check_results jsonb not null default '{}'::jsonb
);

create index candidate_clips_status_idx on candidate_clips (status);

create table status_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  entity_type text not null check (entity_type in ('campaign', 'source_job', 'candidate_clip')),
  entity_id uuid not null,
  from_status text,
  to_status text not null,
  actor text not null,
  reason text,
  error_details jsonb
);

create index status_events_entity_idx on status_events (entity_type, entity_id);

create table posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  candidate_clip_id uuid not null references candidate_clips(id),
  platform text not null check (platform in ('tiktok', 'instagram', 'youtube')),
  url text,
  posted_at timestamptz,
  views int,
  likes int,
  engagement_rate numeric,
  earnings numeric,
  notes text
);

-- Down Migration

drop table if exists posts;
drop table if exists status_events;
drop table if exists candidate_clips;
drop table if exists source_jobs;
drop table if exists campaigns;
