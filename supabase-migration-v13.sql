-- Snapdoc, migration for version 13: the server stamp becomes a sequence.
-- Run once in the Supabase SQL editor of the Snapdoc project (after supabase-schema.sql).
-- The clients only compare and order stamps; a sequence never steps back, unlike the wall clock
-- (an NTP correction or a migration of the database host could otherwise make a conditional
-- write hit the wrong row or a pull skip a change). Existing stamps (milliseconds since 1970)
-- stay valid: the sequence starts above the largest stamp in the table.
do $$
declare m bigint;
begin
  select coalesce(max(synced_at), 0) into m from public.sd_documents;
  if not exists (select 1 from pg_class where relname = 'sd_stamp') then
    execute 'create sequence public.sd_stamp';
  end if;
  perform setval('public.sd_stamp', greatest(m, (extract(epoch from clock_timestamp()) * 1000)::bigint) + 1000, false);
end $$;

create or replace function public.sd_touch() returns trigger
language plpgsql as $$
begin
  new.synced_at := nextval('public.sd_stamp');
  return new;
end $$;

drop trigger if exists sd_documents_touch on public.sd_documents;
create trigger sd_documents_touch before insert or update on public.sd_documents
  for each row execute function public.sd_touch();
