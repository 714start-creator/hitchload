import { Redirect } from 'expo-router';
import { useSession } from '../src/session';

export default function Index() {
  const { token, mode } = useSession();
  if (!token) return <Redirect href="/sign-in" />;
  return <Redirect href={mode === 'driver' ? '/driver' : '/client'} />;
}
