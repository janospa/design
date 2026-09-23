/*!
 * JP Design — engine-poly.js
 * Solver biaxial pe sectiune GENERALA (metoda fibrelor 2D)
 * ---------------------------------------------------------------------------
 * Copyright (c) 2026 Janos Patrik. Toate drepturile rezervate.
 *
 * Extinde nucleul comun (engine.js) cu flexiune compusa OBLICA pe o sectiune
 * de forma oarecare, definita ca REUNIUNE DE DREPTUNGHIURI. engine.js NU este
 * modificat: modulele 01-10 raman bit-identice.
 *
 * De ce un fisier separat: solverul biaxial al stalpului (JP.column) este deja
 * aproape independent de forma sectiunii — singurul lucru care il leaga de un
 * dreptunghi este dmaxTheta(theta, b, h). Aici se generalizeaza trei lucruri:
 *   1. malajul are ARIE SI MATERIAL PE FIBRA, deci bulbii confinati si inima
 *      neconfinata pot coexista in aceeasi integrare;
 *   2. dmax / dmin se iau din EXTINDEREA REALA a fibrelor pe normala, nu din
 *      formula dreptunghiului;
 *   3. momentele se raporteaza la CENTRUL DE GREUTATE GEOMETRIC al betonului,
 *      ca in JP.wall (geomCG) — aceeasi axa fata de care ETABS raporteaza
 *      eforturile pe pier.
 *
 * Sectiunea se construieste prin RASTERIZAREA reuniunii de dreptunghiuri: o
 * celula intra in sectiune daca centrul ei cade in ORICARE dreptunghi. Asa
 * suprapunerile de la colturile unui perete L / Z / T / U nu dubleaza betonul,
 * fara nicio operatie booleana pe poligoane — partea care de obicei greseste.
 *
 * Conventii — IDENTICE cu engine.js:
 *   - compresiunea este POZITIVA (N, eps, sig);
 *   - aria de beton este BRUTA (DEDUCT_STEEL = false), armatura se adauga peste;
 *   - pivot B (beton la eps_cu), pivot A (bara cea mai intinsa la eps_ud),
 *     pivot C (sectiune integral comprimata -> eps_c2);
 *   - lege parabola-dreptunghi pentru beton, elastic-perfect plastic pentru otel.
 *   - My = SUM(F*z), Mz = SUM(F*y) — exact ca in columnForces(), ca semnele si
 *     directia lui M_Ed sa se citeasca la fel ca la modulele 06 / 07.
 * ---------------------------------------------------------------------------
 */
(function (global) {
'use strict';

if (!global.JP) {
  throw new Error('engine-poly.js: engine.js trebuie incarcat INAINTE de acest fisier.');
}
const JPc = global.JP;
const sigC = JPc.laws.sigC, sigS = JPc.laws.sigS;
const CODES = JPc.CODES, ok = JPc.ok, fail = JPc.fail, barArea = JPc.barArea;

/* 1.1.0 — s-a adaugat buildShape2D (pereti L / T / Z cu armare pe zone).
   Functiile existente NU se schimba: buildWall2D si solverul dau exact
   aceleasi rezultate ca in 1.0.0. */
const VERSION = '1.1.0';

/* ─── edgeStrain: COPIE a functiei omonime din engine.js v2.3.0 ──────────────
   engine.js nu o exporta. Este reprodusa aici identic, pentru ca pivotul C sa
   se comporte exact la fel in ambele solvere.
   !! DACA edgeStrain SE SCHIMBA IN engine.js, TREBUIE SCHIMBATA SI AICI. !!
   Verificarea automata din test compara cele doua implementatii pe o grila de
   valori, deci o divergenta nu poate trece neobservata.                      */
function edgeStrain(X, H, pr) {
  if (!(H > 0) || X < H) return { eps: pr.ecu, pivot: 'concrete' };
  const dC = (1 - pr.ec2 / pr.ecu) * H;
  const den = X - dC;
  if (!(den > 0)) return { eps: pr.ec2, pivot: 'squash' };
  return { eps: pr.ec2 * X / den, pivot: 'squash' };
}

/* ═══════════════════════════════════════════════════════════════════════════
   RASTERIZARE
   Dreptunghi: {y0, z0, wy, wz, mat}. mat = indicele materialului (0 = beton
   neconfinat, 1 = zona de capat confinata, 2 = inima confinata). Daca un
   centru de celula cade in mai multe dreptunghiuri, castiga materialul cu
   indicele CEL MAI MARE dintre cele marcate ca prioritare (zonele confinate
   se suprapun peste beton simplu), dar aria este numarata O SINGURA DATA.
   ═══════════════════════════════════════════════════════════════════════════ */
function rasterize(rects, opt) {
  const o = opt || {};
  const NT = o.NT || 16;            // celule pe cea mai mica grosime
  const maxCells = o.maxCells || 60000;
  if (!rects.length) return null;

  let ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity, tmin = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!(r.wy > 0) || !(r.wz > 0)) continue;
    if (r.y0 < ymin) ymin = r.y0;
    if (r.y0 + r.wy > ymax) ymax = r.y0 + r.wy;
    if (r.z0 < zmin) zmin = r.z0;
    if (r.z0 + r.wz > zmax) zmax = r.z0 + r.wz;
    const t = Math.min(r.wy, r.wz);
    if (t < tmin) tmin = t;
  }
  if (!isFinite(ymin) || !(ymax > ymin) || !(zmax > zmin)) return null;

  // Pasul se alege din cea mai mica grosime, ca peretele cel mai subtire sa
  // aiba tot NT celule pe grosime. Apoi se limiteaza numarul total.
  let step = tmin / NT;
  const spanY = ymax - ymin, spanZ = zmax - zmin;
  let ny = Math.max(1, Math.ceil(spanY / step));
  let nz = Math.max(1, Math.ceil(spanZ / step));
  if (ny * nz > maxCells) {
    const f = Math.sqrt((ny * nz) / maxCells);
    ny = Math.max(1, Math.floor(ny / f));
    nz = Math.max(1, Math.floor(nz / f));
  }
  const hy = spanY / ny, hz = spanZ / nz;
  const cellA = hy * hz;

  const cy = [], cz = [], cMat = [];
  for (let i = 0; i < ny; i++) {
    const yy = ymin + (i + 0.5) * hy;
    for (let j = 0; j < nz; j++) {
      const zz = zmin + (j + 0.5) * hz;
      let mat = -1;
      for (let k = 0; k < rects.length; k++) {
        const r = rects[k];
        if (yy >= r.y0 && yy <= r.y0 + r.wy && zz >= r.z0 && zz <= r.z0 + r.wz) {
          if (r.mat > mat) mat = r.mat;      // zona confinata are prioritate
        }
      }
      if (mat < 0) continue;                  // celula in afara sectiunii
      cy.push(yy); cz.push(zz); cMat.push(mat);
    }
  }
  return {
    cy: Float64Array.from(cy), cz: Float64Array.from(cz),
    cMat: Int8Array.from(cMat), nC: cy.length,
    cellA: cellA, hy: hy, hz: hz, ny: ny, nz: nz,
    bbox: { ymin: ymin, ymax: ymax, zmin: zmin, zmax: zmax },
  };
}

