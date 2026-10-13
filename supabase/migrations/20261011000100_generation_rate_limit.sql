-- Per-user rate limit for /api/ideas/generate (AI idea generation).
-- Modelled on consume_extraction_quota() in 20260928000100_extraction_rate_limit.sql.
--
-- The log table has RLS enabled, NO policies, and no table privileges for
-- anon/authenticated, so users can't read, insert, update, delete or truncate
-- rows (and so can't reset or back-date their own quota). The only way in is
-- consume_generation_quota(), which runs as the table owner.

create table public.idea_generation_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index idea_generation_log_user_created_idx
  on public.idea_generation_log (user_id, created_at desc);

alter table public.idea_generation_log enable row level security;

revoke all on table public.idea_generation_log from anon, authenticated;

-- Atomically checks and records one generation batch for the calling user
-- (max 5 per rolling 24 hours).
-- Returns {"allowed": true,  "retry_at": null} when the batch is allowed, or
--         {"allowed": false, "retry_at": "<timestamptz>"} with the moment the
--         oldest batch in the window expires and a new one becomes possible.
create function public.consume_generation_quota()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid            uuid := auth.uid();
  max_per_window constant int := 5;
  window_length  constant interval := interval '24 hours';
  used           int;
  next_free      timestamptz;
begin
  if uid is null then
    return jsonb_build_object('allowed', false, 'retry_at', null);
  end if;

  -- Serialise concurrent calls for the same user so two parallel requests
  -- can't both slip under the limit. (Seed 1 keeps this lock separate from
  -- the extraction quota's.)
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 1));

  select count(*) into used
  from public.idea_generation_log
  where user_id = uid
    and created_at > now() - window_length;

  if used >= max_per_window then
    -- The batch whose expiry brings the count back under the limit.
    select created_at + window_length into next_free
    from public.idea_generation_log
    where user_id = uid
      and created_at > now() - window_length
    order by created_at asc
    offset used - max_per_window
    limit 1;

    return jsonb_build_object('allowed', false, 'retry_at', next_free);
  end if;

  insert into public.idea_generation_log (user_id) values (uid);
  return jsonb_build_object('allowed', true, 'retry_at', null);
end;
$$;

revoke all on function public.consume_generation_quota() from public, anon;
grant execute on function public.consume_generation_quota() to authenticated;
