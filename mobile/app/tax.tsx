// SIN or BN for the CRA platform report; asked before the first payout.
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useSession } from '../src/session';
import { Button, Card, Choice, ErrorBox, Field, P, Screen } from '../src/ui';

export default function Tax() {
  const { api, t, errorMessage, refreshMe, me } = useSession();
  const router = useRouter();
  const [type, setType] = useState<'sin' | 'bn'>('sin');
  const [number, setNumber] = useState('');
  const [gst, setGst] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Screen>
      <Card>
        <P>{t('taxHint')}</P>
        {me?.driver?.taxInfo ? <P muted>{me.driver.taxInfo.type.toUpperCase()} •••{me.driver.taxInfo.last3}</P> : null}
        <Choice value={type} onChange={setType} options={[{ value: 'sin', label: 'SIN' }, { value: 'bn', label: 'BN' }]} />
        <Field label={t('taxNumber')} value={number} onChangeText={setNumber} keyboardType="number-pad" secureTextEntry={type === 'sin'} maxLength={15} />
        <Field label={t('gst')} value={gst} onChangeText={setGst} />
        <Button
          title={t('save')}
          disabled={number.replace(/\D/g, '').length < 9}
          onPress={async () => {
            setErr(null);
            try {
              await api.saveTax({ type, number, ...(gst ? { gstNumber: gst } : {}) });
              await refreshMe();
              router.back();
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        />
        <ErrorBox text={err} />
      </Card>
    </Screen>
  );
}
