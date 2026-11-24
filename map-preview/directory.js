const collator = new Intl.Collator('en', {sensitivity: 'base'});
const suffixes = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
const surnamePrefixes = new Set(['da', 'de', 'del', 'der', 'di', 'du', 'la', 'le', 'van', 'von']);

function normalized(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function familyName(name) {
  if (name.includes(',')) return name.split(',')[0].trim();
  const words = normalized(name).split(' ');
  if (words.length > 1 && suffixes.has(words.at(-1))) words.pop();
  let index = words.length - 1;
  while (index > 0 && surnamePrefixes.has(words[index - 1])) index--;
  return words.slice(index).join(' ');
}

export function locationKey(city, state) {
  return JSON.stringify([city.toLowerCase(), state.toUpperCase()]);
}

export function publicContactLinks(phone, name = '') {
  if (!/^\d{10}$/.test(phone)) return [];
  const formatted = phone.slice(0, 3) + '-' + phone.slice(3, 6) + '-' + phone.slice(6);
  return [['tel:+1', 'Call ' + formatted], ['sms:+1', 'Text ' + formatted]].map(([scheme, label]) => {
    const anchor = document.createElement('a');
    anchor.href = scheme + phone;
    anchor.textContent = label;
    if (name) anchor.setAttribute('aria-label', label.split(' ')[0] + ' ' + name + ' at ' + formatted);
    return anchor;
  });
}

export function directoryEntries(rows) {
  return rows.filter(row => Array.isArray(row) && row.length === 4 &&
    row.every(value => typeof value === 'string') && row[0].trim() &&
    /^[a-z]{2}$/i.test(row[2]) && (!row[3] || /^\d{10}$/.test(row[3])))
    .map(([name, city, state, phone]) => ({
      name, city, state, phone, surname: familyName(name), search: normalized(name),
      key: locationKey(city, state)
    })).sort((a, b) => collator.compare(a.surname, b.surname) ||
      collator.compare(a.name, b.name) || collator.compare(a.city, b.city) ||
      collator.compare(a.state, b.state));
}

export function createVolunteerDirectory(onSelect) {
  const container = document.querySelector('#volunteer-directory');
  const toggle = document.querySelector('#directory-toggle');
  const panel = document.querySelector('#directory-panel');
  const layout = panel.parentElement;
  const input = document.querySelector('#volunteer-name');
  const clear = document.querySelector('#clear-volunteer-name');
  const results = document.querySelector('#directory-results');
  const count = document.querySelector('#directory-count');
  const details = document.querySelector('#directory-contact');
  const mobile = matchMedia('(max-width: 720px)');
  let entries = [];
  let revision;
  let selected;
  let shown;

  function expand(open) {
    toggle.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    layout.classList.toggle('has-directory', open);
  }

  function showContact(entry) {
    shown = entry;
    details.replaceChildren();
    details.hidden = !entry;
    if (!entry) return;
    const title = document.createElement('strong');
    title.textContent = entry.name;
    const area = document.createElement('p');
    area.textContent = [entry.city, entry.state].filter(Boolean).join(', ');
    const links = document.createElement('p');
    const [call, text] = publicContactLinks(entry.phone);
    if (call) links.append(call, ' · ', text);
    else links.textContent = 'No public phone number';
    details.append(title, area, links);
  }

  function filter() {
    const query = normalized(input.value).split(' ').filter(Boolean);
    let total = 0;
    for (const entry of entries) {
      const visible = query.every(term => entry.search.includes(term));
      if (visible) total++;
      entry.row.hidden = !visible;
    }
    count.textContent = query.length
      ? (total ? total + ' matching volunteers · ' + entries.length + ' total'
        : 'No matching volunteers found · 0 matches · ' + entries.length + ' total')
      : entries.length + ' active volunteers';
    clear.disabled = !input.value;
    if (shown && shown.row.hidden) showContact(null);
  }

  function select(matches) {
    selected = new Set(matches);
    for (const entry of entries) entry.button.setAttribute('aria-pressed', String(selected.has(entry)));
    showContact(matches[0]);
  }

  toggle.addEventListener('click', () => {
    expand(panel.hidden);
    if (!panel.hidden) input.focus();
  });
  input.addEventListener('input', filter);
  clear.addEventListener('click', () => {
    input.value = '';
    filter();
    input.focus();
  });

  function update(rows) {
    const next = JSON.stringify(rows);
    if (revision === next) return;
    revision = next;
    const focused = entries.find(entry => entry.button === document.activeElement);
    entries = directoryEntries(rows);
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      entry.row = document.createElement('li');
      entry.button = document.createElement('button');
      entry.button.type = 'button';
      entry.button.textContent = entry.name;
      entry.button.setAttribute('aria-pressed', 'false');
      entry.button.addEventListener('pointerenter', event => {
        if (event.pointerType === 'mouse') showContact(entry);
      });
      entry.button.addEventListener('focus', () => showContact(entry));
      entry.button.addEventListener('click', event => {
        select([entry]);
        const mapped = onSelect(entry);
        if (mapped && mobile.matches) {
          expand(false);
          toggle.focus({preventScroll: true});
        } else if (event.detail === 0) {
          details.querySelector('a')?.focus({preventScroll: true});
        }
      });
      entry.row.append(entry.button);
      fragment.append(entry.row);
    }
    const matches = old => entries.find(entry => entry.name === old.name &&
      entry.phone === old.phone && entry.key === old.key);
    if (container.hidden) {
      container.hidden = false;
      expand(!mobile.matches);
    }
    results.replaceChildren(fragment);
    if (selected) select([...selected].map(matches).filter(Boolean));
    if (shown) showContact(matches(shown));
    filter();
    const newFocus = focused && matches(focused);
    if (newFocus && !newFocus.row.hidden) newFocus.button.focus({preventScroll: true});
  }

  function highlight(keys) {
    const matches = entries.filter(entry => keys.includes(entry.key));
    if (matches.length && matches.every(entry => entry.row.hidden)) {
      input.value = '';
      filter();
    }
    const visible = matches.filter(entry => !entry.row.hidden);
    select(visible);
    if (!visible.length) return;
    if (panel.hidden) expand(true);
    const row = visible[0].row.getBoundingClientRect();
    const list = results.getBoundingClientRect();
    if (row.top < list.top || row.bottom > list.bottom) results.scrollTop += row.top - list.top;
  }

  return {update, highlight, unavailable() {
    if (container.hidden) return;
    update([]);
    count.textContent = 'Volunteer directory temporarily unavailable.';
  }};
}
