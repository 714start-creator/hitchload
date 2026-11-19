// Address search with Google Places API (New), limited to Canada.
import Constants from 'expo-constants';
import { placeFromGoogle, type PlaceValue } from './format';

const KEY: string = (Constants.expoConfig?.extra as { googleMapsApiKey?: string } | undefined)?.googleMapsApiKey ?? '';

export interface Suggestion {
  placeId: string;
  main: string;
  secondary: string;
}

export async function autocomplete(input: string, sessionToken: string, lang: string, near?: { lat: number; lng: number }): Promise<Suggestion[]> {
  if (!KEY || input.trim().length < 3) return [];
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
    body: JSON.stringify({
      input,
      sessionToken,
      includedRegionCodes: ['ca'],
      languageCode: lang,
      ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50000 } } } : {}),
    }),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { suggestions?: { placePrediction?: { placeId: string; structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } } } }[] };
  return (json.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({ placeId: p.placeId, main: p.structuredFormat?.mainText?.text ?? '', secondary: p.structuredFormat?.secondaryText?.text ?? '' }));
}

export async function placeDetails(placeId: string, sessionToken: string, lang: string): Promise<PlaceValue | null> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${sessionToken}&languageCode=${lang}`, {
    headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'formattedAddress,location,addressComponents' },
  });
  if (!res.ok) return null;
  return placeFromGoogle(await res.json());
}

export const hasPlacesKey = () => Boolean(KEY);
export const newSessionToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
