import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Link, navigate, useApp, useLoad, useLocation } from '../lib/app';
import { CardForm } from '../lib/card';
import { dayTime, maskPhone } from '../lib/format';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push';
import { Button, Card, Empty, ErrorBox, Field, Loading, Notice, PageHead, RequireAuth } from '../lib/ui';

export function Account() {
  return <RequireAuth><AccountPage /></RequireAuth>;
}

function AccountPage() {
  const { t, me, refreshMe, signOut, lang, setLang, site, err } = useApp();
  const { query } = useLocation();
  const [name, setName] = useState(me!.name ?? '');
  const [email, setEmail] = useState(me!.email ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [push, setPush] = useState<PushState | null>(null);
  const alerts = useLoad(() => api.alerts(), []);
  useEffect(() => void pushState().then(setPush), []);
  useEffect(() => {
    if (query.get('email') === 'verified') void refreshMe();
  }, [query, refreshMe]);
  const flag = query.get('email');
  const alertFlag = query.get('alert');
  const m = me!;

  return (
    <div className="page">
      <PageHead title={t('accountTitle')} />
      {flag === 'verified' ? <Notice tone="go">{t('emailVerifiedOk')}</Notice> : flag === 'expired' || flag === 'invalid' ? <Notice tone="bad">{t('emailLinkExpired')}</Notice> : null}
      {alertFlag === 'off' ? <Notice tone="go">{t('alertOff')}</Notice> : null}
      <div className="split">
        <div className="stack">
          <Card>
            <form className="stack" onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                await api.updateMe({ name: name.trim(), email: email.trim() });
                await refreshMe();
                setMsg(t('save') + ' ✓');
              } catch (x) {
                setError(x);
              }
            }}>
              <p className="muted small">{t('phone')}: {maskPhone(m.phone)}</p>
              <Field label={t('name')}><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label={t('email')}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              {m.email && !m.emailVerified ? (
                <Notice>
                  {t('emailNotVerified')}{' '}
                  <Button small kind="ghost" onClick={async () => {
                    try {
                      await api.resendEmail();
                      setMsg(t('emailSent', { email: m.email! }));
                    } catch (x) {
                      setError(x);
                    }
                  }}>{t('resendEmail')}</Button>
                </Notice>
              ) : null}
              <Button kind="primary" type="submit">{t('save')}</Button>
              {msg ? <p className="small ok">{msg}</p> : null}
              <ErrorBox error={error} />
            </form>
          </Card>

          <Card>
            <span className="label">{t('card')}</span>
            <p>{m.card ? `${m.card.brand.toUpperCase()} •••• ${m.card.last4}` : t('cardNone')}</p>
            {cardOpen ? <CardForm onSaved={async () => { await refreshMe(); setCardOpen(false); }} /> : <Button onClick={() => setCardOpen(true)}>{m.card ? t('replaceCard') : t('addCard')}</Button>}
          </Card>

          <Card>
            <span className="label">{t('language')}</span>
            <div className="row">
              <Button small kind={lang === 'en' ? 'primary' : 'secondary'} onClick={() => setLang('en')}>English</Button>
              <Button small kind={lang === 'ru' ? 'primary' : 'secondary'} onClick={() => setLang('ru')}>Русский</Button>
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card>
            <span className="label">{t('notifications')}</span>
            <div className="row between">
              <span>{t('browserPush')}</span>
              {push === 'on' ? (
                <Button small onClick={async () => setPush(await disablePush())}>{t('pushOn')} ✓</Button>
              ) : push === 'off' && site?.vapidPublicKey ? (
                <Button small kind="primary" onClick={async () => {
                  try {
                    setPush(await enablePush(site.vapidPublicKey!));
                  } catch (x) {
                    setError(x);
                  }
                }}>{t('pushOff')}</Button>
              ) : push === 'denied' ? <span className="small muted">{t('pushBlocked')}</span> : push === 'unsupported' ? null : <span className="small muted">—</span>}
            </div>
            {push === 'unsupported' ? <p className="small muted">{t('pushUnsupported')}</p> : null}
            <label className="check">
              <input type="checkbox" checked={m.emailAlerts} onChange={async (e) => {
                try {
                  await api.updateMe({ emailAlerts: e.target.checked });
                  await refreshMe();
                } catch (x) {
                  setError(x);
                }
              }} />
              <span>{t('emailAlerts')}</span>
            </label>
          </Card>

          <Card>
            <span className="label">{t('myAlerts')}</span>
            {alerts.loading && !alerts.data ? <Loading /> : null}
            {alerts.data?.length === 0 ? <p className="small muted">{t('noAlerts')}</p> : null}
            {alerts.data?.map((a) => (
              <div key={a.id} className="row between alert-row">
                <Link to={`/send?${new URLSearchParams({ from: `${a.from.city}, ${a.from.province}`, to: `${a.to.city}, ${a.to.province}` })}`}>
                  {a.from.city} → {a.to.city}
                </Link>
                <span className="small muted">{a.dateFrom ?? ''}{a.dateTo ? ` – ${a.dateTo}` : ''}</span>
                <Button small kind="ghost" onClick={async () => {
                  try {
                    await api.deleteAlert(a.id);
                    await alerts.reload();
                  } catch (x) {
                    setError(err(x));
                  }
                }}>{t('deleteAlert')}</Button>
              </div>
            ))}
          </Card>

          <Card>
            <div className="row">
              {m.driver ? <Link to="/driver" className="btn">{t('navDriver')}</Link> : <Link to="/drive" className="btn">{t('navDrive')}</Link>}
              <Link to="/orders" className="btn">{t('navOrders')}</Link>
              <Button kind="ghost" onClick={signOut}>{t('signOut')}</Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function Notifications() {
  return <RequireAuth><NotificationsList /></RequireAuth>;
}

function NotificationsList() {
  const { t, lang, setUnread, onLive } = useApp();
  const { data, error, loading, reload } = useLoad(() => api.notifications(), []);
  useEffect(() => {
    if (data?.length) {
      void api.markRead(data[0]!.id).then(() => setUnread(0));
    }
  }, [data, setUnread]);
  useEffect(() => onLive((e) => { if (e.type === 'notification') void reload(); }), [onLive, reload]);
  return (
    <div className="page narrow-page">
      <PageHead title={t('notificationsTitle')} />
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} onRetry={reload} />
      {data?.length === 0 ? <Empty>{t('noNotifications')}</Empty> : null}
      <div className="list">
        {data?.map((n) => (
          <button key={n.id} className={`card note ${n.read ? '' : 'unread'}`} onClick={() => navigate(n.link ?? (n.orderId ? `/o/${n.orderId}` : '/notifications'))}>
            <div className="row between"><b>{n.title}</b><span className="small muted">{dayTime(n.createdAt, lang)}</span></div>
            <span className="small">{n.body}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
