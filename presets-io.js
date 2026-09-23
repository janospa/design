/*!
 * JP Design — export / import presetari in fisier (.json)
 * ---------------------------------------------------------------------------
 * Copyright (c) 2026 Janos Patrik. Toate drepturile rezervate.
 *
 * Presetarile (P1..P5 / S1..S5) stau in localStorage, deci numai in browserul
 * si pe calculatorul pe care au fost create: se pierd la stergerea datelor de
 * navigare si nu se pot arhiva impreuna cu proiectul. Acest fisier adauga in
 * bara de presetari doua butoane — Exporta / Importa — care le scriu intr-un
 * fisier .json si le citesc inapoi.
 *
 * Nu atinge calculul si nici sistemul de presetari al modulului: citeste si
 * scrie EXACT aceleasi chei (sw_modN_<slot>, sw_modN_active). La import cheile
 * se scriu si pagina se reincarca, deci restaurarea o face codul modulului,
 * cu migrarea lui de semn pentru N cu tot.
 *
 * Utilizare — o singura linie, inainte de </body>, DUPA scriptul modulului:
 *     <script src="presets-io.js" data-mod="6"></script>
 * data-mod = numarul modulului, fara zero in fata (1 ... 11). Daca lipseste,
 * se ia din numele fisierului (6_STALP_BIAXIAL.html -> 6).
 *
 * Preferintele globale (sw_lang, sw_signconv, sw_col_*) NU se exporta: sunt
 * ale utilizatorului, nu ale proiectului. Fiecare presetare isi poarta deja
 * eticheta de semn, deci un fisier facut cu N>0 = compresiune se citeste
 * corect si pe un calculator setat pe N<0.
 * ---------------------------------------------------------------------------
 */
