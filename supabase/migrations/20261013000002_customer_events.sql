-- FR-CUS-02 / FR-MAP-07: a business invoice held for missing customer tax data is
-- re-checked as soon as staff fix the customer in Storeganise (user.updated),
-- instead of waiting for the hourly re-check. Jobs remember the invoice's
-- customer for that; the worker fills it in whenever it reads the invoice.

alter table einvoice.jobs add column sg_owner_id text;

create index jobs_owner_held_idx on einvoice.jobs (company_id, sg_owner_id) where status = 'held';

-- Flags the held invoice jobs of one customer, among the given companies (one
-- Storeganise account). Returns how many were flagged.
create function einvoice.recheck_customer(p_company_ids uuid[], p_sg_owner_id text)
returns int
language sql as $$
  with flagged as (
    update einvoice.jobs
       set needs_eval = true,
           next_attempt_at = least(next_attempt_at, now()),
           last_event = 'user.updated',
           last_event_at = now()
     where company_id = any(p_company_ids)
       and sg_owner_id = p_sg_owner_id
       and status = 'held'
       and kind = 'invoice'
    returning 1
  )
  select count(*)::int from flagged;
$$;