/* ─── Rasterizare ALINIATA (v1.1.0, folosita de buildShape2D) ───────────────
   Malajul uniform de mai sus pune o celula intreaga inauntru sau in afara dupa
   centrul ei, deci o fata care cade in mijlocul unei celule muta aria cu pana
   la o jumatate de celula. La peretele dreptunghiular eroarea este mica (0,1 %
   pe peretele de referinta), dar la o sectiune Z, cu multe fete paralele, s-a
   masurat +2 % pe aria de beton la NT = 24.
   Aici liniile malajului trec prin TOATE muchiile dreptunghiurilor, iar fiecare
   interval dintre doua muchii se imparte egal la pasul cel mult `step`. Orice
   celula este astfel complet in sectiune sau complet in afara, deci aria este
   EXACTA. Celulele nu mai au toate aceeasi arie, asa ca modelul poarta aria si
   dimensiunile fiecarei celule (cA, chy, chz).
   rasterize() si buildWall2D raman neschimbate. */
function rasterizeAligned(rects, opt) {
  const o = opt || {};
  const NT = o.NT || 16;
  const maxCells = o.maxCells || 60000;
  const R = rects.filter(function (r) { return r.wy > 0 && r.wz > 0; });
  if (!R.length) return null;
  let tmin = Infinity;
  const ysE = [], zsE = [];
  R.forEach(function (r) {
    ysE.push(r.y0, r.y0 + r.wy); zsE.push(r.z0, r.z0 + r.wz);
    const t = Math.min(r.wy, r.wz); if (t < tmin) tmin = t;
  });
  const uniq = function (a) {
    a.sort(function (x, y) { return x - y; });
    const out = [];
    a.forEach(function (v) { if (!out.length || v - out[out.length - 1] > 1e-6) out.push(v); });
    return out;
  };
  const ye = uniq(ysE), ze = uniq(zsE);
  function lines(edges, step) {
    const c = [], h = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      const a = edges[i], b = edges[i + 1], k = Math.max(1, Math.ceil((b - a) / step - 1e-9));
      const hh = (b - a) / k;
      for (let j = 0; j < k; j++) { c.push(a + (j + 0.5) * hh); h.push(hh); }
    }
    return { c: c, h: h };
  }
  let step = tmin / NT, Y, Zl, guard = 0;
  for (;;) {
    Y = lines(ye, step); Zl = lines(ze, step);
    if (Y.c.length * Zl.c.length <= maxCells || guard++ > 30) break;
    step *= 1.15;
  }
  const cy = [], cz = [], cMat = [], cA = [], chy = [], chz = [];
  for (let i = 0; i < Y.c.length; i++) {
    const yy = Y.c[i];
    for (let j = 0; j < Zl.c.length; j++) {
      const zz = Zl.c[j];
      let mat = -1;
      for (let k = 0; k < R.length; k++) {
        const r = R[k];
        if (yy > r.y0 && yy < r.y0 + r.wy && zz > r.z0 && zz < r.z0 + r.wz) {
          if (r.mat > mat) mat = r.mat;
        }
      }
      if (mat < 0) continue;
      cy.push(yy); cz.push(zz); cMat.push(mat);
      cA.push(Y.h[i] * Zl.h[j]); chy.push(Y.h[i]); chz.push(Zl.h[j]);
    }
  }
  return {
    cy: Float64Array.from(cy), cz: Float64Array.from(cz), cMat: Int8Array.from(cMat),
    cA: Float64Array.from(cA), chy: Float64Array.from(chy), chz: Float64Array.from(chz),
    nC: cy.length, cellA: step * step, hy: step, hz: step,
    ny: Y.c.length, nz: Zl.c.length,
    bbox: { ymin: ye[0], ymax: ye[ye.length - 1], zmin: ze[0], zmax: ze[ze.length - 1] },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODEL
   inp = {
     rects:  [{y0,z0,wy,wz,mat}]        reuniunea care da betonul
     bars:   [{y,z,A}]                  fibre punctuale de armatura
     props:  [{fcd,ec2,ecu}, ...]       indexate dupa mat
     fyd, Es, eud
     opts:   {NT, maxCells, LIMIT_EPS_UD, LIMIT_PIVOT_C, DEDUCT_STEEL, NANG}
   }
   Coordonatele se muta in CENTRUL DE GREUTATE GEOMETRIC al betonului, deci
   momentele ies direct fata de axa corecta.
   ═══════════════════════════════════════════════════════════════════════════ */
function buildPolyModel(inp) {
  const D = JPc.DEFAULTS;
  const o = Object.assign({
    NT: 16, maxCells: 60000,
    LIMIT_EPS_UD: D.LIMIT_EPS_UD, LIMIT_PIVOT_C: D.LIMIT_PIVOT_C,
    DEDUCT_STEEL: D.DEDUCT_STEEL, NANG: D.NANG, Es: D.Es,
  }, inp.opts || {});

  const aligned = !!o.align;
  const g = aligned ? rasterizeAligned(inp.rects || [], o) : rasterize(inp.rects || [], o);
  if (!g) return { nC: 0, Ac: 0, degenerate: true };

  // ── centru de greutate geometric al betonului (ponderat cu aria celulei
  //    la malajul aliniat; la cel uniform ariile sunt egale)
  let sy = 0, sz = 0, sA = 0;
  for (let i = 0; i < g.nC; i++) {
    const a = aligned ? g.cA[i] : 1;
    sy += g.cy[i] * a; sz += g.cz[i] * a; sA += a;
  }
  const cgY = sy / sA, cgZ = sz / sA;

  const cy = new Float64Array(g.nC), cz = new Float64Array(g.nC);
  for (let i = 0; i < g.nC; i++) { cy[i] = g.cy[i] - cgY; cz[i] = g.cz[i] - cgZ; }

  const bars = (inp.bars || []).map(function (b) {
    return { y: b.y - cgY, z: b.z - cgZ, A: b.A, grp: b.grp || '' };
  });

  const Ac = aligned ? sA : g.nC * g.cellA;
  const As_tot = bars.reduce(function (s, b) { return s + b.A; }, 0);

  // aria de beton pe material — pentru capacitatile axiale limita
  const nMat = inp.props.length;
  const Amat = new Float64Array(nMat);
  for (let i = 0; i < g.nC; i++) Amat[g.cMat[i]] += aligned ? g.cA[i] : g.cellA;

  const m = {
    VERSION: VERSION,
    cy: cy, cz: cz, cMat: g.cMat, nC: g.nC, cellA: g.cellA,
    hy: g.hy, hz: g.hz, ny: g.ny, nz: g.nz,
    bbox: g.bbox, cgY: cgY, cgZ: cgZ,
    rects: inp.rects, props: inp.props, Amat: Amat,
    steelFibers: bars, As_tot: As_tot, Ac: Ac,
    fyd: inp.fyd, Es: o.Es, eud: inp.eud,
    deductSteel: o.DEDUCT_STEEL, limitEpsUd: o.LIMIT_EPS_UD,
    limitPivotC: o.LIMIT_PIVOT_C, NANG: o.NANG,
    degenerate: !(g.nC > 0),
  };
  if (aligned) { m.cA = g.cA; m.chy = g.chy; m.chz = g.chz; m.aligned = true; }
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PROIECTII PE NORMALA LA AXA NEUTRA
   Se calculeaza O SINGURA DATA pe unghi si se refolosesc la toate iteratiile
   de bisectie pe X.
   Pe langa proiectii se retin si:
     - dMaxMat[k] : proiectia maxima a unei celule de material k. Pivotul B
       cere minimul lui ecu_k/shp peste celulele comprimate; cum shp creste cu
       proiectia, minimul se atinge la celula cea mai comprimata a fiecarui
       material. Asa pivotul B costa O(nr. materiale), nu O(nr. celule).
     - dSmin : proiectia minima a unei bare, adica bara cea mai intinsa —
       singura care poate declansa pivotul A.
   ═══════════════════════════════════════════════════════════════════════════ */
function projectPoly(theta, m) {
  const cx = Math.cos(theta), cs = Math.sin(theta);
  const dC = new Float64Array(m.nC);
  const nMat = m.props.length;
  const dMaxMat = new Float64Array(nMat).fill(-Infinity);
  let dmaxC = -Infinity, dminC = Infinity, iEdge = 0;
  for (let i = 0; i < m.nC; i++) {
    const d = m.cy[i] * cx + m.cz[i] * cs;
    dC[i] = d;
    if (d > dmaxC) { dmaxC = d; iEdge = i; }
    if (d < dminC) dminC = d;
    const k = m.cMat[i];
    if (d > dMaxMat[k]) dMaxMat[k] = d;
  }
  const nS = m.steelFibers.length;
  const dS = new Float64Array(nS);
  let dSmin = Infinity;
  for (let i = 0; i < nS; i++) {
    const d = m.steelFibers[i].y * cx + m.steelFibers[i].z * cs;
    dS[i] = d;
    if (d < dSmin) dSmin = d;
  }
  /* Marginea REALA a betonului, nu centrul celulei extreme: planul de
     deformatii este ancorat pe fata sectiunii, exact ca la stalp, unde dmax
     este b/2 iar centrele celulelor stau cu o jumatate de celula mai inauntru. */
  let dmax, dmin;
  if (m.chy) {
    // malaj aliniat: fiecare celula isi are propria jumatate de extindere
    dmax = -Infinity; dmin = Infinity;
    const ax = Math.abs(cx) / 2, as = Math.abs(cs) / 2;
    for (let i = 0; i < m.nC; i++) {
      const e = ax * m.chy[i] + as * m.chz[i];
      if (dC[i] + e > dmax) dmax = dC[i] + e;
      if (dC[i] - e < dmin) dmin = dC[i] - e;
    }
  } else {
    const halfExt = Math.abs(m.hy / 2 * cx) + Math.abs(m.hz / 2 * cs);
    dmax = dmaxC + halfExt; dmin = dminC - halfExt;
  }
  return { dC: dC, dS: dS, dmax: dmax, dmin: dmin, H: dmax - dmin,
           dMaxMat: dMaxMat, dSmin: dSmin, iEdge: iEdge };
}

/**
 * Forte si momente pentru axa neutra la adancimea X, inclinarea theta.
 * X se masoara de la fibra cea mai comprimata (dmax) spre interior.
 */
function polyForces(X, theta, m, proj) {
  const p = proj || projectPoly(theta, m);
  const na = p.dmax - X;

  // ── pivot B: prima zona de beton care isi atinge propriul eps_cu
  let epsEdge = Infinity, pivot = 'none';
  for (let k = 0; k < p.dMaxMat.length; k++) {
    const dk = p.dMaxMat[k];
    if (!isFinite(dk)) continue;               // material absent din sectiune
    const shp = (dk - na) / X;
    if (shp <= 0) continue;                    // nicio celula a lui nu e comprimata
    const e = m.props[k].ecu / shp;
    if (e < epsEdge) { epsEdge = e; pivot = 'concrete'; }
  }
  // ── pivot C: sectiune integral comprimata, cu materialul de la marginea
  //    cea mai comprimata (cel care fixeaza de fapt fata)
  if (m.limitPivotC && X >= p.H) {
    const prEdge = m.props[m.cMat[p.iEdge]];
    const eC = edgeStrain(X, p.H, prEdge);
    if (eC.eps < epsEdge) { epsEdge = eC.eps; pivot = eC.pivot; }
  }
  // ── pivot A: bara cea mai intinsa la eps_ud
  if (m.limitEpsUd && m.eud > 0 && isFinite(p.dSmin)) {
    const r = (p.dSmin - na) / X;
    if (r < 0) {
      const eLim = m.eud / (-r);
      if (eLim < epsEdge) { epsEdge = eLim; pivot = 'steel'; }
    }
  }
  if (!isFinite(epsEdge)) epsEdge = 0;

  // ── beton
  let Fc = 0, Mcy = 0, Mcz = 0;
  const dA = m.cellA, cA = m.cA;
  for (let i = 0; i < m.nC; i++) {
    const eps = epsEdge * (p.dC[i] - na) / X;
    if (eps <= 0) continue;
    const F = sigC(eps, m.props[m.cMat[i]]) * (cA ? cA[i] : dA);
    Fc += F; Mcy += F * m.cz[i]; Mcz += F * m.cy[i];
  }
  // ── armatura
  let Fs = 0, Msy = 0, Msz = 0;
  for (let j = 0; j < m.steelFibers.length; j++) {
    const sf = m.steelFibers[j];
    const eps = epsEdge * (p.dS[j] - na) / X;
    let sig = sigS(eps, m);
    if (m.deductSteel) {
      // conventia "net": se scade betonul dislocuit de bara
      sig -= sigC(eps, m.props[matAtBar(m, sf)]);
    }
    const F = sig * sf.A;
    Fs += F; Msy += F * sf.z; Msz += F * sf.y;
  }
  return { N: (Fc + Fs) / 1e3, My: (Mcy + Msy) / 1e6, Mz: (Mcz + Msz) / 1e6,
           Fc: Fc / 1e3, Fs: Fs / 1e3, epsEdge: epsEdge, pivot: pivot };
}

/** Materialul betonului din dreptul unei bare (doar pentru conventia "net"). */
function matAtBar(m, sf) {
  const y = sf.y + m.cgY, z = sf.z + m.cgZ;
  let mat = 0;
  for (let k = 0; k < m.rects.length; k++) {
    const r = m.rects[k];
    if (y >= r.y0 && y <= r.y0 + r.wy && z >= r.z0 && z <= r.z0 + r.wz) {
      if (r.mat > mat) mat = r.mat;
    }
  }
  return mat;
}

/** Bisectie pe X pentru N_int = Ntarget, la theta fix. */
function solvePolyX(theta, Ntarget, m) {
  const proj = projectPoly(theta, m);
  const span = proj.H;
  const F = function (X) { return polyForces(X, theta, m, proj).N - Ntarget; };
  let lo = 1, hi = span * 8;
  let flo = F(lo), fhi = F(hi), guard = 0;
  while (flo * fhi > 0 && guard++ < 200) {
    if (Math.abs(flo) < Math.abs(fhi)) { lo /= 2; if (lo < 1e-6) break; flo = F(lo); }
    else { hi *= 2; if (hi > span * 1e6) break; fhi = F(hi); }
  }
  if (flo * fhi > 0) {
    const X = (Math.abs(flo) < Math.abs(fhi)) ? lo : hi;
    return Object.assign({ X: X, theta: theta, converged: false },
                         polyForces(X, theta, m, proj));
  }
  for (let it = 0; it < 80; it++) {
    const mid = (lo + hi) / 2, fm = F(mid);
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    if (Math.abs(fm) < 1e-7) break;
  }
  const X = (lo + hi) / 2;
  return Object.assign({ X: X, theta: theta, converged: true },
                       polyForces(X, theta, m, proj));
}

/**
 * Inclinarea axei neutre al carei punct capabil cade EXACT pe directia lui
 * M_Ed. Unghiul axei neutre NU este unghiul momentului: relatia se inverseaza
 * numeric, prin bisectie pe TOT intervalul 0..2*pi. Scurtatura algebrica
 * theta = pi/2 - dirAngle merge numai la sectiuni perfect simetrice, deci NU
 * se foloseste: un perete cu bulbi armati diferit, si cu atat mai mult un
 * perete L sau Z, nu este simetric.
 */
function findPolyTheta(dirAngle, Ntarget, m) {
  /* v1.1.0 — BRACKETING INAINTE DE BISECTIE.
     Directia momentului capabil scade monoton cu theta, dar pe un cerc: are un
     SALT de 2*pi undeva. Versiunea 1.0.0 facea bisectie direct pe [0, 2*pi]
     presupunand ca saltul cade exact la capatul intervalului (theta = 0).
     La o sectiune simetrica asa este (theta = 0 da M pe +/-90 grade), dar la un
     perete L directia la theta = 0 a iesit ~71 de grade: pentru tinte intre 71
     si ~76 de grade bisectia se oprea in capat si intorcea punctul de la 71
     de grade, adica un M_Rd pe ALTA directie — pe peretele de test cu 3,2 %
     prea mare (neacoperitor), prins la comparatia cu fib structuralcodes.
     Acum: se esantioneaza theta pe 24 de pozitii, se cauta intervalul in care
     diferenta de unghi schimba semnul FARA salt (|salt| < pi) si abia apoi se
     face bisectie in el. solvePoly verifica in plus ca directia gasita este
     chiar cea ceruta. */
  const TWO_PI = 2 * Math.PI;
  const wrap = function (a) { while (a > Math.PI) a -= TWO_PI; while (a <= -Math.PI) a += TWO_PI; return a; };
  const target = wrap(dirAngle);
  const diffAt = function (th) { const r = solvePolyX(th, Ntarget, m); return { r: r, d: wrap(Math.atan2(r.Mz, r.My) - target) }; };
  const NS = 24;
  let lo = 0, hi = TWO_PI, found = false;
  let prev = diffAt(0), prevTh = 0;
  for (let k = 1; k <= NS; k++) {
    const th = k * TWO_PI / NS;
    const cur = (k === NS) ? prev0() : diffAt(th);
    if (prev.d > 0 && cur.d <= 0 && (prev.d - cur.d) < Math.PI) { lo = prevTh; hi = th; found = true; break; }
    if (prev.d === 0) { return prev.r; }
    prev = cur; prevTh = th;
  }
  function prev0() { return diffAt(0); }
  if (!found) { lo = 0; hi = TWO_PI; }          // rezerva: comportamentul din 1.0.0
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    const dm = diffAt(mid).d;
    if (dm > 0) lo = mid; else hi = mid;
  }
  return solvePolyX((lo + hi) / 2, Ntarget, m);
}

/** Conturul My-Mz la N constant, baleind inclinarea axei neutre pe 0..360. */
function tracePolyCurve(Ntarget, m, nAng) {
  const n = nAng || m.NANG || 24;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const r = solvePolyX(k * 2 * Math.PI / n, Ntarget, m);
    if (r.converged) pts.push({ My: r.My, Mz: r.Mz });
  }
  return pts;
}

