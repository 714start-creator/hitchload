// Profile: name, email, language, terms, card (Stripe PaymentSheet), switch to driver mode.
import { useStripe } from '@stripe/stripe-react-native';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useSession } from '../../src/session';
import { Button, Card, Check, Choice, ErrorBox, Field, H, Label, Notice, P, Row, Screen } from '../../src/ui';

export default function Profile() {
  const { api, me, setMe, t, errorMessage, setMode, signOut } = useSession();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const router = useRouter();
  const [name, setName] = useState(me?.name ?? '');
  const [email, setEmail] = useState(me?.email ?? '');
  const [terms, setTerms] = useState(me?.termsAccepted ?? false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(me?.name ?? '');
    setEmail(me?.email ?? '');
    setTerms(me?.termsAccepted ?? false);
  }, [me]);

  async function addCard() {
    setErr(null);
    try {
      const s = await api.cardSetup();
      const init = await initPaymentSheet({
        merchantDisplayName: s.merchantDisplayName,
        customerId: s.customerId,
        customerEphemeralKeySecret: s.ephemeralKeySecret,
        setupIntentClientSecret: s.setupIntentClientSecret,
        allowsDelayedPaymentMethods: false,
        returnURL: 'poputka://stripe-redirect',
        defaultBillingDetails: { name: me?.name ?? undefined, email: me?.email ?? undefined },
      });
      if (init.error) throw new Error(init.error.message);
      const r = await presentPaymentSheet();
      if (r.error) {
        if (r.error.code !== 'Canceled') setErr(r.error.message);
        return;
      }
      setMe(await api.cardSync());
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  return (
    <Screen>
      <Card>
        <H>{t('profile')}</H>
        <P muted>{me?.phone}</P>
        <Field label={t('name')} value={name} onChangeText={setName} autoComplete="name" />
        <Field label={t('email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
        <Label>{t('language')}</Label>
        <Choice value={me?.lang ?? 'ru'} onChange={async (lang) => setMe(await api.updateMe({ lang }))} options={[{ value: 'ru', label: 'Русский' }, { value: 'en', label: 'English' }]} />
        <Check label={t('acceptTerms')} value={terms} onChange={setTerms} />
        <Button
          title={t('save')}
          onPress={async () => {
            setErr(null);
            try {
              setMe(await api.updateMe({ name: name.trim(), email: email.trim(), ...(terms && !me?.termsAccepted ? { acceptTerms: true as const } : {}) }));
              setMsg(t('saved'));
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        />
        {msg ? <Notice tone="go" text={msg} /> : null}
      </Card>
      <Card>
        <Label>{t('card')}</Label>
        {me?.card ? <P>{me.card.brand.toUpperCase()} •••• {me.card.last4}</P> : null}
        <P small muted>{t('cardNote')}</P>
        <Button kind={me?.card ? 'secondary' : 'primary'} title={me?.card ? t('changeCard') : t('addCard')} onPress={addCard} />
      </Card>
      <ErrorBox text={err} />
      <Row>
        <Button kind="secondary" title={t('notifications')} onPress={() => router.push('/notifications')} />
        <Button kind="secondary" title={t('switchToDriver')} onPress={() => { setMode('driver'); router.replace('/driver'); }} />
      </Row>
      <Button kind="ghost" title={t('signOut')} onPress={async () => { await signOut(); router.replace('/sign-in'); }} />
    </Screen>
  );
}
