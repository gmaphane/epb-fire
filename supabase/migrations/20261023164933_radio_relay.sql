-- Radio relay: coordinates read out in the field and typed in at camp.
set search_path = public, extensions;
alter table public.incidents
  add column if not exists location_source text not null default 'gps'
    check (location_source in ('gps','map','manual','satellite')),
  add column if not exists observer_name text,          -- who saw the fire (may not be an app user)
  add column if not exists relayed_via text check (relayed_via in ('radio','phone')),
  add column if not exists observed_at timestamptz;     -- when it was seen, if earlier than entry
