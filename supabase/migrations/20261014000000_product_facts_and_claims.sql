-- Grounding for idea generation.
--
-- business_profiles.product_facts: things the owner confirms are true about
-- the product and is happy to say in videos. The only product specifics the
-- model may state. Empty string (not NULL) when there are none.
--
-- generated_ideas.claims_to_verify: specific claims in an idea that are not
-- supported by the profile or product_facts (listed by the model, plus numbers
-- found by the server's own post-check). Shown as "Check before posting".
--
-- RLS policies are left untouched. Column privileges on generated_ideas are
-- unchanged too: authenticated's UPDATE grant is column-level (status only),
-- so it does not extend to this new column; its table-level SELECT does.

alter table public.business_profiles
  add column product_facts text not null default '';

alter table public.generated_ideas
  add column claims_to_verify jsonb not null default '[]'::jsonb
    constraint generated_ideas_claims_to_verify_is_array
    check (jsonb_typeof(claims_to_verify) = 'array');
