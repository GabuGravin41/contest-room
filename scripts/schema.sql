-- The Contest Room — database schema (Postgres / Neon)

create table if not exists students (
  code          text primary key,          -- normalised, e.g. KIO7F3KQ9PX
  name          text,
  school        text,
  county        text,
  candidate_no  text,
  created_at    timestamptz default now()
);

create table if not exists sessions (
  code               text primary key references students(code),
  active_token       text,                 -- the device currently allowed to write
  first_join_at      timestamptz,
  last_join_at       timestamptz,
  join_count         int default 0,
  last_sync_at       timestamptz,
  sync_count         int default 0,
  late_syncs         int default 0,
  submitted_at       timestamptz,
  answers            jsonb default '{}'::jsonb,   -- latest answer per box
  answers_updated_at timestamptz
);

-- One row per join: new | resume (same device reloaded) | device_switch (a second device took over)
create table if not exists joins (
  id    bigserial primary key,
  code  text not null,
  token text,
  kind  text,
  at    timestamptz default now(),
  ip    text,
  ua    text
);
create index if not exists joins_code on joins(code);

-- One row per sync batch from a student's browser.
-- events: "dt,type,q,a,b;dt,type,..." where dt is ms since the previous event
--         (the first dt is relative to `base`, ms since contest start on the server clock).
-- answers: periodic snapshot of changed answers (every ~5 minutes and on submit) for answer history.
create table if not exists logs (
  id          bigserial primary key,
  code        text not null,
  token       text not null,
  seq         int not null,
  received_at timestamptz default now(),
  client_now  bigint,
  base        bigint,
  stale       boolean default false,   -- sent by a device that had been replaced
  late        boolean default false,   -- arrived after the official end (within grace)
  final       boolean default false,
  answers     jsonb,
  events      text,
  unique (code, token, seq)
);
create index if not exists logs_code on logs(code);

-- Admin-page content (also created automatically on first use)
create table if not exists papers (
  id bigserial primary key, uploaded_at timestamptz default now(), filename text, tex text,
  paper jsonb not null, key jsonb, points jsonb, summary jsonb, active boolean default true);
create table if not exists settings (key text primary key, value jsonb, updated_at timestamptz default now());
create table if not exists logos (
  id bigserial primary key, alt text, mime text, data text, pos int default 0, created_at timestamptz default now());
alter table students add column if not exists extra_minutes int default 0;
create table if not exists marks (
  code text not null, problem text not null, score numeric, comment text, marker text,
  claimed_by text, claimed_at timestamptz, updated_at timestamptz default now(), primary key (code, problem));
