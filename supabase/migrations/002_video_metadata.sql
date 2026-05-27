alter table public.videos
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists tags jsonb not null default '[]'::jsonb,
  add column if not exists thumbnail_concept text,
  add column if not exists full_script text;
