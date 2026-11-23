import { useState } from 'react';
import { api } from '../../lib/api';
import { useApp, useLoad } from '../../lib/app';
import { money } from '../../lib/format';
import { ErrorSummary, useFormErrors } from '../../lib/form';
import { Button, Card, ErrorBox, Field, Loading, Notice, PageHead, RequireAuth } from '../../lib/ui';
import { DriverNav } from './Feed';
import { Link } from '../../lib/app';

export function Earnings() {
  return <RequireAuth><EarningsPage /></RequireAuth>;
}

function EarningsPage() {
  const { t, me } = useApp();
  const { data, error, loading, reload } = useLoad(() => api.earnings(), []);
  return (
    <div className="page">
      <PageHead title={t('earnings')} />
      <DriverNav />
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} onRetry={reload} />
      {data ? (
        <div className="tiles">
          {([['today', data.todayCents], ['week', data.weekCents], ['yearToDate', data.yearCents], ['held', data.heldCents], ['feesPaid', data.feesYearCents]] as const).map(([k, v]) => (
            <div key={k} className="card tile"><span className="muted small">{t(k)}</span><b className="money big">{money(v)}</b></div>
          ))}
        </div>
      ) : null}
      {!me?.driver?.taxInfo ? <Notice>{t('taxText')} <Link to="/driver/tax">{t('taxTitle')}</Link></Notice> : null}
    </div>
  );
}

export function Tax() {
  return <RequireAuth><TaxPage /></RequireAuth>;
}

function TaxPage() {
  const { t, me, refreshMe, site } = useApp();
  const [type, setType] = useState<'sin' | 'bn'>('sin');
  const [number, setNumber] = useState('');
  const [gst, setGst] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const info = me?.driver?.taxInfo;
  const f = useFormErrors();
  return (
    <div className="page narrow-page">
      <PageHead title={t('taxTitle')} text={t('taxText')} back="/driver/earnings" />
      {info ? <Notice tone="go">{info.type.toUpperCase()} •••{info.last3}</Notice> : null}
      {done ? <Notice tone="go">{t('taxSaved')}</Notice> : null}
      <Card>
        <div className="row">
          <Button small kind={type === 'sin' ? 'primary' : 'secondary'} onClick={() => setType('sin')}>{t('sin')}</Button>
          <Button small kind={type === 'bn' ? 'primary' : 'secondary'} onClick={() => setType('bn')}>{t('bn')}</Button>
        </div>
        <Field name="number" error={f.errors.number} label={type === 'sin' ? t('sin') : t('bn')}><input id="tax-number" inputMode="numeric" autoComplete="off" value={number} onChange={(e) => { setNumber(e.target.value); f.clear('number'); }} /></Field>
        {site?.devCodes && type === 'sin' ? <p className="small notice" id="tax-test-hint">{t('taxTestHint')}</p> : null}
        <Field name="gst" error={f.errors.gst} label={t('gst')}><input value={gst} onChange={(e) => { setGst(e.target.value); f.clear('gst'); }} /></Field>
        <ErrorSummary errors={f.errors} labels={{ number: type === 'sin' ? t('sin') : t('bn'), gst: t('gst') }} />
        <Button kind="primary" onClick={async () => {
          setError(null);
          if (!f.check({ number: !number.trim() ? t('errRequired') : number.replace(/\D/g, '').length < 9 ? t('errTaxNumber') : '' })) return;
          try {
            await api.saveTax({ type, number, ...(gst ? { gstNumber: gst } : {}) });
            await refreshMe();
            setNumber('');
            setDone(true);
          } catch (e) {
            if (!f.fromServer(e, { invalid_sin: 'number', invalid_bn: 'number', invalid_gst: 'gst' }, { number: 'number', gstNumber: 'gst' })) setError(e);
          }
        }}>{t('save')}</Button>
        <ErrorBox error={error} />
      </Card>
    </div>
  );
}
