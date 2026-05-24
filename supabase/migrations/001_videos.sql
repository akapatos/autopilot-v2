-- Run this in the Supabase SQL editor (or via CLI) before using the pipeline.

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  niche text,
  length_minutes numeric not null default 1,
  style text,
  voice text,
  status text not null default 'generating',
  generation_stage text,
  file_url text,
  scenes jsonb not null default '[]'::jsonb,
  clips jsonb not null default '[]'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists videos_status_idx on public.videos (status);
create index if not exists videos_created_at_idx on public.videos (created_at desc);

alter table public.videos enable row level security;
