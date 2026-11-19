// "I'm driving": publish a route with stops and a departure time.
import { useState } from 'react';
import { CityPicker, RouteMap } from '../../src/components';
import { buildWindow, dayTime } from '../../src/format';
import { useLoad, useSession } from '../../src/session';
import type { Stop } from '../../src/types';
import { Button, Card, Choice, Empty, ErrorBox, Field, H, Label, P, Pill, Row, Screen } from '../../src/ui';

export default function Trips() {
  const { api, t, lang, errorMessage, me } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.trips(), [], []);
  const [stops, setStops] = useState<Stop[]>([]);
  const [picking, setPicking] = useState(false);
  const [day, setDay] = useState<'0' | '1' | '2'>('0');
  const [dep, setDep] = useState('16:00');
  const [space, setSpace] = useState<'quarter' | 'half' | 'full'>('half');
  const [err, setErr] = useState<string | null>(null);

  const approved = me?.driver?.status === 'approved';
  const departAt = buildWindow(Number(day), dep, '23:59')?.start;

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {approved ? (
        <Card>
          <H>{t('newTrip')}</H>
          <Label>{t('stops')}</Label>
          {stops.map((s, i) => (
            <Row between key={`${s.city}-${i}`}>
              <P>{i + 1}. {s.city}, {s.province}</P>
              <Button small kind="ghost" title="✕" onPress={() => setStops(stops.filter((_, j) => j !== i))} />
            </Row>
          ))}
          <Button kind="secondary" title={t('addStop')} disabled={stops.length >= 8} onPress={() => setPicking(true)} />
          <CityPicker visible={picking} onClose={() => setPicking(false)} onPick={(c) => { setPicking(false); setStops([...stops, c]); }} />
          {stops.length >= 2 ? <RouteMap trips={[{ id: 'new', stops }]} highlight={new Set(['new'])} height={160} /> : null}
          <Label>{t('departure')}</Label>
          <Choice value={day} onChange={setDay} options={[{ value: '0', label: t('today') }, { value: '1', label: t('tomorrow') }, { value: '2', label: t('dayAfter') }]} />
          <Field value={dep} onChangeText={setDep} keyboardType="numbers-and-punctuation" maxLength={5} placeholder="16:00" />
          <Label>{t('freeSpace')}</Label>
          <Choice value={space} onChange={setSpace} options={[{ value: 'quarter', label: t('spaceQuarter') }, { value: 'half', label: t('spaceHalf') }, { value: 'full', label: t('spaceFull') }]} />
          <Button
            title={t('publish')}
            disabled={stops.length < 2 || !departAt}
            onPress={async () => {
              setErr(null);
              try {
                await api.createTrip({ stops: stops.map((s) => ({ city: s.city, province: s.province })), departAt: departAt!, space });
                setStops([]);
                await reload();
              } catch (e) {
                setErr(errorMessage(e));
              }
            }}
          />
          <ErrorBox text={err} />
        </Card>
      ) : (
        <P muted>{t('notApproved')}</P>
      )}
      <ErrorBox text={error} />
      {data && data.length === 0 ? <Empty text={t('noTripsMine')} /> : null}
      {data?.map((trip) => (
        <Card key={trip.id} highlight>
          <Row between>
            <P style={{ fontWeight: '700' }}>{trip.stops.map((s) => s.city).join(' → ')}</P>
            <Pill text={t(trip.space === 'full' ? 'spaceFull' : trip.space === 'quarter' ? 'spaceQuarter' : 'spaceHalf')} />
          </Row>
          <P small muted>{t('departs', { time: dayTime(trip.departAt, lang) })}</P>
          <Button small kind="ghost" title={t('cancelTrip')} onPress={async () => { await api.cancelTrip(trip.id); await reload(); }} />
        </Card>
      ))}
    </Screen>
  );
}
