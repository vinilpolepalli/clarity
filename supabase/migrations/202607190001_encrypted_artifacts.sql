-- Optional cloud stores ciphertext and non-sensitive routing metadata only.
create table if not exists public.encrypted_artifacts (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  envelope_version integer not null check (envelope_version = 1),
  ciphertext text not null,
  iv text not null,
  artifact_kind text not null,
  client_updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.encrypted_artifacts enable row level security;

create policy "owners read encrypted artifacts"
  on public.encrypted_artifacts for select
  using (auth.uid() = user_id);

create policy "owners insert encrypted artifacts"
  on public.encrypted_artifacts for insert
  with check (auth.uid() = user_id);

create policy "owners update encrypted artifacts"
  on public.encrypted_artifacts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "owners delete encrypted artifacts"
  on public.encrypted_artifacts for delete
  using (auth.uid() = user_id);

revoke all on public.encrypted_artifacts from anon;
