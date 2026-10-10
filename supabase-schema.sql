-- Snapdoc v1 encrypted cloud sync. Paste into the Supabase SQL Editor and Run. Safe to run twice.
-- Runs in Snapdoc's own Supabase project; every object carries the sd_ prefix (bucket "sd").
-- The app encrypts on the device. This database only ever holds ciphertext:
--   sd_documents.meta   encrypted name, page count, size, creation date
--   bucket sd           one encrypted PDF per document
--   sd_keys             the document key, wrapped with the user's encryption password

create table if not exists public.sd_documents (
  id text not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  meta text not null default '',
  rev bigint not null default 0,
  updated_at bigint not null,
  deleted boolean not null default false,
  synced_at bigint not null default 0,
  primary key (user_id, id)
);
create index if not exists sd_documents_user_synced on public.sd_documents (user_id, synced_at);

-- the server stamps every write; devices ask for "everything stamped after my last visit"
create sequence if not exists public.sd_stamp;
-- the sequence starts above every stamp ever written (installs from before version 13 used milliseconds since 1970)
do $$
declare m bigint;
begin
  select coalesce(max(synced_at), 0) into m from public.sd_documents;
  if (select last_value from public.sd_stamp) < greatest(m, (extract(epoch from clock_timestamp()) * 1000)::bigint) then
    perform setval('public.sd_stamp', greatest(m, (extract(epoch from clock_timestamp()) * 1000)::bigint) + 1000, false);
  end if;
end $$;

create or replace function public.sd_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.synced_at := nextval('public.sd_stamp');      -- a sequence: it never steps back, unlike a clock
  return new;
end $$;
drop trigger if exists sd_documents_touch on public.sd_documents;
create trigger sd_documents_touch before insert or update on public.sd_documents
  for each row execute function public.sd_touch();

create table if not exists public.sd_keys (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  salt text not null,
  iter integer not null,
  wrapped text not null,
  created_at bigint not null
);

alter table public.sd_documents enable row level security;
alter table public.sd_keys enable row level security;

-- explicit privileges, so the script works whether or not the project exposes new tables by itself:
-- visitors who are not signed in get nothing; signed-in users get table access, which row level
-- security then narrows to their own rows
revoke all on public.sd_documents from anon;
revoke all on public.sd_keys from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.sd_documents to authenticated;
grant select, insert, update on public.sd_keys to authenticated;

drop policy if exists "sd select" on public.sd_documents;
drop policy if exists "sd insert" on public.sd_documents;
drop policy if exists "sd update" on public.sd_documents;
drop policy if exists "sd delete" on public.sd_documents;
create policy "sd select" on public.sd_documents for select to authenticated using (user_id = auth.uid());
create policy "sd insert" on public.sd_documents for insert to authenticated with check (user_id = auth.uid());
create policy "sd update" on public.sd_documents for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "sd delete" on public.sd_documents for delete to authenticated using (user_id = auth.uid());

drop policy if exists "sd key select" on public.sd_keys;
drop policy if exists "sd key insert" on public.sd_keys;
drop policy if exists "sd key update" on public.sd_keys;
create policy "sd key select" on public.sd_keys for select to authenticated using (user_id = auth.uid());
create policy "sd key insert" on public.sd_keys for insert to authenticated with check (user_id = auth.uid());
create policy "sd key update" on public.sd_keys for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- private bucket; files live under <user id>/<document id>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('sd', 'sd', false, 52428800, array['application/octet-stream'])
  on conflict (id) do nothing;

drop policy if exists "sd obj select" on storage.objects;
drop policy if exists "sd obj insert" on storage.objects;
drop policy if exists "sd obj update" on storage.objects;
drop policy if exists "sd obj delete" on storage.objects;
create policy "sd obj select" on storage.objects for select to authenticated
  using (bucket_id = 'sd' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "sd obj insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'sd' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "sd obj update" on storage.objects for update to authenticated
  using (bucket_id = 'sd' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "sd obj delete" on storage.objects for delete to authenticated
  using (bucket_id = 'sd' and (storage.foldername(name))[1] = auth.uid()::text);

-- tell the Data API about the new tables right away
notify pgrst, 'reload schema';