(function () {
'use strict';

var IO_VERSION = '1.0.0';
var FORMAT = 'jp-design-presets';
var FORMAT_VERSION = 1;

/* ── identificarea modulului ─────────────────────────────────────────────── */
var me = document.currentScript;
var modAttr = me && me.getAttribute('data-mod');
var MOD = modAttr ? parseInt(modAttr, 10) : NaN;
if (!isFinite(MOD)) {
  var mm = decodeURIComponent(location.pathname.split('/').pop() || '').match(/^(\d+)_/);
  MOD = mm ? parseInt(mm[1], 10) : NaN;
}
if (!isFinite(MOD)) { console.warn('presets-io: modul necunoscut (lipseste data-mod)'); return; }
var PREFIX = 'sw_mod' + MOD + '_';
var MOD_LABEL = 'M' + (MOD < 10 ? '0' : '') + MOD;

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function parse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

/* Sloturile se citesc din selectorul de presetari al paginii, deci P1..P5 la
   modulele individuale si S1..S5 la cele in lot, fara lista scrisa de mana. */
function slots() {
  var sel = document.getElementById('presetSel');
  if (!sel) return [];
  return Array.prototype.map.call(sel.options, function (o) { return o.value; });
}
function modVersion() {
  try { return (typeof MODULE_VERSION !== 'undefined') ? String(MODULE_VERSION) : null; }
  catch (e) { return null; }
}
function engVersion() { return (typeof JP !== 'undefined' && JP.VERSION) ? JP.VERSION : null; }

/* ── limba ───────────────────────────────────────────────────────────────── */
function lang() {
  var l = document.documentElement.lang;
  if (l === 'ro' || l === 'en') return l;
  return lsGet('sw_lang') === 'en' ? 'en' : 'ro';
}
var TX = {
  exp:        { ro: 'Exportă', en: 'Export' },
  imp:        { ro: 'Importă', en: 'Import' },
  expTip:     { ro: 'Salvează presetările într-un fișier .json', en: 'Save the presets to a .json file' },
  impTip:     { ro: 'Încarcă presetări dintr-un fișier .json', en: 'Load presets from a .json file' },
  expTitle:   { ro: 'Exportă presetările în fișier', en: 'Export presets to file' },
  impTitle:   { ro: 'Importă presetări din fișier', en: 'Import presets from file' },
  project:    { ro: 'Nume proiect (opțional)', en: 'Project name (optional)' },
  projectPh:  { ro: 'ex. Bloc A — stâlpi parter', en: 'e.g. Block A — ground floor columns' },
  empty:      { ro: '(gol)', en: '(empty)' },
  withData:   { ro: 'cu date', en: 'has data' },
  rows:       { ro: function (n) { return n + (n === 1 ? ' rând' : ' rânduri'); },
                en: function (n) { return n + (n === 1 ? ' row' : ' rows'); } },
  cancel:     { ro: 'Anulează', en: 'Cancel' },
  doExp:      { ro: 'Descarcă fișierul', en: 'Download file' },
  doImp:      { ro: 'Importă', en: 'Import' },
  nothing:    { ro: 'Toate presetările sunt goale — nu există nimic de exportat.', en: 'All presets are empty — there is nothing to export.' },
  fFile:      { ro: 'Fișier', en: 'File' },
  fProject:   { ro: 'Proiect', en: 'Project' },
  fDate:      { ro: 'Exportat', en: 'Exported' },
  fFrom:      { ro: 'Creat cu', en: 'Created with' },
  overwrite:  { ro: 'suprascrie datele curente', en: 'overwrites current data' },
  notInFile:  { ro: 'nu este în fișier', en: 'not in the file' },
  badJson:    { ro: 'Fișierul nu poate fi citit: nu este un fișier JSON valid.', en: 'The file cannot be read: it is not valid JSON.' },
  badFormat:  { ro: 'Fișierul nu este un export de presetări JP Design.', en: 'The file is not a JP Design preset export.' },
  badModule:  { ro: function (a, b) { return 'Fișierul este pentru modulul ' + a + ', iar pagina aceasta este modulul ' + b + '. Deschide modulul ' + a + ' și importă-l acolo.'; },
                en: function (a, b) { return 'This file belongs to module ' + a + ', but this page is module ' + b + '. Open module ' + a + ' and import it there.'; } },
  newerFmt:   { ro: 'Fișierul a fost creat cu o versiune mai nouă a aplicației. Actualizează pagina (Ctrl+F5) și încearcă din nou.', en: 'The file was created by a newer version of the app. Refresh the page (Ctrl+F5) and try again.' },
  verNote:    { ro: function (a, b) { return 'Fișierul a fost creat cu v' + a + ', modulul este acum v' + b + '. Datele de intrare se încarcă normal; rezultatele se recalculează cu versiunea curentă.'; },
                en: function (a, b) { return 'The file was created with v' + a + '; the module is now v' + b + '. The inputs load as usual; results are recomputed with the current version.'; } },
  saveFail:   { ro: 'Browserul nu a permis scrierea datelor (spațiu plin sau navigare privată).', en: 'The browser refused to store the data (storage full or private browsing).' },
  exported:   { ro: function (n) { return n === 1 ? 'Exportat: 1 presetare.' : 'Exportat: ' + n + ' presetări.'; },
                en: function (n) { return 'Exported: ' + n + ' preset' + (n === 1 ? '' : 's') + '.'; } },
};
function t(k) {
  var e = TX[k]; if (!e) return k;
  var v = e[lang()];
  if (typeof v === 'function') return v.apply(null, Array.prototype.slice.call(arguments, 1));
  return v;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ── descrierea unei presetari, pentru lista din fereastra ───────────────── */
function describe(st) {
  if (!st) return t('empty');
  var parts = [];
  try {
    if (typeof describePreset === 'function') {
      var d = describePreset(st);
      if (d && String(d).indexOf('?') < 0) parts.push(String(d));
    }
  } catch (e) { /* descrierea modulului nu se potriveste cu forma starii */ }
  if (Array.isArray(st.rows)) parts.push(t('rows', st.rows.length));
  return parts.length ? parts.join(' · ') : t('withData');
}

/* ── stiluri (prefix jpio-, ca sa nu se ciocneasca cu ale modulului) ─────── */
var css = ''
 + '.jpio-btns{display:inline-flex;gap:6px;margin-left:4px}'
 + '.jpio-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 11px;font-size:13px;font-weight:500;font-family:Inter,sans-serif;border:1px solid #C7C7CC;border-radius:8px;background:#fff;color:#1C1C1E;cursor:pointer;line-height:1.2;transition:background .12s}'
 + '.jpio-btn:hover{background:#F5F5F7}'
 + '.jpio-btn svg{width:13px;height:13px;stroke:#6C6C70;stroke-width:1.8;fill:none;stroke-linecap:round;stroke-linejoin:round}'
 + '.jpio-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1300;align-items:center;justify-content:center;font-family:Inter,sans-serif}'
 + '.jpio-ov.show{display:flex}'
 + '.jpio-m{background:#fff;border-radius:16px;padding:22px;max-width:400px;width:92%;box-shadow:0 16px 48px rgba(0,0,0,.2);max-height:90vh;overflow:auto}'
 + '.jpio-m h3{font-size:15px;font-weight:600;color:#1C1C1E;margin:0 0 14px}'
 + '.jpio-lbl{display:block;font-size:12px;color:#8E8E93;font-weight:500;margin-bottom:5px}'
 + '.jpio-in{width:100%;box-sizing:border-box;padding:8px 11px;font-size:13px;font-family:Inter,sans-serif;border:1px solid #C7C7CC;border-radius:8px;color:#1C1C1E;margin-bottom:14px}'
 + '.jpio-in:focus{outline:none;box-shadow:0 0 0 2px rgba(0,122,255,.2);border-color:#007AFF}'
 + '.jpio-list{display:flex;flex-direction:column;gap:7px;margin-bottom:16px}'
 + '.jpio-it{display:flex;align-items:center;gap:10px;padding:9px 12px;background:#F5F5F7;border-radius:10px;cursor:pointer;border:2px solid transparent;user-select:none}'
 + '.jpio-it.sel{border-color:#007AFF;background:#EBF3FF}'
 + '.jpio-it.off{opacity:.45;cursor:default}'
 + '.jpio-ck{width:20px;height:20px;border-radius:6px;border:2px solid #C7C7CC;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-sizing:border-box}'
 + '.jpio-it.sel .jpio-ck{border-color:#007AFF;background:#007AFF}'
 + '.jpio-it.sel .jpio-ck::after{content:"";width:6px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);margin-top:-2px}'
 + '.jpio-nm{font-size:13px;font-weight:500;color:#1C1C1E;min-width:24px}'
 + '.jpio-inf{font-size:11px;color:#8E8E93;margin-left:auto;text-align:right}'
 + '.jpio-inf .jpio-ow{display:block;color:#B26A00}'
 + '.jpio-meta{font-size:12px;color:#6C6C70;line-height:1.6;background:#F5F5F7;border-radius:10px;padding:9px 12px;margin-bottom:12px;word-break:break-word}'
 + '.jpio-meta b{color:#1C1C1E;font-weight:500}'
 + '.jpio-msg{font-size:12px;line-height:1.45;border-radius:8px;padding:9px 11px;margin-bottom:12px}'
 + '.jpio-msg.err{background:#FDECEC;color:#C0392B;border:1px solid #F2C2C2}'
 + '.jpio-msg.warn{background:#FFF6E5;color:#8A5A00;border:1px solid #F5DCA8}'
 + '.jpio-bt{display:flex;gap:8px}'
 + '.jpio-bt button{flex:1;padding:11px;font-size:14px;font-weight:500;font-family:Inter,sans-serif;border:none;border-radius:10px;cursor:pointer}'
 + '.jpio-bt .c{background:#E5E5EA;color:#1C1C1E}'
 + '.jpio-bt .p{background:#1C1C1E;color:#fff}'
 + '.jpio-bt .p:disabled{opacity:.35;cursor:default}'
 + '.jpio-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1C1C1E;color:#fff;font:500 13px Inter,sans-serif;padding:10px 16px;border-radius:10px;z-index:1400;opacity:0;transition:opacity .2s;pointer-events:none}'
 + '.jpio-toast.show{opacity:1}'
 + '@media(max-width:680px){.jpio-btn{font-size:14px;padding:7px 11px}.jpio-in{font-size:16px}}';
var styleEl = document.createElement('style');
styleEl.textContent = css;
document.head.appendChild(styleEl);

var ICON_DOWN = '<svg viewBox="0 0 16 16"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13h10"/></svg>';
var ICON_UP   = '<svg viewBox="0 0 16 16"><path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13h10"/></svg>';

/* ── butoanele din bara de presetari ─────────────────────────────────────── */
/* Niciun element injectat nu are atributul id: modulele salveaza in presetare
   toate input[id] / select[id] din pagina, iar campurile acestei ferestre nu
   trebuie sa ajunga acolo. */
var btnExp, btnImp;
function mountButtons() {
  var sel = document.getElementById('presetSel');
  if (!sel) return false;
  var bar = sel.closest('.preset-bar') || sel.parentNode;
  var wrap = document.createElement('span');
  wrap.className = 'jpio-btns';
  btnExp = document.createElement('button');
  btnExp.type = 'button'; btnExp.className = 'jpio-btn';
  btnImp = document.createElement('button');
  btnImp.type = 'button'; btnImp.className = 'jpio-btn';
  btnExp.addEventListener('click', openExport);
  btnImp.addEventListener('click', pickFile);
  wrap.appendChild(btnExp); wrap.appendChild(btnImp);
  if (sel.nextSibling) bar.insertBefore(wrap, sel.nextSibling); else bar.appendChild(wrap);
  relabel();
  return true;
}
function relabel() {
  if (!btnExp) return;
  btnExp.innerHTML = ICON_DOWN + '<span>' + t('exp') + '</span>';
  btnImp.innerHTML = ICON_UP + '<span>' + t('imp') + '</span>';
  btnExp.title = t('expTip'); btnImp.title = t('impTip');
}

/* ── fereastra modala (una singura, refolosita) ──────────────────────────── */
var ov = document.createElement('div');
ov.className = 'jpio-ov';
ov.innerHTML = '<div class="jpio-m"></div>';
var box = ov.firstChild;
/* Evenimentele din fereastra nu urca la document: modulele asculta input /
   change / click pe document ca sa salveze presetarea activa. */
['input', 'change', 'click', 'keydown'].forEach(function (ev) {
  box.addEventListener(ev, function (e) { e.stopPropagation(); });
});
ov.addEventListener('click', function (e) { e.stopPropagation(); if (e.target === ov) close(); });
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && ov.classList.contains('show')) close();
});
function open() { ov.classList.add('show'); }
function close() { ov.classList.remove('show'); box.innerHTML = ''; }

