-- Per-user rate limit for /api/profile/extract (AI profile extraction).
--
-- The log table has RLS enabled and NO policies, so users can't read, insert,
-- or delete rows directly (and so can't reset their own quota). The only way
-- in is consume_extraction_quota(), which runs as the table owner.

create table public.profile_extraction_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index profile_extraction_log_user_created_idx
  on public.profile_extraction_log (user_id, created_at desc);

alter table public.profile_extraction_log enable row level security;

-- Atomically checks and records one extraction for the calling user
-- (max 10 per rolling hour).
-- Returns true if allowed, false if the user is over the limit.
create function public.consume_extraction_quota()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid            uuid := auth.uid();
  max_per_window constant int := 10;
  window_length  constant interval := interval '1 hour';
  used           int;
begin
  if uid is null then
    return false;
  end if;

  -- Serialise concurrent calls for the same user so two parallel requests
  -- can't both slip under the limit.
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));

  select count(*) into used
  from public.profile_extraction_log
  where user_id = uid
    and created_at > now() - window_length;

  if used >= max_per_window then
    return false;
  end if;

  insert into public.profile_extraction_log (user_id) values (uid);
  return true;
end;
$$;

revoke all on function public.consume_extraction_quota() from public, anon;
grant execute on function public.consume_extraction_quota() to authenticated;
