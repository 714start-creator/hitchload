import { useColorScheme } from 'react-native';

// Highway-sign green, as in the prototype.
const light = {
  bg: '#eef1ef',
  panel: '#ffffff',
  ink: '#18201c',
  muted: '#5c6862',
  line: '#d5dcd8',
  sign: '#0b6b45',
  signInk: '#ffffff',
  signSoft: '#e2f1ea',
  amber: '#b86e00',
  amberSoft: '#fbefd9',
  red: '#b3261e',
  redSoft: '#fbe4e2',
  chip: '#f3f6f4',
};
const dark: typeof light = {
  bg: '#101512',
  panel: '#18201b',
  ink: '#e7ede9',
  muted: '#9aa8a1',
  line: '#2c3731',
  sign: '#2fa673',
  signInk: '#08140e',
  signSoft: '#16302a',
  amber: '#e8a33d',
  amberSoft: '#332611',
  red: '#ef7b72',
  redSoft: '#3a1d1b',
  chip: '#1f2923',
};

export type Colors = typeof light;

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 };
export const radius = { s: 8, m: 12, l: 18 };
