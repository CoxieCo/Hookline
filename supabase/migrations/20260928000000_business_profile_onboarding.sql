-- Onboarding: business name + constrained source_type.
-- RLS policies from 20260925000000_business_profiles.sql are left untouched.

alter table public.business_profiles
  add column business_name text;

-- NULL still passes (CHECK treats unknown as satisfied), so any pre-existing
-- rows without a source_type remain valid.
alter table public.business_profiles
  add constraint business_profiles_source_type_check
  check (source_type in ('website', 'social', 'manual'));
