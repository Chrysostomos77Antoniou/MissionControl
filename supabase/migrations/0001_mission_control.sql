create table if not exists agent_memory (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  cycle_at timestamptz not null,
  summary text not null,
  created_at timestamptz default now()
);

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  action_type text not null,
  payload jsonb not null,
  preview text not null,
  status text default 'pending',
  rejection_reason text,
  created_at timestamptz default now(),
  resolved_at timestamptz
);

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  action text not null,
  detail text,
  created_at timestamptz default now()
);

create table if not exists content_drafts (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  type text not null,
  title text not null,
  body text not null,
  status text default 'draft',
  created_at timestamptz default now()
);

create index if not exists idx_approvals_status on approvals(status);
create index if not exists idx_activity_created on activity_log(created_at desc);
