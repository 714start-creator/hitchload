import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { maskPhone } from '../src/format';
import { useSession } from '../src/session';
import { space, useColors } from '../src/theme';
import { Button, Choice, ErrorBox, Field, P, Screen } from '../src/ui';

export default function SignIn() {
  const { api, signIn, t, errorMessage, setMode, mode } = useSession();
  const c = useColors();
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <Screen>
        <View style={{ alignItems: 'flex-start', marginTop: 48, marginBottom: space.l }}>
          <View style={{ backgroundColor: c.sign, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 6, borderWidth: 2, borderColor: c.signInk }}>
            <Text style={{ color: c.signInk, fontSize: 30, fontWeight: '800', letterSpacing: 1 }}>{t('appName').toUpperCase()}</Text>
          </View>
        </View>
        <Text style={{ color: c.ink, fontSize: 22, fontWeight: '700' }}>{t('signInTitle')}</Text>
        <Choice
          value={mode}
          onChange={setMode}
          options={[
            { value: 'client', label: t('iAmClient') },
            { value: 'driver', label: t('iAmDriver') },
          ]}
        />
        {!sentTo ? (
          <>
            <Field label={t('phone')} value={maskPhone(phone)} onChangeText={setPhone} keyboardType="phone-pad" placeholder="(780) 555-0123" autoComplete="tel" textContentType="telephoneNumber" />
            <Button
              title={t('getCode')}
              disabled={phone.replace(/\D/g, '').length < 10}
              onPress={async () => {
                setError(null);
                try {
                  const r = await api.startOtp(phone);
                  setSentTo(r.phone);
                  setDevCode(r.devCode);
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          </>
        ) : (
          <>
            <P muted>{t('codeSent', { phone: sentTo })}</P>
            {devCode ? <P small muted>{t('devCode', { code: devCode })}</P> : null}
            <Field label={t('code')} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode" maxLength={6} autoFocus />
            <Button
              title={t('signIn')}
              disabled={code.length < 4}
              onPress={async () => {
                setError(null);
                try {
                  const r = await api.verifyOtp(sentTo, code);
                  await signIn(r.token, r.user);
                  router.replace(mode === 'driver' ? '/driver' : '/client');
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
            <Button kind="ghost" title={t('changePhone')} onPress={() => { setSentTo(null); setCode(''); }} />
          </>
        )}
        <ErrorBox text={error} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
