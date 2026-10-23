// Operates on the post body only. Short repeated CTA labels and URLs are not
// duplicate prose. Heading matches are advisory: a table of contents is valid.
const normalized = value => String(value || '').normalize('NFC')
  .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
const heading = value => normalized(value).replace(/^\d{1,2}[.)]\s*/, '');
const prose = unit => ['text', 'quote'].includes(unit.type) && !/^https?:\/\//i.test(unit.value);

export function inspectDuplication(units = []) {
  const groups = new Map(), headings = new Map();
  const disclosureIndex = units.findIndex(u => prose(u) && /쿠팡 파트너스 활동의 일환|제휴.*수수료/.test(u.value));
  units.forEach((unit, index) => {
    if (!prose(unit)) return;
    const value = normalized(unit.value), key = heading(value);
    if (value.length >= 40) groups.set(value, [...(groups.get(value) || []), index + 1]);
    if (key.length >= 4 && key.length <= 60) headings.set(key, [...(headings.get(key) || []), index + 1]);
  });
  const duplicateParagraphs = [...groups.values()].filter(indices => indices.length > 1);
  const repeatedHeadings = [...headings.entries()].filter(([, indices]) => indices.length > 1)
    .map(([value, indices]) => ({ value, units: indices }));
  // Images/dividers break a run; do not join distant unrelated CTA fragments.
  const runs = new Map();
  for (let i = 0; i + 2 < units.length; i++) {
    const part = units.slice(i, i + 3);
    if (!part.every(u => prose(u) && normalized(u.value).length >= 12)) continue;
    const values = part.map(u => normalized(u.value));
    if (values.join('').length < 80) continue;
    const key = JSON.stringify(values), prior = runs.get(key) || [];
    if (!prior.length || i + 1 - prior.at(-1) >= 3) runs.set(key, [...prior, i + 1]);
  }
  const repeatedSections = [...runs.values()].filter(indices => indices.length > 1);
  return { duplicateParagraphs, repeatedSections, repeatedHeadings,
    disclosureUnit: disclosureIndex < 0 ? null : disclosureIndex + 1,
    prefixUnitsBeforeDisclosure: Math.max(0, disclosureIndex),
    noDuplicateProse: duplicateParagraphs.length === 0 && repeatedSections.length === 0 };
}
