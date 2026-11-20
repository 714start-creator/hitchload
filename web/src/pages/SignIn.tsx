import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Link, navigate, useApp, useLocation } from '../lib/app';
import { maskPhone } from '../lib/format';
import type { Me } from '../lib/types';
import { ErrorSummary, isEmail, isPhone, useFormErrors } from '../lib/form';
import { Button, Card, Check, ErrorBox, Field } from '../lib/ui';

const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/send');

export function SignIn() {
  const { t, me, signedIn, ready } = useApp();
  const { query } = useLocation();
  const next = safeNext(query.get('next'));
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState<{ phone: string; devCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const f = useFormErrors();

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
          <form className="stack" noValidate onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            if (!f.check({ phone: !phone.trim() ? t('errRequired') : !isPhone(phone) ? t('errPhone') : '' })) return;
            try {
              setSent(await api.startOtp(phone));
            } catch (x) {
              if (!f.fromServer(x, { invalid_phone: 'phone' }, { phone: 'phone' }, t('errPhone'))) setError(x);
            }
          }}>
            <Field name="phone" error={f.errors.phone} label={t('phone')}>
              <input id="phone" inputMode="tel" autoComplete="tel-national" placeholder="(780) 555-0123" value={phone} onChange={(e) => { setPhone(maskPhone(e.target.value)); f.clear('phone'); }} autoFocus />
            </Field>
            <Button kind="primary" type="submit">{t('getCode')}</Button>
          </form>
        ) : (
          <form className="stack" noValidate onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            if (!f.check({ code: code.length < 4 ? t('errCode') : '' })) return;
            try {
              const r = await api.verifyOtp(sent.phone, code);
              signedIn(r.token, r.user);
              if (!needsProfile(r.user)) navigate(next, true);
            } catch (x) {
              if (!f.fromServer(x, { invalid_code: 'code' }, { code: 'code' }, t('errCodeWrong'))) setError(x);
            }
          }}>
            <p className="small">{t('codeSent', { phone: maskPhone(sent.phone) })}</p>
            {sent.devCode ? <p className="notice wait small">{t('devCode', { code: sent.devCode })}</p> : null}
            <Field name="code" error={f.errors.code} label={t('code')}>
              <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); f.clear('code'); }} autoFocus />
            </Field>
            <Button kind="primary" type="submit">{t('verify')}</Button>
            <button type="button" className="btn ghost small" onClick={() => { setSent(null); setCode(''); f.setErrors({}); }}>{t('changePhone')}</button>
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
  const f = useFormErrors();
  const labels = { name: t('name'), email: t('email'), terms: t('termsShort') };
  return (
    <div className="narrow">
      <Card>
        <h1 className="h2">{t('profileTitle')}</h1>
        <p className="muted">{t('profileText')}</p>
        <form className="stack" noValidate onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          if (!f.check({
            name: name.trim().length < 2 ? t('errName') : '',
            email: !email.trim() ? t('errRequired') : !isEmail(email) ? t('errEmail') : '',
            terms: !terms ? t('errTerms') : '',
          })) return;
          try {
            await api.updateMe({ name: name.trim(), email: email.trim(), ...(terms ? { acceptTerms: true as const } : {}) });
            await refreshMe();
            navigate(next, true);
          } catch (x) {
            if (!f.fromServer(x, { email_taken: 'email' }, { name: 'name', email: 'email', acceptTerms: 'terms' })) setError(x);
          }
        }}>
          <Field name="name" error={f.errors.name} label={t('name')}><input id="name" autoComplete="name" value={name} onChange={(e) => { setName(e.target.value); f.clear('name'); }} /></Field>
          <Field name="email" error={f.errors.email} label={t('email')}><input id="email" type="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); f.clear('email'); }} /></Field>
          <Check id="terms" name="terms" error={f.errors.terms} checked={terms} onChange={(v) => { setTerms(v); f.clear('terms'); }}>
            {t('acceptTerms', { terms: '\u0000', privacy: '\u0001' }).split(/(\u0000|\u0001)/).map((part, i) =>
              part === '\u0000' ? <Link key={i} to="/terms">{t('termsLink')}</Link> : part === '\u0001' ? <Link key={i} to="/privacy">{t('privacyLink')}</Link> : <span key={i}>{part}</span>)}
          </Check>
          <ErrorSummary errors={f.errors} labels={labels} />
          <Button kind="primary" type="submit">{t('continue')}</Button>
        </form>
        <ErrorBox error={error} />
      </Card>
    </div>
  );
}
