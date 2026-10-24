-- AI contract v0.5: proposal revision history

alter table public.proposals
  add column if not exists based_on_proposal_id uuid
    references public.proposals(id);

alter table public.proposals
  add column if not exists based_on_version integer
    check (based_on_version >= 1);

alter table public.proposals
  add constraint proposal_revision_pair_check
  check (
    (based_on_proposal_id is null and based_on_version is null)
    or
    (based_on_proposal_id is not null and based_on_version is not null)
  );