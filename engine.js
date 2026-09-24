/*!
 * JP Design — nucleu de calcul comun (shared calculation engine)
 * ---------------------------------------------------------------------------
 * Copyright (c) 2026 Janos Patrik. Toate drepturile rezervate.
 * Dezvoltat in cadrul lucrarii de disertatie, UTCN, Facultatea de Constructii.
 *
 * Metoda fibrelor pentru sectiuni de beton armat — legi constitutive,
 * integrare pe plan de deformatii, rezolvare a axei neutre, diagrame de
 * interactiune. Plus straturi pe formule pentru forta taietoare in pereti
 * (modulul 04) si pentru nodul de cadru grinda-stalp (modulele 08 / 09).
 * Folosit de modulele 03, 04, 06, 07, 08.
 *
 * Referinte: CR 2-1-1.1/2022, P 100-1/2013, SR EN 1992-1-1, Encipedia Anexa A.
 *
 * Validare: vezi test.html. Cazul M03-W1 (perete 400x2750, C50/60, S500,
 * N_Ed = 20000 kN) da M_Rd = 18106,2 kNm, fata de 18105,5 kNm obtinut cu
 * integrare exacta (fib structuralcodes v0.7.2, integrator "marin"),
 * diferenta 0,004 %.
 * ---------------------------------------------------------------------------
 */
