// One driver-registration step.
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { CityPicker } from '../../src/components';
import { openBrowser, takeAndUpload } from '../../src/device';
import { dollarsToCents } from '../../src/format';
import { useSession } from '../../src/session';
import { Button, Card, Check, Choice, ErrorBox, Field, Label, Notice, P, Photos, Row, Screen } from '../../src/ui';

type Photo = { key: string; uri: string };

export default function Step() {
  const { step } = useLocalSearchParams<{ step: string }>();
  const { t } = useSession();
  return (
    <Screen>
      <Stack.Screen options={{ title: t(`step_${step}` as 'step_profile') }} />
      {step === 'profile' ? <ProfileStep /> : null}
      {step === 'vehicle' ? <VehicleStep /> : null}
      {step === 'license' ? <DocStep kinds={['license_front', 'license_back']} /> : null}
      {step === 'registration' ? <DocStep kinds={['registration']} /> : null}
      {step === 'background_check' ? <DocStep kinds={['background_check']} hint={t('backgroundHint')} /> : null}
      {step === 'delivery_insurance' ? <InsuranceStep /> : null}
      {step === 'identity' ? <IdentityStep /> : null}
      {step === 'agreement' ? <QuizStep /> : null}
      {step === 'payouts' ? <PayoutsStep /> : null}
    </Screen>
  );
}

function useStep() {
  const s = useSession();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, back = true) => {
    setErr(null);
    try {
      await fn();
      await s.refreshMe();
      if (back) router.back();
    } catch (e) {
      setErr(s.errorMessage(e));
    }
  };
  return { ...s, err, run };
}

function ProfileStep() {
  const { api, t, err, run, me } = useStep();
  const d = me?.driver;
  const [legalName, setLegalName] = useState(d?.legalName ?? me?.name ?? '');
  const [address, setAddress] = useState(d?.address ?? '');
  const [dob, setDob] = useState(d?.dateOfBirth ?? '');
  const [city, setCity] = useState<{ city: string; lat: number; lng: number } | null>(d?.home && d.homeCity ? { city: d.homeCity, ...d.home } : null);
  const [radius, setRadius] = useState(String(d?.radiusKm ?? 40));
  const [picking, setPicking] = useState(false);
  return (
    <Card>
      <Field label={t('legalName')} value={legalName} onChangeText={setLegalName} />
      <Field label={t('address')} value={address} onChangeText={setAddress} />
      <Field label={t('dob')} value={dob} onChangeText={setDob} placeholder="1990-05-31" maxLength={10} />
      <Label>{t('homeCity')}</Label>
      <Button kind="secondary" title={city?.city ?? '…'} onPress={() => setPicking(true)} />
      <CityPicker visible={picking} onClose={() => setPicking(false)} onPick={(c) => { setPicking(false); setCity(c); }} />
      <Field label={t('radius')} value={radius} onChangeText={setRadius} keyboardType="number-pad" />
      <Button
        title={t('save')}
        disabled={!legalName || !address || !/^\d{4}-\d\d-\d\d$/.test(dob) || !city}
        onPress={() => run(() => api.updateDriver({ legalName, address, dateOfBirth: dob, homeCity: city!.city, home: { lat: city!.lat, lng: city!.lng }, radiusKm: Number(radius) || 40 }))}
      />
      <ErrorBox text={err} />
    </Card>
  );
}

const VEHICLES = ['car', 'suv', 'pickup', 'van', 'cargo_van', 'box_truck', 'tow_truck', 'car_hauler'] as const;

function VehicleStep() {
  const { api, t, err, run } = useStep();
  const [type, setType] = useState<(typeof VEHICLES)[number]>('pickup');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [plate, setPlate] = useState('');
  const [weight, setWeight] = useState('');
  const [trailer, setTrailer] = useState(false);
  return (
    <Card>
      <Label>{t('vehicleType')}</Label>
      <Choice value={type} onChange={setType} options={VEHICLES.map((v) => ({ value: v, label: v.replace('_', ' ') }))} />
      <Row>
        <Field label={t('make')} value={make} onChangeText={setMake} />
        <Field label={t('model')} value={model} onChangeText={setModel} />
      </Row>
      <Row>
        <Field label={t('year')} value={year} onChangeText={setYear} keyboardType="number-pad" maxLength={4} />
        <Field label={t('plate')} value={plate} onChangeText={setPlate} autoCapitalize="characters" />
      </Row>
      <Field label={t('weight')} value={weight} onChangeText={setWeight} keyboardType="number-pad" hint={t('weightNote')} />
      <Check label={t('trailer')} value={trailer} onChange={setTrailer} />
      <Button
        title={t('save')}
        disabled={!make || !model || year.length !== 4 || !plate || !weight}
        onPress={() => run(() => api.addVehicle({ type, make, model, year: Number(year), plate, registeredWeightKg: Number(weight), hasTrailer: trailer }))}
      />
      <ErrorBox text={err} />
    </Card>
  );
}