var toastEl = null, toastTimer = null;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'jpio-toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
}

function buildList(items) {
  /* items: [{slot, info, note, enabled, selected}] */
  var list = document.createElement('div');
  list.className = 'jpio-list';
  items.forEach(function (it) {
    var d = document.createElement('div');
    d.className = 'jpio-it' + (it.selected ? ' sel' : '') + (it.enabled ? '' : ' off');
    d.setAttribute('data-slot', it.slot);
    d.innerHTML = '<div class="jpio-ck"></div><span class="jpio-nm">' + esc(it.slot) + '</span>'
      + '<span class="jpio-inf">' + esc(it.info) + (it.note ? '<span class="jpio-ow">' + esc(it.note) + '</span>' : '') + '</span>';
    if (it.enabled) d.addEventListener('click', function () { d.classList.toggle('sel'); list.onchange && list.onchange(); });
    list.appendChild(d);
  });
  list.selected = function () {
    return Array.prototype.map.call(list.querySelectorAll('.jpio-it.sel:not(.off)'),
      function (el) { return el.getAttribute('data-slot'); });
  };
  return list;
}
function buttons(primaryLabel, onPrimary) {
  var bt = document.createElement('div');
  bt.className = 'jpio-bt';
  var c = document.createElement('button'); c.type = 'button'; c.className = 'c'; c.textContent = t('cancel');
  var p = document.createElement('button'); p.type = 'button'; p.className = 'p'; p.textContent = primaryLabel;
  c.addEventListener('click', close);
  p.addEventListener('click', onPrimary);
  bt.appendChild(c); bt.appendChild(p);
  bt.primary = p;
  return bt;
}
function msg(kind, text) {
  var m = document.createElement('div'); m.className = 'jpio-msg ' + kind; m.textContent = text; return m;
}

