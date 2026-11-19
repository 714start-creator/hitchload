// Canadian cities drivers can use as route stops (approximate city-centre coordinates).
export interface City {
  city: string;
  province: string;
  lat: number;
  lng: number;
}

export const CITIES: City[] = [
  // Alberta
  { city: 'Edmonton', province: 'AB', lat: 53.5461, lng: -113.4938 },
  { city: 'Calgary', province: 'AB', lat: 51.0447, lng: -114.0719 },
  { city: 'Red Deer', province: 'AB', lat: 52.2681, lng: -113.8112 },
  { city: 'Lethbridge', province: 'AB', lat: 49.6956, lng: -112.8451 },
  { city: 'Medicine Hat', province: 'AB', lat: 50.0405, lng: -110.6766 },
  { city: 'Grande Prairie', province: 'AB', lat: 55.1707, lng: -118.7947 },
  { city: 'Fort McMurray', province: 'AB', lat: 56.7268, lng: -111.381 },
  { city: 'Airdrie', province: 'AB', lat: 51.2927, lng: -114.0134 },
  { city: 'Leduc', province: 'AB', lat: 53.2594, lng: -113.5492 },
  { city: 'Lloydminster', province: 'AB', lat: 53.2783, lng: -110.0056 },
  { city: 'Camrose', province: 'AB', lat: 53.0167, lng: -112.8333 },
  { city: 'Lacombe', province: 'AB', lat: 52.4683, lng: -113.7369 },
  { city: 'Olds', province: 'AB', lat: 51.7928, lng: -114.1067 },
  { city: 'Banff', province: 'AB', lat: 51.1784, lng: -115.5708 },
  { city: 'Canmore', province: 'AB', lat: 51.089, lng: -115.359 },
  { city: 'Hinton', province: 'AB', lat: 53.4053, lng: -117.5856 },
  { city: 'Whitecourt', province: 'AB', lat: 54.1437, lng: -115.6833 },
  { city: 'Cold Lake', province: 'AB', lat: 54.4642, lng: -110.1825 },
  { city: 'Brooks', province: 'AB', lat: 50.5642, lng: -111.8989 },
  // British Columbia
  { city: 'Vancouver', province: 'BC', lat: 49.2827, lng: -123.1207 },
  { city: 'Surrey', province: 'BC', lat: 49.1913, lng: -122.849 },
  { city: 'Abbotsford', province: 'BC', lat: 49.0504, lng: -122.3045 },
  { city: 'Kamloops', province: 'BC', lat: 50.6745, lng: -120.3273 },
  { city: 'Kelowna', province: 'BC', lat: 49.888, lng: -119.496 },
  { city: 'Vernon', province: 'BC', lat: 50.267, lng: -119.272 },
  { city: 'Revelstoke', province: 'BC', lat: 50.9981, lng: -118.1957 },
  { city: 'Golden', province: 'BC', lat: 51.2985, lng: -116.9631 },
  { city: 'Cranbrook', province: 'BC', lat: 49.5097, lng: -115.7693 },
  { city: 'Prince George', province: 'BC', lat: 53.9171, lng: -122.7497 },
  { city: 'Victoria', province: 'BC', lat: 48.4284, lng: -123.3656 },
  { city: 'Nanaimo', province: 'BC', lat: 49.1659, lng: -123.9401 },
  // Saskatchewan
  { city: 'Saskatoon', province: 'SK', lat: 52.1332, lng: -106.67 },
  { city: 'Regina', province: 'SK', lat: 50.4452, lng: -104.6189 },
  { city: 'Prince Albert', province: 'SK', lat: 53.2033, lng: -105.7531 },
  { city: 'Moose Jaw', province: 'SK', lat: 50.3934, lng: -105.5519 },
  { city: 'Swift Current', province: 'SK', lat: 50.2851, lng: -107.7972 },
  { city: 'North Battleford', province: 'SK', lat: 52.7575, lng: -108.2861 },
  // Manitoba
  { city: 'Winnipeg', province: 'MB', lat: 49.8951, lng: -97.1384 },
  { city: 'Brandon', province: 'MB', lat: 49.8485, lng: -99.9501 },
  // Ontario
  { city: 'Toronto', province: 'ON', lat: 43.6532, lng: -79.3832 },
  { city: 'Ottawa', province: 'ON', lat: 45.4215, lng: -75.6972 },
  { city: 'Mississauga', province: 'ON', lat: 43.589, lng: -79.6441 },
  { city: 'Hamilton', province: 'ON', lat: 43.2557, lng: -79.8711 },
  { city: 'London', province: 'ON', lat: 42.9849, lng: -81.2453 },
  { city: 'Kitchener', province: 'ON', lat: 43.4516, lng: -80.4925 },
  { city: 'Windsor', province: 'ON', lat: 42.3149, lng: -83.0364 },
  { city: 'Kingston', province: 'ON', lat: 44.2312, lng: -76.486 },
  { city: 'Sudbury', province: 'ON', lat: 46.4917, lng: -80.993 },
  { city: 'Thunder Bay', province: 'ON', lat: 48.3809, lng: -89.2477 },
  { city: 'Sault Ste. Marie', province: 'ON', lat: 46.5219, lng: -84.3461 },
  // Quebec
  { city: 'Montréal', province: 'QC', lat: 45.5019, lng: -73.5674 },
  { city: 'Québec', province: 'QC', lat: 46.8139, lng: -71.208 },
  { city: 'Gatineau', province: 'QC', lat: 45.4765, lng: -75.7013 },
  { city: 'Sherbrooke', province: 'QC', lat: 45.4042, lng: -71.8929 },
  { city: 'Trois-Rivières', province: 'QC', lat: 46.3432, lng: -72.5418 },
  // Atlantic
  { city: 'Moncton', province: 'NB', lat: 46.0878, lng: -64.7782 },
  { city: 'Fredericton', province: 'NB', lat: 45.9636, lng: -66.6431 },
  { city: 'Saint John', province: 'NB', lat: 45.2733, lng: -66.0633 },
  { city: 'Halifax', province: 'NS', lat: 44.6488, lng: -63.5752 },
  { city: 'Charlottetown', province: 'PE', lat: 46.2382, lng: -63.1311 },
  { city: "St. John's", province: 'NL', lat: 47.5615, lng: -52.7126 },
  // North
  { city: 'Whitehorse', province: 'YT', lat: 60.7212, lng: -135.0568 },
  { city: 'Yellowknife', province: 'NT', lat: 62.454, lng: -114.3718 },
];

export function findCity(name: string, province?: string): City | undefined {
  const n = name.trim().toLowerCase();
  return CITIES.find((c) => c.city.toLowerCase() === n && (!province || c.province === province.toUpperCase()));
}
