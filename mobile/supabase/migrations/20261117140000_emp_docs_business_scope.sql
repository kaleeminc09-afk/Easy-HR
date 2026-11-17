-- NorthShift: scope the employee-documents storage policies to the
-- caller's own business (Nov 17, 2026).
--
-- THE HOLE: the three emp_docs policies on storage.objects (created
-- Oct 22, 2026, outside the repo migrations) share one expression
-- whose manager branch is a GLOBAL role check — any business's
-- manager/admin can read, upload into, and delete EVERY business's
-- document files. The documents metadata table was scoped to the own
-- business by the Nov 12 tenancy RLS migration; the file bytes were
-- not. Formal read confirming the hole: Nov 12, 2026.
--
-- THE FIX: the manager branch now additionally requires the file's
-- owner (first path segment = owner user id, per buildStoragePath)
-- to belong to the caller's business, checked through a SECURITY
-- DEFINER helper — the same pattern as my_business_id(). The owner
-- branch (first segment = auth.uid()) is unchanged: owners always
-- reach their own files, including owners with no business. Files
-- whose first segment is not a UUID never match the manager branch.
-- No app change is needed: documents.js already uploads to
-- <ownerId>/<timestamp>-<file>, views via 300s signed URLs, and
-- deletes by storage_path — all covered by these three policies.
-- There is deliberately still no UPDATE policy (unchanged).
-- Re-runnable: CREATE OR REPLACE + DROP IF EXISTS throughout.

create or replace function public.storage_owner_in_my_business(p_owner_folder text)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if p_owner_folder is null
     or p_owner_folder !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1
    from public.profiles prof
    where prof.id = p_owner_folder::uuid
      and prof.business_id is not null
      and prof.business_id = public.my_business_id()
  );
end;
$$;

drop policy if exists "emp_docs_select" on storage.objects;
create policy "emp_docs_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'employee-documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or (
        exists (
          select 1 from public.profiles me
          where me.id = auth.uid() and me.role in ('manager', 'admin')
        )
        and public.storage_owner_in_my_business((storage.foldername(name))[1])
      )
    )
  );

drop policy if exists "emp_docs_insert" on storage.objects;
create policy "emp_docs_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'employee-documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or (
        exists (
          select 1 from public.profiles me
          where me.id = auth.uid() and me.role in ('manager', 'admin')
        )
        and public.storage_owner_in_my_business((storage.foldername(name))[1])
      )
    )
  );

drop policy if exists "emp_docs_delete" on storage.objects;
create policy "emp_docs_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'employee-documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or (
        exists (
          select 1 from public.profiles me
          where me.id = auth.uid() and me.role in ('manager', 'admin')
        )
        and public.storage_owner_in_my_business((storage.foldername(name))[1])
      )
    )
  );
