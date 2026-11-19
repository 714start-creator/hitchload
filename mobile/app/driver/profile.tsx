// Driver profile: level and limits, documents, tax details, payouts, radius and quiet hours.
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { openBrowser } from '../../src/device';
import { money } from '../../src/format';
import { useLoad, useSession } from '../../src/session';
import { Button, Card, ErrorBox, Field, H, Label, P, Pill, Row, Screen } from '../../src/ui';

export default function DriverProfile() {
  const { api, me, t, errorMessage, setMode, signOut, refreshMe } = useSession();
  const router = useRouter();
  const { data, error, loading, reload } = useLoad(() => api.driver(), [], []);
  const [radius, setRadius] = useState('');
  const [qFrom, setQFrom] = useState('');
  const [qTo, setQTo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const d = data?.driver;

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <ErrorBox text={error} />
      {d ? (
        <>
          <Card>
            <Row between>
              <H>{me?.name ?? d.legalName}</H>
              <Pill tone={d.tier === 'pro' ? 'done' : 'go'} text={d.tier === 'pro' ? t('tierPro') : t('tierBasic')} />
            </Row>
            <P muted>{t('cargoLimit', { v: money(d.cargoLimitCents) })} · ★ {me?.rating?.toFixed(1) ?? '—'} · {d.completedJobs}</P>
            {d.status !== 'approved' ? <Button title={t('continueSetup')} onPress={() => router.push('/onboarding')} /> : null}
          </Card>
          <Card>
            <Label>{t('documents')}</Label>
            {data.documents.map((doc) => (
              <Row between key={doc.id}>
                <P small>{doc.kind}{doc.expiresOn ? ` · ${doc.expiresOn}` : ''}</P>
                <Pill tone={doc.status === 'approved' ? 'go' : doc.status === 'rejected' ? 'bad' : 'wait'} text={t(`doc_${doc.status}` as 'doc_pending')} />
              </Row>
            ))}
            <Button small kind="secondary" title={t('step_delivery_insurance')} onPress={() => router.push('/onboarding/delivery_insurance')} />
          </Card>
          <Card>
            <Label>{t('taxTitle')}</Label>
            <P small>{d.taxInfo ? `${d.taxInfo.type.toUpperCase()} •••${d.taxInfo.last3}` : '—'}</P>
            <Button small kind="secondary" title={t('taxTitle')} onPress={() => router.push('/tax')} />
          </Card>
          <Card>
            <Label>{t('step_payouts')}</Label>
            <P small>{d.payoutsEnabled ? '✓' : '—'}</P>
            <Row>
              <Button small kind="secondary" title={t('setupPayouts')} onPress={async () => { const r = await api.payouts(); await openBrowser(r.url); await api.refreshPayouts(); await reload(); }} />
              <Button small kind="ghost" title={t('refresh')} onPress={async () => { await api.refreshPayouts(); await reload(); }} />
            </Row>
          </Card>
          <Card>
            <Field label={t('radius')} value={radius || String(d.radiusKm)} onChangeText={setRadius} keyboardType="number-pad" />
            <Label>{t('quietHours')}</Label>
            <Row>
              <Field value={qFrom || d.quietFrom || ''} onChangeText={setQFrom} placeholder="22:00" maxLength={5} />
              <Field value={qTo || d.quietTo || ''} onChangeText={setQTo} placeholder="07:00" maxLength={5} />
            </Row>
            <Button
              title={t('save')}
              onPress={async () => {
                setErr(null);
                try {
                  await api.updateDriver({
                    ...(radius ? { radiusKm: Number(radius) } : {}),
                    ...(qFrom || qTo ? { quietFrom: qFrom || null, quietTo: qTo || null } : {}),
                  });
                  await reload();
                  await refreshMe();
                } catch (e) {
                  setErr(errorMessage(e));
                }
              }}
            />
          </Card>
        </>
      ) : null}
      <ErrorBox text={err} />
      <Row>
        <Button kind="secondary" title={t('notifications')} onPress={() => router.push('/notifications')} />
        <Button kind="secondary" title={t('switchToClient')} onPress={() => { setMode('client'); router.replace('/client'); }} />
      </Row>
      <Button kind="ghost" title={t('signOut')} onPress={async () => { await signOut(); router.replace('/sign-in'); }} />
    </Screen>
  );
}
