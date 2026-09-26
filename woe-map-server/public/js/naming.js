'use strict';

/**
 * Sequential unit names: "1st Infantry Regiment", "2nd Infantry Regiment"… numbered per faction and formation.
 * The ordinal style follows the faction's name (keyword match), so a French faction counts 1e, 2e, 3e, a German
 * or Austrian one 1., 2., 3., an Italian one 1ª, 2ª… Anything unrecognised uses English ordinals.
 * Shared by the browser (preview of the next name) and the server (the name actually assigned).
 */
const Naming = (() => {
  const STYLES = {
    en: n => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')),
    fr: n => n + 'e',        // as requested: 1e, 2e, 3e (formal French would be 1re/1er for the first)
    nl: n => n + 'e',
    dot: n => n + '.',       // German, Austrian, Hungarian, Scandinavian, Polish, Czech, Serbian, Turkish
    a: n => n + 'ª',         // Italian, Spanish, Portuguese (feminine: divisione, división, divisão)
    ru: n => n + '-я',
    el: n => n + 'η',
    ro: n => n + '-a',
    cjk: n => '第' + n,
  };
  const RULES = [
    [/franc|french|belgi|luxembourg|monaco|haiti|walloon/, 'fr'],
    [/netherland|dutch|holland|flemish|flander/, 'nl'],
    [/german|deutsch|prussia|preu|austria|österreich|austro|bavaria|bayern|saxon|württemberg|wurttemberg|hungar|swiss|switzerland|serbia|croat|sloven|czech|bohemia|slovak|poland|polish|finland|finn|denmark|danish|norway|norweg|sweden|swedish|iceland|estonia|latvia|lithuania|ottoman|turk/, 'dot'],
    [/ital|spain|spanish|portug|brazil|mexic|argentin|chile|colombia|peru|venezuela|cuba|uruguay|bolivia|paraguay/, 'a'],
    [/russia|soviet|ukrain|belarus|bulgar/, 'ru'],
    [/greece|greek|hellen/, 'el'],
    [/romania|rumania|moldov/, 'ro'],
    [/japan|china|chinese|korea/, 'cjk'],
  ];

  function styleFor(nation) {
    const s = String(nation || '').toLowerCase();
    for (const [re, style] of RULES) if (re.test(s)) return style;
    return 'en';
  }
  function ordinal(n, nation) { return STYLES[styleFor(nation)](n); }

  /** Split "3rd Infantry Regiment" / "3. Infanterie" / "第3 X" into { n, rest }; null when the name has no leading number. */
  function parse(name) {
    const m = /^\D{0,1}(\d+)\S*\s+(.+)$/.exec(String(name || '').trim());
    return m ? { n: Number(m[1]), rest: m[2].trim() } : null;
  }

  /** The next free number for `formation` among `names` (this faction's existing unit names). */
  function nextNumber(names, formation) {
    const f = String(formation).toLowerCase();
    let max = 0;
    for (const name of names || []) {
      const p = parse(name);
      if (p && p.rest.toLowerCase() === f && p.n > max) max = p.n;
    }
    return max + 1;
  }
  function nextName(names, formation, nation) {
    return `${ordinal(nextNumber(names, formation), nation)} ${formation}`;
  }

  return { STYLES, styleFor, ordinal, parse, nextNumber, nextName };
})();

if (typeof window !== 'undefined') window.Naming = Naming;
if (typeof module !== 'undefined') module.exports = Naming;
