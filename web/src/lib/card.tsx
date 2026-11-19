// Saving a payment card: Stripe Payment Element on a SetupIntent.
// In test mode (no Stripe keys on the server) a test card is saved instead.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useApp } from './app';
import { Button, ErrorBox, Notice } from './ui';
import type { Me } from './types';

declare global {
  interface Window { Stripe?: (key: string) => any }
}

let stripeJs: Promise<void> | null = null;
const loadStripe = () => (stripeJs ??= new Promise<void>((resolve, reject) => {
  if (window.Stripe) return resolve();
  const s = document.createElement('script');
  s.src = 'https://js.stripe.com/v3/';
  s.onload = () => resolve();
  s.onerror = () => {
    stripeJs = null;
    reject(new Error('Stripe failed to load'));
  };
  document.head.appendChild(s);
}));

export function CardForm({ onSaved }: { onSaved: (me: Me) => void }) {
  const { site, t, lang } = useApp();
  const [error, setError] = useState<unknown>(null);
  const [ready, setReady] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stripe = useRef<any>(null);
  const elements = useRef<any>(null);
  const test = site?.fakePayments || !site?.stripePublishableKey;

  useEffect(() => {
    if (test) return;
    let alive = true;
    (async () => {
      try {
        const [setup] = await Promise.all([api.cardSetup(), loadStripe()]);
        if (!alive || !box.current) return;
        stripe.current = window.Stripe!(setup.publishableKey || site!.stripePublishableKey);
        const css = getComputedStyle(document.documentElement);
        elements.current = stripe.current.elements({
          clientSecret: setup.setupIntentClientSecret,
          locale: lang === 'ru' ? 'ru' : 'en-CA',
          appearance: { theme: 'stripe', variables: { colorPrimary: css.getPropertyValue('--sign').trim() || '#0b6b45', borderRadius: '8px' } },
        });
        elements.current.create('payment', { layout: 'tabs' }).mount(box.current);
        setReady(true);
      } catch (e) {
        if (alive) setError(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [test, lang, site]);

  if (test) {
    return (
      <div className="stack">
        <Notice>{t('testCardNote')}</Notice>
        <Button kind="primary" onClick={async () => {
          try {
            onSaved(await api.testCard());
          } catch (e) {
            setError(e);
          }
        }}>{t('testCard')}</Button>
        <ErrorBox error={error} />
      </div>
    );
  }
  return (
    <div className="stack">
      <div ref={box} className="stripe-box" />
      <Button kind="primary" disabled={!ready} onClick={async () => {
        setError(null);
        const r = await stripe.current.confirmSetup({ elements: elements.current, redirect: 'if_required', confirmParams: { return_url: location.href } });
        if (r.error) {
          setError({ message: r.error.message });
          return;
        }
        try {
          onSaved(await api.cardSync());
        } catch (e) {
          setError(e);
        }
      }}>{t('saveCard')}</Button>
      <p className="small muted">{t('needCardText')}</p>
      <ErrorBox error={error} />
    </div>
  );
}
