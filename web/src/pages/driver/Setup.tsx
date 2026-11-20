// Driver application on one page: details, vehicle, documents, ID check, payouts, rules, submit.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { Link, useApp, useLoad, useLocation } from '../../lib/app';
import { ErrorSummary, useFormErrors, type Errors } from '../../lib/form';
import { dollarsToCents, money } from '../../lib/format';
import type { DriverOverview } from '../../lib/types';
import { Button, Card, Check, CityInput, ErrorBox, Field, Loading, Notice, PageHead, PhotoUpload, Pill, RequireAuth, cityLabel } from '../../lib/ui';

export function Setup() {
  return <RequireAuth><SetupPage /></RequireAuth>;
}

const VEHICLES = ['car', 'suv', 'pickup', 'van', 'cargo_van', 'box_truck', 'tow_truck', 'car_hauler'] as const;
const INSURANCE = ['insurance_endorsement', 'insurance_commercial', 'insurance_cargo', 'insurance_car_hauling', 'insurance_auto'] as const;
type Act = (f: () => Promise<unknown>) => Promise<boolean>;

/** Where each checklist item lives on the page, so "Submit" can point at what is missing. */
const CK_ANCHOR: Record<string, string> = {
  profile: 'sec-profile', vehicle: 'sec-vehicle', license: 'doc-card-license_front', registration: 'doc-card-registration',
  vehicle_photos: 'doc-card-vehicle_side', delivery_insurance: 'ins-card', background_check: 'doc-card-background_check',
  identity: 'sec-identity', identity_verified: 'sec-identity', payouts: 'sec-payouts', agreement: 'sec-agreement',
};

