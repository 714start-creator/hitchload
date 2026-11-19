// Feature components: address input, city picker, route map, status pill.
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import type { PlaceValue } from './format';
import { autocomplete, hasPlacesKey, newSessionToken, placeDetails, type Suggestion } from './places';
import { useSession } from './session';
import { radius, space, useColors } from './theme';
import type { OrderStatus, Stop } from './types';
import { Button, Field, Label, P, Pill, Row } from './ui';

type City = { city: string; province: string; lat: number; lng: number };

let cityCache: City[] | null = null;
export function useCities(): City[] {
  const { api } = useSession();
  const [cities, setCities] = useState<City[]>(cityCache ?? []);
  useEffect(() => {
    if (cityCache) return;
    api.cities().then((c) => {
      cityCache = c;
      setCities(c);
    }).catch(() => undefined);
  }, [api]);
  return cities;
}

export function CityPicker({ visible, onPick, onClose }: { visible: boolean; onPick: (c: City) => void; onClose: () => void }) {
  const c = useColors();
  const { t } = useSession();
  const cities = useCities();
  const [q, setQ] = useState('');
  const list = useMemo(() => cities.filter((x) => x.city.toLowerCase().includes(q.trim().toLowerCase())), [cities, q]);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.bg, padding: space.l, paddingTop: 56, gap: space.m }}>
        <Field autoFocus value={q} onChangeText={setQ} placeholder={t('addStop')} />
        <FlatList
          data={list}
          keyExtractor={(x: City) => x.city + x.province}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }: { item: City }) => (
            <Pressable onPress={() => onPick(item)} style={{ paddingVertical: 12, borderBottomWidth: 1, borderColor: c.line }}>
              <Text style={{ color: c.ink, fontSize: 16 }}>
                {item.city}, <Text style={{ color: c.muted }}>{item.province}</Text>
              </Text>
            </Pressable>
          )}
        />
        <Button kind="secondary" title={t('close')} onPress={onClose} />
      </View>
    </Modal>
  );
}

/**
 * Address field. With a Google key: live suggestions limited to Canada.
 * Without one (local development): street address + city from the list.
 */
export function PlaceInput({ label, value, onChange }: { label: string; value: PlaceValue | null; onChange: (p: PlaceValue | null) => void }) {
  const c = useColors();
  const { t, lang } = useSession();
  const [text, setText] = useState(value?.address ?? '');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [picking, setPicking] = useState(false);
  const session = useRef(newSessionToken());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setText(value ? `${value.address}, ${value.city}` : '');
  }, [value]);

  if (!hasPlacesKey()) {
    return (
      <View style={{ gap: 4 }}>
        <Label>{label}</Label>
        <Row>
          <TextInput
            value={value?.address ?? text}
            onChangeText={(s: string) => {
              setText(s);
              if (value) onChange({ ...value, address: s });
            }}
            placeholder={t('addressPh')}
            placeholderTextColor={c.muted}
            style={{ flex: 1, borderWidth: 1, borderColor: c.line, borderRadius: radius.s, padding: 9, color: c.ink, backgroundColor: c.panel }}
          />
          <Button small kind="secondary" title={value?.city ?? '…'} onPress={() => setPicking(true)} />
        </Row>
        <CityPicker
          visible={picking}
          onClose={() => setPicking(false)}
          onPick={(city) => {
            setPicking(false);
            onChange({ address: text || city.city, city: city.city, province: city.province, lat: city.lat, lng: city.lng });
          }}
        />
      </View>
    );
  }

  return (
    <View style={{ gap: 4 }}>
      <Label>{label}</Label>
      <TextInput
        value={text}
        onChangeText={(s: string) => {
          setText(s);
          onChange(null);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            autocomplete(s, session.current, lang).then(setItems).catch(() => setItems([]));
          }, 300);
        }}
        placeholder={t('addressPh')}
        placeholderTextColor={c.muted}
        style={{ borderWidth: 1, borderColor: value ? c.sign : c.line, borderRadius: radius.s, padding: 9, color: c.ink, backgroundColor: c.panel }}
      />
      {items.length > 0 && !value ? (
        <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: radius.s, backgroundColor: c.panel }}>
          {items.slice(0, 5).map((s) => (
            <Pressable
              key={s.placeId}
              onPress={async () => {
                const p = await placeDetails(s.placeId, session.current, lang);
                session.current = newSessionToken();
                setItems([]);
                if (p) onChange(p);
              }}
              style={{ padding: 10, borderBottomWidth: 1, borderColor: c.line }}
            >
              <Text style={{ color: c.ink }}>{s.main}</Text>
              <Text style={{ color: c.muted, fontSize: 12 }}>{s.secondary}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Map of routes: highlighted ones pass the customer's pickup and dropoff. */
export function RouteMap({ trips, highlight, pickup, dropoff, driver, height = 220 }: { trips: { id: string; stops: Stop[] }[]; highlight?: Set<string>; pickup?: PlaceValue | null; dropoff?: PlaceValue | null; driver?: { lat: number; lng: number } | null; height?: number }) {
  const c = useColors();
  const points = [
    ...trips.flatMap((t) => t.stops),
    ...(pickup ? [pickup] : []),
    ...(dropoff ? [dropoff] : []),
    ...(driver ? [driver] : []),
  ];
  if (!points.length) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const region = {
    latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
    longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    latitudeDelta: Math.max(0.05, (Math.max(...lats) - Math.min(...lats)) * 1.4),
    longitudeDelta: Math.max(0.05, (Math.max(...lngs) - Math.min(...lngs)) * 1.4),
  };
  return (
    <View style={{ height, borderRadius: radius.m, overflow: 'hidden', borderWidth: 1, borderColor: c.line }}>
      <MapView style={{ flex: 1 }} provider={PROVIDER_GOOGLE} initialRegion={region} toolbarEnabled={false}>
        {trips.map((t) => {
          const on = highlight?.has(t.id) ?? false;
          return (
            <Polyline
              key={t.id}
              coordinates={t.stops.map((s) => ({ latitude: s.lat, longitude: s.lng }))}
              strokeColor={on ? c.sign : c.muted}
              strokeWidth={on ? 4 : 2}
              lineDashPattern={on ? undefined : [6, 6]}
            />
          );
        })}
        {pickup ? <Marker coordinate={{ latitude: pickup.lat, longitude: pickup.lng }} title={pickup.address} pinColor="green" /> : null}
        {dropoff ? <Marker coordinate={{ latitude: dropoff.lat, longitude: dropoff.lng }} title={dropoff.address} /> : null}
        {driver ? <Marker coordinate={{ latitude: driver.lat, longitude: driver.lng }} pinColor="blue" /> : null}
      </MapView>
    </View>
  );
}

export function StatusPill({ status }: { status: OrderStatus }) {
  const { t } = useSession();
  const tone = status === 'open' ? 'wait' : status === 'delivered' ? 'done' : status === 'cancelled' ? 'plain' : 'go';
  return <Pill tone={tone} text={t(`st_${status}` as const)} />;
}

export function SizeLabel({ size }: { size: string }) {
  const { t } = useSession();
  return <P small>{t(`size${size}` as 'sizeS')}</P>;
}

export const sizeOrder = ['S', 'M', 'L', 'XL', 'AUTO'] as const;
