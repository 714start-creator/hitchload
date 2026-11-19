import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Link, navigate, useApp, useLocation } from '../lib/app';
import { maskPhone } from '../lib/format';
import type { Me } from '../lib/types';
import { Button, Card, ErrorBox, Field } from '../lib/ui';

const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/send');

export function SignIn() {
  const { t, me, signedIn, ready } = useApp();
  const { query } = useLocation();
  const next = safeNext(query.get('next'));
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState<{ phone: string; devCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);

  const needsProfile = (m: Me) => !m.name || !m.email || !m.termsAccepted;
  useEffect(() => {
    if (ready && me && !needsProfile(me)) navigate(next, true);
  }, [ready, me, next]);

  if (me && needsProfile(me)) return <ProfileStep me={me} next={next} />;

  return (
    <div className="narrow">
      <Card>
        <h1 className="h2">{t('signInTitle')}</h1>
        <p className="muted">{t('signInText')}</p>
        {!sent ? (
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              setSent(await api.startOtp(phone));
            } catch (x) {
              setError(x);
            }
          }}>
            <Field label={t('phone')}>
              <input id="phone" inputMode="tel" autoComplete="tel-national" placeholder="(780) 555-0123" value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} autoFocus />
            </Field>
            <Button kind="primary" type="submit" disabled={phone.replace(/\D/g, '').length < 10}>{t('getCode')}</Button>
          </form>
        ) : (
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const r = await api.verifyOtp(sent.phone, code);
              signedIn(r.token, r.user);
              if (!needsProfile(r.user)) navigate(next, true);
            } catch (x) {
              setError(x);
            }
          }}>
            <p className="small">{t('codeSent', { phone: maskPhone(sent.phone) })}</p>
            {sent.devCode ? <p className="notice wait small">{t('devCode', { code: sent.devCode })}</p> : null}
            <Field label={t('code')}>
              <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            </Field>
            <Button kind="primary" type="submit" disabled={code.length < 4}>{t('verify')}</Button>
            <button type="button" className="btn ghost small" onClick={() => { setSent(null); setCode(''); }}>{t('changePhone')}</button>
          </form>
        )}
        <ErrorBox error={error} />
      </Card>
    </div>
  );
}

function ProfileStep({ me, next }: { me: Me; next: string }) {
  const { t, refreshMe } = useApp();
  const [name, setName] = useState(me.name ?? '');
  const [email, setEmail] = useState(me.email ?? '');
  const [terms, setTerms] = useState(me.termsAccepted);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="narrow">
      <Card>
        <h1 className="h2">{t('profileTitle')}</h1>
        <p className="muted">{t('profileText')}</p>
        <form className="stack" onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api.updateMe({ name: name.trim(), email: email.trim(), ...(terms ? { acceptTerms: true as const } : {}) });
            await refreshMe();
            navigate(next, true);
          } catch (x) {
            setError(x);
          }
        }}>
          <Field label={t('name')}><input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label={t('email')}><input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <label className="check">
            <input id="terms" type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
            <span>
              {t('acceptTerms', { terms: '\u0000', privacy: '\u0001' }).split(/(\u0000|\u0001)/).map((part, i) =>
                part === '\u0000' ? <Link key={i} to="/terms">{t('termsLink')}</Link> : part === '\u0001' ? <Link key={i} to="/privacy">{t('privacyLink')}</Link> : <span key={i}>{part}</span>)}
            </span>
          </label>
          <Button kind="primary" type="submit" disabled={!name.trim() || !email.includes('@') || !terms}>{t('continue')}</Button>
        </form>
        <ErrorBox error={error} />
      </Card>
    </div>
  );
}