function PhotoButton({ purpose = 'document', onDone }: { purpose?: 'document'; onDone: (p: Photo) => void }) {
  const { api, token, t, errorMessage } = useSession();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <Row>
        <Button small kind="secondary" title={t('takePhoto')} onPress={async () => {
          try {
            const p = await takeAndUpload(api, token ?? '', purpose, 'camera');
            if (p) onDone(p);
          } catch (e) {
            setErr(errorMessage(e));
          }
        }} />
        <Button small kind="ghost" title="📁" onPress={async () => {
          const p = await takeAndUpload(api, token ?? '', purpose, 'library').catch(() => null);
          if (p) onDone(p);
        }} />
      </Row>
      <ErrorBox text={err} />
    </>
  );
}

function DocStep({ kinds, hint }: { kinds: string[]; hint?: string }) {
  const { api, t, err, run } = useStep();
  const [photos, setPhotos] = useState<Record<string, Photo>>({});
  return (
    <Card>
      {hint ? <P muted>{hint}</P> : null}
      {kinds.map((k) => (
        <Card key={k}>
          <Label>{k.endsWith('front') ? t('docFront') : k.endsWith('back') ? t('docBack') : t(`step_${k}` as 'step_registration')}</Label>
          {photos[k] ? <Photos urls={[photos[k]!.uri]} size={120} /> : null}
          <PhotoButton onDone={(p) => setPhotos({ ...photos, [k]: p })} />
        </Card>
      ))}
      <Button
        title={t('save')}
        disabled={kinds.some((k) => !photos[k])}
        onPress={() => run(async () => { for (const k of kinds) await api.addDocument({ kind: k, fileKey: photos[k]!.key }); })}
      />
      <ErrorBox text={err} />
    </Card>
  );
}

function InsuranceStep() {
  const { api, t, err, run } = useStep();
  const [kind, setKind] = useState<'insurance_endorsement' | 'insurance_commercial' | 'insurance_cargo'>('insurance_endorsement');
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [insurer, setInsurer] = useState('');
  const [policy, setPolicy] = useState('');
  const [expires, setExpires] = useState('');
  const [coverage, setCoverage] = useState('');
  return (
    <Card>
      <Label>{t('insuranceKind')}</Label>
      <Choice value={kind} onChange={setKind} options={[
        { value: 'insurance_endorsement', label: t('ins_endorsement') },
        { value: 'insurance_commercial', label: t('ins_commercial') },
        { value: 'insurance_cargo', label: t('ins_cargo') },
      ]} />
      {photo ? <Photos urls={[photo.uri]} size={120} /> : null}
      <PhotoButton onDone={setPhoto} />
      <Field label={t('insurer')} value={insurer} onChangeText={setInsurer} />
      <Field label={t('policyNumber')} value={policy} onChangeText={setPolicy} />
      <Field label={t('expiresOn')} value={expires} onChangeText={setExpires} placeholder="2027-06-30" maxLength={10} />
      {kind === 'insurance_cargo' ? <Field label={t('coverage')} value={coverage} onChangeText={setCoverage} keyboardType="number-pad" /> : null}
      <Button
        title={t('save')}
        disabled={!photo || !insurer || !policy || !/^\d{4}-\d\d-\d\d$/.test(expires) || (kind === 'insurance_cargo' && !coverage)}
        onPress={() => run(() => api.addDocument({ kind, fileKey: photo!.key, insurer, policyNumber: policy, expiresOn: expires, ...(kind === 'insurance_cargo' ? { coverageCents: dollarsToCents(coverage) } : {}) }))}
      />
      <ErrorBox text={err} />
    </Card>
  );
}

function IdentityStep() {
  const { api, t, err, run, me } = useStep();
  return (
    <Card>
      <P>{t('identityHint')}</P>
      {me?.driver?.identityStatus === 'verified' ? <Notice tone="go" text="✓" /> : null}
      <Button title={t('startIdentity')} onPress={() => run(async () => { const r = await api.identity(); await openBrowser(r.url); }, false)} />
      <ErrorBox text={err} />
    </Card>
  );
}

function PayoutsStep() {
  const { api, t, err, run, me } = useStep();
  return (
    <Card>
      <P>{t('payoutsHint')}</P>
      {me?.driver?.payoutsEnabled ? <Notice tone="go" text="✓" /> : null}
      <Button title={t('setupPayouts')} onPress={() => run(async () => { const r = await api.payouts(); await openBrowser(r.url); await api.refreshPayouts(); }, false)} />
      <Button kind="ghost" title={t('refresh')} onPress={() => run(() => api.refreshPayouts(), false)} />
      <ErrorBox text={err} />
    </Card>
  );
}

function QuizStep() {
  const { api, t, err, run } = useStep();
  const [quiz, setQuiz] = useState<{ id: string; question: string; options: string[] }[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  useEffect(() => {
    api.quiz().then(setQuiz).catch(() => undefined);
  }, [api]);
  return (
    <Card>
      {quiz.map((q) => (
        <Card key={q.id}>
          <P style={{ fontWeight: '700' }}>{q.question}</P>
          {q.options.map((opt, i) => (
            <Check key={opt} label={opt} value={answers[q.id] === i} onChange={() => setAnswers({ ...answers, [q.id]: i })} />
          ))}
        </Card>
      ))}
      <Button title={t('save')} disabled={quiz.length === 0 || Object.keys(answers).length < quiz.length} onPress={() => run(() => api.agreement(answers))} />
      <ErrorBox text={err} />
    </Card>
  );
}
