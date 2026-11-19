// Small set of shared UI pieces built on React Native primitives.
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { countdown, money } from './format';
import { radius, space, useColors, type Colors } from './theme';

export function Screen({ children, refreshing, onRefresh, scroll = true }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void; scroll?: boolean }) {
  const c = useColors();
  const body = <View style={{ padding: space.l, gap: space.m }}>{children}</View>;
  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: c.bg }}>
      {scroll ? (
        <ScrollView keyboardShouldPersistTaps="handled" refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} /> : undefined}>
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

export function Card({ children, highlight, style }: { children: ReactNode; highlight?: boolean; style?: ViewStyle }) {
  const c = useColors();
  return (
    <View style={[{ backgroundColor: highlight ? c.signSoft : c.panel, borderColor: highlight ? c.sign : c.line, borderWidth: 1, borderRadius: radius.m, padding: space.m, gap: space.s }, style]}>
      {children}
    </View>
  );
}

export function H({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={{ fontSize: 18, fontWeight: '700', color: c.ink }}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: c.muted }}>{children}</Text>;
}

export function P({ children, muted, small, style }: { children: ReactNode; muted?: boolean; small?: boolean; style?: object }) {
  const c = useColors();
  return <Text style={[{ color: muted ? c.muted : c.ink, fontSize: small ? 12 : 14, lineHeight: small ? 17 : 20 }, style]}>{children}</Text>;
}

export function Row({ children, between, wrap, style }: { children: ReactNode; between?: boolean; wrap?: boolean; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.s, justifyContent: between ? 'space-between' : 'flex-start', flexWrap: wrap ? 'wrap' : 'nowrap' }, style]}>{children}</View>;
}

type BtnKind = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ title, onPress, kind = 'primary', disabled, busy, small }: { title: string; onPress: () => void | Promise<void>; kind?: BtnKind; disabled?: boolean; busy?: boolean; small?: boolean }) {
  const c = useColors();
  const [running, setRunning] = useState(false);
  const loading = busy || running;
  const bg = kind === 'primary' ? c.sign : kind === 'danger' ? c.redSoft : kind === 'ghost' ? 'transparent' : c.panel;
  const fg = kind === 'primary' ? c.signInk : kind === 'danger' ? c.red : c.ink;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={async () => {
        setRunning(true);
        try {
          await onPress();
        } finally {
          setRunning(false);
        }
      }}
      style={({ pressed }: { pressed: boolean }) => ({
        backgroundColor: bg,
        borderColor: kind === 'primary' ? c.sign : kind === 'danger' ? c.red : c.line,
        borderWidth: kind === 'ghost' ? 0 : 1,
        borderRadius: radius.s,
        paddingVertical: small ? 7 : 12,
        paddingHorizontal: small ? 10 : 14,
        alignItems: 'center',
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '700', fontSize: small ? 13 : 15 }}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label?: string; hint?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 4, flex: props.style ? undefined : 1 }}>
      {label ? <Label>{label}</Label> : null}
      <TextInput
        placeholderTextColor={c.muted}
        {...props}
        style={[{ borderWidth: 1, borderColor: c.line, borderRadius: radius.s, paddingHorizontal: 10, paddingVertical: 9, color: c.ink, backgroundColor: c.panel, fontSize: 15 }, props.style]}
      />
      {hint ? <P small muted>{hint}</P> : null}
    </View>
  );
}

export function Pill({ text, tone = 'plain' }: { text: string; tone?: 'plain' | 'go' | 'wait' | 'done' | 'bad' }) {
  const c = useColors();
  const map: Record<string, [string, string, string]> = {
    plain: [c.chip, c.line, c.ink],
    go: [c.signSoft, c.sign, c.ink],
    wait: [c.amberSoft, c.amber, c.ink],
    done: [c.ink, c.ink, c.panel],
    bad: [c.redSoft, c.red, c.red],
  };
  const [bg, border, fg] = map[tone]!;
  return (
    <View style={{ backgroundColor: bg, borderColor: border, borderWidth: 1, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontSize: 11, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

export function Choice<T extends string>({ options, value, onChange }: { options: { value: T; label: string; sub?: string }[]; value: T; onChange: (v: T) => void }) {
  const c = useColors();
  return (
    <Row wrap>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={{ borderWidth: 1, borderColor: on ? c.sign : c.line, backgroundColor: on ? c.signSoft : c.chip, borderRadius: radius.s, paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center', minWidth: 64 }}
          >
            <Text style={{ color: c.ink, fontWeight: '700' }}>{o.label}</Text>
            {o.sub ? <Text style={{ color: c.muted, fontSize: 11 }}>{o.sub}</Text> : null}
          </Pressable>
        );
      })}
    </Row>
  );
}

export function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: value ? c.sign : c.line, backgroundColor: value ? c.sign : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        {value ? <Text style={{ color: c.signInk, fontWeight: '900', fontSize: 13 }}>✓</Text> : null}
      </View>
      <Text style={{ color: c.ink, flex: 1 }}>{label}</Text>
    </Pressable>
  );
}