/**
 * Capacitati axiale limita, conventie BRUTA.
 * La compresiune centrica deformatia este uniforma si limitata de pivotul C.
 * Cand sectiunea are materiale diferite (bulbi confinati + inima neconfinata)
 * nu exista un singur eps_c2: se ia CEL MAI MIC dintre materialele prezente,
 * adica primul care isi atinge palierul. Este alegerea acoperitoare; JP.wall
 * ia in schimb eps_c2 al bulbului cand acesta este confinat, deci N_Rd,c poate
 * iesi aici cu putin mai mic. Marimea este folosita doar pentru incadrare si
 * pentru raport, nu intra in M_Rd la N dat.
 */
function polyAxialLimits(m) {
  let Nc = 0, ec2min = Infinity;
  for (let k = 0; k < m.props.length; k++) {
    if (!(m.Amat[k] > 0)) continue;
    Nc += m.Amat[k] * m.props[k].fcd;
    if (m.props[k].ec2 < ec2min) ec2min = m.props[k].ec2;
  }
  if (!isFinite(ec2min)) ec2min = JPc.DEFAULTS.EC2_NC;
  const sigS_c = m.limitPivotC ? Math.min(m.fyd, m.Es * ec2min) : m.fyd;
  return {
    NRdc: (Nc + m.As_tot * sigS_c) / 1e3,
    NRdc_mat: (Nc + m.As_tot * m.fyd) / 1e3,
    sigS_c: sigS_c,
    NRdt: -(m.As_tot * m.fyd) / 1e3,
  };
}

