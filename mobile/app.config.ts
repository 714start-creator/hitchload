import type { ExpoConfig } from 'expo/config';

// Values from the environment (EAS secrets or a local .env):
//   API_URL                 e.g. https://api.poputka.ca
//   GOOGLE_MAPS_API_KEY     Maps SDK for Android/iOS + Places API (New), restricted to the app
//   EAS_PROJECT_ID          from `eas init`
const config: ExpoConfig = {
  name: 'Poputka',
  slug: 'poputka',
  scheme: 'poputka',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  splash: { image: './assets/splash.png', resizeMode: 'contain', backgroundColor: '#0b6b45' },
  ios: {
    bundleIdentifier: 'ca.poputka.app',
    supportsTablet: false,
    config: { googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY },
    infoPlist: {
      NSLocationWhenInUseUsageDescription: 'Poputka shows your position to the customer while you are on a delivery.',
      NSCameraUsageDescription: 'Take photos of the cargo and your documents.',
      NSPhotoLibraryUsageDescription: 'Attach photos of the cargo and your documents.',
    },
  },
  android: {
    package: 'ca.poputka.app',
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#0b6b45' },
    permissions: ['ACCESS_FINE_LOCATION', 'CAMERA', 'POST_NOTIFICATIONS'],
    config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_API_KEY } },
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-notifications', { color: '#0b6b45' }],
    ['expo-location', { locationWhenInUsePermission: 'Poputka shows your position to the customer while you are on a delivery.' }],
    ['expo-image-picker', { cameraPermission: 'Take photos of the cargo and your documents.' }],
    ['@stripe/stripe-react-native', { merchantIdentifier: 'merchant.ca.poputka', enableGooglePay: true }],
  ],
  experiments: { typedRoutes: false },
  extra: {
    apiUrl: process.env.API_URL ?? 'http://localhost:8080',
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
};

export default config;