export function MoneyLines({ lines, total }: { lines: [string, number, boolean?][]; total: [string, number] }) {
  const c = useColors();
  return (
    <View style={{ gap: 3 }}>
      {lines.map(([label, cents, minus]) => (
        <Row between key={label}>
          <P muted>{label}</P>
          <P muted>{(minus ? '−' : '') + money(cents)}</P>
        </Row>
      ))}
      <View style={{ borderTopWidth: 1, borderStyle: 'dashed', borderColor: c.line, marginTop: 2, paddingTop: 4 }}>
        <Row between>
          <Text style={{ color: c.ink, fontWeight: '700' }}>{total[0]}</Text>
          <Text style={{ color: c.ink, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{money(total[1])}</Text>
        </Row>
      </View>
    </View>
  );
}

export function ErrorBox({ text, onRetry, retryLabel }: { text: string | null; onRetry?: () => void; retryLabel?: string }) {
  const c = useColors();
  if (!text) return null;
  return (
    <View style={{ backgroundColor: c.redSoft, borderColor: c.red, borderWidth: 1, borderRadius: radius.s, padding: space.m, gap: space.s }}>
      <Text style={{ color: c.red }}>{text}</Text>
      {onRetry ? <Button small kind="secondary" title={retryLabel ?? 'Retry'} onPress={onRetry} /> : null}
    </View>
  );
}

export function Notice({ text, tone = 'wait' }: { text: string; tone?: 'wait' | 'go' }) {
  const c = useColors();
  return (
    <View style={{ backgroundColor: tone === 'go' ? c.signSoft : c.amberSoft, borderColor: tone === 'go' ? c.sign : c.amber, borderWidth: 1, borderRadius: radius.s, padding: 10 }}>
      <Text style={{ color: c.ink, fontSize: 13 }}>{text}</Text>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  const c = useColors();
  return (
    <View style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: c.line, borderRadius: radius.m, padding: space.xl }}>
      <Text style={{ color: c.muted, textAlign: 'center' }}>{text}</Text>
    </View>
  );
}

export function Loading({ text }: { text: string }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.m, backgroundColor: c.bg }}>
      <ActivityIndicator color={c.sign} />
      <Text style={{ color: c.muted }}>{text}</Text>
    </View>
  );
}

/** Ticks every second while mounted. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Countdown({ to, render }: { to: string; render: (left: string) => string }) {
  const now = useNow();
  const left = countdown(to, now);
  return left ? <P small muted>{render(left)}</P> : null;
}

export function Photos({ urls, size = 72 }: { urls: string[]; size?: number }) {
  const c = useColors();
  if (!urls.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
      {urls.map((u) => (
        <Image key={u} source={{ uri: u }} style={{ width: size, height: size, borderRadius: radius.s, backgroundColor: c.chip }} />
      ))}
    </ScrollView>
  );
}

export function Stars({ value, onChange }: { value: number; onChange?: (n: number) => void }) {
  const c = useColors();
  return (
    <Row>
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable key={n} accessibilityLabel={`${n}`} disabled={!onChange} onPress={() => onChange?.(n)} hitSlop={6}>
          <Text style={{ fontSize: 28, color: n <= value ? c.amber : c.line }}>★</Text>
        </Pressable>
      ))}
    </Row>
  );
}

export function Route({ from, to, sub }: { from: string; to: string; sub?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: c.ink, fontSize: 17, fontWeight: '700' }}>
        {from} <Text style={{ color: c.sign }}>→</Text> {to}
      </Text>
      {sub ? <P small muted>{sub}</P> : null}
    </View>
  );
}

export function Steps({ index, total = 4 }: { index: number; total?: number }) {
  const c = useColors();
  return (
    <Row>
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i < index ? c.sign : c.line }} />
      ))}
    </Row>
  );
}

export const styles = StyleSheet.create({ flex1: { flex: 1 } });
export type { Colors };
