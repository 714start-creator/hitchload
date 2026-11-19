// Driver application on one page: details, vehicle, documents, ID check, payouts, rules, submit.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { Link, useApp, useLoad, useLocation } from '../../lib/app';
import { dollarsToCents, money } from '../../lib/format';
import type { DriverOverview } from '../../lib/types';
import { Button, Card, CityInput, ErrorBox, Field, Loading, Notice, PageHead, PhotoUpload, Pill, RequireAuth, cityLabel } from '../../lib/ui';

export function Setup() {
  return <RequireAuth><SetupPage /></RequireAuth>;
}

const VEHICLES = ['car', 'suv', 'pickup', 'van', 'cargo_van', 'box_truck', 'tow_truck', 'car_hauler'] as const;
const INSURANCE = ['insurance_endorsement', 'insurance_commercial', 'insurance_cargo', 'insurance_car_hauling', 'insurance_auto'] as const;

function SetupPage() {
  const { t, me, refreshMe, err } = useApp();
  const { query } = useLocation();
  const { data, error, loading, reload, setData } = useLoad<DriverOverview | null>(() => (me?.driver ? api.driver() : Promise.resolve(null)), [me?.driver ? 1 : 0]);
  const [actErr, setActErr] = useState<string | null>(null);
  const done = query.get('done');

  // back from Stripe: re-read payout status
  useEffect(() => {
    if (done === 'payouts' && me?.driver) void api.refreshPayouts().then(setData).catch(() => undefined);
    if (done === 'identity' && me?.driver) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const act = async (fn: () => Promise<unknown>) => {
    setActErr(null);
    try {
      await fn();
      await reload();
      await refreshMe();
    } catch (e) {
      setActErr(err(e));
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
  const missing = required.filter((c) => !c.done).map((c) => t(`ck_${c.key}` as 'ck_profile'));
  const statusTone = d.status === 'approved' ? 'go' : d.status === 'pending' ? 'wait' : d.status === 'draft' ? undefined : 'bad';

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
          {data.checklist.map((c) => <li key={c.key} className={c.done ? 'done' : c.requiredToSubmit ? 'todo' : 'opt'}>{t(`ck_${c.key}` as 'ck_profile')}</li>)}
        </ul>
      </Card>
      {actErr ? <Notice tone="bad">{actErr}</Notice> : null}

      <Section n={1} title={t('step_profile')} done={ck('profile')}>
        <ProfileForm data={data} editable={editable} act={act} />
      </Section>
      <Section n={2} title={t('step_vehicle')} done={ck('vehicle')}>
        <VehicleForm data={data} act={act} />
      </Section>
      <Section n={3} title={t('step_documents')} done={ck('license') && ck('registration') && ck('delivery_insurance') && ck('background_check')}>
        <Documents data={data} act={act} />
      </Section>
      <Section n={4} title={t('step_identity')} done={ck('identity_verified')}>
        <p>{t('identityText')}</p>
        <p className="small">{t(`identity_${d.identityStatus}` as 'identity_none')}</p>
        {d.identityStatus !== 'verified' ? <Button kind="primary" onClick={() => act(async () => { const r = await api.identity(); location.href = r.url; })}>{t('startIdentity')}</Button> : null}
      </Section>
      <Section n={5} title={t('step_payouts')} done={d.payoutsEnabled}>
        <p>{t('payoutsText')}</p>
        {d.payoutsEnabled ? <Notice tone="go">{t('payoutsOn')}</Notice> : (
          <div className="row">
            <Button kind="primary" onClick={() => act(async () => { const r = await api.payouts(); location.href = r.url; })}>{t('startPayouts')}</Button>
            {d.payoutsStarted ? <Button kind="ghost" onClick={() => act(() => api.refreshPayouts())}>{t('refreshStatus')}</Button> : null}
          </div>
        )}
      </Section>
      <Section n={6} title={t('step_agreement')} done={ck('agreement')}>
        {ck('agreement') ? <p className="small muted">✓</p> : <Quiz act={act} />}
      </Section>
      {editable ? (
        <Section n={7} title={t('step_submit')} done={false}>
          {missing.length ? <p className="small">{t('missing', { list: missing.join(', ') })}</p> : null}
          <Button kind="primary" id="submit-driver" disabled={missing.length > 0} onClick={() => act(() => api.submitDriver())}>{t('submitReview')}</Button>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <details className="card section" open={!done}>
      <summary><span className={`num ${done ? 'done' : ''}`}>{done ? '✓' : n}</span> {title}</summary>
      <div className="stack">{children}</div>
    </details>
  );
}

function ProfileForm({ data, editable, act }: { data: DriverOverview; editable: boolean; act: (f: () => Promise<unknown>) => Promise<void> }) {
  const { t, me, cities } = useApp();
  const d = data.driver;
  const [legalName, setLegalName] = useState(d.legalName ?? me?.name ?? '');
  const [dob, setDob] = useState(d.dateOfBirth ?? '');
  const [address, setAddress] = useState(d.address ?? '');
  const home = d.homeCity ? cities.find((c) => c.city === d.homeCity) : undefined;
  const [city, setCity] = useState(home ? cityLabel(home) : '');
  const [radius, setRadius] = useState(String(d.radiusKm ?? 40));
  const [quietFrom, setQuietFrom] = useState(d.quietFrom ?? '');
  const [quietTo, setQuietTo] = useState(d.quietTo ?? '');
  const c = cities.find((x) => cityLabel(x) === city);
  return (
    <form className="stack" onSubmit={(e) => {
      e.preventDefault();
      void act(() => api.updateDriver({
        ...(editable ? { legalName: legalName.trim(), dateOfBirth: dob } : {}),
        address: address.trim(), ...(c ? { homeCity: c.city, home: { lat: c.lat, lng: c.lng } } : {}), radiusKm: Number(radius) || 40,
        quietFrom: quietFrom || null, quietTo: quietTo || null,
      }));
    }}>
      <div className="grid2">
        <Field label={t('legalName')}><input id="legal-name" value={legalName} disabled={!editable} onChange={(e) => setLegalName(e.target.value)} /></Field>
        <Field label={t('dob')}><input id="dob" type="date" value={dob} disabled={!editable} onChange={(e) => setDob(e.target.value)} /></Field>
      </div>
      <Field label={t('homeAddress')}><input id="home-address" value={address} autoComplete="street-address" onChange={(e) => setAddress(e.target.value)} /></Field>
      <div className="grid2">
        <Field label={t('homeCity')}><CityInput id="home-city" value={city} onChange={(v) => setCity(v)} /></Field>
        <Field label={t('radius')}><input id="radius" type="number" min={5} max={300} value={radius} onChange={(e) => setRadius(e.target.value)} /></Field>
      </div>
      <Field label={t('quietHours')}>
        <div className="row"><input type="time" value={quietFrom} onChange={(e) => setQuietFrom(e.target.value)} aria-label="from" /> – <input type="time" value={quietTo} onChange={(e) => setQuietTo(e.target.value)} aria-label="to" /></div>
      </Field>
      <Button kind="primary" type="submit" id="save-profile" disabled={!legalName || !dob || address.length < 5 || !c}>{t('save')}</Button>
    </form>
  );
}

function VehicleForm({ data, act }: { data: DriverOverview; act: (f: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useApp();
  const [type, setType] = useState<(typeof VEHICLES)[number]>('pickup');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [plate, setPlate] = useState('');
  const [weight, setWeight] = useState('');
  const [trailer, setTrailer] = useState(false);
  return (
    <>
      {data.vehicles.map((v) => (
        <div key={v.id} className="row between vehicle">
          <span><b>{v.year} {v.make} {v.model}</b> · {v.plate} · {t(`vt_${v.type}` as 'vt_car')} · {t('maxSize', { size: t(`size${v.maxSize}`) })}</span>
          {data.vehicles.length > 1 ? <Button small kind="ghost" onClick={() => act(() => api.removeVehicle(v.id))}>{t('removeStop')}</Button> : null}
        </div>
      ))}
      <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        void act(async () => {
          await api.addVehicle({ type, make, model, year: Number(year), plate, registeredWeightKg: Number(weight), hasTrailer: trailer });
          setMake(''); setModel(''); setYear(''); setPlate(''); setWeight('');
        });
      }}>
        <div className="grid3">
          <Field label={t('vehicleType')}>
            <select id="vehicle-type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              {VEHICLES.map((v) => <option key={v} value={v}>{t(`vt_${v}`)}</option>)}
            </select>
          </Field>
          <Field label={t('make')}><input id="make" value={make} onChange={(e) => setMake(e.target.value)} /></Field>
          <Field label={t('model')}><input id="model" value={model} onChange={(e) => setModel(e.target.value)} /></Field>
          <Field label={t('year')}><input id="year" inputMode="numeric" maxLength={4} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label={t('plate')}><input id="plate" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} /></Field>
          <Field label={t('gvw')}><input id="gvw" inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={trailer} onChange={(e) => setTrailer(e.target.checked)} /><span>{t('trailer')}</span></label>
        <Button type="submit" id="add-vehicle" kind={data.vehicles.length ? 'secondary' : 'primary'} disabled={!make || !model || year.length !== 4 || plate.length < 2 || Number(weight) < 500}>{t('addVehicle')}</Button>
      </form>
    </>
  );
}

function Documents({ data, act }: { data: DriverOverview; act: (f: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useApp();
  const has = (k: string) => data.documents.some((d) => d.kind === k && d.status !== 'rejected');
  const simple: { kind: string; label: string }[] = [
    { kind: 'license_front', label: t('dk_license_front') },
    { kind: 'license_back', label: t('dk_license_back') },
    { kind: 'registration', label: t('dk_registration') },
    { kind: 'background_check', label: t('dk_background_check') },
  ];
  return (
    <>
      <p className="small muted">{t('docsHint')}</p>
      <div className="doc-grid">
        {simple.map((s) => (
          <div key={s.kind} className={`card doc ${has(s.kind) ? 'hl' : ''}`}>
            <b>{s.label}</b>
            <DocStatus data={data} kind={s.kind} />
            <PhotoUpload id={`doc-${s.kind}`} purpose="document" keys={[]} max={1} accept="image/*,application/pdf" label={has(s.kind) ? t('replaceFile') : t('upload')}
              onChange={(k) => { if (k[0]) void act(() => api.addDocument({ kind: s.kind, fileKey: k[0]!.key })); }} />
          </div>
        ))}
      </div>
      <InsuranceForm data={data} act={act} />
    </>
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

function InsuranceForm({ data, act }: { data: DriverOverview; act: (f: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useApp();
  const [kind, setKind] = useState<(typeof INSURANCE)[number]>('insurance_endorsement');
  const [file, setFile] = useState<{ key: string; url: string }[]>([]);
  const [insurer, setInsurer] = useState('');
  const [policy, setPolicy] = useState('');
  const [expires, setExpires] = useState('');
  const [coverage, setCoverage] = useState('');
  const needsCoverage = kind === 'insurance_cargo' || kind === 'insurance_car_hauling';
  const policies = data.documents.filter((d) => d.kind.startsWith('insurance_'));
  return (
    <div className="card">
      <b>{t('insuranceDoc')}</b>
      {policies.map((p) => (
        <div key={p.id} className="row between small">
          <span>{t(`dk_${p.kind}` as 'dk_insurance_auto')} · {p.insurer} · {p.expiresOn}</span>
          <Pill tone={p.status === 'approved' ? 'go' : p.status === 'pending' ? 'wait' : 'bad'}>{t(p.status === 'approved' ? 'docApproved' : p.status === 'pending' ? 'docPending' : 'docRejected')}</Pill>
        </div>
      ))}
      <p className="small muted">{t('insuranceKindHint')}</p>
      <div className="grid2">
        <Field label={t('docKind')}>
          <select id="ins-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {INSURANCE.map((k) => <option key={k} value={k}>{t(`dk_${k}`)}</option>)}
          </select>
        </Field>
        <Field label={t('insurer')}><input id="ins-insurer" value={insurer} onChange={(e) => setInsurer(e.target.value)} /></Field>
        <Field label={t('policyNumber')}><input id="ins-policy" value={policy} onChange={(e) => setPolicy(e.target.value)} /></Field>
        <Field label={t('expiresOn')}><input id="ins-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        {needsCoverage ? <Field label={t('coverage')}><input id="ins-coverage" inputMode="numeric" value={coverage} onChange={(e) => setCoverage(e.target.value)} /></Field> : null}
      </div>
      <PhotoUpload id="ins-file" purpose="document" keys={file} onChange={setFile} max={1} accept="image/*,application/pdf" label={t('upload')} />
      <Button id="ins-save" disabled={!file[0] || !insurer || !policy || !expires || (needsCoverage && !dollarsToCents(coverage))} onClick={() => act(async () => {
        await api.addDocument({ kind, fileKey: file[0]!.key, insurer, policyNumber: policy, expiresOn: expires, ...(needsCoverage ? { coverageCents: dollarsToCents(coverage) } : {}) });
        setFile([]); setInsurer(''); setPolicy(''); setExpires(''); setCoverage('');
      })}>{t('save')}</Button>
    </div>
  );
}

function Quiz({ act }: { act: (f: () => Promise<unknown>) => Promise<void> }) {
  const { t, lang } = useApp();
  const [quiz, setQuiz] = useState<{ id: string; question: string; options: string[] }[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [agree, setAgree] = useState(false);
  useEffect(() => void api.quiz().then(setQuiz).catch(() => undefined), [lang]);
  return (
    <div className="stack">
      <b>{t('quizTitle')}</b>
      {quiz.map((q) => (
        <fieldset key={q.id} className="quiz">
          <legend>{q.question}</legend>
          {q.options.map((o, i) => (
            <label key={o} className="check"><input type="radio" name={q.id} checked={answers[q.id] === i} onChange={() => setAnswers({ ...answers, [q.id]: i })} /><span>{o}</span></label>
          ))}
        </fieldset>
      ))}
      <label className="check"><input id="agree-rules" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>{t('agreeRules')}</span></label>
      <Button kind="primary" id="submit-quiz" disabled={!agree || quiz.length === 0 || Object.keys(answers).length < quiz.length} onClick={() => act(() => api.agreement(answers))}>{t('submitQuiz')}</Button>
    </div>
  );
}
