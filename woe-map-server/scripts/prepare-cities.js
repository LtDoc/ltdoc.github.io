#!/usr/bin/env node
'use strict';
/**
 * Build public/earth/cities.json: the major cities of the 1914 world with the names of the time.
 *
 * Natural Earth's populated-places file supplies coordinates only (its populations are modern and would
 * rank Lagos above Vienna); which cities matter, their 1914 names, whether they were capitals and how much
 * industry they carry are authored here. Usage:
 *
 *   node scripts/prepare-cities.js [path/to/ne_10m_populated_places_simple.geojson]
 *
 * Without a path the file is downloaded from the natural-earth-vector repository (public domain).
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const SRC = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson';
const OUT = path.join(__dirname, '..', 'public', 'earth', 'cities.json');

// n: 1914 name · ne: Natural Earth nameascii when different · cap: capital of a 1914 power · ind: industry 1–5
const CITIES = [
  // British Isles
  { n: 'London', cap: 1, ind: 5 }, { n: 'Manchester', ind: 4 }, { n: 'Birmingham', ind: 4 }, { n: 'Glasgow', ind: 4 },
  { n: 'Liverpool', ind: 3 }, { n: 'Leeds', ind: 3 }, { n: 'Sheffield', ind: 3 }, { n: 'Newcastle', adm0: 'United Kingdom', ind: 3 },
  { n: 'Belfast', ind: 3 }, { n: 'Dublin', ind: 2 }, { n: 'Cardiff', ind: 2 }, { n: 'Edinburgh', ind: 2 }, { n: 'Bristol', ind: 2 },
  // France, Belgium, Netherlands, Switzerland
  { n: 'Paris', cap: 1, ind: 5 }, { n: 'Lyon', ind: 3 }, { n: 'Marseille', ind: 3 }, { n: 'Lille', ind: 3 }, { n: 'Bordeaux', ind: 2 },
  { n: 'Nantes', ind: 2 }, { n: 'Toulouse', ind: 2 }, { n: 'Le Havre', ind: 2 }, { n: 'Nancy', ind: 2 }, { n: 'Saint-Étienne', ne: 'Saint-Etienne', ind: 3 },
  { n: 'Brussels', cap: 1, ind: 3 }, { n: 'Antwerp', ne: 'Antwerpen', ind: 3 }, { n: 'Liège', ne: 'Liege', ind: 3 }, { n: 'Ghent', ne: 'Gent', ind: 2 },
  { n: 'Amsterdam', cap: 1, ind: 2 }, { n: 'Rotterdam', ind: 3 }, { n: 'Bern', cap: 1, ind: 1 }, { n: 'Zürich', ne: 'Zurich', ind: 2 },
  // Germany
  { n: 'Berlin', cap: 1, ind: 5 }, { n: 'Hamburg', ind: 4 }, { n: 'Essen', ind: 4 }, { n: 'Cologne', ind: 3 }, { n: 'Munich', ind: 3 },
  { n: 'Leipzig', ind: 3 }, { n: 'Dresden', ind: 3 }, { n: 'Frankfurt', ind: 3 }, { n: 'Stuttgart', ind: 3 }, { n: 'Nuremberg', ne: 'Nurnberg', ind: 2 },
  { n: 'Düsseldorf', ne: 'Dusseldorf', ind: 3 }, { n: 'Dortmund', ind: 3 }, { n: 'Hanover', ne: 'Hannover', ind: 2 }, { n: 'Bremen', ind: 2 },
  { n: 'Kiel', ind: 3 }, { n: 'Königsberg', ne: 'Kaliningrad', ind: 2 }, { n: 'Breslau', ne: 'Wroclaw', ind: 3 }, { n: 'Danzig', ne: 'Gdansk', ind: 2 },
  { n: 'Stettin', ne: 'Szczecin', ind: 2 }, { n: 'Posen', ne: 'Poznan', ind: 2 }, { n: 'Strasbourg', ind: 2 }, { n: 'Magdeburg', ind: 2 },
  // Austria-Hungary and the Balkans
  { n: 'Vienna', cap: 1, ind: 4 }, { n: 'Budapest', ind: 3 }, { n: 'Prague', ind: 3 }, { n: 'Trieste', ind: 2 }, { n: 'Lemberg', ne: 'Lvov', ind: 2 },
  { n: 'Kraków', ne: 'Krakow', ind: 2 }, { n: 'Brünn', ne: 'Brno', ind: 2 }, { n: 'Graz', ind: 2 }, { n: 'Pressburg', ne: 'Bratislava', ind: 1 },
  { n: 'Agram', ne: 'Zagreb', ind: 1 }, { n: 'Sarajevo', ind: 1 }, { n: 'Czernowitz', ne: 'Chernivtsi', ind: 1 }, { n: 'Fiume', ne: 'Rijeka', ind: 1 },
  { n: 'Belgrade', cap: 1, ind: 1 }, { n: 'Sofia', cap: 1, ind: 1 }, { n: 'Bucharest', cap: 1, ind: 2 }, { n: 'Athens', cap: 1, ind: 1 },
  { n: 'Salonika', ne: 'Thessaloniki', ind: 2 }, { n: 'Cetinje', lat: 42.39, lon: 18.92, cap: 1, ind: 1 }, { n: 'Tirana', ind: 1 },
  // Italy and Iberia
  { n: 'Rome', cap: 1, ind: 2 }, { n: 'Milan', ind: 4 }, { n: 'Turin', ind: 3 }, { n: 'Genoa', ind: 3 }, { n: 'Naples', ind: 2 },
  { n: 'Venice', ind: 2 }, { n: 'Bologna', ind: 2 }, { n: 'Florence', ind: 1 }, { n: 'Palermo', ind: 1 }, { n: 'Trento', ind: 1 },
  { n: 'Madrid', cap: 1, ind: 2 }, { n: 'Barcelona', ind: 3 }, { n: 'Bilbao', ind: 3 }, { n: 'Valencia', ind: 1 }, { n: 'Seville', ind: 1 },
  { n: 'Lisbon', cap: 1, ind: 2 }, { n: 'Porto', ind: 1 },
  // Scandinavia
  { n: 'Copenhagen', ne: 'Kobenhavn', cap: 1, ind: 2 }, { n: 'Stockholm', cap: 1, ind: 2 }, { n: 'Gothenburg', ne: 'Goteborg', ind: 2 }, { n: 'Christiania', ne: 'Oslo', cap: 1, ind: 2 },
  { n: 'Bergen', ind: 1 }, { n: 'Helsingfors', ne: 'Helsinki', ind: 2 },
  // Russian Empire
  { n: 'St Petersburg', ne: 'St. Petersburg', adm0: 'Russia', cap: 1, ind: 4 }, { n: 'Moscow', ind: 4 }, { n: 'Warsaw', ind: 3 }, { n: 'Łódź', ne: 'Lodz', ind: 3 },
  { n: 'Kiev', ind: 2 }, { n: 'Odessa', ind: 2 }, { n: 'Kharkov', ne: 'Kharkiv', ind: 2 }, { n: 'Riga', ind: 3 }, { n: 'Reval', ne: 'Tallinn', ind: 1 },
  { n: 'Vilna', ne: 'Vilnius', ind: 1 }, { n: 'Minsk', ind: 1 }, { n: 'Rostov', ind: 2 }, { n: 'Tsaritsyn', ne: 'Volgograd', ind: 1 },
  { n: 'Saratov', ind: 1 }, { n: 'Kazan', ind: 1 }, { n: 'Nizhny Novgorod', ind: 2 }, { n: 'Ekaterinburg', ne: 'Yekaterinburg', ind: 2 },
  { n: 'Omsk', ind: 1 }, { n: 'Irkutsk', ind: 1 }, { n: 'Vladivostok', ind: 1 }, { n: 'Tiflis', ne: 'Tbilisi', ind: 1 }, { n: 'Baku', ind: 3 },
  { n: 'Tashkent', ind: 1 }, { n: 'Sevastopol', ne: 'Sevastapol', ind: 2 }, { n: 'Yekaterinoslav', ne: 'Dnipro', ind: 2 }, { n: 'Yuzovka', ne: 'Donetsk', ind: 3 },
  // Ottoman Empire, Persia, Arabia
  { n: 'Constantinople', ne: 'Istanbul', cap: 1, ind: 2 }, { n: 'Smyrna', ne: 'Izmir', ind: 1 }, { n: 'Angora', ne: 'Ankara', ind: 1 }, { n: 'Adrianople', ne: 'Edirne', ind: 1 },
  { n: 'Damascus', ind: 1 }, { n: 'Aleppo', ind: 1 }, { n: 'Beirut', ind: 1 }, { n: 'Jerusalem', ind: 1 }, { n: 'Baghdad', ind: 1 }, { n: 'Basra', ind: 1 },
  { n: 'Mecca', ne: 'Makkah', ind: 1 }, { n: 'Trebizond', ne: 'Trabzon', ind: 1 }, { n: 'Erzurum', ind: 1 }, { n: 'Tehran', cap: 1, ind: 1 }, { n: 'Tabriz', ind: 1 },
  // Africa
  { n: 'Cairo', ind: 2 }, { n: 'Alexandria', ind: 2 }, { n: 'Khartoum', ind: 1 }, { n: 'Algiers', ne: 'Algiers', ind: 1 }, { n: 'Oran', ind: 1 },
  { n: 'Tunis', ind: 1 }, { n: 'Tripoli', ind: 1 }, { n: 'Casablanca', ind: 1 }, { n: 'Fez', ind: 1 }, { n: 'Dakar', ind: 1 },
  { n: 'Freetown', ind: 1 }, { n: 'Accra', ind: 1 }, { n: 'Lagos', ind: 1 }, { n: 'Léopoldville', ne: 'Kinshasa', ind: 1 }, { n: 'Elisabethville', ne: 'Lubumbashi', ind: 1 },
  { n: 'Luanda', ind: 1 }, { n: 'Lourenço Marques', ne: 'Maputo', ind: 1 }, { n: 'Dar es Salaam', ind: 1 }, { n: 'Zanzibar', ind: 1 },
  { n: 'Mombasa', ind: 1 }, { n: 'Nairobi', ind: 1 }, { n: 'Addis Ababa', cap: 1, ind: 1 }, { n: 'Cape Town', ind: 2 }, { n: 'Johannesburg', ind: 3 },
  { n: 'Durban', ind: 1 }, { n: 'Pretoria', ind: 1 }, { n: 'Windhoek', ind: 1 }, { n: 'Salisbury', ne: 'Harare', ind: 1 }, { n: 'Monrovia', cap: 1, ind: 1 },
  // Asia
  { n: 'Peking', ne: 'Beijing', cap: 1, ind: 1 }, { n: 'Shanghai', ind: 2 }, { n: 'Canton', ne: 'Guangzhou', ind: 1 }, { n: 'Hankow', ne: 'Wuhan', ind: 2 },
  { n: 'Tientsin', ne: 'Tianjin', ind: 2 }, { n: 'Nanking', ne: 'Nanjing', ind: 1 }, { n: 'Mukden', lat: 41.8, lon: 123.4, ind: 1 }, { n: 'Harbin', ind: 1 },
  { n: 'Hong Kong', ind: 2 }, { n: 'Tsingtao', ne: 'Qingdao', ind: 1 }, { n: 'Port Arthur', ne: 'Dalian', ind: 1 },
  { n: 'Tokyo', cap: 1, ind: 4 }, { n: 'Osaka', ind: 4 }, { n: 'Kyoto', ind: 2 }, { n: 'Nagoya', ind: 2 }, { n: 'Yokohama', ind: 2 }, { n: 'Kobe', ind: 2 },
  { n: 'Nagasaki', ind: 2 }, { n: 'Sapporo', ind: 1 }, { n: 'Seoul', ind: 1 }, { n: 'Taipei', ind: 1 },
  { n: 'Delhi', cap: 1, ind: 2 }, { n: 'Calcutta', ne: 'Kolkata', ind: 3 }, { n: 'Bombay', ne: 'Mumbai', ind: 3 }, { n: 'Madras', ne: 'Chennai', ind: 2 },
  { n: 'Karachi', ind: 1 }, { n: 'Lahore', ind: 1 }, { n: 'Rangoon', ind: 1 }, { n: 'Colombo', ind: 1 }, { n: 'Singapore', ind: 2 },
  { n: 'Batavia', ne: 'Jakarta', ind: 1 }, { n: 'Surabaya', ind: 1 }, { n: 'Manila', ind: 1 }, { n: 'Bangkok', cap: 1, ind: 1 }, { n: 'Saigon', ne: 'Ho Chi Minh City', ind: 1 },
  { n: 'Hanoi', ind: 1 }, { n: 'Kabul', cap: 1, ind: 1 }, { n: 'Kathmandu', cap: 1, ind: 1 }, { n: 'Lhasa', ind: 1 },
  // Oceania
  { n: 'Sydney', ind: 2 }, { n: 'Melbourne', cap: 1, ind: 2 }, { n: 'Brisbane', ind: 1 }, { n: 'Perth', ind: 1 }, { n: 'Adelaide', ind: 1 },
  { n: 'Wellington', cap: 1, ind: 1 }, { n: 'Auckland', ind: 1 }, { n: 'Honolulu', ind: 1 },
  // North America
  { n: 'Washington', ne: 'Washington, D.C.', cap: 1, ind: 2 }, { n: 'New York', ind: 5 }, { n: 'Chicago', ind: 4 }, { n: 'Philadelphia', ind: 4 },
  { n: 'Pittsburgh', ind: 4 }, { n: 'Detroit', ind: 3 }, { n: 'Cleveland', ind: 3 }, { n: 'Boston', ind: 3 }, { n: 'Baltimore', ind: 3 },
  { n: 'St. Louis', ind: 3 }, { n: 'Buffalo', ind: 2 }, { n: 'Cincinnati', ind: 2 }, { n: 'Milwaukee', ind: 2 }, { n: 'Minneapolis', ind: 2 },
  { n: 'Kansas City', ind: 2 }, { n: 'New Orleans', ind: 2 }, { n: 'Houston', ind: 1 }, { n: 'Dallas', ind: 1 }, { n: 'Atlanta', ind: 1 },
  { n: 'Denver', ind: 1 }, { n: 'Salt Lake City', ind: 1 }, { n: 'San Francisco', ind: 3 }, { n: 'Los Angeles', ind: 2 }, { n: 'Seattle', ind: 2 },
  { n: 'Portland', ind: 1 }, { n: 'Norfolk', ind: 2 }, { n: 'Birmingham', ne: 'Birmingham', adm0: 'United States of America', ind: 2 },
  { n: 'Ottawa', cap: 1, ind: 1 }, { n: 'Montreal', ne: 'Montreal', ind: 3 }, { n: 'Toronto', ind: 3 }, { n: 'Winnipeg', ind: 1 }, { n: 'Vancouver', ind: 1 },
  { n: 'Halifax', ind: 1 }, { n: 'Quebec', ne: 'Quebec', ind: 1 }, { n: 'Hamilton', adm0: 'Canada', ind: 2 }, { n: "St. John's", ne: "St. John's", cap: 1, ind: 1 },
  { n: 'Mexico City', cap: 1, ind: 2 }, { n: 'Havana', cap: 1, ind: 1 }, { n: 'Monterrey', ind: 1 }, { n: 'Veracruz', ind: 1 },
  // South America
  { n: 'Buenos Aires', cap: 1, ind: 3 }, { n: 'Rio de Janeiro', cap: 1, ind: 2 }, { n: 'São Paulo', ne: 'Sao Paulo', ind: 2 }, { n: 'Santiago', cap: 1, ind: 2 },
  { n: 'Valparaíso', ne: 'Valparaiso', ind: 1 }, { n: 'Lima', cap: 1, ind: 1 }, { n: 'Bogotá', ne: 'Bogota', cap: 1, ind: 1 }, { n: 'Caracas', cap: 1, ind: 1 },
  { n: 'Montevideo', cap: 1, ind: 1 }, { n: 'Rosario', ind: 1 }, { n: 'Salvador', ind: 1 }, { n: 'Recife', ind: 1 }, { n: 'Quito', cap: 1, ind: 1 }, { n: 'La Paz', cap: 1, ind: 1 },
  { n: 'Asunción', ne: 'Asuncion', cap: 1, ind: 1 },
];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.headers.location) return fetchText(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let s = ''; res.setEncoding('utf8'); res.on('data', d => s += d); res.on('end', () => resolve(s));
    }).on('error', reject);
  });
}

(async () => {
  const file = process.argv[2];
  const text = file ? fs.readFileSync(file, 'utf8') : await fetchText(SRC);
  const feats = JSON.parse(text).features;
  const byName = new Map();
  for (const f of feats) {
    const key = String(f.properties.nameascii || f.properties.name).toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }
  const out = [], missing = [];
  for (const c of CITIES) {
    if (c.lat !== undefined && c.lon !== undefined) { out.push({ n: c.n, lat: c.lat, lon: c.lon, cap: c.cap ? 1 : 0, ind: c.ind || 1 }); continue; }   // authored coordinates
    const key = String(c.ne || c.n).toLowerCase();
    let cands = byName.get(key) || [];
    if (c.adm0) cands = cands.filter(f => f.properties.adm0name === c.adm0);
    // Prefer the most populous match (disambiguates Portland, Birmingham, Hamilton…).
    cands.sort((a, b) => (b.properties.pop_max || 0) - (a.properties.pop_max || 0));
    const f = cands[0];
    if (!f) { missing.push(c.n); continue; }
    const [lon, lat] = f.geometry.coordinates;
    out.push({ n: c.n, lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, cap: c.cap ? 1 : 0, ind: c.ind || 1 });
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ source: 'Natural Earth populated places (coordinates); 1914 names, capitals and industry authored', cities: out }));
  console.log(`${out.length} cities written to ${OUT}`);
  if (missing.length) console.log('Not found in Natural Earth:', missing.join(', '));
})().catch(e => { console.error(e.message); process.exit(1); });
