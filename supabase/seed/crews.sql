-- Standby crews: 20 per block (10 day / 10 night) + community support. Edit names to match the final roster.
insert into public.crews (id, name, block, shift) values
 ('00000000-0000-4000-8000-000000000301','Block A — Day','Block A','day'),
 ('00000000-0000-4000-8000-000000000302','Block A — Night','Block A','night'),
 ('00000000-0000-4000-8000-000000000303','Block B — Day','Block B','day'),
 ('00000000-0000-4000-8000-000000000304','Block B — Night','Block B','night'),
 ('00000000-0000-4000-8000-000000000305','Block C — Day','Block C','day'),
 ('00000000-0000-4000-8000-000000000306','Block C — Night','Block C','night'),
 ('00000000-0000-4000-8000-000000000307','Community support','All','support')
on conflict (id) do update set name = excluded.name, block = excluded.block, shift = excluded.shift;

-- After creating users in Supabase Auth (profiles are created automatically as 'reporter'):
-- update public.profiles set role = 'coordinator' where id = '<uuid>';
-- update public.profiles set role = 'responder', crew_id = '00000000-0000-4000-8000-000000000303' where id = '<uuid>';
