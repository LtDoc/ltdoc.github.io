'use strict';
/**
 * Who owns what in the bundled historical borders (aourednik/historical-basemaps), shared by the server and
 * the Earth layer. The dataset is inconsistent about overlords:
 *   - the same power goes by several names ("United Kingdom of Great Britain and Ireland" for most British
 *     colonies, "United Kingdom" for the Raj and Hong Kong, "Great Britain" in 1880; "Russia" and "Russian Empire");
 *   - many colonies, dominions and protectorates carry no overlord at all (Canada, Australia, Ceylon, Malaya,
 *     Togoland, Kamerun, Finland, Suriname…), so they looked independent;
 *   - some islands have no name (the Hebrides, Orkney, Shetland, the Faroes, the Aegean islands).
 * This module fixes all three: `canon()` folds a power's names (and the names people give factions, like
 * "British Empire") into one key, HOLDINGS lists the overlord of unlabelled holdings per year, and ISLANDS names
 * the nameless features by position. `resolve(year, feature)` returns { state, power } for one feature.
 */
const Powers = (() => {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

  // One entry per power: every name it goes by, and (optionally) the name to show for it.
  const GROUPS = [
    { display: 'British Empire', names: ['British Empire', 'United Kingdom of Great Britain and Ireland', 'United Kingdom', 'Great Britain', 'Britain', 'UK', 'England', 'Empire of Great Britain'] },
    { display: 'Russian Empire', names: ['Russian Empire', 'Russia', 'Imperial Russia'] },
    { display: 'Austro-Hungarian Empire', names: ['Austro-Hungarian Empire', 'Austria Hungary', 'Austria-Hungary', 'Austria–Hungary', 'Austro Hungary'] },
    { names: ['German Empire', 'Germany', 'Imperial Germany', 'German Reich', 'Deutsches Reich'] },
    { names: ['Ottoman Empire', 'Ottoman Sultanate', 'Turkey'] },
    { names: ['Empire of Japan', 'Imperial Japan', 'Japan'] },
    { names: ['United States', 'United States of America', 'USA', 'US', 'America'] },
    { names: ['France', 'French Republic', 'French Empire'] },
    { names: ['Italy', 'Kingdom of Italy'] },
    { names: ['Netherlands', 'Holland', 'Kingdom of the Netherlands'] },
    { names: ['Rattanakosin Kingdom', 'Siam', 'Thailand'] },
    { names: ['Persia', 'Iran'] },
    { names: ['Manchu Empire', 'China', 'Qing', 'Qing Empire', 'Chinese Empire', 'Republic of China'] },
    { names: ['USSR', 'Soviet Union', 'Union of Soviet Socialist Republics'] },
  ];
  const groupOf = new Map();
  GROUPS.forEach((g, i) => { g.key = norm(g.names[0]); for (const n of g.names) groupOf.set(norm(n), i); });

  /** Canonical key for a power or faction name: every name of one power maps to the same key. */
  function canon(name) { const i = groupOf.get(norm(name)); return i === undefined ? norm(name) : GROUPS[i].key; }
  /** The name to show for a power ("British Empire" for every British variant); unknown names come back as given. */
  function display(name) { const i = groupOf.get(norm(name)); return i !== undefined && GROUPS[i].display ? GROUPS[i].display : String(name || ''); }
  /** Do two names mean the same power? */
  function same(a, b) { return !!a && !!b && canon(a) === canon(b); }

  // Overlords of holdings the dataset leaves unlabelled, per bundled year: { power: [state names] }.
  // Dominions count as British up to 1920 (they went to war with Britain in 1914) but not in 1938.
  const BRIT_WEST_INDIES = ['Antigua and Barbuda', 'Dominica', 'Montserrat', 'Anguilla', 'Saint Kitts and Nevis'];
  const HOLDINGS = {
    1880: {
      'British Empire': ['Ceylon', 'Belize', 'Malaya', 'British Guiana', 'Canada', 'Cape Colony', 'Natal', 'Griqualand West', 'Basutoland',
        'Transvaal', 'Lagos', 'Sierra Leone', 'Gambia', 'Malta', 'Fiji', 'Māori', 'South Australia (UK)', 'Western Australia (UK)',
        'Victoria (UK)', 'Queensland (UK)', 'New South Wales (UK)', 'Northern Territory (UK)', ...BRIT_WEST_INDIES],
    },
    1900: {
      'British Empire': ['Ceylon', 'Belize', 'Malaya', 'Brunei', 'Canada', 'British Guiana', 'Cape Colony', 'Natal', 'Basutoland', 'Zululand',
        'Griqualand West', 'Ngwato', 'Ndebele', 'Shona', 'Lozi', 'Barotse', 'Nguni', 'Sultanate of Zanzibar', 'Buganda', 'Bunyoro', 'Trucial Oman',
        'Egypt', 'Lagos', 'Accra', 'Calabar', 'Opobo', 'Benin', 'Ibadan', 'Oyo', 'Sierra Leone', 'Gambia', 'Malta', 'Fiji', 'Tonga', 'Niue',
        'Māori', 'India', 'British New Guinea (Papua)', ...BRIT_WEST_INDIES],
      'German Empire': ['German New Guinea'],
    },
    1914: {
      'British Empire': ['Canada', 'Australia', 'New Zealand', 'Ceylon', 'Sierra Leone', 'Swaziland', 'Lesotho', 'Kuwait', 'Belize', 'Guyana',
        'Malaya', 'Brunei', 'British New Guinea (Papua)', 'Gambia, The', 'Uganda', 'Malta', 'Fiji', 'Niue', 'Tonga', 'Barbados', 'Grenada',
        'Saint Lucia', 'Saint Vincent and the Grenadines', ...BRIT_WEST_INDIES],
      'German Empire': ['Togoland', 'Kamerun', 'German South-West Africa', 'Samoa', 'German New Guinea'],
      'France': ['Tunisia', 'Morocco', 'French Guiana', 'Martinique', 'Guadeloupe', 'Saint Martin', 'Saint Barthelemy', 'Wallis and Futuna Islands'],
      'Russian Empire': ['Finland', 'Georgia', 'Armenia', 'Azerbaijan'],
      'Netherlands': ['Suriname', 'Netherlands Indies', 'Netherlands Antilles'],
      'Denmark': ['Iceland', 'United States Virgin Islands'],
      'United States': ['Philippines', 'Puerto Rico', 'American Samoa'],
      'Spain': ['Spanish Morocco', 'Rio De Oro', 'Equatorial Guinea'],
      'Portugal': ['Portuguese Guinea'],
    },
    1920: {
      'British Empire': ['Canada', 'Australia', 'New Zealand', 'Union of South Africa', 'Papua New Guinea', 'Jamaica', 'Trinidad', 'Guyana', 'Belize',
        'Ceylon', 'Malaysia', 'Brunei', 'Sierra Leone', 'Gambia, The', 'Ghana', 'Nigeria', 'Sudan', 'Kenya', 'Uganda', 'Tanzania, United Republic of',
        'Malawi', 'Zambia', 'Zimbabwe', 'Botswana', 'Swaziland', 'Lesotho', 'Barbados', 'Grenada', 'Saint Lucia', 'Saint Vincent and the Grenadines',
        'Fiji', 'Niue', 'Tonga', 'Samoa', ...BRIT_WEST_INDIES],
    },
    1938: {
      'British Empire': ['Jamaica', 'Trinidad', 'Guyana', 'Belize', 'Bahamas', 'Turks and Caicos Islands', 'Ceylon', 'Brunei', 'Kuwait', 'Qatar',
        'Trucial Oman', 'Sudan', 'Malawi', 'Gambia, The', 'Dominion of Newfoundland', 'Barbados', 'Grenada', 'Saint Lucia',
        'Saint Vincent and the Grenadines', 'Fiji', 'Tonga', ...BRIT_WEST_INDIES],
    },
  };
  const holdingIndex = {};
  for (const [year, byPower] of Object.entries(HOLDINGS)) {
    holdingIndex[year] = new Map();
    for (const [power, states] of Object.entries(byPower)) for (const s of states) holdingIndex[year].set(norm(s), power);
  }

  // Nameless features, named by where their centre lies: [lonMin, latMin, lonMax, latMax, name, fromYear, toYear]. First match wins.
  const ISLANDS = [
    [-8.2, 61.3, -6.0, 62.5, 'Denmark', 0, 9999],                                   // Faroe Islands
    [-11, 49.5, 2.0, 61.2, 'United Kingdom of Great Britain and Ireland', 0, 1921],  // Hebrides, Orkney, Shetland, Isle of Man…
    [-8.0, 49.5, 2.0, 61.2, 'United Kingdom', 1922, 9999],
    [26.8, 35.3, 28.4, 37.5, 'Italy', 1912, 1946],                                  // Dodecanese
    [23.3, 34.8, 26.4, 35.7, 'Greece', 1913, 9999],                                 // Crete
    [19.3, 36.1, 27.1, 40.3, 'Greece', 1913, 9999],                                 // Aegean and Ionian islands
  ];

  function centroidOf(polys) {
    let best = null, bestA = 0;
    for (const poly of polys || []) {
      const r = poly[0] || [];
      let a = 0, x = 0, y = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
        a += f; x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f;
      }
      if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = [x / (3 * a), y / (3 * a)]; }
    }
    return best;
  }

  /** The overlord of a named state in a year, from the dataset's own field or the holdings table ('' when independent). */
  function overlordOf(year, state, subject) {
    const fixed = (holdingIndex[year] || holdingIndex[nearestYear(year)] || new Map()).get(norm(state));
    return fixed || subject || '';
  }
  function nearestYear(year) {
    const ys = Object.keys(HOLDINGS).map(Number).sort((a, b) => a - b);
    return ys.filter(y => y <= Number(year)).pop() || ys[0];
  }

  /**
   * One feature of a year's borders → { state, power }: the state's name (nameless islands named by position),
   * and the power it belongs to, shown by its display name ("British Empire"). '' state and power for
   * nameless features nobody owns (Antarctica).
   */
  function resolve(year, c) {
    let state = c.n || '';
    if (!state) {
      const ctr = centroidOf(c.p);
      if (ctr) for (const [x0, y0, x1, y1, name, from, to] of ISLANDS) {
        if (year >= from && year <= to && ctr[0] >= x0 && ctr[0] <= x1 && ctr[1] >= y0 && ctr[1] <= y1) { state = name; break; }
      }
    }
    if (!state) return { state: '', power: '' };
    const over = overlordOf(year, state, c.s || '');
    return { state, power: display(over || state) };
  }

  return { canon, display, same, resolve, overlordOf, norm, HOLDINGS, GROUPS };
})();

if (typeof window !== 'undefined') window.Powers = Powers;
if (typeof module !== 'undefined') module.exports = Powers;
