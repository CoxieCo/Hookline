-- Business profile used to tailor content ideas. One row per user.

create table public.business_profiles (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique default auth.uid()
                        references auth.users (id) on delete cascade,
  source_type         text,
  source_url          text,
  industry            text,
  product_description text,
  target_customer     text,
  brand_tone          text,
  created_at          timestamptz not null default now()
);

alter table public.business_profiles enable row level security;

-- Only signed-in users get policies; anon has none, so RLS denies it everything.
-- `(select auth.uid())` is evaluated once per statement rather than per row.

create policy "Users can read their own profile"
  on public.business_profiles for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own profile"
  on public.business_profiles for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- USING limits which rows can be targeted; WITH CHECK stops a user from
-- re-assigning their row to someone else's user_id.
create policy "Users can update their own profile"
  on public.business_profiles for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own profile"
  on public.business_profiles for delete
  to authenticated
  using ((select auth.uid()) = user_id);
