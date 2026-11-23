// Hitchload admin: driver review, orders, disputes, CRA report.
// Built with esbuild into dist/ and served by the API server at /admin.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

const API = (window as unknown as { POPUTKA_API?: string }).POPUTKA_API ?? location.origin;
const TOKEN_KEY = 'poputka.admin.token';

let token: string | null = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? 'Request failed', json?.error?.details);
  return json as T;
}

const money = (c: number | null | undefined) => (c === null || c === undefined ? '—' : `$${(c / 100).toFixed(2)}`);
const dt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const STATUS_TONE: Record<string, string> = { open: 'wait', pending: 'wait', agreed: 'go', picked_up: 'go', in_transit: 'go', approved: 'go', delivered: 'done', cancelled: 'plain', rejected: 'bad', paused: 'bad', draft: 'plain' };

function Pill({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`pill ${tone ?? 'plain'}`}>{children}</span>;
}

function useData<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    load().then(setData).catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

// ---------------------------------------------------------------- sign in

function SignIn({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<{ phone: string; devCode?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="signin">
      <div className="brand">HITCHLOAD</div>
      <h1>Admin</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            if (!sent) setSent(await api('POST', '/v1/auth/otp/start', { phone }));
            else {
              const r = await api<{ token: string; user: { isAdmin: boolean } }>('POST', '/v1/auth/otp/verify', { phone: sent.phone, code });
              if (!r.user.isAdmin) throw new Error('This phone is not an admin. Add it to ADMIN_PHONES on the server.');
              token = r.token;
              try {
                localStorage.setItem(TOKEN_KEY, r.token);
              } catch {
                /* storage blocked: stay signed in for this tab */
              }
              onDone();
            }
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        {!sent ? (
          <label>
            Phone <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(780) 555-0123" autoFocus />
          </label>
        ) : (
          <label>
            SMS code {sent.devCode ? <small>(dev: {sent.devCode})</small> : null}
            <input id="code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoFocus />
          </label>
        )}
        <button className="primary" type="submit">{sent ? 'Sign in' : 'Send code'}</button>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </main>
  );
}

// ---------------------------------------------------------------- dashboard

function Dashboard() {
  const { data, error } = useData(() => api<Record<string, number>>('GET', '/v1/admin/stats'), []);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const tiles: [string, string, string?][] = [
    ['Drivers waiting for review', String(data.drivers_pending), '#drivers'],
    ['Open disputes', String(data.disputes_open), '#disputes'],
    ['Payouts on hold', String(data.payouts_held), '#orders'],
    ['Open orders', String(data.open_orders), '#orders'],
    ['Active orders', String(data.active_orders), '#orders'],
    ['Orders, last 24 h', String(data.orders_24h)],
    ['Delivered, 30 days', String(data.delivered_30d)],
    ['Fees earned, 30 days', money(data.fees_30d_cents)],
    ['Cancellation income, 30 days', money(data.cancel_income_30d_cents)],
    ['Cargo insurance collected, 30 days', money(data.insurance_30d_cents)],
    ['Approved drivers', String(data.drivers_approved)],
  ];
  return (
    <section>
      <h2>Overview</h2>
      <div className="tiles">
        {tiles.map(([label, value, href]) => (
          <a key={label} className={`tile ${href ? 'link' : ''}`} href={href}>
            <span className="num">{value}</span>
            <span className="muted">{label}</span>
          </a>
        ))}
      </div>
      <p className="muted small">Insurance collected is owed to the insurance partner; fees are platform revenue before Stripe costs.</p>
    </section>
  );
}

// ---------------------------------------------------------------- drivers

function Drivers({ openId }: { openId?: string }) {
  const [status, setStatus] = useState('pending');
  const { data, error, reload } = useData(() => api<any[]>('GET', `/v1/admin/drivers${status ? `?status=${status}` : ''}`), [status]);
  if (openId) return <DriverDetail id={openId} onChange={reload} />;
  return (
    <section>
      <h2>Drivers</h2>
      <div className="tabs">
        {['pending', 'approved', 'paused', 'draft', 'rejected', ''].map((s) => (
          <button key={s} className={s === status ? 'on' : ''} onClick={() => setStatus(s)}>{s || 'all'}</button>
        ))}
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Level</th><th>Identity</th><th>Background</th><th>Payouts</th><th>Jobs</th><th>Submitted</th></tr></thead>
          <tbody>
            {data?.map((d) => (
              <tr key={d.userId} onClick={() => (location.hash = `#drivers/${d.userId}`)} className="clickable">
                <td>{d.legalName ?? d.name ?? '—'}</td>
                <td>{d.phone}</td>
                <td><Pill tone={STATUS_TONE[d.status]}>{d.status}</Pill></td>
                <td>{d.tier}</td>
                <td>{d.identityStatus}</td>
                <td>{d.backgroundStatus}</td>
                <td>{d.payoutsEnabled ? '✓' : '—'}</td>
                <td>{d.completedJobs}</td>
                <td>{dt(d.submittedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.length === 0 ? <p className="muted">Nobody here.</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------- users

/** Ask, then delete. Returns a message for the toast, or null when the admin changed their mind. */
async function deleteUserFlow(u: { id: string; name: string | null; phone: string }): Promise<{ text: string; ok: boolean } | null> {
  const who = `${u.name ?? 'No name'} (${u.phone})`;
  if (!confirm(`Delete ${who}?\n\nIf this person has paid or taken orders, their name, phone, email and card are wiped and the account is closed; the orders and tax records stay for accounting. Otherwise everything is removed. This cannot be undone.`)) return null;
  try {
    const r = await api<{ mode: string }>('DELETE', `/v1/admin/users/${u.id}`);
    return { ok: true, text: r.mode === 'deleted' ? `${who}: deleted completely` : `${who}: personal data wiped, account closed (has order history, kept for accounting)` };
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
}

function Users() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, error, reload } = useData(() => api<any[]>('GET', `/v1/admin/users${search ? `?q=${encodeURIComponent(search)}` : ''}`), [search]);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 6000);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <section>
      <h2>Users</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setSearch(q); }}>
        <label className="grow">Search by name, phone or email <input id="user-search" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button type="submit">Search</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Driver</th><th className="num">Orders</th><th className="num">Jobs</th><th>Joined</th><th></th></tr></thead>
          <tbody>
            {data?.map((u) => (
              <tr key={u.id} data-user={u.phone}>
                <td>{u.name ?? '—'} {u.is_admin ? <Pill tone="done">admin</Pill> : null} {u.blocked ? <Pill tone="bad">blocked</Pill> : null}</td>
                <td>{u.phone}</td>
                <td>{u.email ?? '—'}</td>
                <td>{u.driver_status ? <a href={`#drivers/${u.id}`}><Pill tone={STATUS_TONE[u.driver_status]}>{u.driver_status}</Pill> {u.driver_tier}</a> : '—'}</td>
                <td className="num">{u.orders}</td>
                <td className="num">{u.jobs}</td>
                <td>{dt(u.created_at)}</td>
                <td>{u.is_admin ? null : (
                  <button className="danger delete-user" disabled={busy === u.id} onClick={async () => {
                    setBusy(u.id);
                    const r = await deleteUserFlow(u);
                    setBusy(null);
                    if (r) { setMsg(r); if (r.ok) reload(); }
                  }}>Delete</button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.length === 0 ? <p className="muted">Nobody found.</p> : null}
      {msg ? <div className={`toast-admin ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</div> : null}
    </section>
  );
}

const CHECK_LABEL: Record<string, string> = {
  profile: 'Personal details', vehicle: 'Vehicle', vehicle_photos: 'Vehicle photos (side + rear with plate)', license: "Driver's licence (both sides)", registration: 'Vehicle registration',
  delivery_insurance: 'Insurance covering deliveries', identity: 'ID check started', identity_verified: 'ID verified by Stripe',
  background_check: 'Criminal record check uploaded', background_clear: 'Criminal record check accepted', agreement: 'Rules + quiz', payouts: 'Payout account',
  documents_approved: 'All current documents reviewed',
};

const DOC_LABEL: Record<string, string> = {
  background_check: 'Criminal record check', license_front: "Driver's licence — front", license_back: "Driver's licence — back", registration: 'Vehicle registration',
  vehicle_side: 'Vehicle — side view', vehicle_rear: 'Vehicle — rear view (plate)',
  insurance_auto: 'Personal auto policy', insurance_endorsement: 'Delivery endorsement', insurance_commercial: 'Commercial auto policy',
  insurance_cargo: 'Cargo policy', insurance_car_hauling: 'Car hauling policy', safety_fitness_certificate: 'Safety fitness certificate', other: 'Other',
};
const DOC_ORDER = Object.keys(DOC_LABEL);

function DriverDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, error, reload } = useData(() => api<any>('GET', `/v1/admin/drivers/${id}`), [id]);
  const [tier, setTier] = useState('basic');
  const [cargo, setCargo] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) {
      setTier(data.driver.tier);
      // personal auto policy only (no delivery endorsement / commercial policy): $2,500 unless already approved with another limit
      const live = (k: string) => data.documents.some((d: any) => d.kind === k && d.status !== 'rejected');
      const personalOnly = live('insurance_auto') && !live('insurance_endorsement') && !live('insurance_commercial');
      const endorsed = live('insurance_endorsement') || live('insurance_commercial');
      const fresh = data.driver.status !== 'approved';
      setCargo(String(fresh && personalOnly ? 2500 : fresh && endorsed ? 4000 : data.driver.cargoLimitCents / 100));
    }
  }, [data]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const d = data.driver;
  const act = async (fn: () => Promise<unknown>, okText = 'Saved') => {
    setMsg(null);
    setBusy(true);
    try {
      await fn();
      setMsg({ text: okText, ok: true });
    } catch (e) {
      const err = e as ApiError;
      const missing = (err.details as { missing?: string[] } | undefined)?.missing;
      setMsg({ text: missing ? `${err.message}: ${missing.map((k) => CHECK_LABEL[k] ?? k).join(', ')}` : err.message, ok: false });
    } finally {
      setBusy(false);
      reload();
      onChange();
    }
  };
  const cargoCents = Math.round(Number(cargo) * 100);
  // newest document of each kind is the one that counts; older copies were replaced
  const docs: any[] = data.documents;
  const current = docs.filter((doc, i) => !docs.slice(0, i).some((x) => x.kind === doc.kind))
    .sort((x, y) => DOC_ORDER.indexOf(x.kind) - DOC_ORDER.indexOf(y.kind));
  const replaced = docs.filter((doc) => !current.includes(doc));
  const pendingDocs = current.filter((doc) => doc.status === 'pending');
  const missing: string[] = data.checklist.filter((c: { requiredToApprove: boolean; done: boolean }) => c.requiredToApprove && !c.done).map((c: { key: string }) => c.key);
  // what is still missing after "Accept all" would accept the pending documents
  const fixable = new Set<string>();
  if (pendingDocs.length) fixable.add('documents_approved');
  if (pendingDocs.some((x) => x.kind === 'background_check')) fixable.add('background_clear');
  const afterAcceptAll = missing.filter((k) => !fixable.has(k));
  const docCard = (doc: any, old = false) => (
    <div key={doc.id} className="card doc" style={old ? { opacity: 0.55 } : undefined}>
      <a href={doc.url} target="_blank" rel="noreferrer" className="thumb">
        {/\.pdf/.test(doc.url) ? 'PDF' : <img src={doc.url} alt={DOC_LABEL[doc.kind] ?? doc.kind} />}
      </a>
      <div>
        <strong>{DOC_LABEL[doc.kind] ?? doc.kind}</strong> <Pill tone={STATUS_TONE[doc.status === 'approved' ? 'approved' : doc.status]}>{doc.status}</Pill>
        {doc.insurer ? <p className="small">{doc.insurer} · {doc.policyNumber} · until {doc.expiresOn}{doc.coverageCents ? ` · cargo ${money(doc.coverageCents)}` : ''}</p> : null}
        {doc.kind === 'insurance_auto' && doc.riskAcknowledgedAt ? <p className="small">Driver confirmed the policy may not cover paid deliveries ({new Date(doc.riskAcknowledgedAt).toLocaleDateString('en-CA')})</p> : null}
        {doc.note ? <p className="small muted">{doc.note}</p> : null}
        {!old ? (
          <div className="row">
            <button disabled={busy || doc.status === 'approved'} onClick={() => act(() => api('POST', `/v1/admin/documents/${doc.id}/review`, { status: 'approved' }), `${DOC_LABEL[doc.kind] ?? doc.kind}: accepted`)}>Accept</button>
            <button className="danger" disabled={busy || doc.status === 'rejected'} onClick={() => act(() => api('POST', `/v1/admin/documents/${doc.id}/review`, { status: 'rejected', note: reason || 'Photo unreadable or document invalid' }), `${DOC_LABEL[doc.kind] ?? doc.kind}: rejected`)}>Reject</button>
          </div>
        ) : null}
      </div>
    </div>
  );
  return (
    <section>
      <a href="#drivers">← Drivers</a>
      <h2>{d.legalName ?? data.user.name ?? data.user.phone} <Pill tone={STATUS_TONE[d.status]}>{d.status}</Pill> <Pill>{d.tier}</Pill></h2>
      <p className="muted">{data.user.phone} · {data.user.email ?? 'no email'} · born {d.dateOfBirth ?? '—'} · {d.address ?? 'no address'} · works around {d.homeCity ?? '—'} ({d.radiusKm} km)</p>
      <div className="grid2">
        <div className="card">
          <h3>Checklist</h3>
          <ul className="checks">
            {data.checklist.map((c: { key: string; done: boolean; requiredToApprove: boolean }) => (
              <li key={c.key} className={c.done ? 'done' : c.requiredToApprove ? 'todo' : 'opt'}>{CHECK_LABEL[c.key] ?? c.key}</li>
            ))}
          </ul>
          <p className="small muted">Tax number: {d.taxInfo ? `${d.taxInfo.type.toUpperCase()} •••${d.taxInfo.last3}` : 'not yet (asked before first payout)'}</p>
        </div>
        <div className="card">
          <h3>Vehicles</h3>
          {data.vehicles.map((v: any) => (
            <p key={v.id}><b>{v.year} {v.make} {v.model}</b> · plate <b>{v.plate}</b> · {v.type} · up to {v.maxSize} · {v.registeredWeightKg} kg{v.needsFederalSfc ? ' · needs federal SFC for interprovincial' : ''}</p>
          ))}
          <p className="small muted">Compare the plate with the rear photo below.</p>
        </div>
      </div>
      <h3>Documents ({pendingDocs.length} waiting for review)</h3>
      <div className="docs">{current.map((doc) => docCard(doc))}</div>
      {replaced.length ? (
        <details className="card">
          <summary>Replaced by newer uploads ({replaced.length})</summary>
          <div className="docs">{replaced.map((doc) => docCard(doc, true))}</div>
        </details>
      ) : null}
      <div className="card" id="decision">
        <h3>Decision</h3>
        {missing.length ? (
          <p className="notice-box">Still needed to approve: <b>{missing.map((k) => CHECK_LABEL[k] ?? k).join(', ')}</b></p>
        ) : <p className="ok">Everything is in place: the driver can be approved.</p>}
        <div className="row">
          <label>Level <select id="tier" value={tier} onChange={(e) => setTier(e.target.value)}><option value="basic">Basic</option><option value="pro">Pro</option></select></label>
          {tier === 'pro' ? <span className="small muted">Pro: no cargo value limit</span> : <label>Cargo limit, $ <input id="cargo" value={cargo} onChange={(e) => setCargo(e.target.value)} size={8} /></label>}
          <label className="grow">Reason / note <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Shown to the driver when rejecting a document, rejecting or pausing" /></label>
        </div>
        <div className="row">
          <button className="primary" id="approve-all" disabled={busy || afterAcceptAll.length > 0} title={afterAcceptAll.length ? 'Not possible yet: ' + afterAcceptAll.map((k) => CHECK_LABEL[k] ?? k).join(', ') : ''}
            onClick={() => act(() => api('POST', `/v1/admin/drivers/${id}/approve-all`, { tier, ...(tier === 'pro' ? {} : { cargoLimitCents: cargoCents }) }), 'Approved')}>
            Accept all documents & approve
          </button>
          <button id="approve" disabled={busy || missing.length > 0} onClick={() => act(() => api('POST', `/v1/admin/drivers/${id}/decision`, { status: 'approved', tier, ...(tier === 'pro' ? {} : { cargoLimitCents: cargoCents }) }), 'Approved')}>Approve</button>
          <button disabled={busy} onClick={() => act(() => api('POST', `/v1/admin/drivers/${id}/decision`, { status: 'paused', ...(reason ? { reason } : {}) }), 'Paused')}>Pause</button>
          <button className="danger" disabled={busy} onClick={() => act(() => api('POST', `/v1/admin/drivers/${id}/decision`, { status: 'rejected', ...(reason ? { reason } : {}) }), 'Rejected')}>Reject driver</button>
          <button disabled={busy} onClick={() => act(() => api('POST', `/v1/admin/users/${id}/block`, { blocked: true }), 'Account blocked')}>Block account</button>
          <button className="danger" id="delete-user" disabled={busy} onClick={async () => {
            const r = await deleteUserFlow({ id, name: data.driver?.legalName ?? data.user?.name ?? null, phone: data.user?.phone ?? '' });
            if (!r) return;
            if (r.ok) { onChange(); location.hash = '#users'; } else setMsg(r);
          }}>Delete user</button>
        </div>
        {afterAcceptAll.length && missing.length ? <p className="small muted">“Accept all” cannot fix: {afterAcceptAll.map((k) => CHECK_LABEL[k] ?? k).join(', ')}. The driver has to complete these.</p> : null}
        <p className="small muted">Basic with a delivery endorsement or commercial auto policy: $4,000. Basic with a personal auto policy only: $2,500 (cannot go higher). Otherwise $1,000. When the customer buys cargo insurance, Basic drivers can take items up to at least $5,000. These limits are filled in automatically. Pro: commercial auto + cargo policy, takes any order with no cargo value limit.</p>
        {msg ? <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</p> : null}
      </div>
      {msg ? <div className={`toast-admin ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</div> : null}
    </section>
  );
}

// ---------------------------------------------------------------- orders

function Orders({ openId }: { openId?: string }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error } = useData(() => api<any[]>('GET', `/v1/admin/orders?${new URLSearchParams({ ...(status ? { status } : {}), ...(query ? { q: query } : {}) })}`), [status, query]);
  if (openId) return <OrderDetail id={openId} />;
  return (
    <section>
      <h2>Orders</h2>
      <div className="row">
        <div className="tabs">
          {['', 'open', 'agreed', 'picked_up', 'in_transit', 'delivered', 'cancelled'].map((s) => (
            <button key={s} className={s === status ? 'on' : ''} onClick={() => setStatus(s)}>{s || 'all'}</button>
          ))}
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
          <input id="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order # or phone" />
          <button type="submit">Search</button>
        </form>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Created</th><th>Route</th><th>Status</th><th>Customer</th><th>Driver</th><th className="num">Charged</th><th>Payout</th></tr></thead>
          <tbody>
            {data?.map((o) => (
              <tr key={o.id} className="clickable" onClick={() => (location.hash = `#orders/${o.id}`)}>
                <td>{o.number}</td>
                <td>{dt(o.createdAt)}</td>
                <td>{o.pickup.city} → {o.dropoff.city}</td>
                <td><Pill tone={STATUS_TONE[o.status]}>{o.status}</Pill></td>
                <td>{o.clientPhone}</td>
                <td>{o.driverPhone ?? '—'}</td>
                <td className="num">{money(o.chargedCents)}</td>
                <td>{o.payoutHeldReason ? <Pill tone="bad">{o.payoutHeldReason}</Pill> : o.transferId ? 'sent' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrderDetail({ id }: { id: string }) {
  const { data, error } = useData(() => api<any>('GET', `/v1/admin/orders/${id}`), [id]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const o = data.order;
  return (
    <section>
      <a href="#orders">← Orders</a>
      <h2>Order #{o.number} <Pill tone={STATUS_TONE[o.status]}>{o.status}</Pill></h2>
      <div className="grid2">
        <div className="card">
          <p><strong>From</strong> {o.pickup.address}, {o.pickup.city} {o.pickup.province}</p>
          <p><strong>To</strong> {o.dropoff.address}, {o.dropoff.city} {o.dropoff.province}</p>
          <p className="muted">{o.distanceKm} km · {o.size} · {o.description || 'no description'} · declared {money(o.declaredValueCents)}{o.insured ? ' · insured' : ''}</p>
          <p className="muted">Loading window {dt(o.windowStart)} – {dt(o.windowEnd)}</p>
        </div>
        <div className="card money">
          <p><span>Asked</span><span>{money(o.priceCents)}</span></p>
          <p><span>Agreed (to driver)</span><span>{money(o.agreedCents)}</span></p>
          <p><span>Customer fee</span><span>{money(o.clientFeeCents)}</span></p>
          <p><span>Driver fee</span><span>{money(o.driverFeeCents)}</span></p>
          <p><span>Insurance</span><span>{money(o.insuranceCents)}</span></p>
          <p><span>Charged</span><span>{money(o.chargedCents)}</span></p>
          <p><span>Refunded</span><span>{money(o.refundCents)}</span></p>
          <p><span>Driver compensation</span><span>{money(o.driverCompCents)}</span></p>
          <p className="small muted">{o.paymentIntentId ?? ''} {o.transferId ?? ''}</p>
        </div>
      </div>
      {data.photos.length ? (
        <>
          <h3>Photos</h3>
          <div className="row">{data.photos.map((p: any) => <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="thumb"><img src={p.url} alt={p.stage} /><span className="small">{p.stage}</span></a>)}</div>
        </>
      ) : null}
      <div className="grid2">
        <div className="card">
          <h3>Timeline</h3>
          <ol className="timeline">
            {data.events.map((e: any) => <li key={e.id}><span className="muted small">{dt(e.createdAt)}</span> <strong>{e.type}</strong> <code>{JSON.stringify(e.data) === '{}' ? '' : JSON.stringify(e.data)}</code></li>)}
          </ol>
        </div>
        <div className="card">
          <h3>Chat</h3>
          {data.messages.length === 0 ? <p className="muted">No messages.</p> : null}
          {data.messages.map((m: any) => (
            <p key={m.id} className="small"><span className="muted">{dt(m.createdAt)} · {m.senderId === null ? 'system' : m.senderId === o.clientId ? 'customer' : 'driver'}:</span> {m.body} {m.contactHidden ? <Pill tone="wait">contact hidden</Pill> : null}</p>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- disputes

function Disputes() {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const { data, error, reload } = useData(() => api<any[]>('GET', `/v1/admin/disputes?status=${status}`), [status]);
  return (
    <section>
      <h2>Disputes</h2>
      <div className="tabs">{(['open', 'resolved'] as const).map((s) => <button key={s} className={s === status ? 'on' : ''} onClick={() => setStatus(s)}>{s}</button>)}</div>
      {error ? <p className="error">{error}</p> : null}
      {data?.length === 0 ? <p className="muted">No disputes.</p> : null}
      {data?.map((d) => <DisputeCard key={d.id} d={d} onDone={reload} />)}
    </section>
  );
}

function DisputeCard({ d, onDone }: { d: any; onDone: () => void }) {
  const [resolution, setResolution] = useState('');
  const [action, setAction] = useState('none');
  const [refund, setRefund] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="card">
      <p><a href={`#orders/${d.order_id}`}>Order #{d.number}</a> · <Pill tone={STATUS_TONE[d.order_status]}>{d.order_status}</Pill> · opened by {d.opened_by_phone} · {dt(d.created_at)}</p>
      <p>{d.reason}</p>
      {d.status === 'resolved' ? (
        <p className="muted">Resolved: {d.resolution}</p>
      ) : (
        <>
          <div className="row">
            <label className="grow">Resolution (sent to both sides) <input value={resolution} onChange={(e) => setResolution(e.target.value)} /></label>
            <label>Action
              <select value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="none">No money movement</option>
                <option value="refund">Refund part of the charge</option>
                <option value="no_show">No cargo at pickup (40% + 10%)</option>
              </select>
            </label>
            {action === 'refund' ? <label>Refund, $ <input value={refund} onChange={(e) => setRefund(e.target.value)} size={7} /></label> : null}
          </div>
          <button
            className="primary"
            disabled={resolution.trim().length < 3}
            onClick={async () => {
              setErr(null);
              try {
                await api('POST', `/v1/admin/disputes/${d.id}/resolve`, { resolution, action, ...(action === 'refund' ? { refundCents: Math.round(Number(refund) * 100) } : {}) });
                onDone();
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >Resolve</button>
          {err ? <p className="error">{err}</p> : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- reports

function Reports() {
  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [state, setState] = useState<{ url: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section>
      <h2>CRA platform report</h2>
      <p>Under Part XX of the Income Tax Act, Hitchload must report every driver's earnings to CRA by <strong>January 31</strong> for the previous calendar year. This export has the data per driver and quarter; your accountant files it in CRA's XML format.</p>
      <div className="row">
        <label>Year <input id="year" value={year} onChange={(e) => setYear(e.target.value)} size={6} /></label>
        <button
          className="primary"
          onClick={async () => {
            setErr(null);
            try {
              const res = await fetch(`${API}/v1/admin/reports/cra?year=${encodeURIComponent(year)}`, { headers: { Authorization: `Bearer ${token}` } });
              if (!res.ok) throw new Error((await res.json()).error?.message ?? 'Export failed');
              const blob = await res.blob();
              setState({ url: URL.createObjectURL(blob), name: `cra-platform-report-${year}.csv` });
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >Prepare CSV</button>
        {state ? <a className="button" href={state.url} download={state.name}>Download {state.name}</a> : null}
      </div>
      <p className="small muted">Drivers marked missing_tin=yes have not given a SIN or BN. Their payouts are held until they do.</p>
      {err ? <p className="error">{err}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------- shell

function App() {
  const [signedIn, setSignedIn] = useState(Boolean(token));
  const [hash, setHash] = useState(location.hash || '#overview');
  useEffect(() => {
    const on = () => setHash(location.hash || '#overview');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;
  const [page, id] = hash.slice(1).split('/');
  const nav: [string, string][] = [['overview', 'Overview'], ['users', 'Users'], ['drivers', 'Drivers'], ['orders', 'Orders'], ['disputes', 'Disputes'], ['reports', 'Reports']];
  return (
    <>
      <header>
        <div className="brand small">HITCHLOAD</div>
        <nav>{nav.map(([k, label]) => <a key={k} href={`#${k}`} className={page === k ? 'on' : ''}>{label}</a>)}</nav>
        <button className="ghost" onClick={() => { token = null; try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } setSignedIn(false); }}>Sign out</button>
      </header>
      <main>
        {page === 'users' ? <Users /> : page === 'drivers' ? <Drivers openId={id} /> : page === 'orders' ? <Orders openId={id} /> : page === 'disputes' ? <Disputes /> : page === 'reports' ? <Reports /> : <Dashboard />}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
