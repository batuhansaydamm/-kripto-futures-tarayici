import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveStagedTargets } from "../src/radar.js";

test("bariyer yokken standart R planına düşer (1R / 1.5R / 2.5R)", () => {
  const targets = deriveStagedTargets("LONG", 100, 2, []);
  assert.equal(targets.blockingBarrier, false);
  assert.equal(targets.tp1, 102); // 100 + 1*2
  assert.equal(targets.tp2, 103); // 100 + 1.5*2
  assert.equal(targets.tp3, 105); // 100 + 2.5*2
});

test("0.45R altında güçlü bariyer varsa işlemi engeller", () => {
  const barriers = [{ price: 100.5, label: "Test direnç", score: 4 }];
  const targets = deriveStagedTargets("LONG", 100, 2, barriers);
  assert.equal(targets.blockingBarrier, true);
  assert.equal(targets.blockingLabel, "Test direnç");
});

test("0.45-1.05R arası güçlü bariyer TP1'i engelin önüne çeker", () => {
  const barriers = [{ price: 101.6, label: "Günlük açılış", score: 3 }];
  // distanceR = (101.6-100)/2 = 0.8 -> safeR ~ 0.8*0.86 = 0.688
  const targets = deriveStagedTargets("LONG", 100, 2, barriers);
  assert.equal(targets.blockingBarrier, false);
  assert.ok(targets.safeR < 1, `safeR ${targets.safeR} 1'den küçük olmalı`);
  assert.equal(targets.barrierUsedTp1, "Günlük açılış");
});

test("zayıf bariyer (score<3) hedefi etkilemez", () => {
  const barriers = [{ price: 100.5, label: "Zayıf seviye", score: 1 }];
  const targets = deriveStagedTargets("LONG", 100, 2, barriers);
  assert.equal(targets.blockingBarrier, false);
  assert.equal(targets.tp1, 102);
});

test("SHORT yönünde bariyer mesafesi doğru işaretle hesaplanır", () => {
  const barriers = [{ price: 98.4, label: "Test destek", score: 4 }];
  // direction = -1, distanceR = (-1*(98.4-100))/2 = 0.8
  const targets = deriveStagedTargets("SHORT", 100, 2, barriers);
  assert.equal(targets.blockingBarrier, false);
  assert.ok(targets.safeR < 1);
});

test("risk sıfırsa entry'ye eşit hedef döner, hata fırlatmaz", () => {
  const targets = deriveStagedTargets("LONG", 100, 0, []);
  assert.equal(targets.tp1, 100);
  assert.equal(targets.tp2, 100);
  assert.equal(targets.tp3, 100);
});
