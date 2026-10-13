-- Database functions used by the service, plus the operator toolkit (FR-REC-03,
-- FR-CFG-05). Operators run these from the Supabase SQL editor.

-- ---------------------------------------------------------------------------
-- Numbering (FR-NUM-01 / 02 / 03)
-- ---------------------------------------------------------------------------

-- Reserves the next number in `p_series` for a job, atomically. If the job already
-- holds a number, that number is returned unchanged, so retries always reuse it.
-- The job row is locked first, then the series row; every caller takes the locks
-- in that order, so concurrent workers cannot deadlock or skip numbers.
create function einvoice.reserve_job_number(
  p_job_id uuid,
  p_series text,
  p_invoice_type_code text,
  p_customer_kind text
) returns table (series_code text, number bigint, date_issued timestamptz)
language plpgsql as $$
declare
  j einvoice.jobs%rowtype;
  n bigint;
begin
  select * into j from einvoice.jobs where id = p_job_id for update;
  if not found then
    raise exception 'Job % not found', p_job_id;
  end if;

  if j.number is not null then
    return query select j.series_code, j.number, j.date_issued;
    return;
  end if;

  update einvoice.series s
     set next_number = s.next_number + 1
   where s.code = p_series and s.active
  returning s.next_number - 1 into n;

  if n is null then
    raise exception 'Series "%" is not configured or not active', p_series;
  end if;

  update einvoice.jobs
     set series_code = p_series,
         number = n,
         date_issued = now(),
         invoice_type_code = p_invoice_type_code,
         customer_kind = p_customer_kind
   where id = p_job_id;

  return query select p_series, n, now();
end $$;

-- ---------------------------------------------------------------------------
-- Queue
-- ---------------------------------------------------------------------------

-- Idempotent job creation keyed on the Storeganise invoice id (FR-CAP-02).
-- A repeat event only flags the job for re-evaluation.
create function einvoice.enqueue_invoice(
  p_sg_invoice_id text,
  p_event text,
  p_sg_site_id text default null
) returns uuid
language sql as $$
  insert into einvoice.jobs (sg_invoice_id, sg_site_id, last_event, last_event_at, needs_eval)
  values (p_sg_invoice_id, p_sg_site_id, p_event, now(), true)
  on conflict (sg_invoice_id, kind, correction_key) do update
     set needs_eval    = true,
         last_event    = excluded.last_event,
         last_event_at = excluded.last_event_at,
         sg_site_id    = coalesce(einvoice.jobs.sg_site_id, excluded.sg_site_id)
  returning id;
$$;

-- Claims a batch of jobs for one worker run. SKIP LOCKED plus a lease means
-- overlapping runs never pick up the same job, and a crashed run's jobs come back
-- once the lease expires. `sending` jobs with an expired lease are resent with
-- their reserved number; Impact answers 409 if the first attempt had landed.
-- needs_eval is left set; the worker clears it just before re-reading the invoice,
-- so an event that arrives mid-run is never lost. Held jobs are re-checked when
-- due, and sent documents still waiting for their MARK (Impact status PENDING)
-- are followed up.
create function einvoice.claim_jobs(
  p_limit int,
  p_lease_seconds int,
  p_transmit boolean
) returns setof einvoice.jobs
language sql as $$
  with c as (
    select id
      from einvoice.jobs
     where (locked_until is null or locked_until < now())
       and (
             needs_eval
          or writeback_pending
          or (p_transmit and status in ('pending', 'retry', 'sending', 'held') and next_attempt_at <= now())
          or (p_transmit and status = 'sent' and mark is null and next_attempt_at <= now())
       )
     order by needs_eval desc, next_attempt_at
     limit p_limit
     for update skip locked
  )
  update einvoice.jobs j
     set locked_until = now() + make_interval(secs => p_lease_seconds),
         lease_token = gen_random_uuid()
    from c
   where j.id = c.id
  returning j.*;
$$;

-- ---------------------------------------------------------------------------
-- Operator toolkit
-- ---------------------------------------------------------------------------

-- FR-REC-03: re-queue a job after the data has been fixed in Storeganise.
-- A reserved number is kept, so the document is re-sent under the same number.
create function einvoice.requeue_job(p_job_id uuid, p_note text default null)
returns einvoice.jobs
language plpgsql as $$
declare
  j einvoice.jobs%rowtype;