/* ═══════════════════ EXPORT ═══════════════════ */
function flush() {
  /* starea de pe ecran se scrie intai in slotul activ — altfel ultima
     modificare (inca nesalvata de modul) ar lipsi din fisier */
  try { if (typeof saveCurrentPreset === 'function') saveCurrentPreset(); } catch (e) {}
}
function openExport() {
  flush();
  var data = {};
  slots().forEach(function (s) { data[s] = parse(lsGet(PREFIX + s)); });
  var any = slots().some(function (s) { return !!data[s]; });
  if (!any) { toast(t('nothing')); return; }

  box.innerHTML = '<h3>' + esc(t('expTitle')) + '</h3>';
  var lbl = document.createElement('label'); lbl.className = 'jpio-lbl'; lbl.textContent = t('project');
  var inp = document.createElement('input'); inp.type = 'text'; inp.className = 'jpio-in';
  inp.placeholder = t('projectPh');
  inp.value = lsGet('sw_io_project') || '';
  box.appendChild(lbl); box.appendChild(inp);

  var list = buildList(slots().map(function (s) {
    return { slot: s, info: describe(data[s]), enabled: !!data[s], selected: !!data[s] };
  }));
  box.appendChild(list);
  var bt = buttons(t('doExp'), function () {
    var chosen = list.selected();
    if (!chosen.length) return;
    var project = inp.value.trim();
    lsSet('sw_io_project', project);
    doExport(chosen, data, project);
    close();
  });
  list.onchange = function () { bt.primary.disabled = list.selected().length === 0; };
  box.appendChild(bt);
  open();
  setTimeout(function () { inp.focus(); inp.select(); }, 30);
}
function stamp(d) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function safeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')      // ă -> a, ș -> s
    .replace(/[^A-Za-z0-9._ -]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, 60);
}
function doExport(chosen, data, project) {
  var now = new Date();
  var active = lsGet(PREFIX + 'active');
  var out = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    app: 'JP Design',
    module: MOD,
    moduleLabel: MOD_LABEL,
    moduleVersion: modVersion(),
    engineVersion: engVersion(),
    ioVersion: IO_VERSION,
    page: document.title || '',
    project: project || '',
    exportedAt: now.toISOString(),
    active: (active && chosen.indexOf(active) >= 0) ? active : chosen[0],
    presets: {},
  };
  chosen.forEach(function (s) { out.presets[s] = data[s]; });
  var name = 'JP_' + MOD_LABEL + (project ? '_' + safeName(project) : '') + '_' + stamp(now) + '.json';
  var blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  toast(t('exported', chosen.length));
}