(function (global) {
'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VERSIUNE
   Se incrementeaza MINOR cand rezultatele numerice se pot modifica (lege
   constitutiva noua, schimbare de integrare, schimbare de conventie) si PATCH
   pentru corecturi care NU muta rezultatele. Se afiseaza in subsolul PDF si in
   pagina, ca o nota de calcul tiparita sa fie reproductibila.

   2.1.0 — s-a adaugat stratul JP.joint (nod de cadru, P 100-1/2013), etichete
   de grup pe fibrele de armatura ale stalpului si JP.column.mrdUniaxial().
   Rezultatele modulelor 03, 04, 06 si 07 NU se schimba fata de 2.0.0.
   2.1.1 — utilizarea alcatuirii nodului include si incadrarea seturilor de
   etrieri pe inaltimea utila (uFit). Verdictele NU se schimba: conditia era
   deja in "ok", lipsea doar din procent.
   2.2.0 — (a) barele peretelui sunt asezate la ACOPERIREA MECANICA, ca la
   stalp: centrul barei la c_nom + Ø_etrier + Ø_bara/2 de fata bulbului.
   Pana acum lumpurile de capat stateau chiar pe fetele bulbului, deci bratul
   de parghie era supraestimat — M_Rd al modulului 03 SCADE cu ~0,2 % la
   compresiune mare si pana la ~1,9 % pe ramura de intindere. Sensul este cel
   corect: versiunea anterioara era neacoperitoare.
   (b) numerele de bare care nu se pot dispune in sectiune nu mai sunt
   rotunjite tacut, ci opresc calculul cu codul BAR_COUNT.
   2.3.0 — (a) V_c se calculeaza din STALPUL DE DEASUPRA NODULUI, cum cere
   P 100-1/2013 5.3.3.4(2) coroborat cu 5.3.3.3(2): V_c = 2*M_dc,sup / l_cl.
   Pana acum se folosea (M_dc,inf + M_dc,sup)/l_cl, care amesteca stalpul
   inferior cu inaltimea celui superior. V_jhd SE SCHIMBA cand cei doi stalpi
   au capacitati diferite; pe o linie uniforma rezultatul este identic.
   (b) alcatuirea nodului nu se mai raporteaza ca procent, ci doar ca verdict,
   si nu mai intra in "cea mai solicitata verificare". Verdictele NU se schimba.
   (c) s-a expus JP.barMessage(issues, lang), ca modulele in lot sa poata
   semnala o sectiune imposibila O SINGURA DATA, nu pe fiecare rand.
   Nu schimba niciun rezultat.
   2.4.0 — s-a adaugat JP.column.secondOrder(): efectele de ordinul 2 la stalp
   dupa SR EN 1992-1-1 §5.8 (metoda curburii nominale, 5.8.8). Functie noua,
   apelata numai cand modulul o cere; niciun rezultat existent nu se schimba.
   ═══════════════════════════════════════════════════════════════════════════ */
const VERSION = '2.4.0';

/* ═══════════════════════════════════════════════════════════════════════════
   CONVENTII DE CALCUL
   ───────────────────────────────────────────────────────────────────────────
   DEDUCT_STEEL — daca aria barelor se scade din aria de beton.
     false (implicit, "brut"): betonul se integreaza pe toata aria, iar
       armatura se adauga peste. Este conventia din fib structuralcodes
       (verificat: calculate_limit_axial_load da exact A_c*f_cd + A_s*f_yd) si
       din majoritatea manualelor. Eroarea este in sens defavorabil, dar mica
       in raport cu coeficientii partiali.
     true ("net"): se scade contributia betonului pe aria ocupata de bare.
       Mai riguros fizic, dar da rezultate cu ~0,4-2 % mai mici (2,007 % pe
       cazul M03-W1) si NU mai coincide cu fib.
   Conventia trebuie sa fie ACEEASI in toate modulele si declarata in PDF.

   SEMNUL LUI N — in interiorul nucleului, COMPRESIUNEA ESTE POZITIVA. Este o
   conventie interna, fixa, care nu se schimba niciodata: legile constitutive,
   epsEdge si bisectia depind de ea. ETABS raporteaza compresiunea NEGATIV, deci
   conversia se face la granita cu interfata (vezi convN() in modulele 03 / 07 /
   08), nu aici. Tot ce intra prin Ned si tot ce iese prin Nint / NRdc / NRdt
   este in conventia interna: compresiune pozitiva.

   LIMIT_EPS_UD — pivotul A al diagramei de deformatii (SR EN 1992-1-1 fig. 6.1).
     true (implicit): curbura este fixata de PRIMA limita atinsa, fie zdrobirea
       betonului la eps_cu (pivot B/C), fie bara cea mai intinsa la
       eps_ud = 0,9*eps_uk (pivot A). Este construcția corecta pentru ULS.
     false: numai betonul limiteaza, otelul are ductilitate nelimitata (ramura
       superioara orizontala, SR EN 1992-1-1 §3.2.7(2)(b)). Pastrat doar pentru
       comparatie cu versiunile anterioare.
   Pivotul A nu intervine la sectiuni puternic comprimate (unde otelul intins
   ramane departe de eps_ud); guverneaza pe ramura de intindere si la
   compresiune mica, exact zona in care pana acum rezultatele nu erau limitate.
   ═══════════════════════════════════════════════════════════════════════════ */
const DEFAULTS = {
  NF: 5000,            // numar de fibre de beton pe lungimea sectiunii
  DEDUCT_STEEL: false, // vezi nota de mai sus
  LIMIT_EPS_UD: true,  // pivot A: limiteaza deformatia otelului la eps_ud
  LIMIT_PIVOT_C: true, // pivot C: sectiune integral comprimata -> eps_c2
  Es: 200000,          // MPa
  GAMMA_C: 1.5,
  GAMMA_S: 1.15,
  EC2_NC: 0.002,       // eps_c2 neconfinat
  ECU_NC: 0.0035,      // eps_cu2 neconfinat
  NM_DIV: 120,         // puncte per ramura pe diagrama N-M
  NGY: 40, NGZ: 40,    // malaj 2D pentru stalp (modulele 06/07/08)
  NANG: 24,            // directii ale axei neutre pentru conturul My-Mz
  BISECT_IT: 200,      // iteratii de bisectie
  BISECT_TOL: 1e-9,    // kN, rezidual de echilibru acceptat
};

/* ═══════════════════════════════════════════════════════════════════════════
   MATERIALE
   ═══════════════════════════════════════════════════════════════════════════ */
const CONC = {
  'C12/15': { fck: 12 }, 'C16/20': { fck: 16 }, 'C20/25': { fck: 20 },
  'C25/30': { fck: 25 }, 'C30/37': { fck: 30 }, 'C35/45': { fck: 35 },
  'C40/50': { fck: 40 }, 'C45/55': { fck: 45 }, 'C50/60': { fck: 50 },
  'C55/67': { fck: 55 }, 'C60/75': { fck: 60 },
};

/* euk = alungirea caracteristica la forta maxima; eud = 0,9*euk (SR EN 1992-1-1).
   Tabel unificat: clasele S240B / S400B / S500B provin din modulul 03, iar
   S 235 ... S 420 din modulul 04. Pentru cele din modulul 04, euk NU a fost
   niciodata declarat (calculul de forta taietoare nu il foloseste), deci este
   PRESUPUS la minimul clasei B (50 permil) si marcat eukAssumed. Modulele care
   folosesc metoda fibrelor (pivotul A depinde de euk) primesc un avertisment
   daca se selecteaza o astfel de clasa — valoarea trebuie confirmata inainte de
   a fi folosita intr-o nota de calcul.
   f_yd se calculeaza exact (f_yk / 1,15). Modulul 04 folosea valori rotunjite
   (434,8 in loc de 434,7826), deci rezultatele lui se schimba cu ~0,004 %. */
const STEEL = {
  'S240B': { fyk: 240, euk: 0.05 },
  'S400B': { fyk: 400, euk: 0.05 },
  'S500B': { fyk: 500, euk: 0.05 },
  'S 235': { fyk: 235, euk: 0.05, eukAssumed: true },
  'S 255': { fyk: 255, euk: 0.05, eukAssumed: true },
  'S 345': { fyk: 345, euk: 0.05, eukAssumed: true },
  'S 355': { fyk: 355, euk: 0.05, eukAssumed: true },
  'S 405': { fyk: 405, euk: 0.05, eukAssumed: true },
  'S 420': { fyk: 420, euk: 0.05, eukAssumed: true },
  'S 500': { fyk: 500, euk: 0.05 },
};

const barArea = (d) => d * d * Math.PI / 4;

/**
 * Blocul dreptunghiular echivalent, SR EN 1992-1-1 §3.1.7(3): lambda (inaltimea
 * relativa) si eta (rezistenta efectiva). Constante pana la C50/60, apoi scad.
 * Folosit numai de stratul de nod, pentru M_Rb al grinzilor — metoda fibrelor
 * nu are nevoie de el.
 */
function lamEta(fck) {
  return fck <= 50 ? { lam: 0.8, eta: 1.0 }
                   : { lam: 0.8 - (fck - 50) / 400, eta: 1.0 - (fck - 50) / 200 };
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONTRACTUL DE REZULTAT  {ok, code, message, value, partial}
   ───────────────────────────────────────────────────────────────────────────
   Orice functie de rezolvare intoarce acest obiect. Nu se intorc niciodata
   NaN sau numere "plauzibile" fara stare: o celula de utilizare greseala in
   silence este mai periculoasa decat una goala.
     ok:true   -> value contine rezultatele
     ok:false  -> code + message explica de ce; partial poate contine valori
                  utile (ex. N_Rd,max) ca utilizatorul sa vada cu cat depaseste
   ═══════════════════════════════════════════════════════════════════════════ */
const CODES = {
  OK:            'OK',
  NO_BRACKET:    'NO_BRACKET',    // tinta in afara capacitatii sectiunii
  RESIDUAL_HIGH: 'RESIDUAL_HIGH', // bisectie convergenta dar rezidual mare
  INVALID_INPUT: 'INVALID_INPUT', // geometrie / materiale imposibile
  DEGENERATE:    'DEGENERATE',    // sectiune fara beton sau fara armatura
  BAR_COUNT:     'BAR_COUNT',     // numar de bare care nu se poate dispune
};

const MSG = {
  ro: {
    NO_BRACKET:    'N_Ed este in afara capacitatii axiale a sectiunii. M_Rd nu este valabil.',
    RESIDUAL_HIGH: 'Echilibrul nu a fost satisfacut exact. Cresteti numarul de fibre (NF).',
    INVALID_INPUT: 'Date de intrare invalide: verificati geometria si materialele.',
    DEGENERATE:    'Sectiune degenerata: aria de beton sau de armatura este nula.',
    BAR_COUNT:     'Numar de bare care nu se poate dispune in sectiune.',
  },
  en: {
    NO_BRACKET:    'N_Ed lies outside the section axial capacity. M_Rd is not valid.',
    RESIDUAL_HIGH: 'Equilibrium not satisfied exactly. Increase the fiber count (NF).',
    INVALID_INPUT: 'Invalid input: check geometry and materials.',
    DEGENERATE:    'Degenerate section: zero concrete or zero reinforcement area.',
    BAR_COUNT:     'Bar count that cannot be arranged in the section.',
  },
};

function ok(value, extra) {
  return Object.assign({ ok: true, code: CODES.OK, message: '', value: value }, extra || {});
}
function fail(code, lang, partial, detail) {
  const dict = MSG[lang === 'en' ? 'en' : 'ro'];
  return {
    ok: false, code: code,
    message: (dict[code] || code) + (detail ? ' ' + detail : ''),
    value: null, partial: partial || null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   NUMERE DE BARE CARE NU SE POT DISPUNE
   ───────────────────────────────────────────────────────────────────────────
   "La colturi" se numara pe TOATE cele patru colturi ale sectiunii: un pachet
   de n bare la fiecare colt da 4n, deci totalul este intotdeauna multiplu de 4
   (4, 8, 12 ...). La fel, barele de pe latura lunga a bulbului se aseaza in
   randuri egale, deci numarul lor trebuie sa se imparta exact la numarul de
   randuri.
   Pana la versiunea 2.2.0 aceste numere erau rotunjite tacut — la stalp,
   "6 bare la colturi" devenea o sectiune cu 8, adica se calcula altceva decat
   s-a tastat. Nucleul nu intoarce numere plauzibile fara stare: acum se
   opreste calculul si se spune exact ce numar nu se poate dispune.
   ═══════════════════════════════════════════════════════════════════════════ */
const BAR_LBL = {
  ro: { cornerB1: 'Bulb 1, la colturi', cornerB2: 'Bulb 2, la colturi',
        longB1: 'Bulb 1, lateral latura lunga', longB2: 'Bulb 2, lateral latura lunga',
        corner: 'La colturi' },
  en: { cornerB1: 'BE 1, at corners', cornerB2: 'BE 2, at corners',
        longB1: 'BE 1, lateral long side', longB2: 'BE 2, lateral long side',
        corner: 'At corners' },
};
function barIssue(kind, key, got, rows) {
  return { kind: kind, key: key, got: got, rows: rows };
}
/** Pastreaza numai intrarile care chiar sunt o problema. */
function barIssues(list) {
  return list.filter(function (i) {
    const n = i.got;
    if (!isFinite(n) || n < 0) return true;
    if (i.kind === 'mult4') return (n % 4) !== 0;
    return !(i.rows >= 1) || (n % i.rows) !== 0;   // 'rows'
  });
}
function barIssueDetail(issues, lang) {
  const ro = (lang !== 'en');
  const L = BAR_LBL[ro ? 'ro' : 'en'];
  return '(' + issues.map(function (i) {
    const lbl = L[i.key] || i.key;
    if (i.kind === 'mult4') {
      return ro ? lbl + ': ' + i.got + ' nu este multiplu de 4 — barele se numara pe toate cele '
                  + '4 colturi, deci un pachet la fiecare colt da 4, 8, 12 ...'
                : lbl + ': ' + i.got + ' is not a multiple of 4 — corner bars are counted over '
                  + 'all 4 corners, so one bundle at each gives 4, 8, 12 ...';
    }
    return ro ? lbl + ': ' + i.got + ' bare nu se impart exact in ' + i.rows + ' randuri'
              : lbl + ': ' + i.got + ' bars do not divide exactly into ' + i.rows + ' rows';
  }).join('; ') + ')';
}
/** Mesajul complet, in limba ceruta, pentru un set de barIssues.
    Modulele in lot (07, 09) verifica sectiunea O SINGURA DATA, inainte de a
    rula sute de combinatii care ar esua toate cu acelasi motiv; ele au nevoie
    de exact textul pe care l-ar fi compus fail(), fara a rula solverul. */
function barMessage(issues, lang) {
  if (!issues || !issues.length) return '';
  return fail(CODES.BAR_COUNT, lang, null, barIssueDetail(issues, lang)).message;
}

/* ═══════════════════════════════════════════════════════════════════════════
   LEGI CONSTITUTIVE
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Lege parabola-dreptunghi (SR EN 1992-1-1 / Encipedia Anexa A):
 * parabola pana la eps_c2, apoi palier constant la f_cd pana la eps_cu2.
 *
 * NU se anuleaza tensiunea peste ecu ("if (eps > ecu) return 0"): epsEdge este
 * calibrat astfel incat fibra critica sa fie EXACT la ecu, iar erorile de
 * virgula mobila o pot plasa cu un ulp deasupra pragului. Tensiunea ei ar sari
 * atunci de la f_cd la 0 (salt de ~7 kN pe o fibra de bulb), ceea ce introducea
 * dinti de fierastrau in N(X) si impiedica bisectia sa atinga echilibrul exact.
 * ecu este limita domeniului, nu un prag peste care contributia dispare.
 */
function sigC(eps, props) {
  if (eps <= 0) return 0;
  const r = eps / props.ec2;
  if (eps <= props.ec2) return props.fcd * (2 * r - r * r);
  return props.fcd;
}

/** Otel elastic - perfect plastic, fara consolidare. */
function sigS(eps, m) {
  let s = eps * m.Es;
  if (s > m.fyd) s = m.fyd;
  if (s < -m.fyd) s = -m.fyd;
  return s;
}

/* ═══════════════════════════════════════════════════════════════════════════
   NUCLEU: INTEGRARE PE PLAN DE DEFORMATII
   Sectiunea este discretizata 1D pe lungime (coordonata l, mm), cu latime
   variabila w(l) si zona ('bulb' / 'web') data de model.widthAt(l).
   Armatura este data ca fibre punctuale {A, l}.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Forte in sectiune pentru adancimea axei neutre X (mm de la marginea cea mai
 * comprimata).
 *
 * Construirea planului de deformatii: curbura se fixeaza astfel incat zona
 * care cedeaza prima sa fie EXACT la eps_cu al ei (bulb confinat sau inima
 * neconfinata, dupa caz). Planul este liniar: eps(lc) = epsEdge*(X-lc)/X.
 * Cu palierul parabola-dreptunghi diagrama se inchide lin: pe masura ce X
 * creste, toata sectiunea ajunge pe palier si N tinde la A_c*f_cd (compresiune
 * centrica).
 *
 * @param {number}  X            adancimea axei neutre [mm]
 * @param {object}  m            modelul sectiunii
 * @param {boolean} compFromRef  true = comprimat dinspre l=0 (referinta)
 */
function sectionForces(X, m, compFromRef) {
  const L = m.lw, NF = m.NF, dx = L / NF;
  const deduct = m.deductSteel;

  // ── 1. epsEdge: deformatia la marginea comprimata, fixata de prima limita
  //      atinsa. Pivot B — zdrobirea betonului la eps_cu al zonei.
  let epsEdge = Infinity, pivot = 'none';
  for (let i = 0; i < NF; i++) {
    const lc = (i + 0.5) * dx;
    const shp = (X - lc) / X;
    if (shp <= 0) continue;
    const lpos = compFromRef ? lc : (L - lc);
    const z = m.widthAt(lpos);
    const e = m.props(z.zone).ecu / shp;  // deformatia la margine care aduce
    if (e < epsEdge) { epsEdge = e; pivot = 'concrete'; }  // ACEASTA fibra la ecu-ul ei
  }
  // ── 1a. PIVOT C — sectiune integral comprimata (X >= l_w). Vezi edgeStrain().
  // La perete zonele pot avea confinari diferite; se folosesc proprietatile
  // zonei care contine fibra cea mai comprimata, adica materialul care fixeaza
  // de fapt marginea. Pivotul C este continuu cu pivotul B la X = l_w.
  if (m.limitPivotC && X >= L) {
    const edgePos = compFromRef ? (0.5 * dx) : (L - 0.5 * dx);
    const prEdge = m.props(m.widthAt(edgePos).zone);
    const eC = edgeStrain(X, L, prEdge);
    if (eC.eps < epsEdge) { epsEdge = eC.eps; pivot = eC.pivot; }
  }
  // Pivot A — bara cea mai intinsa la eps_ud. Pentru o bara intinsa shp < 0,
  // deci eps_s = epsEdge*shp este negativ; conditia |eps_s| = eps_ud da
  // epsEdge = eps_ud / (-shp). Cea mai mica dintre toate candidaturile (beton
  // si otel) este cea care guverneaza: la ea se atinge prima limita.
  if (m.limitEpsUd && m.eud > 0) {
    for (let k = 0; k < m.steelFibers.length; k++) {
      const sf = m.steelFibers[k];
      const lc = compFromRef ? sf.l : (L - sf.l);
      const shp = (X - lc) / X;
      if (shp >= 0) continue;            // bara comprimata sau pe axa neutra
      const e = m.eud / (-shp);
      if (e < epsEdge) { epsEdge = e; pivot = 'steel'; }
    }
  }
  // La X foarte mic nicio fibra nu are shp>0 si epsEdge ramane 0 => toate
  // fortele ies nule, deci N_int sare artificial la 0. Este o degenerare
  // numerica, nu o stare fizica: sectiunea complet intinsa are N = N_Rd,t.
  // Se evita pornind bisectia de la X >= 1 mm (vezi solveX).
  if (!isFinite(epsEdge)) epsEdge = 0;

  // ── 2. beton
  let Fb = 0, Fbl = 0;
  for (let i = 0; i < NF; i++) {
    const lc = (i + 0.5) * dx;
    const eps = epsEdge * (X - lc) / X;
    const lpos = compFromRef ? lc : (L - lc);
    const z = m.widthAt(lpos);
    const F = sigC(eps, m.props(z.zone)) * z.w * dx;
    Fb += F; Fbl += F * lpos;
  }

  // ── 3. armatura
  let Fa = 0, Fal = 0;
  for (let k = 0; k < m.steelFibers.length; k++) {
    const sf = m.steelFibers[k];
    const lc = compFromRef ? sf.l : (L - sf.l);
    const eps = epsEdge * (X - lc) / X;
    let sig = sigS(eps, m);
    if (deduct) {
      // conventia "net": se scade betonul de pe aria barei
      const z = m.widthAt(sf.l);
      sig -= sigC(eps, m.props(z.zone));
    }
    const F = sig * sf.A;
    Fa += F; Fal += F * sf.l;
  }

  return {
    Fb: Fb / 1e3, Fa: Fa / 1e3,   // kN
    Fbl: Fbl, Fal: Fal,           // N*mm
    Nint: (Fb + Fa) / 1e3,        // kN
    epsEdge: epsEdge,
    pivot: pivot,                 // 'concrete' | 'steel' | 'squash' | 'none'
  };
}

/**
 * Bisectie pe X pentru N_int = Ntarget.
 *
 * ATENTIE: la X -> 0 sectiunea degenereaza (nicio fibra nu mai are shp>0,
 * epsEdge devine 0 si toate fortele ies nule) => N_int sare artificial la 0.
 * Capatul inferior TREBUIE luat la X mic dar nenul (1 mm), unde sectiunea este
 * efectiv toata intinsa si N_int ~ N_Rd,t. Pornind de la X=1e-3 (punct
 * degenerat) bisectia esua pentru N negativ, desi solutia exista.
 */
function solveX(Ntarget, m, compFromRef) {
  const F = (X) => sectionForces(X, m, compFromRef).Nint - Ntarget;
  let lo = 1, hi = m.lw * 6;
  let flo = F(lo), fhi = F(hi);
  let guard = 0;
  while (flo * fhi > 0 && guard++ < 200) {
    if (Math.abs(flo) < Math.abs(fhi)) {
      lo /= 2; if (lo < 1e-6) break; flo = F(lo);
    } else {
      hi *= 2; if (hi > m.lw * 1e6) break; fhi = F(hi);
    }
  }
  if (flo * fhi > 0) {
    // tinta in afara capacitatii sectiunii (N_Ed < N_Rd,t sau > N_Rd,c)
    const X = (Math.abs(flo) < Math.abs(fhi)) ? lo : hi;
    const r = sectionForces(X, m, compFromRef);
    return { X: X, res: r, converged: false };
  }
  let mid = lo;
  for (let it = 0; it < m.BISECT_IT; it++) {
    mid = (lo + hi) / 2;
    const fm = F(mid);
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    if (Math.abs(fm) < m.BISECT_TOL) break;
  }
  const X = (lo + hi) / 2;
  return { X: X, res: sectionForces(X, m, compFromRef), converged: true };
}

/**
 * Centrul de greutate GEOMETRIC al sectiunii de beton, masurat de la marginea
 * de referinta (l=0). Este axa fata de care ETABS raporteaza eforturile pe
 * *pier*, deci M_Rd trebuie raportat la aceeasi axa pentru consistenta cu
 * modelul. Se calculeaza doar din forma sectiunii de beton (fara armatura si
 * fara ponderare cu f_cd). La sectiune simetrica coincide cu mijlocul
 * geometric l_w/2; la bulbi diferiti geometric este deplasat spre bulbul mai
 * mare.
 */
function geomCG(m) {
  let SA = 0, SS = 0;
  for (let i = 0; i < m.zones.length; i++) {
    const z = m.zones[i];
    if (z.len <= 0) continue;
    const A = z.len * z.w;
    SA += A; SS += A * (z.l0 + z.len / 2);
  }
  if (SA <= 0) return 0;
  return SS / SA;
}

/** M_Rd raportat la centrul de greutate geometric [kNm]. */
function momentRd(res, m) {
  const Mfb = res.Fbl / 1e6, Mfa = res.Fal / 1e6, N = res.Nint;
  return -Mfa - Mfb + N * (geomCG(m) / 1e3);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODEL DE PERETE (module 03 / 04)
   Sectiune: bulb 2 (referinta, l=0) | inima | bulb 1
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {object} inp  geometrie, materiale, armare, confinare — vezi README
 * @returns {object} model gata pentru sectionForces / solveX
 */
function buildWallModel(inp) {
  const o = Object.assign({}, DEFAULTS, inp.opts || {});
  const lw = +inp.lw, bw0 = +inp.bw0;
  const bf1 = +inp.bf1, lf1 = +inp.lf1, li1 = +(inp.li1 || 0);
  const bf2 = +inp.bf2, lf2 = +inp.lf2, li2 = +(inp.li2 || 0);
  const lwi = lw - bf1 - bf2 - li1 - li2;

  const fck = CONC[inp.concrete] ? CONC[inp.concrete].fck : 0;
  const fyk = STEEL[inp.steel] ? STEEL[inp.steel].fyk : 0;
  const euk = STEEL[inp.steel] ? STEEL[inp.steel].euk : 0.05;
  const fcd = fck / o.GAMMA_C;
  const fyd = fyk / o.GAMMA_S;

  const confMode = inp.confMode || 'none';          // 'none' | 'bulb' | 'all'
  const bulbConf = (confMode === 'bulb' || confMode === 'all');
  const webConf  = (confMode === 'all');
  const fcdc  = (+inp.fckc  || 0) / o.GAMMA_C;      // bulb confinat
  const fcdcw = (+inp.fckcw || 0) / o.GAMMA_C;      // inima confinata

  /* ── Pozitia CENTRULUI barei fata de fata bulbului ────────────────────────
     acoperire de beton      ->  fata exterioara a etrierului
     + diametrul etrierului  ->  fata interioara a etrierului
     + jumatate din diametrul barei longitudinale  ->  CENTRUL barei
     Este aceeasi "acoperire mecanica" c_mec ca la stalp (buildColumnModel) si
     ca in XD-CoSec: pentru c_nom = 35, etrier 10 si bara Ø25 rezulta
     35 + 10 + 12,5 = 57,5 mm. Fiecare grup de bare are propriul diametru, deci
     propriul decalaj.
     ATENTIE — pana la engine v2.2.0 lumpurile de capat ale bulbului stateau
     chiar pe fetele lui (l = refStart si l = refStart + bulbLen), adica barele
     extreme cadeau pe marginea betonului. Bratul de parghie era supraestimat,
     deci M_Rd iesea prea mare. Bulbul este un element de capat cu etrier
     propriu inchis, deci ambele fete transversale au acoperire. */
  const cnom = +inp.cnom || 0, detr = +inp.detr || 0;
  const cMec = function (dbar, bulbLen) {
    // la un bulb foarte scurt cele doua capete nu se pot incrucisa
    return Math.min(cnom + detr + (+dbar || 0) / 2, bulbLen / 2);
  };

  // ── armatura: fibre punctuale, lumped pe lungimea sectiunii
  function bulbFibers(c_n, c_d, s_n, s_d, l_n, l_d, l_r, bulbLen, refStart) {
    const Ac = barArea(c_d), As = barArea(s_d), Al = barArea(l_d);
    const f = [];
    const cmC = cMec(c_d, bulbLen), cmS = cMec(s_d, bulbLen);
    // Capetele bulbului: barele de colt si cele de pe latura scurta stau la
    // acelasi l, dar la decalaje diferite daca au diametre diferite.
    if (c_n > 0) {
      f.push({ A: Ac * (c_n / 2), l: refStart + cmC });
      f.push({ A: Ac * (c_n / 2), l: refStart + bulbLen - cmC });
    }
    if (s_n > 0) {
      f.push({ A: As * (s_n / 2), l: refStart + cmS });
      f.push({ A: As * (s_n / 2), l: refStart + bulbLen - cmS });
    }
    // Barele de pe latura lunga se distribuie INTRE barele de capat (intre
    // centrele lor), nu intre fetele bulbului — la fel ca barele intermediare
    // ale stalpului, care se distribuie intre barele de colt.
    const cmEnd = (c_n > 0) ? cmC : (s_n > 0 ? cmS : cMec(0, bulbLen));
    const l0 = refStart + cmEnd, l1 = refStart + bulbLen - cmEnd;
    const nRows = Math.max(0, Math.round(l_n / Math.max(1, l_r)));
    for (let i = 0; i < nRows; i++) {
      f.push({ A: Al * l_r, l: l0 + (l1 - l0) * (i + 1) / (nRows + 1) });
    }
    return f;
  }

  const b = inp.bars;
  const nWeb = (b.in_r > 0 && b.in_s > 0) ? Math.max(0, Math.floor(lwi / b.in_s)) : 0;
  const f2 = bulbFibers(b.b2c_n, b.b2c_d, b.b2s_n, b.b2s_d, b.b2l_n, b.b2l_d,
                        Math.max(1, b.b2l_r), bf2, 0);
  const f1 = bulbFibers(b.b1c_n, b.b1c_d, b.b1s_n, b.b1s_d, b.b1l_n, b.b1l_d,
                        Math.max(1, b.b1l_r), bf1, lw - bf1);
  const webFibers = [];
  const Aweb_row = (b.in_r > 0) ? barArea(b.in_d) * b.in_r : 0;
  const webStart = bf2 + li2;
  const webStep = nWeb > 0 ? lwi / nWeb : 0;
  for (let i = 0; i < nWeb; i++) {
    webFibers.push({ A: Aweb_row, l: webStart + (i + 0.5) * webStep });
  }
  const steelFibers = f2.concat(webFibers, f1);

  const As_b1 = b.b1c_n * barArea(b.b1c_d) + b.b1s_n * barArea(b.b1s_d) + b.b1l_n * barArea(b.b1l_d);
  const As_b2 = b.b2c_n * barArea(b.b2c_d) + b.b2s_n * barArea(b.b2s_d) + b.b2l_n * barArea(b.b2l_d);
  const As_web = (b.in_r > 0 && b.in_s > 0) ? barArea(b.in_d) * b.in_r * nWeb : 0;
  const As_tot = As_b1 + As_b2 + As_web;
  const Ac_gross = bf1 * lf1 + li1 * bw0 + bf2 * lf2 + li2 * bw0 + lwi * bw0;

  // ── zone geometrice, de la marginea de referinta l=0
  const zones = [
    { l0: 0,                        len: bf2, w: lf2, zone: 'bulb' },
    { l0: bf2,                      len: li2, w: bw0, zone: 'bulb' },
    { l0: bf2 + li2,                len: lwi, w: bw0, zone: 'web'  },
    { l0: bf2 + li2 + lwi,          len: li1, w: bw0, zone: 'bulb' },
    { l0: bf2 + li2 + lwi + li1,    len: bf1, w: lf1, zone: 'bulb' },
  ];

  const propsUnconf = { fcd: fcd,   ec2: o.EC2_NC,             ecu: o.ECU_NC };
  const propsBulbC  = { fcd: fcdc,  ec2: (+inp.ec2c  || 0) / 1000, ecu: (+inp.ecu2c  || 0) / 1000 };
  const propsWebC   = { fcd: fcdcw, ec2: (+inp.ec2cw || 0) / 1000, ecu: (+inp.ecu2cw || 0) / 1000 };

  const m = {
    // geometrie
    lw: lw, bw0: bw0, bf1: bf1, lf1: lf1, li1: li1, bf2: bf2, lf2: lf2, li2: li2,
    lwi: lwi, zones: zones, cnom: +inp.cnom || 0, detr: +inp.detr || 0,
    // materiale
    fck: fck, fcd: fcd, fyd: fyd, Es: o.Es, euk: euk, eud: 0.9 * euk,
    eukAssumed: !!(STEEL[inp.steel] && STEEL[inp.steel].eukAssumed),
    fckc: +inp.fckc || 0, fcdc: fcdc, fckcw: +inp.fckcw || 0, fcdcw: fcdcw,
    ec2_nc: o.EC2_NC, ecu_nc: o.ECU_NC,
    ec2_c: propsBulbC.ec2, ecu_c: propsBulbC.ecu,
    ec2_cw: propsWebC.ec2, ecu_cw: propsWebC.ecu,
    confMode: confMode, bulbConf: bulbConf, webConf: webConf,
    // armatura
    steelFibers: steelFibers, As_b1: As_b1, As_b2: As_b2, As_web: As_web,
    As_tot: As_tot, Ac: Ac_gross,
    cntB1: b.b1c_n + b.b1s_n + b.b1l_n,
    cntB2: b.b2c_n + b.b2s_n + b.b2l_n,
    cntWeb: nWeb * b.in_r, nWeb: nWeb, bars: b,
    // numere de bare care nu se pot dispune — vezi barIssues()
    barIssues: barIssues([
      barIssue('mult4', 'cornerB1', +b.b1c_n || 0),
      barIssue('mult4', 'cornerB2', +b.b2c_n || 0),
      barIssue('rows', 'longB1', +b.b1l_n || 0, Math.max(1, +b.b1l_r || 1)),
      barIssue('rows', 'longB2', +b.b2l_n || 0, Math.max(1, +b.b2l_r || 1)),
    ]),
    // opts
    NF: o.NF, deductSteel: o.DEDUCT_STEEL, limitEpsUd: o.LIMIT_EPS_UD,
    limitPivotC: o.LIMIT_PIVOT_C,
    BISECT_IT: o.BISECT_IT, BISECT_TOL: o.BISECT_TOL, NM_DIV: o.NM_DIV,
    concrete: inp.concrete, steel: inp.steel,
  };

  // proprietatile betonului pe zona, tinand cont de modul de confinare
  m.props = function (zone) {
    if (zone === 'bulb' && bulbConf) return propsBulbC;
    if (zone === 'web'  && webConf)  return propsWebC;
    return propsUnconf;
  };
  m.widthAt = function (l) {
    if (l <= bf2)                   return { w: lf2, zone: 'bulb' };
    if (l <= bf2 + li2)             return { w: bw0, zone: 'bulb' };
    if (l <= bf2 + li2 + lwi)       return { w: bw0, zone: 'web'  };
    if (l <= bf2 + li2 + lwi + li1) return { w: bw0, zone: 'bulb' };
    return { w: lf1, zone: 'bulb' };
  };

  return m;
}

/** Capacitati axiale limita [kN]. */
function axialLimits(m) {
  const Ab = m.bf1 * m.lf1 + m.bf2 * m.lf2;
  const Aw = m.Ac - Ab;
  const fbulb = m.bulbConf ? m.fcdc : m.fcd;
  const fweb  = m.webConf  ? m.fcdcw : m.fcd;
  // Palierul parabola-dreptunghi: fiecare zona la f_cd al ei. Otelul NU ajunge
  // la f_yd la compresiune centrica: pivotul C limiteaza deformatia la eps_c2
  // (vezi edgeStrain si nota de la columnAxialLimits). Se ia eps_c2 al zonei
  // neconfinate, care este cea care guverneaza marginea in cazul uzual.
  const ec2edge = m.bulbConf ? m.ec2_c : m.ec2_nc;
  const sigS_c = m.limitPivotC ? Math.min(m.fyd, m.Es * ec2edge) : m.fyd;
  const NRdc = (Aw * fweb + Ab * fbulb + m.As_tot * sigS_c) / 1e3;
  return { NRdc: NRdc,
           NRdc_mat: (Aw * fweb + Ab * fbulb + m.As_tot * m.fyd) / 1e3,
           sigS_c: sigS_c,
           NRdt: -(m.As_tot * m.fyd) / 1e3 };
}

/**
 * Rezolvare M_Rd la N_Ed dat.
 * @returns {object} contract {ok, code, message, value, partial}
 */
function solveWall(m, Ned, Med, lang) {
  if (!(m.Ac > 0)) return fail(CODES.DEGENERATE, lang);
  if (!(m.fcd > 0) || !(m.fyd > 0)) return fail(CODES.INVALID_INPUT, lang);
  if (m.barIssues && m.barIssues.length)
    return fail(CODES.BAR_COUNT, lang, null, barIssueDetail(m.barIssues, lang));

  const lim = axialLimits(m);
  const compFromRef = Med >= 0;
  const s = solveX(Ned, m, compFromRef);
  const Mrd = Math.abs(momentRd(s.res, m));
  const residual = Ned - s.res.Nint;
  const tol = Math.max(0.01, Math.abs(Ned) * 1e-5);

  const value = {
    Mrd: Mrd, X: s.X, Nint: s.res.Nint, residual: residual,
    Fb: s.res.Fb, Fa: s.res.Fa, epsEdge: s.res.epsEdge, pivot: s.res.pivot,
    compFromRef: compFromRef,
    NRdc: lim.NRdc, NRdt: lim.NRdt,
    util: Mrd > 0 ? Math.abs(Med) / Mrd * 100 : Infinity,
  };

  // Clasele preluate din modulul 04 nu au un euk declarat: pivotul A foloseste
  // o valoare presupusa, care trebuie confirmata inainte de a ajunge in raport.
  const warnings = [];
  if (m.eukAssumed && m.limitEpsUd) warnings.push({ code: 'EUK_ASSUMED', ref: m.steel });

  if (!s.converged) {
    // N_Ed in afara domeniului: se intoarce capacitatea limita depasita, ca
    // utilizatorul sa vada CU CAT depaseste, nu doar o celula goala.
    const over = Ned > lim.NRdc ? { limit: 'N_Rd,c', value: lim.NRdc }
                                : { limit: 'N_Rd,t', value: lim.NRdt };
    return fail(CODES.NO_BRACKET, lang,
      Object.assign({}, value, { exceeded: over }),
      '(' + over.limit + ' = ' + over.value.toFixed(0) + ' kN)');
  }
  if (Math.abs(residual) > tol) {
    return fail(CODES.RESIDUAL_HIGH, lang, value,
      '(rezidual ' + residual.toFixed(2) + ' kN)');
  }
  return ok(value, warnings.length ? { warnings: warnings } : null);
}

/**
 * Diagrama de interactiune N-M.
 *
 * sectionForces() fixeaza deja curbura pe zona care cedeaza prima (bulb ecu_c
 * sau inima ecu_nc). Baleiajul lui X de la mic (incovoiere) la mare
 * (compresiune) traseaza tot conturul; pe masura ce X creste sectiunea tinde
 * la deformatie uniforma si N tinde natural la apexul de compresiune centrica.
 *
 * Sectiune nesimetrica (bulbi armati diferit): M_Rd(+) != M_Rd(-) la acelasi N,
 * deci se genereaza DOUA ramuri, baleiate dupa X (nu dupa N), fiecare cu semnul
 * ei. Nu se filtreaza si nu se monotonizeaza nimic: fiecare punct este o
 * solutie exacta a echilibrului sectiunii.
 *
 * ATENTIE: la sectiune NESIMETRICA nu se adauga puncte terminale cu M=0.
 * Momentul este raportat la centrul de greutate geometric, deci compresiunea
 * centrica NU are M=0 daca CG nu coincide cu mijlocul. Fortarea unui punct M=0
 * ar introduce o cotitura artificiala la capatul curbei.
 */
function interactionNM(m, side) {
  const nDiv = m.NM_DIV, xStart = 1, xEnd = m.lw * 60;
  const pts = [];
  const cfr = (side === 'pos');
  for (let i = 0; i <= nDiv; i++) {
    const f = i / nDiv;
    const X = xStart * Math.pow(xEnd / xStart, f);
    const r = sectionForces(X, m, cfr);
    pts.push({ M: Math.abs(momentRd(r, m)), N: r.Nint });
  }
  pts.sort((a, b) => a.N - b.N);
  return ok(pts);
}

/* ═══════════════════════════════════════════════════════════════════════════
   STALP — FLEXIUNE COMPUSA OBLICA (modulele 06 / 07 / 08)
   Metoda fibrelor 2D pe malaj rectangular. Sectiunea este centrata in (0,0);
   y este orizontala (latimea b), z verticala (inaltimea h).

   Conventii — ACELEASI ca la perete:
     - compresiunea este pozitiva (N, eps, sig);
     - aria de beton este BRUTA (DEDUCT_STEEL = false): betonul se integreaza
       pe toata sectiunea, iar armatura se adauga peste. ATENTIE: versiunea
       anterioara a modulului 06 scadea betonul dislocuit de bare, deci dadea
       rezultate cu ~0,4-2 % mai mici. Alinierea la conventia din modulul 03 si
       din fib structuralcodes le creste.
     - pivotul A (eps_ud) limiteaza curbura la fel ca la perete.

   Fiecare fibra de armatura poarta o eticheta de grup (grp): 'cor' pentru
   barele de colt, 'topb' pentru cele de pe fetele de lungime b si 'sidh'
   pentru cele de pe fetele de lungime h. Stratul de nod are nevoie de ele ca
   sa extraga A_sv (barele distribuite pe adancimea nodului) fara sa depinda de
   ordinea in care sunt generate fibrele.
   ═══════════════════════════════════════════════════════════════════════════ */

function buildColumnModel(inp) {
  const o = Object.assign({}, DEFAULTS, inp.opts || {});
  const b = +inp.b || 0, h = +inp.h || 0;
  const cnom = +inp.cnom || 0, detr = +inp.detr || 0;
  const fck = CONC[inp.concrete] ? CONC[inp.concrete].fck : 0;
  const st = STEEL[inp.steel] || { fyk: 0, euk: 0.05 };
  const conf = inp.confMode === 'all';
  const fcd = fck / o.GAMMA_C;
  const fcdc = (+inp.fckc || 0) / o.GAMMA_C;

  const NGY = o.NGY, NGZ = o.NGZ;

  /* ── Pozitia CENTRULUI barei fata de fata betonului ──────────────────────
     acoperire de beton  ->  fata exterioara a etrierului
     + diametrul etrierului  ->  fata interioara a etrierului
     + jumatate din diametrul barei longitudinale  ->  CENTRUL barei
     Este exact "acoperirea mecanica" c_mec din XD-CoSec: pentru c_nom = 35,
     etrier 8 si bara 20 rezulta 35 + 8 + 10 = 53 mm.
     Fiecare grup de bare are propriul diametru, deci propriul decalaj: bare de
     diametre diferite pe laturi diferite NU stau pe aceeasi linie.
     ATENTIE — versiunea anterioara folosea doar c_nom + etrier, deci aseza
     centrul barei cu Ø/2 prea aproape de fata; cu acoperire si etrier nule
     centrul cadea chiar pe fata sectiunii, ceea ce este imposibil fizic.
     ──────────────────────────────────────────────────────────────────────── */
  const cMec = function (dbar) { return cnom + detr + dbar / 2; };
  const cor_d = +inp.cor_d || 0, topb_d = +inp.topb_d || 0, sidh_d = +inp.sidh_d || 0;
  const halfYc = b / 2 - cMec(cor_d), halfZc = h / 2 - cMec(cor_d);   // colturi
  const halfZt = h / 2 - cMec(topb_d);                                // bare sus/jos
  const halfYs = b / 2 - cMec(sidh_d);                                // bare stanga/dreapta

  // ── armatura pe contur
  const steelFibers = [];
  /* "La colturi" se numara pe toate cele patru colturi: un pachet de n bare la
     fiecare colt da 4n. Un numar care nu este multiplu de 4 NU se mai rotunjeste
     tacut (6 devenea 8, adica alta sectiune decat cea tastata) — se pastreaza
     rotunjirea doar pentru desen, iar solverul refuza sa calculeze. */
  const cor_n = Math.max(0, Math.round(+inp.cor_n || 0));
  const perCorner = Math.max(0, Math.round(cor_n / 4));
  const Acorner = barArea(cor_d);
  [[-halfYc, -halfZc], [halfYc, -halfZc], [halfYc, halfZc], [-halfYc, halfZc]].forEach(function (c) {
    steelFibers.push({ y: c[0], z: c[1], A: Acorner * perCorner, grp: 'cor' });
  });
  // Barele intermediare se distribuie intre barele de colt, nu intre fetele
  // sectiunii: intervalul liber este cel dintre centrele barelor de colt.
  const topb_n = Math.max(0, +inp.topb_n || 0), Atop = barArea(topb_d);
  if (topb_n > 0) for (let s = 0; s < 2; s++) {
    const z = (s === 0) ? -halfZt : halfZt;
    for (let i = 0; i < topb_n; i++) {
      steelFibers.push({ y: -halfYc + (halfYc * 2) * (i + 1) / (topb_n + 1), z: z, A: Atop, grp: 'topb' });
    }
  }
  const sidh_n = Math.max(0, +inp.sidh_n || 0), Aside = barArea(sidh_d);
  if (sidh_n > 0) for (let s = 0; s < 2; s++) {
    const y = (s === 0) ? -halfYs : halfYs;
    for (let i = 0; i < sidh_n; i++) {
      steelFibers.push({ y: y, z: -halfZc + (halfZc * 2) * (i + 1) / (sidh_n + 1), A: Aside, grp: 'sidh' });
    }
  }
  const halfY = halfYc, halfZ = halfZc;   // pastrate pentru desen / compatibilitate

  // ── malaj de beton
  const dAg = (b / NGY) * (h / NGZ);
  const cy = new Float64Array(NGY * NGZ), cz = new Float64Array(NGY * NGZ);
  let k = 0;
  for (let i = 0; i < NGY; i++) {
    const yy = -b / 2 + (i + 0.5) * (b / NGY);
    for (let j = 0; j < NGZ; j++) {
      cy[k] = yy; cz[k] = -h / 2 + (j + 0.5) * (h / NGZ); k++;
    }
  }

  const As_tot = steelFibers.reduce(function (s, f) { return s + f.A; }, 0);
  const grpArea = function (tags) {
    return steelFibers.reduce(function (s, f) {
      return s + (tags.indexOf(f.grp) >= 0 ? f.A : 0);
    }, 0);
  };
  const euk = st.euk;
  const m = {
    b: b, h: h, cnom: cnom, detr: detr,
    fck: fck, fcd: fcd, fckc: +inp.fckc || 0, fcdc: fcdc,
    fyd: st.fyk / o.GAMMA_S, fyk: st.fyk, Es: o.Es,
    euk: euk, eud: 0.9 * euk, eukAssumed: !!st.eukAssumed,
    ec2_nc: o.EC2_NC, ecu_nc: o.ECU_NC,
    ec2_c: (+inp.ec2c || 0) / 1000, ecu_c: (+inp.ecu2c || 0) / 1000,
    confMode: conf ? 'all' : 'none', conf: conf,
    steelFibers: steelFibers, cy: cy, cz: cz, nC: NGY * NGZ, dAg: dAg,
    As_tot: As_tot,
    As_cor: grpArea(['cor']), As_topb: grpArea(['topb']), As_sidh: grpArea(['sidh']),
    // barele distribuite pe adancimea h (colturi + fetele de lungime h) — este
    // A_sv din relatia (5.31) cand nodul se verifica pe directia adancimii h
    As_alongH: grpArea(['cor', 'sidh']),
    As_alongB: grpArea(['cor', 'topb']),
    Ac: b * h,
    cntCorner: perCorner * 4, cntTop: topb_n * 2, cntSide: sidh_n * 2,
    cntTot: perCorner * 4 + topb_n * 2 + sidh_n * 2,
    halfY: halfY, halfZ: halfZ,
    NGY: NGY, NGZ: NGZ, NANG: o.NANG,
    deductSteel: o.DEDUCT_STEEL, limitEpsUd: o.LIMIT_EPS_UD,
    limitPivotC: o.LIMIT_PIVOT_C,
    concrete: inp.concrete, steel: inp.steel,
    bars: { cor_n: +inp.cor_n || 0, cor_d: +inp.cor_d || 0,
            topb_n: topb_n, topb_d: +inp.topb_d || 0,
            sidh_n: sidh_n, sidh_d: +inp.sidh_d || 0 },
    barIssues: barIssues([barIssue('mult4', 'corner', cor_n)]),
  };
  m.props = function () {
    return conf ? { fcd: fcdc, ec2: m.ec2_c, ecu: m.ecu_c }
                : { fcd: fcd, ec2: m.ec2_nc, ecu: m.ecu_nc };
  };
  return m;
}

/** Distanta de la centru la coltul cel mai comprimat, proiectata pe normala. */
function dmaxTheta(theta, b, h) {
  const cx = Math.cos(theta), cz = Math.sin(theta);
  return Math.abs(b / 2 * cx) + Math.abs(h / 2 * cz);
}

/**
 * Proiectiile fibrelor pe normala la axa neutra. NU depind de X, deci se
 * calculeaza O SINGURA DATA pe unghi si se refolosesc la toate iteratiile de
 * bisectie — altfel aceleasi ~1600 de produse scalare se refac de 45 de ori.
 */
function projectColumn(theta, m) {
  const cx = Math.cos(theta), cs = Math.sin(theta);
  const dC = new Float64Array(m.nC);
  for (let i = 0; i < m.nC; i++) dC[i] = m.cy[i] * cx + m.cz[i] * cs;
  const dS = new Float64Array(m.steelFibers.length);
  for (let i = 0; i < m.steelFibers.length; i++) {
    dS[i] = m.steelFibers[i].y * cx + m.steelFibers[i].z * cs;
  }
  // Sectiunea dreptunghiulara este centrata in origine, deci proiectia minima
  // este simetrica fata de cea maxima. H este adancimea sectiunii pe directia
  // normalei — marimea de care depinde pivotul C.
  const dmax = dmaxTheta(theta, m.b, m.h);
  return { dC: dC, dS: dS, dmax: dmax, dmin: -dmax, H: 2 * dmax };
}

/**
 * Deformatia la fibra extrema comprimata, conform diagramei de pivoti a
 * SR EN 1992-1-1 (fig. 6.1).
 *
 *   X <  H : sectiunea are si zona intinsa -> pivot B, fibra extrema la eps_cu.
 *   X >= H : sectiunea este integral comprimata -> PIVOT C. Planul de
 *            deformatii se roteste in jurul punctului situat la
 *            d_C = (1 - eps_c2/eps_cu) * H de fata cea mai comprimata, unde
 *            deformatia este fixata la eps_c2. Rezulta
 *                eps_edge = eps_c2 * X / (X - d_C)
 *            care da exact eps_cu la X = H (continuu cu pivotul B) si tinde la
 *            eps_c2 cand X -> infinit (compresiune centrica).
 *
 * Fara pivotul C, compresiunea centrica ar fi calculata cu eps_cu, deci cu
 * otelul la f_yd; codul limiteaza insa deformatia la eps_c2, unde otelul S500
 * ajunge doar la Es*eps_c2 = 400 MPa. Diferenta este vizibila numai la N mare:
 * pe stalpul de referinta, sub ~5800 kN efectul este nul, iar la 6288 kN
 * rezultatul fara pivot C era cu 17 % mai mare (in sens defavorabil).
 */
function edgeStrain(X, H, pr) {
  if (!(H > 0) || X < H) return { eps: pr.ecu, pivot: 'concrete' };
  const dC = (1 - pr.ec2 / pr.ecu) * H;
  const den = X - dC;
  if (!(den > 0)) return { eps: pr.ec2, pivot: 'squash' };
  return { eps: pr.ec2 * X / den, pivot: 'squash' };
}

/**
 * Forte si momente pentru axa neutra la adancimea X, inclinarea theta.
 * Planul de deformatii este fixat de prima limita atinsa: fibra extrema de
 * beton la eps_cu (pivot B/C) sau bara cea mai intinsa la eps_ud (pivot A).
 */
function columnForces(X, theta, m, proj) {
  const p = proj || projectColumn(theta, m);
  const pr = m.props();
  const na = p.dmax - X;
  const e0 = m.limitPivotC ? edgeStrain(X, p.H, pr)
                           : { eps: pr.ecu, pivot: 'concrete' };
  let epsEdge = e0.eps, pivot = e0.pivot;

  if (m.limitEpsUd && m.eud > 0) {
    // epsEdge care aduce fibra extrema la ecu da, la bara j, deformatia
    // eps_j = epsEdge*(d_j-na)/X. Se cauta bara cea mai intinsa si, daca
    // depaseste eps_ud, se reduce epsEdge proportional.
    let worst = 0;
    for (let j = 0; j < p.dS.length; j++) {
      const r = (p.dS[j] - na) / X;
      if (r < worst) worst = r;
    }
    if (worst < 0) {
      const eLim = m.eud / (-worst);
      if (eLim < epsEdge) { epsEdge = eLim; pivot = 'steel'; }
    }
  }

  let Fc = 0, Mcy = 0, Mcz = 0;
  for (let i = 0; i < m.nC; i++) {
    const eps = epsEdge * (p.dC[i] - na) / X;
    if (eps <= 0) continue;
    const F = sigC(eps, pr) * m.dAg;
    Fc += F; Mcy += F * m.cz[i]; Mcz += F * m.cy[i];
  }
  let Fs = 0, Msy = 0, Msz = 0;
  for (let j = 0; j < m.steelFibers.length; j++) {
    const sf = m.steelFibers[j];
    const eps = epsEdge * (p.dS[j] - na) / X;
    let sig = sigS(eps, m);
    if (m.deductSteel) sig -= sigC(eps, pr);
    const F = sig * sf.A;
    Fs += F; Msy += F * sf.z; Msz += F * sf.y;
  }
  return { N: (Fc + Fs) / 1e3, My: (Mcy + Msy) / 1e6, Mz: (Mcz + Msz) / 1e6,
           Fc: Fc / 1e3, Fs: Fs / 1e3, epsEdge: epsEdge, pivot: pivot };
}

function solveColumnX(theta, Ntarget, m) {
  const proj = projectColumn(theta, m);
  const maxSpan = Math.max(m.b, m.h) * 2;
  const F = function (X) { return columnForces(X, theta, m, proj).N - Ntarget; };
  let lo = 1, hi = maxSpan * 4;
  let flo = F(lo), fhi = F(hi), guard = 0;
  while (flo * fhi > 0 && guard++ < 200) {
    if (Math.abs(flo) < Math.abs(fhi)) { lo /= 2; if (lo < 1e-6) break; flo = F(lo); }
    else { hi *= 2; if (hi > maxSpan * 1e6) break; fhi = F(hi); }
  }
  if (flo * fhi > 0) {
    const X = (Math.abs(flo) < Math.abs(fhi)) ? lo : hi;
    const r = columnForces(X, theta, m, proj);
    return Object.assign({ X: X, theta: theta, converged: false }, r);
  }
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2, fm = F(mid);
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    if (Math.abs(fm) < 1e-7) break;
  }
  const X = (lo + hi) / 2;
  return Object.assign({ X: X, theta: theta, converged: true },
                       columnForces(X, theta, m, proj));
}

/** Conturul My-Mz la N constant, baleind inclinarea axei neutre pe 0..360. */
function traceColumnCurve(Ntarget, m) {
  const pts = [], n = m.NANG;
  for (let k = 0; k < n; k++) {
    const r = solveColumnX(k * 2 * Math.PI / n, Ntarget, m);
    if (r.converged) pts.push({ My: r.My, Mz: r.Mz });
  }
  return pts;
}

/**
 * Inclinarea axei neutre al carei punct capabil cade EXACT pe directia lui
 * M_Ed. Unghiul axei neutre NU este unghiul momentului: relatia trebuie
 * inversata numeric. Bisectia merge pe theta in [0, 2*pi) comparand diferenta
 * unghiulara cu semn, pentru ca atan2(Mz,My) scade monoton cu theta.
 */
function findColumnTheta(dirAngle, Ntarget, m) {
  const TWO_PI = 2 * Math.PI;
  let target = dirAngle;
  while (target <= -Math.PI) target += TWO_PI;
  while (target > Math.PI) target -= TWO_PI;
  let lo = 0, hi = TWO_PI, rFinal = null;
  for (let it = 0; it < 42; it++) {
    const mid = (lo + hi) / 2;
    const r = solveColumnX(mid, Ntarget, m);
    let diff = Math.atan2(r.Mz, r.My) - target;
    while (diff > Math.PI) diff -= TWO_PI;
    while (diff <= -Math.PI) diff += TWO_PI;
    if (diff > 0) lo = mid; else hi = mid;
    rFinal = r;
  }
  return solveColumnX((lo + hi) / 2, Ntarget, m);
}

/**
 * Moment capabil UNIAXIAL la N_Ed dat, pe una dintre axele principale.
 *
 *   axis = 'h' (implicit) — incovoiere pe ADANCIMEA h, adica axa neutra are
 *          normala pe z: theta = +-pi/2, momentul iese pe M_y.
 *   axis = 'b'            — incovoiere pe adancimea b: theta = 0 / pi, M_z.
 *
 * Se rezolva AMBELE sensuri si se retine cel mai mic: la sectiune armata
 * nesimetric pe directia respectiva, capacitatea nu este aceeasi in cele doua
 * sensuri, iar verificarea trebuie sa o foloseasca pe cea defavorabila.
 * Este forma de care are nevoie stratul de nod (M_Rd,inf / M_Rd,sup pe directia
 * in care se verifica nodul).
 */
function mrdUniaxial(m, Ned, axis) {
  const t1 = (axis === 'b') ? 0 : Math.PI / 2;
  const t2 = (axis === 'b') ? Math.PI : -Math.PI / 2;
  const a = solveColumnX(t1, Ned, m);
  const b = solveColumnX(t2, Ned, m);
  const pick = function (r) { return Math.abs((axis === 'b') ? r.Mz : r.My); };
  const Ma = pick(a), Mb = pick(b);
  const gov = (Ma <= Mb) ? a : b;
  return { MRd: Math.min(Ma, Mb), X: gov.X, theta: gov.theta,
           pivot: gov.pivot, epsEdge: gov.epsEdge,
           Nint: gov.N, residual: Ned - gov.N,
           converged: a.converged && b.converged,
           senses: { pos: Ma, neg: Mb } };
}

/**
 * Capacitati axiale limita, conventie BRUTA.
 * La compresiune centrica deformatia este limitata de pivotul C la eps_c2, deci
 * otelul NU ajunge la f_yd daca f_yd/Es > eps_c2: pentru S500, f_yd/Es =
 * 2,174 permil > 2 permil, deci sigma_s = Es*eps_c2 = 400 MPa. Valoarea
 * obtinuta astfel coincide cu apexul domeniului de interactiune din fib
 * structuralcodes si cu N_Rd din XD-CoSec.
 * NRdc_mat este limita pur materiala (otel la f_yd), pastrata pentru
 * diagnostic: este valoarea pe care o da fib prin calculate_limit_axial_load().
 */
function columnAxialLimits(m) {
  const pr = m.props();
  const Ac = m.deductSteel ? (m.Ac - m.As_tot) : m.Ac;
  const sigS_c = m.limitPivotC ? Math.min(m.fyd, m.Es * pr.ec2) : m.fyd;
  return { NRdc: (Ac * pr.fcd + m.As_tot * sigS_c) / 1e3,
           NRdc_mat: (Ac * pr.fcd + m.As_tot * m.fyd) / 1e3,
           sigS_c: sigS_c,
           NRdt: -(m.As_tot * m.fyd) / 1e3 };
}

/**
 * Verificare biaxiala la N_Ed dat.
 * Utilizarea este raportul distantelor pe raza M_Ed in planul (My, Mz).
 */
function solveColumn(m, Ned, MyEd, MzEd, lang) {
  if (!(m.Ac > 0)) return fail(CODES.DEGENERATE, lang);
  if (!(m.fcd > 0) || !(m.fyd > 0)) return fail(CODES.INVALID_INPUT, lang);
  if (m.barIssues && m.barIssues.length)
    return fail(CODES.BAR_COUNT, lang, null, barIssueDetail(m.barIssues, lang));
  const lim = columnAxialLimits(m);

  const warnings = [];
  if (m.eukAssumed && m.limitEpsUd) warnings.push({ code: 'EUK_ASSUMED', ref: m.steel });

  const dirAngle = Math.atan2(MzEd, MyEd);
  const res = findColumnTheta(dirAngle, Ned, m);
  const residual = Ned - res.N;
  const tol = Math.max(0.01, Math.abs(Ned) * 1e-5);

  const dEd = Math.hypot(MyEd, MzEd);
  const dRd = Math.hypot(res.My, res.Mz);
  const value = {
    MyRd: res.My, MzRd: res.Mz, X: res.X, theta: res.theta,
    thetaDeg: res.theta * 180 / Math.PI, Nint: res.N, residual: residual,
    Fc: res.Fc, Fs: res.Fs, epsEdge: res.epsEdge, pivot: res.pivot,
    NRdc: lim.NRdc, NRdt: lim.NRdt,
    util: dRd > 1e-9 ? (dEd / dRd * 100) : 0,
    dirAngle: dirAngle,
  };
  if (!res.converged) {
    const over = Ned > lim.NRdc ? { limit: 'N_Rd,c', value: lim.NRdc }
                                : { limit: 'N_Rd,t', value: lim.NRdt };
    return fail(CODES.NO_BRACKET, lang, Object.assign({}, value, { exceeded: over }),
      '(' + over.limit + ' = ' + over.value.toFixed(0) + ' kN)');
  }
  if (Math.abs(residual) > tol) {
    return fail(CODES.RESIDUAL_HIGH, lang, value, '(rezidual ' + residual.toFixed(2) + ' kN)');
  }
  return ok(value, warnings.length ? { warnings: warnings } : null);
}

/* ═══════════════════════════════════════════════════════════════════════════
   STALP — EFECTE DE ORDINUL 2, SR EN 1992-1-1 §5.8 (metoda curburii nominale)
   ───────────────────────────────────────────────────────────────────────────
   Pe O directie. `dir` = 'y' pentru M_y (bratul pe inaltimea h) sau 'z' pentru
   M_z (bratul pe latimea b). Unitati: N [kN, compresiune pozitiva], momente
   [kNm, eforturi interne, cu semn], lungimi [mm].

   M01, M02 — momentele de ordinul 1 de la capete, cu |M02| >= |M01|; au acelasi
   semn cand intind aceeasi fata (curbura simpla) — exact conventia eforturilor
   interne din ETABS, deci valorile de la cele doua statii se pot folosi direct.

     l0 = beta*l;  i = dim/sqrt(12);  lambda = l0/i                     5.8.3.2
     n = N_Ed/(A_c f_cd);  omega = A_s f_yd/(A_c f_cd)
     lambda_lim = 20*A*B*C/sqrt(n)                                      (5.13N)
       A = 1/(1+0,2 phi_ef),  B = sqrt(1+2 omega),  C = 1,7 - r_m
       r_m = M01/M02 la stalp contravantuit; r_m = 1 (C = 0,7) la stalp
       necontravantuit si cand momentele de capat sunt nule
     e_i = l0/400                                              5.2(7), 5.2(9)
     M0e = max(0,6 M02 + 0,4 M01 ; 0,4 M02)  (contravantuit)            (5.32)
     M0e = M02                                (necontravantuit)
     1/r = K_r K_phi eps_yd/(0,45 d)                                    (5.34)
       K_r = (n_u - n)/(n_u - n_bal) <= 1, n_u = 1 + omega, n_bal = 0,4  (5.36)
       K_phi = 1 + beta_phi*phi_ef >= 1,
       beta_phi = 0,35 + f_ck/200 - lambda/150                          (5.37)
     e2 = (1/r) l0^2/c, c = 10                                          (5.33)
     M_Ed = M0e + N e_i + N e2 ; la contravantuit si >= M02, >= M01 + 0,5 M2
                                                                   5.8.8.2(3)
     M_Ed >= N e0, e0 = max(dim/30 ; 20 mm)                              6.1(4)
   d = inaltimea utila pe directia respectiva: centrul barelor de colt.
   Constantele A, B, C (cand nu se calculeaza) si c = 10 sunt valorile
   recomandate; imperfectiunea si e0 se aplica numai daca withImperf = true
   (la flexiune oblica imperfectiunea se ia pe O SINGURA directie, cea mai
   defavorabila — 5.8.9(2) — iar modulul incearca ambele variante).
   ═══════════════════════════════════════════════════════════════════════════ */
function secondOrderEC2(m, p) {
  const dir = (p.dir === 'z') ? 'z' : 'y';
  const dim = (dir === 'y') ? m.h : m.b;
  const half = (dir === 'y') ? m.halfZ : m.halfY;         // centrul barelor de colt
  const N = +p.N || 0;
  const M01in = +p.M01 || 0, M02in = +p.M02 || 0;
  const l0 = Math.max(0, +p.l0 || 0);
  const phiEf = Math.max(0, +p.phiEf || 0);
  const braced = !!p.braced;
  const withImp = (p.withImperf !== false);
  const o = { dir: dir, N: N, M01: M01in, M02: M02in, l0: l0, phiEf: phiEf, braced: braced,
              withImperf: withImp, dim: dim };

  const s = (M02in >= 0) ? 1 : -1;
  const m02 = Math.abs(M02in), m01 = M01in * s;           // M01 relativ la semnul lui M02
  o.i = dim / Math.sqrt(12);
  o.lambda = o.i > 0 ? l0 / o.i : 0;
  const fcd = m.fcd, Ac = m.Ac;
  o.n = (Ac > 0 && fcd > 0) ? N * 1e3 / (Ac * fcd) : 0;
  o.omega = (Ac > 0 && fcd > 0) ? m.As_tot * m.fyd / (Ac * fcd) : 0;
  o.A = 1 / (1 + 0.2 * phiEf);
  o.B = Math.sqrt(1 + 2 * o.omega);
  o.rm = (!braced || m02 < 1e-9) ? 1 : Math.max(-1, Math.min(1, m01 / m02));
  o.C = 1.7 - o.rm;
  o.lambdaLim = (o.n > 0) ? 20 * o.A * o.B * o.C / Math.sqrt(o.n) : Infinity;
  o.slender = (o.n > 0) && (o.lambda > o.lambdaLim);

  if (!(N > 0)) {                                        // intindere: fara ordinul 2
    o.ei = 0; o.e0 = 0; o.M0e = m02; o.M0Ed = m02; o.M2 = 0; o.e2 = 0;
    o.MEd = M02in; o.governs = 'first';
    return o;
  }
  o.ei = withImp ? l0 / 400 : 0;
  o.e0 = withImp ? Math.max(dim / 30, 20) : 0;
  o.M0e = braced ? Math.max(0.6 * m02 + 0.4 * m01, 0.4 * m02) : m02;
  o.M0Ed = o.M0e + N * o.ei / 1e3;

  o.M2 = 0; o.e2 = 0;
  if (o.slender) {
    o.d = dim / 2 + half;
    o.epsYd = m.fyd / m.Es;
    o.nu = 1 + o.omega; o.nBal = 0.4;
    o.Kr = Math.max(0, Math.min(1, (o.nu - o.n) / (o.nu - o.nBal)));
    o.betaPhi = 0.35 + m.fck / 200 - o.lambda / 150;
    o.Kphi = Math.max(1, 1 + o.betaPhi * phiEf);
    o.curv = o.d > 0 ? o.Kr * o.Kphi * o.epsYd / (0.45 * o.d) : 0;   // 1/mm
    o.c = 10;
    o.e2 = o.curv * l0 * l0 / o.c;
    o.M2 = N * o.e2 / 1e3;
  }
  // momentul de calcul, 5.8.8.2 — la stalp contravantuit se compara cu capetele
  const cand = [{ v: o.M0Ed + o.M2, k: 'mid' }];
  if (braced) {
    cand.push({ v: m02, k: 'end2' });
    cand.push({ v: Math.abs(M01in) + 0.5 * o.M2, k: 'end1' });
  }
  cand.push({ v: N * o.e0 / 1e3, k: 'e0' });              // 6.1(4)
  let best = cand[0];
  cand.forEach(function (c) { if (c.v > best.v) best = c; });
  o.MEdAbs = best.v; o.governs = best.k;
  o.MEd = s * best.v;
  return o;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FORTA TAIETOARE — PERETI (modulul 04)
   CR 2-1-1.1/2022 si SR EN 1992-1-1. Calcul pe formule, fara metoda fibrelor:
   nu foloseste nucleul de integrare, doar materialele si contractul de stare.

   Semnul lui N: ca in tot nucleul, COMPRESIUNEA ESTE POZITIVA. Intinderea
   (N < 0) este acceptata si reduce fizic capacitatile — sigma_cp devine negativ,
   deci contributia betonului in zona B scade, iar V_Rd,i scade prin termenul
   mu_f*(...+N). Capacitatile care ies negative sunt aduse la zero si semnalate:
   o capacitate negativa nu este un rezultat, este un avertisment.
   ═══════════════════════════════════════════════════════════════════════════ */

function buildShearModel(inp) {
  const o = Object.assign({}, DEFAULTS, inp.opts || {});
  const fck = CONC[inp.concrete] ? CONC[inp.concrete].fck : 0;
  const st = STEEL[inp.steel] || { fyk: 0, euk: 0.05 };
  const m = {
    wallType: inp.wallType === 'Bulb' ? 'Bulb' : 'Bulb+inima',
    lw: +inp.lw || 0, bw0: +inp.bw0 || 0, bf: +inp.bf || 0, cnom: +inp.cnom || 0,
    fck: fck, fcd: fck / o.GAMMA_C,
    fyk: st.fyk, fyd: st.fyk / o.GAMMA_S,
    eukAssumed: !!st.eukAssumed,
    muf: +inp.muf || 0.7,
    // armare orizontala inima
    oh: +inp.oh || 0, sh: +inp.sh || 0, nr: +inp.nr || 0,
    // etrieri zona de capat (tip Bulb)
    ss: +inp.ss || 0, oswp: +inp.oswp || 0, nswp: +inp.nswp || 0,
    oswi: +inp.oswi || 0, loswi: +inp.loswi || 0, nei: +inp.nei || 0, nswi: +inp.nswi || 0,
    // armare verticala inima (lunecare)
    ol: +inp.ol || 0, sl: +inp.sl || 0, nrl: +inp.nrl || 0,
    // bare bulbi
    obb1: +inp.obb1 || 0, nbb1: +inp.nbb1 || 0,
    obb2: +inp.obb2 || 0, nbb2: +inp.nbb2 || 0,
    // armaturi inclinate care traverseaza planul de lunecare — CR 2 rel. (5.7),
    // termenul sum(A_si)*f_yd,i*(cos a + mu_f*sin a). Implicit zero.
    osi: +inp.osi || 0, nsi: +inp.nsi || 0, alphaSi: +inp.alphaSi || 45,
    concrete: inp.concrete, steel: inp.steel,
  };
  m.Acw = m.lw * m.bw0;
  // Lungimea inimii intre bulbi, scazand acoperirile. La tipul "Bulb" nu exista
  // inima, deci este nula prin definitie.
  m.lweb = (m.wallType === 'Bulb') ? 0 : Math.max(m.lw - 2 * m.bf - 4 * m.cnom, 0);
  // Ramura dreapta a etrierului perimetral, de-a lungul lui l_w.
  m.loswp = Math.max(m.lw - 2 * m.cnom - 2 * m.oswp, 0);
  return m;
}

/**
 * Aria de armatura orizontala taiata de fisura la 45 grade.
 * Bulb+inima: numai armatura orizontala a inimii (etrierii nu se adauga).
 * Bulb:       etrierii taiati de fisura (perimetral + intermediari).
 */
function shearAsh(m) {
  if (m.wallType === 'Bulb+inima') {
    const barsCut = m.sh > 0 ? (m.nr * m.lw / m.sh) : 0;
    const AshWeb = barsCut * barArea(m.oh);
    return { Ash: AshWeb, detail: { mode: 'web', barsCut: barsCut, AshWeb: AshWeb } };
  }
  const cutP = m.ss > 0 ? (m.nswp * m.loswp / m.ss) : 0;
  const cutI = m.ss > 0 ? (m.nei * m.nswi * m.loswi / m.ss) : 0;
  const AshP = cutP * barArea(m.oswp);
  const AshI = cutI * barArea(m.oswi);
  return { Ash: AshP + AshI,
           detail: { mode: 'stir', loswp: m.loswp, cutP: cutP, AshP: AshP,
                     loswi: m.loswi, cutI: cutI, AshI: AshI } };
}

/**
 * Rezolvare capacitati la forta taietoare.
 * @param {object} m   modelul de la buildShearModel
 * @param {number} Ved kN
 * @param {number} Ned kN, COMPRESIUNE POZITIVA
 */
function solveShear(m, Ved, Ned, lang) {
  if (!(m.Acw > 0)) return fail(CODES.DEGENERATE, lang);
  if (!(m.fcd > 0) || !(m.fyd > 0)) return fail(CODES.INVALID_INPUT, lang);

  const sq = Math.sqrt(m.fcd);
  const scp = m.Acw > 0 ? (Ned * 1e3) / m.Acw : 0;    // MPa, + = compresiune

  const VRdmaxA = (0.67 * m.Acw * sq) / 1e3;          // zona critica
  const VRdmaxB = (0.80 * m.Acw * sq) / 1e3;          // zona non-critica

  const a = shearAsh(m);
  const VRdsA = (a.Ash * m.fyd) / 1e3;
  const vsB1 = (0.5 * scp * m.Acw) / 1e3;             // contributia betonului
  const vsB2 = (a.Ash * m.fyd) / 1e3;                 // contributia armaturii
  const VRdsB = vsB1 + vsB2;

  /* ── Lunecare in rostul de turnare — CR 2-1-1.1/2022 rel. (5.7) ───────────
     V_Rd,s = mu_f * ( sum(A_sv * f_yd,v) + N_Ed )
              + sum(A_si * f_yd,i) * (cos a + mu_f * sin a)
     N_Ed intra CU SEMNUL LUI: "in cazul in care forta axiala este de intindere
     se utilizeaza semnul «−»" (CR 2, nota la rel. 5.7). Deci intinderea reduce
     rezultatul, nu este ignorata. Conventia interna a nucleului (compresiune
     pozitiva) coincide deja cu asta.
     ──────────────────────────────────────────────────────────────────────── */
  const AsvWeb = m.sl > 0 ? m.nrl * ((m.lweb / m.sl) * barArea(m.ol)) : 0;
  const asvb1 = m.nbb1 * barArea(m.obb1);
  const asvb2 = m.nbb2 * barArea(m.obb2);
  const Asi = m.nsi * barArea(m.osi);
  const aRad = m.alphaSi * Math.PI / 180;
  const VRdIncl = (Asi * m.fyd * (Math.cos(aRad) + m.muf * Math.sin(aRad))) / 1e3;
  const VRdiWeb  = (m.muf * (AsvWeb * m.fyd + Ned * 1e3)) / 1e3 + VRdIncl;
  const VRdiBulb = (m.muf * ((AsvWeb + asvb1) * m.fyd + Ned * 1e3)) / 1e3 + VRdIncl;

  const warnings = [];
  if (m.eukAssumed) warnings.push({ code: 'EUK_ASSUMED', ref: m.steel });
  if (scp < 0)      warnings.push({ code: 'TENSION', ref: scp });
  // O capacitate negativa nu se raporteaza ca numar: se aduce la zero si se
  // semnaleaza, altfel ar aparea ca o "rezistenta" negativa in raport.
  const clamp = function (v, name) {
    if (v < 0) { warnings.push({ code: 'NEG_CAPACITY', ref: name }); return 0; }
    return v;
  };
  const cVRdsB = clamp(VRdsB, 'V_Rd,s (B)');
  const cVRdiWeb = clamp(VRdiWeb, 'V_Rd,i (inima)');
  const cVRdiBulb = clamp(VRdiBulb, 'V_Rd,i');

  const govA = Math.min(VRdmaxA, VRdsA, cVRdiBulb);
  const govB = Math.min(VRdmaxB, cVRdsB, cVRdiBulb);

  const util = function (V) { return V > 0 ? Math.abs(Ved) / V * 100 : Infinity; };

  return ok({
    sq: sq, scp: scp, Acw: m.Acw, lweb: m.lweb,
    VRdmaxA: VRdmaxA, VRdmaxB: VRdmaxB,
    Ash: a.Ash, vsDetail: a.detail,
    VRdsA: VRdsA, vsB1: vsB1, vsB2: vsB2, VRdsB: cVRdsB,
    AsvWeb: AsvWeb, asvb1: asvb1, asvb2: asvb2,
    Asi: Asi, VRdIncl: VRdIncl, alphaSi: m.alphaSi,
    VRdiWeb: cVRdiWeb, VRdiBulb: cVRdiBulb,
    govA: govA, govB: govB,
    utilVmaxA: util(VRdmaxA), utilVmaxB: util(VRdmaxB),
    utilVsA: util(VRdsA), utilVsB: util(cVRdsB), utilVi: util(cVRdiBulb),
    okA: Math.abs(Ved) <= govA, okB: Math.abs(Ved) <= govB,
  }, warnings.length ? { warnings: warnings } : null);
}

/* ═══════════════════════════════════════════════════════════════════════════
   NOD DE CADRU GRINDA-STALP (modulele 08 / 09)
   P 100-1/2013 §5.2.3.3.3, §5.3.3.4, §5.3.4.2.3, §5.4.4.3.

   Strat pe formule, ca si cel de forta taietoare: singura parte care foloseste
   nucleul de integrare este M_Rd al stalpilor, prin JP.column.mrdUniaxial().
   Momentele capabile ale grinzilor se calculeaza cu blocul dreptunghiular
   echivalent (sectiune simplu armata), nu cu metoda fibrelor — asa cum era si
   in modulul 08 inainte de migrare, deci rezultatele grinzilor NU se schimba.

   DIRECTIE. Verificarea se face pe o singura directie. h_c este latura
   stalpului PARALELA cu axa grinzilor, adica adancimea nodului pe directia lui
   V_jhd; b_c este latura perpendiculara. Aceeasi directie fixeaza si M_Rd al
   stalpilor: incovoierea are loc pe adancimea h_c, deci mrdUniaxial(..., 'h').
   Capacitatea stalpului si nodul se refera astfel intotdeauna la aceeasi axa.

   SEMNUL LUI N. Ca peste tot in nucleu, COMPRESIUNEA ESTE POZITIVA. Conversia
   se face la granita cu interfata, nu aici.

   SENSURI. Actiunea seismica se ia in ambele sensuri si se retine infasuratoarea:
   sensul 1 = grinda din stanga intinsa sus, sensul 2 = intinsa jos. La nodurile
   de capat exista o singura grinda, deci sensurile sunt "intindere sus" si
   "intindere jos". Fiecare verificare pastreaza sensul care o guverneaza, si
   nu neaparat acelasi sens pentru toate.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Materialele nodului: beton, otel longitudinal, otel transversal. */
function jointMaterials(concrete, steel, steelW, o) {
  const fck = CONC[concrete] ? CONC[concrete].fck : 0;
  const st  = STEEL[steel]  || { fyk: 0, euk: 0.05 };
  const stw = STEEL[steelW] || { fyk: 0, euk: 0.05 };
  const le = lamEta(fck);
  return {
    fck: fck, fcd: fck / o.GAMMA_C,
    fyk: st.fyk,  fyd: st.fyk / o.GAMMA_S,
    fywk: stw.fyk, fywd: stw.fyk / o.GAMMA_S,
    lam: le.lam, eta: le.eta, Es: o.Es,
    concrete: concrete, steel: steel, steelW: steelW,
    eukAssumed: !!st.eukAssumed || !!stw.eukAssumed,
  };
}

/**
 * Moment capabil al unei sectiuni dreptunghiulare simplu armate, cu blocul
 * dreptunghiular echivalent:
 *     x = A_s f_yd / (lambda * eta * f_cd * b_w),  z = d - lambda*x/2,
 *     M_Rb = A_s f_yd z.
 * Armatura comprimata si armatura din placa in latimea activa NU se iau in
 * considerare — ipoteza acoperitoare pentru M_Rb al grinzii.
 */
function beamRectCap(b, n, dia, mat) {
  const As = n * barArea(dia);
  const d = b.hb - (b.cnom + b.dsw + dia / 2);
  const x = (b.bw > 0 && mat.fcd > 0) ? As * mat.fyd / (mat.lam * mat.eta * mat.fcd * b.bw) : 0;
  const z = d - mat.lam * x / 2;
  return { As: As, d: d, x: x, z: z, M: As * mat.fyd * z / 1e6, n: n, dia: dia };
}

function buildBeam(inp, mat) {
  const b = {
    bw: +inp.bw || 0, hb: +inp.hb || 0,
    cnom: +inp.cnom || 0, dsw: +inp.dsw || 0,
    nt: Math.max(0, Math.round(+inp.nt || 0)), dt: +inp.dt || 0,
    nb: Math.max(0, Math.round(+inp.nb || 0)), db: +inp.db || 0,
  };
  b.top = beamRectCap(b, b.nt, b.dt, mat);
  b.bot = beamRectCap(b, b.nb, b.db, mat);
  // Inaltimea utila a nodului: distanta dintre axele armaturilor grinzii.
  b.hjw = b.hb - 2 * b.cnom - 2 * b.dsw - b.dt / 2 - b.db / 2;
  return b;
}

/**
 * Stalpul de sub / de peste nod. Sectiunea se construieste cu modelul de stalp
 * al nucleului (b = b_c, h = h_c), deci beneficiaza de aceleasi conventii ca
 * modulele 06 / 07: arie de beton bruta, acoperire mecanica c_nom + Ø_etr + Ø/2,
 * pivotii A si C.
 *
 * Maparea barelor:
 *   fb — bare pe fetele de lungime b_c (fetele z = ±h_c/2) -> 'topb' in nucleu;
 *   fh — bare pe fetele de lungime h_c (fetele y = ±b_c/2) -> 'sidh' in nucleu.
 *
 * A_sv pentru (5.31) este suma barelor distribuite pe ADANCIMEA nodului: barele
 * de colt plus cele de pe fetele de lungime h_c. Se extrage dupa eticheta de
 * grup, nu dupa ordinea fibrelor.
 */
function buildJointColumn(inp, geom, mat, o) {
  const model = buildColumnModel({
    b: geom.bc, h: geom.hc, cnom: geom.cnom, detr: geom.dsw,
    concrete: mat.concrete, steel: mat.steel, confMode: 'none',
    cor_n: inp.cor_n, cor_d: inp.cor_d,
    topb_n: inp.fb_n, topb_d: inp.fb_d,
    sidh_n: inp.fh_n, sidh_d: inp.fh_d,
    opts: o,
  });
  const As_dir = model.steelFibers
    .filter(function (f) { return f.grp === 'cor' || f.grp === 'sidh'; })
    .reduce(function (s, f) { return s + f.A; }, 0);
  const N = +inp.N || 0;                       // compresiune pozitiva
  const r = (geom.bc > 0 && geom.hc > 0) ? mrdUniaxial(model, N, 'h')
                                         : { MRd: 0, X: 0, converged: false, pivot: 'none' };
  const ovr = +inp.MRdOverride || 0;
  return {
    model: model, As_dir: As_dir, N: N,
    MRdCalc: r.MRd, X: r.X, pivot: r.pivot, converged: r.converged,
    residual: r.residual, senses: r.senses,
    ovr: ovr, MRd: (ovr > 0 ? ovr : r.MRd),
  };
}

function buildJointModel(inp) {
  const o = Object.assign({}, DEFAULTS, inp.opts || {});
  const mat = jointMaterials(inp.concrete, inp.steel, inp.steelW, o);
  const end = (inp.jointType === 'end');
  const geom = {
    bc: +inp.bc || 0, hc: +inp.hc || 0,
    cnom: +inp.cnom || 0, dsw: +inp.dsw || 0, lcl: +inp.lcl || 0,
  };
  const beamL = buildBeam(inp.beamL || {}, mat);
  const beamR = end ? null : buildBeam(inp.beamR || {}, mat);
  const colI = buildJointColumn(inp.colI || {}, geom, mat, o);
  const colS = buildJointColumn(inp.colS || {}, geom, mat, o);

  // ── geometria nodului
  const bwMin = end ? beamL.bw : Math.min(beamL.bw, beamR.bw);
  const bj = Math.min(geom.bc, bwMin + 0.5 * geom.hc);          // (5.28)
  const corD = +(inp.colI && inp.colI.cor_d) || 0;
  const hjc = geom.hc - 2 * geom.cnom - 2 * geom.dsw - corD;    // intre axele barelor de colt
  const hjw = end ? beamL.hjw : Math.min(beamL.hjw, beamR.hjw);

  // ── armatura transversala din nod
  const j = inp.joint || {};
  const n1 = Math.max(0, Math.round(+j.n1 || 0)), d1 = +j.d1 || 0;
  const n2 = Math.max(0, Math.round(+j.n2 || 0)), d2 = +j.d2 || 0;
  const nSets = Math.max(1, Math.round(+j.nSets || 1)), s = +j.s || 0;
  const AshSet = n1 * barArea(d1) + n2 * barArea(d2);
  const AshProv = AshSet * nSets;
  // Pasul maxim la care cele nSets seturi mai incap pe inaltimea utila a nodului.
  const sMax = (nSets > 1) ? Math.floor(hjw / (nSets - 1)) : Math.floor(hjw);
  const nCol = Math.max(0, Math.round(+j.nCol || 0)), dCol = +j.dCol || 0, sCol = +j.sCol || 0;
  const AswCol = nCol * barArea(dCol);

  return {
    mat: mat, end: end, duct: (inp.duct === 'DCH' ? 'DCH' : 'DCM'),
    level: (inp.level === 'base' ? 'base' : 'cur'),
    topLevel: !!inp.topLevel, fourBeams: !!inp.fourBeams,
    bc: geom.bc, hc: geom.hc, cnom: geom.cnom, dsw: geom.dsw, lcl: geom.lcl,
    beamL: beamL, beamR: beamR, colI: colI, colS: colS,
    bwMin: bwMin, bj: bj, hjc: hjc, hjw: hjw,
    n1: n1, d1: d1, n2: n2, d2: d2, nSets: nSets, s: s,
    AshSet: AshSet, AshProv: AshProv, sMax: sMax,
    nCol: nCol, dCol: dCol, sCol: sCol, AswCol: AswCol,
  };
}

/**
 * Verificarea completa a nodului. Intoarce contractul de stare obisnuit; in
 * value stau TOATE marimile intermediare, ca modulul sa poata construi tabelele
 * de derivare fara sa recalculeze nimic.
 */
function solveJoint(m, lang) {
  if (!(m.bc > 0) || !(m.hc > 0)) return fail(CODES.DEGENERATE, lang);
  if (!(m.mat.fcd > 0) || !(m.mat.fyd > 0) || !(m.mat.fywd > 0))
    return fail(CODES.INVALID_INPUT, lang);
  // Barele stalpilor trec prin acelasi model ca la modulele 06 / 07, deci prin
  // aceeasi validare: un numar de bare de colt care nu se poate dispune ar
  // schimba tacit M_Rd al stalpului, deci si Sum M_Rc si verificarea (5.4).
  const colIssues = (m.colI.model.barIssues || []).concat(m.colS.model.barIssues || []);
  if (colIssues.length)
    return fail(CODES.BAR_COUNT, lang, null, barIssueDetail(colIssues, lang));

  const mat = m.mat, end = m.end, DCH = (m.duct === 'DCH');

  /* ── factori de suprarezistenta ──────────────────────────────────────────
     (5.4)        1,3 DCH / 1,2 DCM
     (5.9)        grinzi:  1,2 DCH / 1,0 DCM
     (5.10)       stalpi:  1,3 la baza si 1,2 la restul nivelurilor (DCH), 1,0 DCM
     (5.11)/(5.12) nod:    1,1 DCH / 1,0 DCM                                   */
  const g54 = DCH ? 1.3 : 1.2;
  const gb  = DCH ? 1.2 : 1.0;
  const gc  = DCH ? (m.level === 'base' ? 1.3 : 1.2) : 1.0;
  const gj  = DCH ? 1.1 : 1.0;

  const SMRc = m.colI.MRd + m.colS.MRd;

  /* ── cele doua sensuri ale actiunii seismice ──────────────────────────── */
  function mkSense(name) {
    let SMRb, As1, As2, Acomp, parts;
    if (end) {
      if (name === 'A') { SMRb = m.beamL.top.M; As1 = m.beamL.top.As; As2 = 0;
                          Acomp = m.beamL.bot.As; parts = [['M_Rb,L,sup', m.beamL.top.M]]; }
      else              { SMRb = m.beamL.bot.M; As1 = m.beamL.bot.As; As2 = 0;
                          Acomp = m.beamL.top.As; parts = [['M_Rb,L,inf', m.beamL.bot.M]]; }
    } else {
      if (name === 'A') { SMRb = m.beamL.top.M + m.beamR.bot.M;
                          As1 = m.beamL.top.As; As2 = m.beamR.bot.As; Acomp = 0;
                          parts = [['M_Rb,L,sup', m.beamL.top.M], ['M_Rb,R,inf', m.beamR.bot.M]]; }
      else              { SMRb = m.beamL.bot.M + m.beamR.top.M;
                          As1 = m.beamR.top.As; As2 = m.beamL.bot.As; Acomp = 0;
                          parts = [['M_Rb,L,inf', m.beamL.bot.M], ['M_Rb,R,sup', m.beamR.top.M]]; }
    }
    const rat54 = SMRc > 0 ? g54 * SMRb / SMRc : Infinity;
    const kRcRb = SMRb > 0 ? Math.min(1, SMRc / SMRb) : 1;
    const kRbRc = SMRc > 0 ? Math.min(1, SMRb / SMRc) : 1;
    const MdcI = gc * m.colI.MRd * kRbRc, MdcS = gc * m.colS.MRd * kRbRc;
    /* ── V_c, P 100-1/2013 5.3.3.4(2) ────────────────────────────────────
       "V_c forta taietoare din STALPUL DE DEASUPRA NODULUI corespunzatoare
       situatiei considerate (vezi 5.3.3.3(2) si (3))", iar 5.3.3.3(2) o
       defineste "din echilibrul stalpului la fiecare nivel sub momentele de
       la extremitati". Deci ambele momente apartin stalpului de deasupra:
       cel de la baza lui (acest nod) si cel de la capatul lui superior
       (nodul urmator). Modulul cunoaste un singur nod, deci momentul de la
       capatul superior se ia egal cu cel de la baza — stalpul este prismatic
       si armat la fel pe inaltimea nivelului:
           V_c = 2 * M_dc,sup / l_cl
       ATENTIE — pana la engine 2.3.0 se folosea (M_dc,inf + M_dc,sup)/l_cl,
       care amesteca stalpul inferior cu inaltimea celui superior si nu este
       forta taietoare a niciunui element. Cum V_c SCADE V_jhd, o supraestimare
       este neacoperitoare, iar stalpul inferior are de obicei M_Rd mai mare
       (forta axiala mai mare), deci vechea formula supraestima V_c.
       Pe o linie de stalpi uniforma cele doua formule coincid.
       Folosirea lui k de la NODUL CURENT (kRbRc <= 1) pentru capatul superior
       este de partea sigura: daca nodul de deasupra ar avea k mai mare, V_c ar
       creste, iar V_jhd ar scadea.                                        */
    const Vc = m.lcl > 0 ? (2 * MdcS) * 1e6 / m.lcl / 1e3 : 0;
    const Astens = end ? As1 : (As1 + As2);
    const Vjhd = gj * Astens * mat.fyd / 1e3 - Vc;                  // (5.11)/(5.12)
    // (5.29)/(5.30): nu_d corespunde fortei axiale a STALPULUI INFERIOR.
    const nud = (m.bc * m.hc * mat.fcd) > 0
      ? Math.max(0, m.colI.N) * 1e3 / (m.bc * m.hc * mat.fcd) : 0;
    const Abase = end ? Acomp : (As1 + As2);
    const AshReq0 = mat.fywd > 0 ? 0.8 * Abase * mat.fyd * (1 - 0.8 * nud) / mat.fywd : 0;
    const AshReq = end ? AshReq0 * 1.2 : AshReq0;                   // +20% la noduri de capat
    return { name: name, SMRb: SMRb, parts: parts, As1: As1, As2: As2, Acomp: Acomp,
             Astens: Astens, rat54: rat54, kRcRb: kRcRb, kRbRc: kRbRc,
             MdbParts: parts.map(function (p) { return [p[0], gb * p[1] * kRcRb]; }),
             MdcI: MdcI, MdcS: MdcS, Vc: Vc, Vjhd: Vjhd,
             nud: nud, Abase: Abase, AshReq: AshReq };
  }
  const sA = mkSense('A'), sB = mkSense('B');
  const senses = [sA, sB];
  const pickMax = function (key) {
    return senses.reduce(function (a, b) { return b[key] > a[key] ? b : a; });
  };
  const govVj = pickMax('Vjhd'), govAsh = pickMax('AshReq'), gov54 = pickMax('rat54');

  /* ── compresiune diagonala (5.26)/(5.27) ─────────────────────────────── */
  const kDiag = end ? 0.25 : 0.30;
  const VRdj = kDiag * m.bj * m.hc * mat.fcd / 1e3;

  /* ── armatura verticala (5.31) ───────────────────────────────────────── */
  const AsvReq = m.hjw > 0 ? (2 / 3) * m.AshProv * (m.hjc / m.hjw) : 0;
  const AsvProv = Math.min(m.colI.As_dir, m.colS.As_dir);

  /* ── alcatuire: 5.3.4.2.3(4)(6) si 5.4.4.3(2) ────────────────────────── */
  const ratJoint = m.s > 0 ? m.AshSet / m.s : 0;
  const ratCol = m.sCol > 0 ? m.AswCol / m.sCol : 0;
  const sLimit = m.fourBeams ? Math.min(2 * m.sCol, 150) : m.sCol;

  /* ── verdicte ─────────────────────────────────────────────────────────── */
  const u54  = gov54.rat54;
  const uDiag = VRdj > 0 ? govVj.Vjhd / VRdj : Infinity;
  const uAsh = m.AshProv > 0 ? govAsh.AshReq / m.AshProv : Infinity;
  const uAsv = AsvProv > 0 ? AsvReq / AsvProv : Infinity;
  const okQty = ratJoint >= ratCol - 1e-9;
  const okSp  = m.s <= sLimit + 1e-9;
  const fits  = (m.nSets - 1) * m.s <= m.hjw + 1e-9;
  // Utilizarea alcatuirii este cea mai mare dintre cele trei conditii: cantitatea
  // fata de zona critica a stalpului, pasul fata de cel admis, si incadrarea celor
  // n seturi pe inaltimea utila a nodului. Fara al treilea termen un nod la care
  // etrierii nu incap ar afisa 100 % si ar pica fara sa se vada de ce.
  const uFit  = m.hjw > 0 ? (m.nSets - 1) * m.s / m.hjw : Infinity;
  const uDet  = ratJoint > 0 ? Math.max(ratCol / ratJoint, m.s / (sLimit || 1), uFit) : Infinity;

  /* Alcatuirea NU este o utilizare: sunt trei conditii de detaliere care se
     indeplinesc sau nu. Exprimata ca procent, ea citea 100 % ori de cate ori
     pasul din nod era egal cu cel din zona critica a stalpului — cazul uzual —
     si parea o sectiune la limita desi nimic nu era solicitat. De aceea
     verificarea poarta pct:false: modulele afiseaza doar verdictul, iar
     "worst" (cea mai solicitata verificare) o sare.
     uDet ramane in value pentru diagnostic. */
  const checks = [
    { id: 'c54',  clause: '(5.4)',                 util: u54,   ok: u54 <= 1 + 1e-7,  na: m.topLevel },
    { id: 'diag', clause: end ? '(5.27)' : '(5.26)', util: uDiag, ok: uDiag <= 1 + 1e-7, na: false },
    { id: 'ash',  clause: end ? '(5.30)' : '(5.29)', util: uAsh,  ok: uAsh <= 1 + 1e-7,  na: false },
    { id: 'asv',  clause: '(5.31)',                util: uAsv,  ok: uAsv <= 1 + 1e-7,  na: false },
    { id: 'det',  clause: '5.3.4.2.3(4)(6) · 5.4.4.3', util: uDet, ok: okQty && okSp && fits,
      na: false, pct: false },
  ];
  const active = checks.filter(function (c) { return !c.na; });
  const nOk = active.filter(function (c) { return c.ok; }).length;
  const worst = active.reduce(function (a, c) {
    return (c.pct !== false && isFinite(c.util)) ? Math.max(a, c.util) : a;
  }, 0);

  const warnings = [];
  if (mat.eukAssumed) warnings.push({ code: 'EUK_ASSUMED', ref: mat.steel });
  if (!m.colI.converged) warnings.push({ code: 'COL_NO_BRACKET', ref: 'inf' });
  if (!m.colS.converged) warnings.push({ code: 'COL_NO_BRACKET', ref: 'sup' });
  if (!fits) warnings.push({ code: 'SETS_DONT_FIT', ref: m.sMax });

  return ok({
    g54: g54, gb: gb, gc: gc, gj: gj,
    SMRc: SMRc, senses: senses, sA: sA, sB: sB,
    govVj: govVj, govAsh: govAsh, gov54: gov54,
    kDiag: kDiag, VRdj: VRdj,
    AsvReq: AsvReq, AsvProv: AsvProv,
    ratJoint: ratJoint, ratCol: ratCol, sLimit: sLimit, fits: fits,
    u54: u54, uDiag: uDiag, uAsh: uAsh, uAsv: uAsv, uDet: uDet, uFit: uFit,
    okQty: okQty, okSp: okSp,
    checks: checks, nChecks: active.length, nOk: nOk, nNo: active.length - nOk,
    worst: worst, allOk: nOk === active.length,
  }, warnings.length ? { warnings: warnings } : null);
}

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════════════════════════════ */
global.JP = {
  VERSION: VERSION,
  DEFAULTS: DEFAULTS,
  CODES: CODES,
  CONC: CONC,
  STEEL: STEEL,
  barArea: barArea,
  lamEta: lamEta,
  barMessage: barMessage,
  ok: ok,
  fail: fail,
  laws: { sigC: sigC, sigS: sigS },
  core: {
    sectionForces: sectionForces,
    solveX: solveX,
    geomCG: geomCG,
    momentRd: momentRd,
  },
  column: {
    buildModel: buildColumnModel,
    solve: solveColumn,
    forces: columnForces,
    solveX: solveColumnX,
    traceCurve: traceColumnCurve,
    findTheta: findColumnTheta,
    mrdUniaxial: mrdUniaxial,
    secondOrder: secondOrderEC2,
    axialLimits: columnAxialLimits,
    project: projectColumn,
  },
  shear: {
    buildModel: buildShearModel,
    solve: solveShear,
    Ash: shearAsh,
  },
  wall: {
    buildModel: buildWallModel,
    solve: solveWall,
    axialLimits: axialLimits,
    interactionNM: interactionNM,
  },
  joint: {
    buildModel: buildJointModel,
    solve: solveJoint,
    materials: jointMaterials,
    beam: buildBeam,
    beamCap: beamRectCap,
  },
};

})(typeof window !== 'undefined' ? window : globalThis);
