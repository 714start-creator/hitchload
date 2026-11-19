// Device features: push registration, photo capture + upload, location, browser.
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import type { Api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/** Asks permission, gets the Expo push token and sends it to the server. */
export async function registerPush(api: Api): Promise<string | null> {
  if (!Device.isDevice) return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('orders', { name: 'Orders', importance: Notifications.AndroidImportance.MAX, sound: 'default' });
    await Notifications.setNotificationChannelAsync('chat', { name: 'Chat', importance: Notifications.AndroidImportance.HIGH });
    await Notifications.setNotificationChannelAsync('account', { name: 'Account', importance: Notifications.AndroidImportance.DEFAULT });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
  await api.savePushToken(token, Platform.OS === 'ios' ? 'ios' : 'android');
  return token;
}

/** Calls `onOpen(orderId)` when a notification is tapped. */
export function onNotificationTap(onOpen: (orderId: string | null, type: string) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => {
    const data = r.notification.request.content.data as { orderId?: string | null; type?: string };
    onOpen(data.orderId ?? null, data.type ?? '');
  });
  return () => sub.remove();
}

export type PhotoSource = 'camera' | 'library';

/** Takes or picks a photo, uploads it and returns the storage key. */
export async function takeAndUpload(api: Api, token: string, purpose: 'order' | 'pickup' | 'delivery' | 'document', source: PhotoSource = 'camera'): Promise<{ key: string; uri: string } | null> {
  const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.6, exif: false };
  const result = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  const type = asset.mimeType ?? 'image/jpeg';
  const res = await FileSystem.uploadAsync(`${api.baseUrl}/v1/uploads?purpose=${purpose}`, asset.uri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
  });
  if (res.status !== 200) throw new Error(`Upload failed (${res.status})`);
  const body = JSON.parse(res.body) as { key: string };
  return { key: body.key, uri: asset.uri };
}

export async function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return null;
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { lat: p.coords.latitude, lng: p.coords.longitude };
}

/** While a job is active, send the driver's position every 30 s (app in foreground). */
export async function watchDriverPosition(api: Api): Promise<() => void> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return () => undefined;
  const sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, timeInterval: 30_000, distanceInterval: 100 }, (p) => {
    api.location(p.coords.latitude, p.coords.longitude).catch(() => undefined);
  });
  return () => sub.remove();
}

export const openBrowser = (url: string) => WebBrowser.openBrowserAsync(url);