function SetupPage() {
  const { t, me, refreshMe, err } = useApp();
  const { query } = useLocation();
  const { data, error, loading, reload, setData } = useLoad<DriverOverview | null>(() => (me?.driver ? api.driver() : Promise.resolve(null)), [me?.driver ? 1 : 0]);
  const [actErr, setActErr] = useState<string | null>(null);
  const [missingShown, setMissingShown] = useState<string[]>([]);
  const done = query.get('done');

  // back from Stripe: re-read payout status
  useEffect(() => {
    if (done === 'payouts' && me?.driver) void api.refreshPayouts().then(setData).catch(() => undefined);
    if (done === 'identity' && me?.driver) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const act: Act = async (fn) => {
    setActErr(null);
    try {
      await fn();
      await reload();
      await refreshMe();
      return true;
    } catch (e) {
      setActErr(err(e));
      return false;
    }
  };

  if (!me?.driver) {
    return (
      <div className="page narrow-page">
        <PageHead title={t('driverSetupTitle')} text={t('driverSetupText')} />
        <Button kind="primary" onClick={() => act(async () => { await api.startDriver(); await refreshMe(); })}>{t('startDriver')}</Button>
        {actErr ? <Notice tone="bad">{actErr}</Notice> : null}
      </div>
    );
  }
  if (!data) return loading ? <Loading /> : <ErrorBox error={error} onRetry={reload} />;

  const ck = (k: string) => data.checklist.some((c) => c.key === k && c.done);
  const d = data.driver;
  const editable = d.status === 'draft' || d.status === 'rejected';
  const required = data.checklist.filter((c) => c.requiredToSubmit);
  const missingKeys = required.filter((c) => !c.done).map((c) => c.key);
  const statusTone = d.status === 'approved' ? 'go' : d.status === 'pending' ? 'wait' : d.status === 'draft' ? undefined : 'bad';
  const flagged = (k: string) => missingShown.includes(k) && missingKeys.includes(k);

  const submit = async () => {
    if (missingKeys.length) {
      setMissingShown(missingKeys);
      const el = document.getElementById(CK_ANCHOR[missingKeys[0]!] ?? 'sec-profile');
      if (el) {
        if (el instanceof HTMLDetailsElement) el.open = true;
        el.closest('details')?.setAttribute('open', '');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      return;
    }
    await act(() => api.submitDriver());
  };

  return (
    <div className="page">
      <PageHead title={t('driverSetupTitle')} text={t('driverSetupText')} back="/driver" />
      <Card hl={d.status === 'approved'}>
        <div className="row between">
          <b>{t(`ds_${d.status}`)}</b>
          <span className="row"><Pill tone={statusTone}>{t(`tier_${d.tier}`)}</Pill><span className="small muted">{t('cargoLimit', { amount: money(d.cargoLimitCents) })}</span></span>
        </div>
        {d.pausedReason ? <p className="small">{d.pausedReason}</p> : null}
        {d.status === 'pending' ? <p className="small muted">{t('pendingNote')}</p> : null}
        {d.status === 'approved' ? <p className="small muted">{t('approvedNote')} <Link to="/driver/trips">{t('myTrips')}</Link></p> : null}
        <p className="small">{t('setupProgress', { done: required.filter((c) => c.done).length, total: required.length })}</p>
        <ul className="checks">
          {data.checklist.map((c) => <li key={c.key} className={`${c.done ? 'done' : c.requiredToSubmit ? 'todo' : 'opt'} ${flagged(c.key) ? 'err' : ''}`}>{t(`ck_${c.key}` as 'ck_profile')}</li>)}
        </ul>
      </Card>
      {actErr ? <Notice tone="bad">{actErr}</Notice> : null}

      <Section id="sec-profile" n={1} title={t('step_profile')} done={ck('profile')} invalid={flagged('profile')}>
        <ProfileForm data={data} editable={editable} act={act} />
      </Section>
      <Section id="sec-vehicle" n={2} title={t('step_vehicle')} done={ck('vehicle')} invalid={flagged('vehicle')}>
        <VehicleForm data={data} act={act} />
      </Section>
      <Section n={3} title={t('step_documents')} done={ck('license') && ck('registration') && ck('delivery_insurance') && ck('background_check') && ck('vehicle_photos')}
        invalid={['license', 'registration', 'delivery_insurance', 'background_check', 'vehicle_photos'].some(flagged)}>
        <Documents data={data} act={act} flagged={flagged} />
      </Section>
      <Section id="sec-identity" n={4} title={t('step_identity')} done={ck('identity_verified')} invalid={flagged('identity') || flagged('identity_verified')}>
        <p>{t('identityText')}</p>
        <p className="small">{t(`identity_${d.identityStatus}` as 'identity_none')}</p>
        {d.identityStatus !== 'verified' ? <Button kind="primary" onClick={() => act(async () => { const r = await api.identity(); location.href = r.url; })}>{t('startIdentity')}</Button> : null}
      </Section>
      <Section id="sec-payouts" n={5} title={t('step_payouts')} done={d.payoutsEnabled} invalid={flagged('payouts')}>
        <p>{t('payoutsText')}</p>
        {d.payoutsEnabled ? <Notice tone="go">{t('payoutsOn')}</Notice> : (
          <div className="row">
            <Button kind="primary" onClick={() => act(async () => { const r = await api.payouts(); location.href = r.url; })}>{t('startPayouts')}</Button>
            {d.payoutsStarted ? <Button kind="ghost" onClick={() => act(() => api.refreshPayouts())}>{t('refreshStatus')}</Button> : null}
          </div>
        )}
      </Section>
      <Section id="sec-agreement" n={6} title={t('step_agreement')} done={ck('agreement')} invalid={flagged('agreement')}>
        {ck('agreement') ? <p className="small muted">✓</p> : <Quiz act={act} />}
      </Section>
      {editable ? (
        <Section n={7} title={t('step_submit')} done={false}>
          {missingShown.length && missingKeys.length ? (
            <div className="notice bad error-summary" role="alert">{t('missing', { list: missingKeys.map((k) => t(`ck_${k}` as 'ck_profile')).join(', ') })}</div>
          ) : missingKeys.length ? <p className="small muted">{t('missing', { list: missingKeys.map((k) => t(`ck_${k}` as 'ck_profile')).join(', ') })}</p> : null}
          <Button kind="primary" id="submit-driver" onClick={submit}>{t('submitReview')}</Button>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ n, title, done, children, id, invalid }: { n: number; title: string; done: boolean; children: ReactNode; id?: string; invalid?: boolean }) {
  return (
    <details className={`card section ${invalid ? 'invalid' : ''}`} open={!done || invalid} id={id}>
      <summary><span className={`num ${done ? 'done' : ''}`}>{done ? '✓' : n}</span> {title}</summary>
      <div className="stack">{children}</div>
    </details>
  );
}

function ageOn(dob: string, now = new Date()) {
  const [y, m, d] = dob.split('-').map(Number);
  if (!y || !m || !d) return -1;
  let a = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a -= 1;
  return a;
}

function ProfileForm({ data, editable, act }: { data: DriverOverview; editable: boolean; act: Act }) {
  const { t, me, cities } = useApp();
  const d = data.driver;
  const f = useFormErrors();
  const [legalName, setLegalName] = useState(d.legalName ?? me?.name ?? '');
  const [dob, setDob] = useState(d.dateOfBirth ?? '');
  const [address, setAddress] = useState(d.address ?? '');
  const home = d.homeCity ? cities.find((c) => c.city === d.homeCity) : undefined;
  const [city, setCity] = useState(home ? cityLabel(home) : '');
  const [radius, setRadius] = useState(String(d.radiusKm ?? 40));
  const [quietFrom, setQuietFrom] = useState(d.quietFrom ?? '');
  const [quietTo, setQuietTo] = useState(d.quietTo ?? '');
  const c = cities.find((x) => cityLabel(x) === city);
  const labels = { legalName: t('legalName'), dob: t('dob'), address: t('homeAddress'), city: t('homeCity'), radius: t('radius') };
  return (
    <form className="stack" noValidate onSubmit={(e) => {
      e.preventDefault();
      const r = Number(radius);
      const errs: Errors = {
        legalName: editable && legalName.trim().split(/\s+/).length < 2 ? t('errLegalName') : '',
        dob: editable && !dob ? t('errRequired') : editable && ageOn(dob) < 18 ? t('errAge') : '',
        address: address.trim().length < 5 ? t('errAddress') : '',
        city: !c ? t('errCity') : '',
        radius: !Number.isFinite(r) || r < 5 || r > 300 ? t('errRadius') : '',
      };
      if (!f.check(errs)) return;
      void act(() => api.updateDriver({
        ...(editable ? { legalName: legalName.trim(), dateOfBirth: dob } : {}),
        address: address.trim(), ...(c ? { homeCity: c.city, home: { lat: c.lat, lng: c.lng } } : {}), radiusKm: r,
        quietFrom: quietFrom || null, quietTo: quietTo || null,
      }).catch((e2) => {
        if (!f.fromServer(e2, { too_young: 'dob' }, { legalName: 'legalName', dateOfBirth: 'dob', address: 'address', homeCity: 'city', home: 'city', radiusKm: 'radius' })) throw e2;
      }));
    }}>
      <div className="grid2">
        <Field name="legalName" error={f.errors.legalName} label={t('legalName')}><input id="legal-name" value={legalName} disabled={!editable} onChange={(e) => { setLegalName(e.target.value); f.clear('legalName'); }} /></Field>
        <Field name="dob" error={f.errors.dob} label={t('dob')}><input id="dob" type="date" value={dob} disabled={!editable} onChange={(e) => { setDob(e.target.value); f.clear('dob'); }} /></Field>
      </div>
      <Field name="address" error={f.errors.address} label={t('homeAddress')}><input id="home-address" value={address} autoComplete="street-address" onChange={(e) => { setAddress(e.target.value); f.clear('address'); }} /></Field>
      <div className="grid2">
        <Field name="city" error={f.errors.city} label={t('homeCity')}><CityInput id="home-city" value={city} onChange={(v) => { setCity(v); f.clear('city'); }} /></Field>
        <Field name="radius" error={f.errors.radius} label={t('radius')}><input id="radius" type="number" min={5} max={300} value={radius} onChange={(e) => { setRadius(e.target.value); f.clear('radius'); }} /></Field>
      </div>
      <Field label={t('quietHours')}>
        <div className="row"><input type="time" value={quietFrom} onChange={(e) => setQuietFrom(e.target.value)} aria-label="from" /> – <input type="time" value={quietTo} onChange={(e) => setQuietTo(e.target.value)} aria-label="to" /></div>
      </Field>
      <ErrorSummary errors={f.errors} labels={labels} />
      <Button kind="primary" type="submit" id="save-profile">{t('save')}</Button>
    </form>
  );
}

function VehicleForm({ data, act }: { data: DriverOverview; act: Act }) {
  const { t } = useApp();
  const f = useFormErrors();
  const [type, setType] = useState<(typeof VEHICLES)[number]>('pickup');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [plate, setPlate] = useState('');
  const [weight, setWeight] = useState('');
  const [trailer, setTrailer] = useState(false);
  const labels = { make: t('make'), model: t('model'), year: t('year'), plate: t('plate'), weight: t('gvw') };
  const thisYear = new Date().getFullYear();
  return (
    <>
      {data.vehicles.map((v) => (
        <div key={v.id} className="row between vehicle">
          <span><b>{v.year} {v.make} {v.model}</b> · {v.plate} · {t(`vt_${v.type}` as 'vt_car')} · {t('maxSize', { size: t(`size${v.maxSize}`) })}</span>
          {data.vehicles.length > 1 ? <Button small kind="ghost" onClick={() => act(() => api.removeVehicle(v.id))}>{t('removeStop')}</Button> : null}
        </div>
      ))}
      <form className="stack" noValidate onSubmit={(e) => {
        e.preventDefault();
        const y = Number(year);
        const errs: Errors = {
          make: !make.trim() ? t('errRequired') : '',
          model: !model.trim() ? t('errRequired') : '',
          year: year.length !== 4 || y < 1990 || y > thisYear + 1 ? t('errYear', { max: thisYear + 1 }) : '',
          plate: plate.trim().length < 2 ? t('errPlate') : '',
          weight: Number(weight) < 500 || Number(weight) > 40000 ? t('errGvw') : '',
        };
        if (!f.check(errs)) return;
        void act(async () => {
          try {
            await api.addVehicle({ type, make, model, year: y, plate, registeredWeightKg: Number(weight), hasTrailer: trailer });
          } catch (e2) {
            if (!f.fromServer(e2, {}, { make: 'make', model: 'model', year: 'year', plate: 'plate', registeredWeightKg: 'weight' })) throw e2;
            return;
          }
          setMake(''); setModel(''); setYear(''); setPlate(''); setWeight('');
        });
      }}>
        <div className="grid3">
          <Field label={t('vehicleType')}>
            <select id="vehicle-type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              {VEHICLES.map((v) => <option key={v} value={v}>{t(`vt_${v}`)}</option>)}
            </select>
          </Field>
          <Field name="make" error={f.errors.make} label={t('make')}><input id="make" value={make} onChange={(e) => { setMake(e.target.value); f.clear('make'); }} /></Field>
          <Field name="model" error={f.errors.model} label={t('model')}><input id="model" value={model} onChange={(e) => { setModel(e.target.value); f.clear('model'); }} /></Field>
          <Field name="year" error={f.errors.year} label={t('year')}><input id="year" inputMode="numeric" maxLength={4} value={year} onChange={(e) => { setYear(e.target.value.replace(/\D/g, '')); f.clear('year'); }} /></Field>
          <Field name="plate" error={f.errors.plate} label={t('plate')}><input id="plate" value={plate} onChange={(e) => { setPlate(e.target.value.toUpperCase()); f.clear('plate'); }} /></Field>
          <Field name="weight" error={f.errors.weight} label={t('gvw')}><input id="gvw" inputMode="numeric" value={weight} onChange={(e) => { setWeight(e.target.value.replace(/\D/g, '')); f.clear('weight'); }} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={trailer} onChange={(e) => setTrailer(e.target.checked)} /><span>{t('trailer')}</span></label>
        <ErrorSummary errors={f.errors} labels={labels} />
        <Button type="submit" id="add-vehicle" kind={data.vehicles.length ? 'secondary' : 'primary'}>{t('addVehicle')}</Button>
      </form>
    </>
  );
}

function Documents({ data, act, flagged }: { data: DriverOverview; act: Act; flagged: (k: string) => boolean }) {
  const { t } = useApp();
  const has = (k: string) => data.documents.some((d) => d.kind === k && d.status !== 'rejected');
  const simple: { kind: string; label: string; ck: string }[] = [
    { kind: 'license_front', label: t('dk_license_front'), ck: 'license' },
    { kind: 'license_back', label: t('dk_license_back'), ck: 'license' },
    { kind: 'registration', label: t('dk_registration'), ck: 'registration' },
    { kind: 'background_check', label: t('dk_background_check'), ck: 'background_check' },
  ];
  const photos: { kind: 'vehicle_side' | 'vehicle_rear'; label: string; how: string }[] = [
    { kind: 'vehicle_side', label: t('dk_vehicle_side'), how: t('vehicleSideHow') },
    { kind: 'vehicle_rear', label: t('dk_vehicle_rear'), how: t('vehicleRearHow') },
  ];
  const upload = (kind: string) => (k: { key: string; url: string }[]) => { if (k[0]) void act(() => api.addDocument({ kind, fileKey: k[0]!.key })); };
  return (
    <>
      <p className="small muted">{t('docsHint')}</p>
      <div className="doc-grid">
        {simple.map((s) => {
          const bad = flagged(s.ck) && !has(s.kind);
          return (
            <div key={s.kind} id={`doc-card-${s.kind}`} className={`card doc ${has(s.kind) ? 'hl' : ''} ${bad ? 'invalid' : ''}`}>
              <b>{s.label}</b>
              <DocStatus data={data} kind={s.kind} />
              <PhotoUpload id={`doc-${s.kind}`} purpose="document" keys={[]} max={1} accept="image/*,application/pdf" label={has(s.kind) ? t('replaceFile') : t('upload')}
                invalid={bad ? t('errUploadThis') : null} onChange={upload(s.kind)} />
            </div>
          );
        })}
      </div>
      <b>{t('vehiclePhotosTitle')}</b>
      <p className="small muted">{t('vehiclePhotosText')}</p>
      <div className="doc-grid">
        {photos.map((p) => {
          const bad = flagged('vehicle_photos') && !has(p.kind);
          return (
            <div key={p.kind} id={`doc-card-${p.kind}`} className={`card doc ${has(p.kind) ? 'hl' : ''} ${bad ? 'invalid' : ''}`}>
              <b>{p.label}</b>
              <figure className="example">
                {p.kind === 'vehicle_side' ? <SideExample /> : <RearExample />}
                <figcaption className="small muted">{t('exampleLabel')} · {p.how}</figcaption>
              </figure>
              <DocStatus data={data} kind={p.kind} />
              <PhotoUpload id={`doc-${p.kind}`} purpose="document" keys={[]} max={1} accept="image/*" label={has(p.kind) ? t('replaceFile') : t('upload')}
                invalid={bad ? t('errUploadThis') : null} onChange={upload(p.kind)} />
            </div>
          );
        })}
      </div>
      <InsuranceForm data={data} act={act} invalid={flagged('delivery_insurance')} />
    </>
  );
}

/** Example: the whole vehicle from the side, wheels and both ends in the frame. */
function SideExample() {
  return (
    <svg viewBox="0 0 240 130" role="img" aria-label="Side view example" className="example-svg">
      <rect x="1" y="1" width="238" height="128" rx="10" fill="var(--chip, #f2f4f3)" stroke="currentColor" strokeOpacity=".25" />
      <line x1="8" y1="104" x2="232" y2="104" stroke="currentColor" strokeOpacity=".35" strokeWidth="2" />
      <path d="M28 92 V70 Q28 64 34 63 L74 60 L96 38 Q100 34 108 34 H146 Q152 34 154 40 L160 60 H206 Q214 60 214 68 V92 Z" fill="#2f7d5b" stroke="#17402e" strokeWidth="2" />
      <path d="M100 42 L82 60 H122 V42 Z M128 42 V60 H154 L149 42 Z" fill="#cfe6f5" stroke="#17402e" strokeWidth="1.5" />
      <line x1="160" y1="60" x2="160" y2="92" stroke="#17402e" strokeWidth="1.5" />
      <circle cx="62" cy="94" r="13" fill="#222" /><circle cx="62" cy="94" r="5" fill="#bbb" />
      <circle cx="182" cy="94" r="13" fill="#222" /><circle cx="182" cy="94" r="5" fill="#bbb" />
      <g stroke="#0b6b45" strokeWidth="3" fill="none">
        <path d="M14 26 V14 H26" /><path d="M214 14 H226 V26" /><path d="M14 104 V116 H26" /><path d="M214 116 H226 V104" />
      </g>
    </svg>
  );
}

/** Example: straight from behind, the licence plate sharp and readable. */
function RearExample() {
  return (
    <svg viewBox="0 0 240 130" role="img" aria-label="Rear view example with plate" className="example-svg">
      <rect x="1" y="1" width="238" height="128" rx="10" fill="var(--chip, #f2f4f3)" stroke="currentColor" strokeOpacity=".25" />
      <line x1="8" y1="112" x2="232" y2="112" stroke="currentColor" strokeOpacity=".35" strokeWidth="2" />
      <path d="M66 22 H174 Q182 22 184 30 L192 58 H48 L56 30 Q58 22 66 22 Z" fill="#cfe6f5" stroke="#17402e" strokeWidth="2" />
      <rect x="40" y="56" width="160" height="44" rx="8" fill="#2f7d5b" stroke="#17402e" strokeWidth="2" />
      <rect x="46" y="64" width="24" height="12" rx="3" fill="#d23b2f" /><rect x="170" y="64" width="24" height="12" rx="3" fill="#d23b2f" />
      <rect x="44" y="100" width="22" height="12" rx="3" fill="#222" /><rect x="174" y="100" width="22" height="12" rx="3" fill="#222" />
      <rect x="90" y="74" width="60" height="22" rx="3" fill="#fff" stroke="#17402e" strokeWidth="1.5" />
      <text x="120" y="90" textAnchor="middle" fontFamily="ui-monospace, monospace" fontWeight="700" fontSize="13" fill="#1a3d8f">ABC 123</text>
      <rect x="84" y="69" width="72" height="32" rx="5" fill="none" stroke="#e8a33d" strokeWidth="3" strokeDasharray="6 4" />
    </svg>
  );
}

function DocStatus({ data, kind }: { data: DriverOverview; kind: string }) {
  const { t } = useApp();
  const doc = data.documents.find((d) => d.kind === kind);
  if (!doc) return null;
  return (
    <span className="small">
      <Pill tone={doc.status === 'approved' ? 'go' : doc.status === 'pending' ? 'wait' : 'bad'}>{t(doc.status === 'approved' ? 'docApproved' : doc.status === 'pending' ? 'docPending' : 'docRejected')}</Pill>
      {doc.note ? <span className="muted"> {doc.note}</span> : null}
    </span>
  );
}

function InsuranceForm({ data, act, invalid }: { data: DriverOverview; act: Act; invalid?: boolean }) {
  const { t } = useApp();
  const f = useFormErrors();
  const [kind, setKind] = useState<(typeof INSURANCE)[number]>('insurance_endorsement');
  const [file, setFile] = useState<{ key: string; url: string }[]>([]);
  const [insurer, setInsurer] = useState('');
  const [policy, setPolicy] = useState('');
  const [expires, setExpires] = useState('');
  const [coverage, setCoverage] = useState('');
  const [riskAck, setRiskAck] = useState(false);
  const needsCoverage = kind === 'insurance_cargo' || kind === 'insurance_car_hauling';
  const personal = kind === 'insurance_auto';
  const policies = data.documents.filter((d) => d.kind.startsWith('insurance_'));
  const labels = { file: t('policyFile'), insurer: t('insurer'), policy: t('policyNumber'), expires: t('expiresOn'), coverage: t('coverage'), riskAck: t('riskAckShort') };
  const today = new Date().toISOString().slice(0, 10);
  const save = async () => {
    const errs: Errors = {
      file: !file[0] ? t('errUploadThis') : '',
      insurer: !insurer.trim() ? t('errRequired') : '',
      policy: !policy.trim() ? t('errRequired') : '',
      expires: !expires ? t('errRequired') : expires <= today ? t('errExpired') : '',
      coverage: needsCoverage && !dollarsToCents(coverage) ? t('errCoverage') : '',
      riskAck: personal && !riskAck ? t('errRiskAck') : '',
    };
    if (!f.check(errs)) return;
    let fieldErr = false;
    const ok = await act(async () => {
      try {
        await api.addDocument({ kind, fileKey: file[0]!.key, insurer, policyNumber: policy, expiresOn: expires, ...(needsCoverage ? { coverageCents: dollarsToCents(coverage) } : {}), ...(personal ? { riskAck: true } : {}) });
      } catch (e) {
        if (f.fromServer(e, { policy_expired: 'expires', coverage_required: 'coverage', risk_ack_required: 'riskAck' }, { insurer: 'insurer', policyNumber: 'policy', expiresOn: 'expires', coverageCents: 'coverage', fileKey: 'file' })) { fieldErr = true; return; }
        throw e;
      }
    });
    if (ok && !fieldErr) { setFile([]); setInsurer(''); setPolicy(''); setExpires(''); setCoverage(''); setRiskAck(false); }
  };
  return (
    <div className={`card ${invalid ? 'invalid' : ''}`} id="ins-card">
      <b>{t('insuranceDoc')}</b>
      {invalid ? <span className="small err field-error">{t('errInsuranceMissing')}</span> : null}
      {policies.map((p) => (
        <div key={p.id} className="row between small">
          <span>{t(`dk_${p.kind}` as 'dk_insurance_auto')} · {p.insurer} · {p.expiresOn}</span>
          <Pill tone={p.status === 'approved' ? 'go' : p.status === 'pending' ? 'wait' : 'bad'}>{t(p.status === 'approved' ? 'docApproved' : p.status === 'pending' ? 'docPending' : 'docRejected')}</Pill>
        </div>
      ))}
      <p className="small muted">{t('insuranceKindHint')}</p>
      <div className="grid2">
        <Field label={t('docKind')}>
          <select id="ins-kind" value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); f.setErrors({}); }}>
            {INSURANCE.map((k) => <option key={k} value={k}>{t(`dk_${k}`)}</option>)}
          </select>
        </Field>
        <Field name="insurer" error={f.errors.insurer} label={t('insurer')}><input id="ins-insurer" value={insurer} onChange={(e) => { setInsurer(e.target.value); f.clear('insurer'); }} /></Field>
        <Field name="policy" error={f.errors.policy} label={t('policyNumber')}><input id="ins-policy" value={policy} onChange={(e) => { setPolicy(e.target.value); f.clear('policy'); }} /></Field>
        <Field name="expires" error={f.errors.expires} label={t('expiresOn')}><input id="ins-expires" type="date" value={expires} onChange={(e) => { setExpires(e.target.value); f.clear('expires'); }} /></Field>
        {needsCoverage ? <Field name="coverage" error={f.errors.coverage} label={t('coverage')}><input id="ins-coverage" inputMode="numeric" value={coverage} onChange={(e) => { setCoverage(e.target.value); f.clear('coverage'); }} /></Field> : null}
      </div>
      {personal ? (
        <>
          <Notice>{t('personalPolicyNote')}</Notice>
          <Check id="ins-risk-ack" name="riskAck" error={f.errors.riskAck} checked={riskAck} onChange={(v) => { setRiskAck(v); f.clear('riskAck'); }}>{t('riskAck')}</Check>
        </>
      ) : null}
      <PhotoUpload id="ins-file" name="file" invalid={f.errors.file} purpose="document" keys={file} onChange={(k) => { setFile(k); f.clear('file'); }} max={1} accept="image/*,application/pdf" label={t('upload')} />
      <ErrorSummary errors={f.errors} labels={labels} />
      <Button id="ins-save" onClick={save}>{t('save')}</Button>
    </div>
  );
}

function Quiz({ act }: { act: Act }) {
  const { t, lang } = useApp();
  const f = useFormErrors();
  const [quiz, setQuiz] = useState<{ id: string; question: string; options: string[] }[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [agree, setAgree] = useState(false);
  useEffect(() => void api.quiz().then(setQuiz).catch(() => undefined), [lang]);
  const labels: Record<string, string> = { agree: t('agreeShort') };
  quiz.forEach((q, i) => { labels[`q_${q.id}`] = t('questionN', { n: i + 1 }); });
  return (
    <div className="stack">
      <b>{t('quizTitle')}</b>
      {quiz.map((q) => (
        <fieldset key={q.id} className={`quiz ${f.errors[`q_${q.id}`] ? 'invalid' : ''}`} data-field={`q_${q.id}`}>
          <legend>{q.question}</legend>
          {q.options.map((o, i) => (
            <label key={o} className="check"><input type="radio" name={q.id} checked={answers[q.id] === i} onChange={() => { setAnswers({ ...answers, [q.id]: i }); f.clear(`q_${q.id}`); }} /><span>{o}</span></label>
          ))}
          {f.errors[`q_${q.id}`] ? <span className="small err field-error">{f.errors[`q_${q.id}`]}</span> : null}
        </fieldset>
      ))}
      <Check id="agree-rules" name="agree" error={f.errors.agree} checked={agree} onChange={(v) => { setAgree(v); f.clear('agree'); }}>{t('agreeRules')}</Check>
      <ErrorSummary errors={f.errors} labels={labels} />
      <Button kind="primary" id="submit-quiz" onClick={() => {
        const errs: Errors = { agree: !agree ? t('errAgree') : '' };
        for (const q of quiz) if (answers[q.id] === undefined) errs[`q_${q.id}`] = t('errPickAnswer');
        if (!f.check(errs)) return;
        return act(() => api.agreement(answers));
      }}>{t('submitQuiz')}</Button>
    </div>
  );
}
