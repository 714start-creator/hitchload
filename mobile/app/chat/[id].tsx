// In-app chat for one order. Contacts are hidden by the server.
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native';
import { time } from '../../src/format';
import { useSession } from '../../src/session';
import { radius, space, useColors } from '../../src/theme';
import type { Message } from '../../src/types';
import { Button, ErrorBox, P } from '../../src/ui';

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, t, lang, subscribe, errorMessage } = useSession();
  const c = useColors();
  const [items, setItems] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const list = useRef<FlatList<Message>>(null);

  useEffect(() => {
    api.messages(id).then(setItems).catch((e) => setErr(errorMessage(e)));
    return subscribe((e) => {
      if (e.type === 'message' && e.data?.orderId === id) {
        setItems((prev) => (prev.some((m) => m.id === e.data.id) ? prev : [...prev, e.data as Message]));
      }
    });
  }, [api, id, subscribe, errorMessage]);

  useEffect(() => {
    setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
  }, [items.length]);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ padding: space.m }}>
        <P small muted>{t('chatWarn')}</P>
      </View>
      <FlatList
        ref={list}
        data={items}
        keyExtractor={(m: Message) => String(m.id)}
        contentContainerStyle={{ padding: space.m, gap: 6 }}
        renderItem={({ item: m }: { item: Message }) =>
          m.from === 'system' ? (
            <Text style={{ alignSelf: 'center', color: c.muted, fontSize: 12 }}>{m.body}</Text>
          ) : (
            <View style={{ alignSelf: m.from === 'me' ? 'flex-end' : 'flex-start', maxWidth: '82%', backgroundColor: m.from === 'me' ? c.signSoft : c.panel, borderColor: c.line, borderWidth: 1, borderRadius: radius.m, padding: 10 }}>
              <Text style={{ color: c.ink }}>{m.body}</Text>
              <Text style={{ color: c.muted, fontSize: 11, alignSelf: 'flex-end' }}>{time(m.createdAt, lang)}</Text>
            </View>
          )
        }
      />
      <ErrorBox text={err} />
      <View style={{ flexDirection: 'row', gap: space.s, padding: space.m, borderTopWidth: 1, borderColor: c.line, backgroundColor: c.panel }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t('chatPh')}
          placeholderTextColor={c.muted}
          multiline
          style={{ flex: 1, color: c.ink, borderWidth: 1, borderColor: c.line, borderRadius: radius.s, paddingHorizontal: 10, paddingVertical: 8, maxHeight: 120 }}
        />
        <Button
          small
          title={t('send')}
          disabled={!text.trim()}
          onPress={async () => {
            setErr(null);
            try {
              const m = await api.sendMessage(id, text);
              setItems((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
              setText('');
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
