-- Generated content ideas. Rows are created only by the server (service role)
-- in batches of 5; users can read them, change their status, and delete them.

create table public.generated_ideas (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null default auth.uid()
                         references auth.users (id) on delete cascade,
  batch_id             uuid not null,
  hook                 text not null,
  script_beats         jsonb not null
                         constraint generated_ideas_script_beats_is_array
                         check (jsonb_typeof(script_beats) = 'array'),
  filming_instructions text not null,
  format               text not null,
  caption              text not null default '',
  duration_seconds     int,
  trend_name           text,
  status               text not null default 'new'
                         constraint generated_ideas_status_check
                         check (status in ('new', 'saved', 'dismissed')),
  created_at           timestamptz not null default now()
);

create index generated_ideas_user_created_idx
  on public.generated_ideas (user_id, created_at desc);

alter table public.generated_ideas enable row level security;

-- Policies: signed-in users see, update and delete only their own rows.
-- There is deliberately NO insert policy (and no INSERT privilege below):
-- ideas are only written by the generation route with the service role,
-- which bypasses RLS.

create policy "Users can read their own ideas"
  on public.generated_ideas for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can update their own ideas"
  on public.generated_ideas for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own ideas"
  on public.generated_ideas for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Column-level privileges (not a trigger) restrict what an update can touch.
-- Supabase grants ALL on new public tables to anon and authenticated, which
-- would let a user's UPDATE rewrite any column of their own rows. Replace that
-- with: read + delete the whole row, but UPDATE only the `status` column.
-- An update that sets any other column (hook, script_beats, user_id, ...)
-- fails with "permission denied for table generated_ideas".
-- anon gets nothing at all. service_role keeps its default full access.
revoke all on table public.generated_ideas from anon, authenticated;
grant select, delete on table public.generated_ideas to authenticated;
grant update (status) on table public.generated_ideas to authenticated;
