// Driver registration checklist; each step opens its own screen.
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { useLoad, useSession } from '../../src/session';
import { useColors } from '../../src/theme';
import { Button, Card, ErrorBox, Notice, P, Row, Screen } from '../../src/ui';

const STEPS = ['profile', 'vehicle', 'license', 'registration', 'delivery_insurance', 'identity', 'background_check', 'agreement', 'payouts'] as const;

export default function Onboarding() {
  const { api, t, errorMessage, refreshMe } = useSession();
  const c = useColors();
  const router = useRouter();
  const { data, error, loading, reload } = useLoad(async () => {
    try {
      return await api.driver();
    } catch {
      return await api.startDriver();
    }
  }, [], ['notification']);
  const [err, setErr] = useState<string | null>(null);
  const done = (key: string) => data?.checklist.find((x) => x.key === key)?.done ?? false;
  const status = data?.driver.status;

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <ErrorBox text={error} />
      {status === 'pending' ? <Notice text={t('pendingReview')} /> : null}
      {STEPS.map((s, i) => (
        <Pressable key={s} onPress={() => router.push(`/onboarding/${s}`)}>
          <Card highlight={done(s)}>
            <Row between>
              <Text style={{ color: c.ink, fontSize: 16, fontWeight: '600' }}>{i + 1}. {t(`step_${s}` as 'step_profile')}</Text>
              <Text style={{ color: done(s) ? c.sign : c.muted, fontSize: 18 }}>{done(s) ? '✓' : '›'}</Text>
            </Row>
          </Card>
        </Pressable>
      ))}
      {status === 'draft' || status === 'rejected' ? (
        <Button
          title={t('submit')}
          disabled={!data?.checklist.every((x) => !x.requiredToSubmit || x.done)}
          onPress={async () => {
            setErr(null);
            try {
              await api.submitDriver();
              await reload();
              await refreshMe();
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        />
      ) : null}
      {data ? <P small muted>{t('missing', { list: data.checklist.filter((x) => x.requiredToSubmit && !x.done).map((x) => x.key).join(', ') || '—' })}</P> : null}
      <ErrorBox text={err} />
    </Screen>
  );
}