/**
 * Verificare biaxiala la N_Ed dat.
 * Utilizarea este raportul distantelor pe raza M_Ed in planul (My, Mz), exact
 * ca la stalp (solveColumn).
 * @returns contractul comun {ok, code, message, value, partial}
 */
function solvePoly(m, Ned, MyEd, MzEd, lang) {
  if (!m || m.degenerate || !(m.Ac > 0)) return fail(CODES.DEGENERATE, lang);
  if (!(m.fyd > 0)) return fail(CODES.INVALID_INPUT, lang);
  let anyFcd = false;
  for (let k = 0; k < m.props.length; k++) if (m.Amat[k] > 0 && m.props[k].fcd > 0) anyFcd = true;
  if (!anyFcd) return fail(CODES.INVALID_INPUT, lang);

  const lim = polyAxialLimits(m);
  const dirAngle = Math.atan2(MzEd, MyEd);
  const res = findPolyTheta(dirAngle, Ned, m);
  const residual = Ned - res.N;
  const tol = Math.max(0.01, Math.abs(Ned) * 1e-5);

  const dEd = Math.hypot(MyEd, MzEd);
  const dRd = Math.hypot(res.My, res.Mz);
  // directia punctului capabil trebuie sa fie chiar directia lui M_Ed
  let dirErr = Math.atan2(res.Mz, res.My) - dirAngle;
  while (dirErr > Math.PI) dirErr -= 2 * Math.PI;
  while (dirErr <= -Math.PI) dirErr += 2 * Math.PI;
  const value = {
    MyRd: res.My, MzRd: res.Mz, MRd: dRd, MEd: dEd,
    X: res.X, theta: res.theta, thetaDeg: res.theta * 180 / Math.PI,
    Nint: res.N, residual: residual,
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
  if (dEd > 1e-9 && Math.abs(dirErr) > 0.2 * Math.PI / 180) {
    return fail(CODES.RESIDUAL_HIGH, lang, value,
      '(directia M_Rd difera cu ' + (dirErr * 180 / Math.PI).toFixed(2) + ' grade)');
  }
  return ok(value);
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONSTRUCTOR PENTRU PERETELE MODULULUI 03, IN 2D
   Aceeasi geometrie si aceeasi alcatuire ca JP.wall.buildModel, dar barele se
   aseaza in PLAN (y, z) in loc sa fie lumpate pe o singura coordonata. La
   incovoiere strict in planul peretelui coordonata z nu intervine, deci
   rezultatul trebuie sa coincida cu JP.wall — vezi testul de validare.
   y = lungimea peretelui (0 la l_w), z = grosimea (centrata pe 0).
   ═══════════════════════════════════════════════════════════════════════════ */
function buildWall2D(inp) {
  const D = JPc.DEFAULTS;
  const o = Object.assign({}, D, inp.opts || {});
  const lw = +inp.lw, bw0 = +inp.bw0;
  const bf1 = +inp.bf1, lf1 = +inp.lf1;
  const bf2 = +inp.bf2, lf2 = +inp.lf2;
  const lwi = lw - bf1 - bf2;
  const cnom = +inp.cnom || 0, detr = +inp.detr || 0;

  const fck = JPc.CONC[inp.concrete] ? JPc.CONC[inp.concrete].fck : 0;
  const st = JPc.STEEL[inp.steel] || { fyk: 0, euk: 0.05 };
  const fcd = fck / o.GAMMA_C, fyd = st.fyk / o.GAMMA_S;
  const confMode = inp.confMode || 'none';
  const bulbConf = (confMode === 'bulb' || confMode === 'all');
  const webConf = (confMode === 'all');

  const propsUnconf = { fcd: fcd, ec2: o.EC2_NC, ecu: o.ECU_NC };
  const propsBulbC = { fcd: (+inp.fckc || 0) / o.GAMMA_C,
                       ec2: (+inp.ec2c || 0) / 1000, ecu: (+inp.ecu2c || 0) / 1000 };
  const propsWebC = { fcd: (+inp.fckcw || 0) / o.GAMMA_C,
                      ec2: (+inp.ec2cw || 0) / 1000, ecu: (+inp.ecu2cw || 0) / 1000 };
  // indici: 0 = neconfinat, 1 = bulb confinat, 2 = inima confinata
  const props = [propsUnconf, bulbConf ? propsBulbC : propsUnconf,
                 webConf ? propsWebC : propsUnconf];

  /* ── beton: bulb 1 (y = 0) | inima | bulb 2 (y = l_w) ────────────────────
     ATENTIE — ORIENTAREA NU ESTE ARBITRARA. Nucleul calculeaza Mz = SUM(F*y),
     deci un moment POZITIV inseamna compresiune la y mare. Modulul 03 (si
     JP.wall) foloseste conventia "M_Ed > 0 comprima Bulbul 2". Ca acelasi
     M_Ed sa insemne acelasi lucru in ambele module, BULBUL 2 TREBUIE SA STEA
     LA y MARE. Asezarea inversa da rezultate corecte pentru un perete simetric
     si TACIT GRESITE pentru unul cu bulbi armati diferit: se intoarce
     capacitatea celuilalt sens. Testul 10 din validate.js prinde exact asta. */
  const rects = [
    { y0: 0,         z0: -lf1 / 2, wy: bf1, wz: lf1, mat: 1 },
    { y0: bf1,       z0: -bw0 / 2, wy: lwi, wz: bw0, mat: 2 },
    { y0: lw - bf2,  z0: -lf2 / 2, wy: bf2, wz: lf2, mat: 1 },
  ].filter(function (r) { return r.wy > 0 && r.wz > 0; });

  /* ── armatura: acelasi tipar ca JP.wall, dar cu pozitie pe grosime ────────
     Acoperirea mecanica este identica: c_nom + Ø_etr + Ø_bara/2, plafonata la
     jumatate din dimensiunea zonei ca cele doua fete sa nu se incruciseze. */
  const bars = [];
  function cMec(dbar, span) {
    return Math.min(cnom + detr + (+dbar || 0) / 2, span / 2);
  }
  function bulbBars(c_n, c_d, s_n, s_d, l_n, l_d, l_r, bulbLen, bulbWid, y0) {
    const Ac = barArea(c_d), As = barArea(s_d), Al = barArea(l_d);
    const cmCy = cMec(c_d, bulbLen), cmCz = cMec(c_d, bulbWid);
    const cmSy = cMec(s_d, bulbLen), cmSz = cMec(s_d, bulbWid);
    const cmLz = cMec(l_d, bulbWid);
    const hz = bulbWid / 2;
    // colturi: n/4 la fiecare dintre cele 4 colturi
    if (c_n > 0) {
      const per = c_n / 4;
      [[y0 + cmCy, -hz + cmCz], [y0 + bulbLen - cmCy, -hz + cmCz],
       [y0 + bulbLen - cmCy, hz - cmCz], [y0 + cmCy, hz - cmCz]].forEach(function (c) {
        bars.push({ y: c[0], z: c[1], A: Ac * per, grp: 'cor' });
      });
    }
    // latura scurta (fetele de capat, perpendiculare pe lungimea peretelui):
    // n/2 pe fiecare capat, distribuite pe grosime intre barele de colt
    if (s_n > 0) {
      const per = s_n / 2;
      const nEach = Math.max(1, Math.round(per));
      const zA = -hz + cmCz, zB = hz - cmCz;
      [y0 + cmSy, y0 + bulbLen - cmSy].forEach(function (yy) {
        for (let i = 0; i < nEach; i++) {
          const z = (nEach === 1) ? 0 : zA + (zB - zA) * (i + 1) / (nEach + 1);
          bars.push({ y: yy, z: z, A: As * (per / nEach), grp: 'sid' });
        }
      });
    }
    // latura lunga: l_n bare in l_r randuri pe grosime -> nCol pozitii pe
    // lungime, fiecare cu l_r bare pe grosime
    const cmEndY = (c_n > 0) ? cmCy : (s_n > 0 ? cmSy : cMec(0, bulbLen));
    const ya = y0 + cmEndY, yb = y0 + bulbLen - cmEndY;
    const nCol = Math.max(0, Math.round(l_n / Math.max(1, l_r)));
    const rows = Math.max(1, l_r);
    const zA = -hz + cmLz, zB = hz - cmLz;
    for (let i = 0; i < nCol; i++) {
      const yy = ya + (yb - ya) * (i + 1) / (nCol + 1);
      for (let r = 0; r < rows; r++) {
        const z = (rows === 1) ? 0 : zA + (zB - zA) * r / (rows - 1);
        bars.push({ y: yy, z: z, A: Al, grp: 'lng' });
      }
    }
  }
  const b = inp.bars;
  // bulb 1 la y = 0, bulb 2 la y = l_w — vezi nota de la definirea betonului
  bulbBars(b.b1c_n, b.b1c_d, b.b1s_n, b.b1s_d, b.b1l_n, b.b1l_d,
           Math.max(1, b.b1l_r), bf1, lf1, 0);
  bulbBars(b.b2c_n, b.b2c_d, b.b2s_n, b.b2s_d, b.b2l_n, b.b2l_d,
           Math.max(1, b.b2l_r), bf2, lf2, lw - bf2);
  // inima: nWeb pozitii pe lungime x in_r randuri pe grosime
  const nWeb = (b.in_r > 0 && b.in_s > 0) ? Math.max(0, Math.floor(lwi / b.in_s)) : 0;
  const rowsW = Math.max(1, b.in_r);
  const cmW = cMec(b.in_d, bw0);
  const zAw = -bw0 / 2 + cmW, zBw = bw0 / 2 - cmW;
  const stepW = nWeb > 0 ? lwi / nWeb : 0;
  for (let i = 0; i < nWeb; i++) {
    const yy = bf1 + (i + 0.5) * stepW;
    for (let r = 0; r < rowsW; r++) {
      const z = (rowsW === 1) ? 0 : zAw + (zBw - zAw) * r / (rowsW - 1);
      bars.push({ y: yy, z: z, A: barArea(b.in_d), grp: 'web' });
    }
  }

  const m = buildPolyModel({
    rects: rects, bars: bars, props: props,
    fyd: fyd, eud: 0.9 * st.euk,
    opts: Object.assign({}, inp.opts || {}, {
      NT: (inp.opts && inp.opts.NT) || 16,
      maxCells: (inp.opts && inp.opts.maxCells) || 60000,
    }),
  });
  // metadate pentru interfata si raport
  m.lw = lw; m.bw0 = bw0; m.bf1 = bf1; m.lf1 = lf1; m.bf2 = bf2; m.lf2 = lf2;
  m.lwi = lwi; m.cnom = cnom; m.detr = detr;
  m.fck = fck; m.fcd = fcd; m.fyk = st.fyk;
  m.euk = st.euk; m.eukAssumed = !!st.eukAssumed;
  m.confMode = confMode; m.bulbConf = bulbConf; m.webConf = webConf;
  m.fckc = +inp.fckc || 0; m.fckcw = +inp.fckcw || 0;
  m.ec2_nc = o.EC2_NC; m.ecu_nc = o.ECU_NC;
  m.ec2_c = propsBulbC.ec2; m.ecu_c = propsBulbC.ecu;
  m.ec2_cw = propsWebC.ec2; m.ecu_cw = propsWebC.ecu;
  m.concrete = inp.concrete; m.steel = inp.steel;
  m.nWeb = nWeb; m.bars = b;
  m.cntB1 = b.b1c_n + b.b1s_n + b.b1l_n;
  m.cntB2 = b.b2c_n + b.b2s_n + b.b2l_n;
  m.cntWeb = nWeb * b.in_r;
  // aceleasi validari de numar de bare ca la JP.wall
  m.barIssues = wallBarIssues(b);
  return m;
}

/** Aceleasi reguli ca engine.js: colturi multiplu de 4, latura lunga divizibila. */
function wallBarIssues(b) {
  const out = [];
  const chk4 = function (key, n) { if (!isFinite(n) || n < 0 || (n % 4) !== 0) out.push({ kind: 'mult4', key: key, got: n }); };
  const chkR = function (key, n, r) { if (!isFinite(n) || n < 0 || !(r >= 1) || (n % r) !== 0) out.push({ kind: 'rows', key: key, got: n, rows: r }); };
  chk4('cornerB1', +b.b1c_n || 0);
  chk4('cornerB2', +b.b2c_n || 0);
  chkR('longB1', +b.b1l_n || 0, Math.max(1, +b.b1l_r || 1));
  chkR('longB2', +b.b2l_n || 0, Math.max(1, +b.b2l_r || 1));
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PERETI L / T / Z  (v1.1.0)
   ───────────────────────────────────────────────────────────────────────────
   Geometrie, dimensiuni EXTERIOARE:
     inima  — y de la 0 la l_w, grosimea t_w centrata pe z = 0;
     talpa  — la capatul y = l_w, grosimea t_f (pe y), lungimea l_f (pe z):
              L: de la fata inimii spre partea `side` (+1 = +z, -1 = -z);
              T: centrata pe inima;
              Z: ca la L, plus o a doua talpa la y = 0, spre partea OPUSA
                 (sectiunea Z este simetrica fata de centru, deci a doua
                 jumatate se obtine prin reflexie in punct).
   Axe: y = lungimea inimii (axa locala 2 a pier-ului), z = grosimea (axa 3).
   Mz = SUM(F*y) este momentul din planul inimii, My = SUM(F*z) cel din afara
   lui — exact ca buildWall2D si modulul 11.

   Armare, pe ZONE, pe doua randuri (cate unul pe fiecare fata, fara randuri
   intermediare):
     end  — capatul liber al inimii (L, T): lungime l, n bare pe fata, Ø;
     jn   — nodul inima-talpa: cele 4 bare din patratul de intersectie se pun
            automat; in plus nw bare pe fiecare fata a inimii pe lungimea lw
            (masurata de la fata interioara a talpii) si nf bare pe fiecare
            fata a talpii pe lungimea lf (masurata de la fata inimii, de
            fiecare parte la T);
     tip  — capatul liber al talpii: lungime l, n bare pe fata, Ø;
     web / fl — bare distribuite Ø / s pe fiecare fata, intre zone.
   Centrul barei sta la c_nom + Ø_etr + Ø/2 de fata betonului, ca peste tot.
   O bara care ar cadea la mai putin de (Ø1+Ø2)/2 de alta existenta nu se mai
   adauga — asa colturile comune dintre zone nu se dubleaza.

   Materiale: zonele (capete, noduri, varfuri de talpa) sunt confinate cand
   confMode este 'bulb' sau 'all', inima si talpile numai la 'all' (vezi
   nota de la `props` pentru ordinea indicilor).
   ═══════════════════════════════════════════════════════════════════════════ */
function buildShape2D(inp) {
  const D = JPc.DEFAULTS;
  const o = Object.assign({}, D, inp.opts || {});
  const shape = (inp.shape === 'T' || inp.shape === 'Z') ? inp.shape : 'L';
  const side = (+inp.side < 0) ? -1 : 1;
  const lw = +inp.lw || 0, tw = +inp.tw || 0, lf = +inp.lf || 0, tf = +inp.tf || 0;
  const cnom = +inp.cnom || 0, detr = +inp.detr || 0;
  const Z = (shape === 'Z');
  const hasEnd = !Z;

  const fck = JPc.CONC[inp.concrete] ? JPc.CONC[inp.concrete].fck : 0;
  const st = JPc.STEEL[inp.steel] || { fyk: 0, euk: 0.05 };
  const fcd = fck / o.GAMMA_C, fyd = st.fyk / o.GAMMA_S;
  const confMode = inp.confMode || 'none';
  const bulbConf = (confMode === 'bulb' || confMode === 'all');
  const webConf = (confMode === 'all');
  const propsUnconf = { fcd: fcd, ec2: o.EC2_NC, ecu: o.ECU_NC };
  const propsBulbC = { fcd: (+inp.fckc || 0) / o.GAMMA_C,
                       ec2: (+inp.ec2c || 0) / 1000, ecu: (+inp.ecu2c || 0) / 1000 };
  const propsWebC = { fcd: (+inp.fckcw || 0) / o.GAMMA_C,
                      ec2: (+inp.ec2cw || 0) / 1000, ecu: (+inp.ecu2cw || 0) / 1000 };
  /* Indicii de material sunt INVERSATI fata de buildWall2D: aici zonele se
     suprapun peste inima / talpa, iar la rasterizare castiga indicele cel mai
     mare, deci zonele trebuie sa aiba indicele mai mare.
       0 = neconfinat, 1 = inima / talpa (confinata la 'all'), 2 = zone. */
  const props = [propsUnconf, webConf ? propsWebC : propsUnconf,
                 bulbConf ? propsBulbC : propsUnconf];
  const MB = 1, MZ = 2;

  const E = inp.end || {}, J = inp.jn || {}, P = inp.tip || {};
  const Wd = inp.web || {}, Fd = inp.fl || {};
  const num = function (v) { v = +v; return isFinite(v) ? v : 0; };
  const endL = num(E.l), endN = Math.max(0, Math.round(num(E.n))), endD = num(E.d);
  const jLw = num(J.lw), jLf = num(J.lf), jNw = Math.max(0, Math.round(num(J.nw))),
        jNf = Math.max(0, Math.round(num(J.nf))), jD = num(J.d);
  const tipL = num(P.l), tipN = Math.max(0, Math.round(num(P.n))), tipD = num(P.d);
  const wD = num(Wd.d), wS = num(Wd.s), fD = num(Fd.d), fS = num(Fd.s);

  // ── talpa de la y = l_w: intinderea pe z
  //    L / Z: de la fata inimii din partea opusa lui `side` spre `side`
  //    T:     centrata
  let fz0, fz1;
  if (shape === 'T') { fz0 = -lf / 2; fz1 = lf / 2; }
  else if (side > 0) { fz0 = -tw / 2; fz1 = -tw / 2 + lf; }
  else { fz0 = tw / 2 - lf; fz1 = tw / 2; }

  // ── beton: dreptunghiuri; reflexia in punct pentru a doua jumatate a lui Z
  const refl = function (r) {   // (y,z) -> (l_w - y, -z)
    return { y0: lw - (r.y0 + r.wy), z0: -(r.z0 + r.wz), wy: r.wy, wz: r.wz, mat: r.mat };
  };
  const clampPos = function (v) { return v > 0 ? v : 0; };
  const rects = [];
  rects.push({ y0: 0, z0: -tw / 2, wy: lw, wz: tw, mat: MB });                 // inima
  const half = [];                                                             // jumatatea de la y = l_w
  half.push({ y0: lw - tf, z0: fz0, wy: tf, wz: fz1 - fz0, mat: MB });          // talpa
  // zone (material MZ): nodul pe inima + patratul, nodul pe talpa, varful talpii
  half.push({ y0: lw - tf - jLw, z0: -tw / 2, wy: tf + jLw, wz: tw, mat: MZ });
  if (shape === 'T') {
    half.push({ y0: lw - tf, z0: tw / 2, wy: tf, wz: Math.min(clampPos(jLf), fz1 - tw / 2), mat: MZ });
    half.push({ y0: lw - tf, z0: -tw / 2 - Math.min(clampPos(jLf), -tw / 2 - fz0), wy: tf,
                wz: Math.min(clampPos(jLf), -tw / 2 - fz0), mat: MZ });
    half.push({ y0: lw - tf, z0: fz1 - tipL, wy: tf, wz: tipL, mat: MZ });
    half.push({ y0: lw - tf, z0: fz0, wy: tf, wz: tipL, mat: MZ });
  } else if (side > 0) {
    half.push({ y0: lw - tf, z0: tw / 2, wy: tf, wz: Math.min(clampPos(jLf), fz1 - tw / 2), mat: MZ });
    half.push({ y0: lw - tf, z0: fz1 - tipL, wy: tf, wz: tipL, mat: MZ });
  } else {
    half.push({ y0: lw - tf, z0: -tw / 2 - Math.min(clampPos(jLf), -tw / 2 - fz0), wy: tf,
                wz: Math.min(clampPos(jLf), -tw / 2 - fz0), mat: MZ });
    half.push({ y0: lw - tf, z0: fz0, wy: tf, wz: tipL, mat: MZ });
  }
  half.forEach(function (r) { rects.push(r); });
  if (Z) half.forEach(function (r) { rects.push(refl(r)); });
  if (hasEnd) rects.push({ y0: 0, z0: -tw / 2, wy: endL, wz: tw, mat: MZ });
  const rectsOk = rects.filter(function (r) { return r.wy > 0 && r.wz > 0; });

  // ── armatura
  const bars = [];
  const cm = function (d) { return cnom + detr + d / 2; };
  function addBar(y, z, d, grp) {
    if (!(d > 0)) return;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (Math.hypot(b.y - y, b.z - z) < (b.d + d) / 2) return;   // colt comun
    }
    bars.push({ y: y, z: z, A: barArea(d), d: d, grp: grp });
  }
  // n pozitii egal distantate de la a la b, inclusiv capetele
  function lin(a, b, n) {
    if (n <= 0) return [];
    if (n === 1) return [(a + b) / 2];
    const out = [];
    for (let i = 0; i < n; i++) out.push(a + (b - a) * i / (n - 1));
    return out;
  }
  // pozitii interioare intervalului (a, b) la pasul cel mult s
  function fill(a, b, s) {
    if (!(s > 0) || !(b > a)) return [];
    const k = Math.max(0, Math.ceil((b - a) / s - 1e-9) - 1);
    const out = [];
    for (let i = 1; i <= k; i++) out.push(a + (b - a) * i / (k + 1));
    return out;
  }
  const halfBars = [];                 // barele jumatatii de la y = l_w
  const hb = function (y, z, d, g) { halfBars.push({ y: y, z: z, d: d, grp: g }); };

  // fetele inimii si ale talpii (pentru diametrul zonei respective)
  const zA = function (d) { return -tw / 2 + cm(d); }, zB = function (d) { return tw / 2 - cm(d); };
  const yO = function (d) { return lw - cm(d); }, yI = function (d) { return lw - tf + cm(d); };

  // nodul: cele 4 bare din patratul de intersectie
  [[yO(jD), zA(jD)], [yO(jD), zB(jD)], [yI(jD), zA(jD)], [yI(jD), zB(jD)]].forEach(function (c) {
    hb(c[0], c[1], jD, 'jn');
  });
  // nodul, pe inima: nw bare pe fiecare fata, de la capatul zonei spre patrat
  if (jNw > 0 && jLw > 0) {
    const y0 = lw - tf - jLw + cm(jD), y1 = yI(jD);
    for (let i = 0; i < jNw; i++) {
      const yy = y0 + (y1 - y0) * i / jNw;
      hb(yy, zA(jD), jD, 'jn'); hb(yy, zB(jD), jD, 'jn');
    }
  }
  // nodul, pe talpa: nf bare pe fiecare fata, de la patrat spre capatul zonei
  function flangeJn(dir) {           // dir = +1 spre +z, -1 spre -z
    if (!(jNf > 0) || !(jLf > 0)) return;
    const zs = dir > 0 ? zB(jD) : zA(jD);
    const edge = dir > 0 ? fz1 : fz0;
    let ze = (dir > 0 ? tw / 2 + jLf : -tw / 2 - jLf) - dir * cm(jD);
    if (dir > 0 ? ze > edge - cm(jD) : ze < edge + cm(jD)) ze = edge - dir * cm(jD);
    for (let i = 1; i <= jNf; i++) {
      const zz = zs + (ze - zs) * i / jNf;
      hb(yO(jD), zz, jD, 'jn'); hb(yI(jD), zz, jD, 'jn');
    }
  }
  // varful talpii
  function flangeTip(dir) {
    if (!(tipN > 0) || !(tipL > 0)) return;
    const edge = dir > 0 ? fz1 : fz0;
    const zs = edge - dir * cm(tipD), ze = edge - dir * (tipL - cm(tipD));
    lin(zs, ze, tipN).forEach(function (zz) { hb(yO(tipD), zz, tipD, 'tip'); hb(yI(tipD), zz, tipD, 'tip'); });
  }
  // bare distribuite pe talpa, intre nod si varf
  function flangeDist(dir) {
    const zj = dir > 0 ? tw / 2 + jLf : -tw / 2 - jLf;
    const edge = dir > 0 ? fz1 : fz0;
    const zt = edge - dir * tipL;
    const a = Math.min(zj, zt), b = Math.max(zj, zt);
    if (dir > 0 ? zt <= zj : zt >= zj) return;
    fill(a, b, fS).forEach(function (zz) { hb(yO(fD), zz, fD, 'fl'); hb(yI(fD), zz, fD, 'fl'); });
  }
  const dirs = (shape === 'T') ? [1, -1] : [side];
  dirs.forEach(function (dr) { flangeJn(dr); flangeTip(dr); flangeDist(dr); });

  // jumatatea de la y = l_w se adauga; la Z si reflexia ei in punct
  halfBars.forEach(function (b) { addBar(b.y, b.z, b.d, b.grp); });
  if (Z) halfBars.forEach(function (b) { addBar(lw - b.y, -b.z, b.d, b.grp); });

  // capatul liber al inimii (L, T)
  if (hasEnd && endN > 0 && endL > 0) {
    lin(cm(endD), endL - cm(endD), endN).forEach(function (yy) {
      addBar(yy, zA(endD), endD, 'end'); addBar(yy, zB(endD), endD, 'end');
    });
  }
  // bare distribuite pe inima, intre zone
  const webA = hasEnd ? endL : (tf + jLw);
  const webB = lw - tf - jLw;
  fill(webA, webB, wS).forEach(function (yy) {
    addBar(yy, zA(wD), wD, 'web'); addBar(yy, zB(wD), wD, 'web');
  });

  const m = buildPolyModel({
    rects: rectsOk, bars: bars.map(function (b) { return { y: b.y, z: b.z, A: b.A, grp: b.grp }; }),
    props: props, fyd: fyd, eud: 0.9 * st.euk,
    opts: Object.assign({ align: true }, inp.opts || {}, {
      NT: (inp.opts && inp.opts.NT) || 16,
      maxCells: (inp.opts && inp.opts.maxCells) || 60000,
    }),
  });

  // ── verificari de geometrie (nu opresc calculul pe tacute: se raporteaza)
  const issues = [];
  if (!(lw > 0) || !(tw > 0) || !(lf > 0) || !(tf > 0)) issues.push('dims');
  if (lf < tw) issues.push('lfShort');
  if (tf >= lw) issues.push('tfLong');
  if (webB < webA) issues.push('zonesOverlapWeb');
  if (shape === 'T') { if (tw / 2 + jLf > lf / 2 - tipL + 1e-6) issues.push('zonesOverlapFl'); }
  else if (tw / 2 + jLf > lf - tw / 2 - tipL + 1e-6) issues.push('zonesOverlapFl');

  const cnt = { end: 0, jn: 0, tip: 0, web: 0, fl: 0 };
  bars.forEach(function (b) { cnt[b.grp] = (cnt[b.grp] || 0) + 1; });
  Object.assign(m, {
    shape: shape, side: side, lw: lw, tw: tw, lf: lf, tf: tf, bw0: tw,
    cnom: cnom, detr: detr, fck: fck, fcd: fcd, fyk: st.fyk,
    euk: st.euk, eukAssumed: !!st.eukAssumed,
    confMode: confMode, bulbConf: bulbConf, webConf: webConf,
    ec2_nc: o.EC2_NC, ecu_nc: o.ECU_NC,
    concrete: inp.concrete, steel: inp.steel,
    barList: bars, cnt: cnt, cntTot: bars.length, zoneMat: MZ,
    shapeIssues: issues, barIssues: [],
  });
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORT
   ═══════════════════════════════════════════════════════════════════════════ */
global.JP.poly = {
  VERSION: VERSION,
  buildModel: buildPolyModel,
  buildWall2D: buildWall2D,
  buildShape2D: buildShape2D,
  solve: solvePoly,
  forces: polyForces,
  solveX: solvePolyX,
  findTheta: findPolyTheta,
  traceCurve: tracePolyCurve,
  axialLimits: polyAxialLimits,
  project: projectPoly,
  rasterize: rasterize,
  rasterizeAligned: rasterizeAligned,
  edgeStrain: edgeStrain,   // expusa ca testul sa o poata compara cu engine.js
};

})(typeof window !== 'undefined' ? window : globalThis);
