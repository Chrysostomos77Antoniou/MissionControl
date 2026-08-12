create table if not exists agent_evals (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  cycle_at timestamptz not null,
  score smallint not null check (score between 1 and 5),
  reasoning text not null,
  suggestions_count smallint not null default 0,
  created_at timestamptz default now()
);

create index if not exists idx_agent_evals_agent_cycle on agent_evals(agent, cycle_at desc);
