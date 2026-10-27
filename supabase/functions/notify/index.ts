// Push alerts for call-outs (the crew) and new fire reports (everyone), called by database triggers, plus a "send test".
import { caller, dd, ensureVapid, json, sb, sendPush, users } from '../_shared/alerts.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  const who = await caller(req);
  if (!who) return json({ error: 'unauthorised' }, 401);
  const body = await req.json().catch(() => ({}));
  const event = String(body.event ?? '');

  try {
    if (event === 'init') { await ensureVapid(); return json({ ok: true }); }

    if (event === 'test') {
      if (who.kind !== 'user') return json({ error: 'test needs a signed-in user' }, 400);
      const r = await sendPush([who.id], { title: 'Test alert', body: 'Fire alerts are working on this phone.', url: '/#/map', tag: 'test', kind: 'test' });
      console.log(JSON.stringify({ alert: 'test', ...r }));
      return json(r);
    }

    if (who.kind !== 'hook') return json({ error: 'only the database can send this alert' }, 403);

    if (event === 'dispatch') {
      const { data: a } = await sb.from('assignments').select('*').eq('id', body.id).single();
      if (!a || a.state !== 'dispatched') return json({ skipped: 'not dispatched' });
      const { data: i } = await sb.from('incidents').select('*').eq('id', a.incident_id).single();
      const { data: crew } = a.crew_id ? await sb.from('crews').select('name').eq('id', a.crew_id).single() : { data: null };
      const to = await users({ ids: a.user_id ? [a.user_id] : [], crewId: a.crew_id });
      const where = i?.compartment ?? i?.block ?? 'see map';
      const r = await sendPush(to, {
        title: `FIRE CALL-OUT · ${where}`,
        body: [crew?.name, i?.code ?? i?.label, a.instruction, i ? dd(i.lat, i.lon) : null].filter(Boolean).join(' · '),
        url: `/#/incident/${a.incident_id}`, tag: `dispatch-${a.id}`, urgent: true, kind: 'dispatch',
      });
      console.log(JSON.stringify({ alert: 'dispatch', recipients: to.length, ...r }));
      return json(r);
    }

    if (event === 'incident') {
      const { data: i } = await sb.from('incidents').select('*').eq('id', body.id).single();
      if (!i) return json({ skipped: 'no incident' });
      const to = await users({ all: true, except: i.reported_by }); // every crew member and coordinator, not just control
      const r = await sendPush(to, {
        title: `Fire reported · ${i.compartment ?? i.block ?? 'unmapped area'}`,
        body: `${i.status === 'reported' ? 'Unverified' : i.status} · by ${i.reported_by_name} · ${dd(i.lat, i.lon)}`,
        url: `/#/incident/${i.id}`, tag: `incident-${i.id}`, urgent: true, kind: 'incident',
      });
      console.log(JSON.stringify({ alert: 'incident', code: i.code, recipients: to.length, ...r }));
      return json(r);
    }

    return json({ error: `unknown event ${event}` }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
