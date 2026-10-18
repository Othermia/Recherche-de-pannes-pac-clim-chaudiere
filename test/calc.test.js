import { test } from "node:test";
import assert from "node:assert/strict";
import * as c from "../public/calc.js";

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);

test("masse volumique de l'eau", () => {
  near(c.waterDensity(4), 1000, 0.1);
  near(c.waterDensity(20), 998.2, 0.2);
  near(c.waterDensity(80), 971.8, 0.3);
});

test("débit : 10 kW à ΔT 5 K ≈ 1,72 m³/h (règle 0,86·P/ΔT)", () => {
  const r = c.debit({ puissance: 10, deltaT: 5, temperature: 40 });
  near(r.m3h, 1.73, 0.02);
  near(r.lmin, 28.8, 0.4);
});

test("débit / puissance réciproques", () => {
  const q = c.debit({ puissance: 8, deltaT: 7 }).m3h;
  near(c.puissanceDepuisDebit({ debitM3h: q, deltaT: 7 }), 8, 1e-9);
});

test("glycol augmente le débit nécessaire", () => {
  assert.ok(c.debit({ puissance: 10, deltaT: 5, fluide: "mpg30" }).m3h > c.debit({ puissance: 10, deltaT: 5 }).m3h);
});

test("perte de charge cuivre 22x1 à 1 m³/h dans la plage attendue", () => {
  const r = c.perteCharge({ debitM3h: 1, diametreMm: 20, rugositeMm: 0.0015, temperature: 40 });
  near(r.v, 0.884, 0.01);
  assert.ok(r.r > 350 && r.r < 550, `R = ${r.r}`);
});

test("dimensionnement recommande un diamètre", () => {
  // 1,7 m³/h : 28x1 ≈ 0,9 m/s et ≈ 340 Pa/m, donc 35x1,2 avec R ≤ 200 Pa/m
  assert.equal(c.dimensionnerTube({ debitM3h: 1.7, materiau: "cuivre" }).conseil, "35x1,2");
  assert.equal(c.dimensionnerTube({ debitM3h: 1.7, materiau: "cuivre", rMax: 400 }).conseil, "28x1");
});

test("loi d'eau : passe par le point de base et vaut Tint à Text = Tint", () => {
  const p = { tint: 20, textBase: -7, tdepBase: 45, deltaTBase: 7, n: 1.3 };
  near(c.loiEauPoint({ ...p, text: -7 }).depart, 45, 1e-9);
  near(c.loiEauPoint({ ...p, text: 20 }).depart, 20, 1e-9);
  const mid = c.loiEauPoint({ ...p, text: 6.5 }).depart;
  assert.ok(mid > 32.5 && mid < 36, `courbe convexe attendue, obtenu ${mid}`);
  const l = c.loiEau({ ...p });
  assert.ok(l.pente > 0.5 && l.pente < 1.2);
});

test("vase d'expansion 150 L, 80 °C, 3 bar", () => {
  const r = c.vaseExpansion({ volume: 150, tMax: 80, hauteurStatique: 6, soupape: 3 });
  near(r.e, 0.0287, 0.001);
  near(r.pi, 0.9, 1e-9);
  near(r.pf, 2.5, 1e-9);
  assert.ok(r.vn > 15 && r.vn < 20, `Vn = ${r.vn}`);
  assert.equal(c.vaseCommercial(r.vn), 18);
});

test("volume mini anti-court-cycle", () => {
  near(c.volumeMini({ puissanceMin: 5, dureeMin: 6, hysteresis: 5 }).litres, 86, 1);
});

test("Kv", () => {
  near(c.kvRequis(1, 0.1), 3.162, 0.001);
  near(c.dpVanne(1, 3.162), 0.1, 0.001);
});

test("frigo : SH haut + SC bas = manque de charge", () => {
  const r = c.frigo({ tSatEvap: 2, tAspiration: 18, tSatCond: 40, tLiquide: 39 });
  assert.equal(r.sh, 16);
  assert.match(r.interpretation, /Manque de fluide/);
});