begin
  update einvoice.jobs
     set status = case
                    when kind = 'credit_note' or number is not null then 'pending'
                    else 'new'
                  end,
         status_reason = 'requeued by operator',
         attempts = 0,
         next_attempt_at = now(),
         needs_eval = true,
         locked_until = null,
         last_error = null,
         last_error_detail = null
   where id = p_job_id
     and status in ('held', 'failed_data', 'failed', 'retry', 'skipped', 'waiting')
  returning * into j;

  if not found then
    raise exception 'Job % not found, or its status cannot be re-queued', p_job_id;
  end if;

  insert into einvoice.audit_log (kind, job_id, sg_invoice_id, method, request)
  values ('operator', j.id, j.sg_invoice_id, 'requeue_job', jsonb_build_object('note', p_note, 'by', current_user));

  return j;
end $$;

-- Re-queue every job in the given statuses, e.g. after an Impact outage.
create function einvoice.requeue_all(p_statuses text[] default array['failed'])
returns int
language plpgsql as $$
declare
  j record;
  n int := 0;
begin
  for j in select id from einvoice.jobs where status = any(p_statuses) loop
    perform einvoice.requeue_job(j.id, 'bulk requeue');
    n := n + 1;
  end loop;
  return n;
end $$;

-- Ask the worker to re-read a Storeganise invoice (e.g. to re-run change or refund
-- detection), creating the job if it does not exist.
create function einvoice.refresh_invoice(p_sg_invoice_id text)
returns uuid
language sql as $$
  select einvoice.enqueue_invoice(p_sg_invoice_id, 'operator.refresh');
$$;

-- FR-CFG-05: kill switch. Jobs keep queueing while paused; nothing is transmitted.
create function einvoice.set_paused(p_paused boolean)
returns boolean
language plpgsql as $$
begin
  insert into einvoice.settings (key, value, description)
  values ('transmission_paused', to_jsonb(p_paused), 'Kill switch (FR-CFG-05)')
  on conflict (key) do update set value = excluded.value;

  insert into einvoice.audit_log (kind, method, request)
  values ('operator', 'set_paused', jsonb_build_object('paused', p_paused, 'by', current_user));

  return p_paused;
end $$;

-- FR-ERR-01 retention, driven by the audit_retention_days setting (null = keep).
create function einvoice.purge_audit_log()
returns int
language plpgsql as $$
declare
  days int;
  n int;
begin
  select (value #>> '{}')::int into days
    from einvoice.settings where key = 'audit_retention_days' and value <> 'null'::jsonb;
  if days is null then
    return 0;
  end if;
  delete from einvoice.audit_log where at < now() - make_interval(days => days);
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Views for the Supabase dashboard (no UI in this release)
-- ---------------------------------------------------------------------------

create view einvoice.v_attention as
select id, kind, sg_invoice_id, status, status_reason, last_error, attempts, next_attempt_at,
       series_code, number, mark, changed_after_issue, credit_required, updated_at
  from einvoice.jobs
 where status in ('held', 'failed_data', 'failed', 'retry')
    or changed_after_issue
    or credit_required is not null
    or writeback_pending
    or (status = 'sent' and mark is null)
    or delayed_code > 0
 order by updated_at desc;

create view einvoice.v_queue as
select status, kind, count(*) as jobs, min(next_attempt_at) as oldest_due
  from einvoice.jobs
 group by status, kind
 order by status, kind;

-- Each series with the numbers used, the numbers reserved but not yet accepted by
-- Impact, and any genuine gaps (which should never appear).
create view einvoice.v_series as
select s.code,
       s.next_number,
       s.active,
       count(j.id) filter (where j.status in ('sent', 'credited')) as issued,
       array_agg(j.number order by j.number) filter (
         where j.status not in ('sent', 'credited')) as reserved_not_issued,
       (select array_agg(g order by g)
          from generate_series(1, s.next_number - 1) g
         where not exists (select 1 from einvoice.jobs x where x.series_code = s.code and x.number = g)
       ) as gaps
  from einvoice.series s
  left join einvoice.jobs j on j.series_code = s.code
 group by s.code, s.next_number, s.active;

create view einvoice.v_open_reconciliation_issues as
select i.*, r.started_at as run_started_at
  from einvoice.reconciliation_issues i
  join einvoice.reconciliation_runs r on r.id = i.run_id
 where i.resolved_at is null
 order by i.created_at desc;