/* ═══════════════════ IMPORT ═══════════════════ */
var fileIn = document.createElement('input');
fileIn.type = 'file';
fileIn.accept = '.json,application/json';
fileIn.style.display = 'none';
fileIn.addEventListener('change', function (e) {
  e.stopPropagation();
  var f = fileIn.files && fileIn.files[0];
  fileIn.value = '';
  if (!f) return;
  var rd = new FileReader();
  rd.onload = function () { openImport(f.name, String(rd.result || '')); };
  rd.onerror = function () { openImport(f.name, null); };
  rd.readAsText(f);
});
function pickFile() {
  if (!fileIn.parentNode) document.body.appendChild(fileIn);
  fileIn.click();
}
function validate(obj) {
  if (!obj || typeof obj !== 'object') return { err: t('badJson') };
  if (obj.format !== FORMAT || !obj.presets || typeof obj.presets !== 'object') return { err: t('badFormat') };
  if ((+obj.formatVersion || 0) > FORMAT_VERSION) return { err: t('newerFmt') };
  if (+obj.module !== MOD) {
    var a = obj.moduleLabel || ('M' + obj.module);
    return { err: t('badModule', a, MOD_LABEL) };
  }
  return { ok: true };
}
function openImport(fname, text) {
  flush();
  var obj = null;
  if (text !== null) { try { obj = JSON.parse(text); } catch (e) { obj = null; } }
  var v = (text === null || obj === null) ? { err: t('badJson') } : validate(obj);

  box.innerHTML = '<h3>' + esc(t('impTitle')) + '</h3>';
  var meta = document.createElement('div'); meta.className = 'jpio-meta';
  var lines = ['<b>' + esc(t('fFile')) + ':</b> ' + esc(fname)];
  if (v.ok) {
    if (obj.project) lines.push('<b>' + esc(t('fProject')) + ':</b> ' + esc(obj.project));
    if (obj.exportedAt) {
      var d = new Date(obj.exportedAt);
      if (!isNaN(d)) lines.push('<b>' + esc(t('fDate')) + ':</b> ' + esc(d.toLocaleString(lang() === 'en' ? 'en-GB' : 'ro-RO')));
    }
    lines.push('<b>' + esc(t('fFrom')) + ':</b> ' + esc(obj.moduleLabel || MOD_LABEL)
      + (obj.moduleVersion ? ' v' + esc(obj.moduleVersion) : '')
      + (obj.engineVersion ? ' · engine v' + esc(obj.engineVersion) : ''));
  }
  meta.innerHTML = lines.join('<br>');
  box.appendChild(meta);

  if (!v.ok) {
    box.appendChild(msg('err', v.err));
    var btE = buttons(t('doImp'), function () {});
    btE.primary.disabled = true;
    box.appendChild(btE);
    open();
    return;
  }
  var cur = modVersion();
  if (obj.moduleVersion && cur && obj.moduleVersion !== cur) box.appendChild(msg('warn', t('verNote', obj.moduleVersion, cur)));

  var here = slots();
  var list = buildList(here.map(function (s) {
    var inFile = !!obj.presets[s];
    var local = parse(lsGet(PREFIX + s));
    return {
      slot: s,
      info: inFile ? describe(obj.presets[s]) : t('notInFile'),
      note: (inFile && local) ? t('overwrite') : '',
      enabled: inFile, selected: inFile,
    };
  }));
  box.appendChild(list);
  var bt = buttons(t('doImp'), function () {
    var chosen = list.selected();
    if (!chosen.length) return;
    for (var i = 0; i < chosen.length; i++) {
      if (!lsSet(PREFIX + chosen[i], JSON.stringify(obj.presets[chosen[i]]))) {
        box.appendChild(msg('err', t('saveFail'))); return;
      }
    }
    var act = (obj.active && chosen.indexOf(obj.active) >= 0) ? obj.active : chosen[0];
    lsSet(PREFIX + 'active', act);
    if (obj.project) lsSet('sw_io_project', obj.project);
    /* Restaurarea o face modulul la pornire (inclusiv migrarea de semn a lui
       N), deci pagina se reincarca in loc sa se aplice starea din afara. */
    location.reload();
  });
  list.onchange = function () { bt.primary.disabled = list.selected().length === 0; };
  box.appendChild(bt);
  open();
}

/* ── pornire ─────────────────────────────────────────────────────────────── */
function boot() {
  document.body.appendChild(ov);
  if (!mountButtons()) return;
  /* modulele schimba atributul lang al paginii cand se comuta RO/EN */
  try {
    new MutationObserver(relabel).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  } catch (e) {}
  var ls = document.getElementById('langSeg');
  if (ls) ls.addEventListener('click', function () { setTimeout(relabel, 0); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

window.JPPresetsIO = { VERSION: IO_VERSION, module: MOD, prefix: PREFIX };
})();
