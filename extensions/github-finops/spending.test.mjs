import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSpending, loadSpending, loadUserSpending } from "./spending.mjs";

const period = { year: 2025, month: 1 };
const row = (grossAmount, discountAmount, netAmount) => ({
    unitType: "ai-credits", grossAmount, discountAmount, netAmount,
});
const report = usageItems => ({ timePeriod: period, usageItems });

test("sums gross, coverage and net across rows without rounding away small amounts", () => {
    const result = normalizeSpending(report([
        { ...row(10, 8, 2), product: "Copilot" },
        { ...row(0.004, 0, 0.004), product: "Advanced Security" },
        { ...row(0.004, 0, 0.004), product: "Code Quality" },
    ]), period);
    assert.equal(result.status, "available");
    assert.ok(Math.abs(result.gross - 10.008) < 1e-9);
    assert.equal(result.discount, 8);
    assert.ok(Math.abs(result.net - 2.008) < 1e-9);
});

test("explicit zero-valued rows establish zero, but an empty report stays unavailable", () => {
    assert.equal(normalizeSpending(report([row(0, 0, 0)]), period).net, 0);
    const empty = normalizeSpending(report([]), period);
    assert.equal(empty.status, "unavailable");
    assert.equal(empty.net, undefined);
});

test("rejects missing amounts, malformed units, inconsistent totals and restricted periods/scope", () => {
    for (const invalid of [
        { ...row(1, 0, 1), netAmount: undefined },
        { ...row(1, 0, 1), grossAmount: "1" },
        { ...row(1, 0, 1), discountAmount: NaN },
        { ...row(1, 0, 1), unitType: "requests" },
        row(10, 8, 9),
    ]) {
        assert.throws(() => normalizeSpending(report([invalid]), period));
    }
    assert.throws(() => normalizeSpending({ timePeriod: period }, period));
    assert.throws(() => normalizeSpending({ ...report([]), timePeriod: { year: 2025, month: 2 } }, period));
    assert.throws(() => normalizeSpending({ ...report([]), timePeriod: { ...period, day: 1 } }, period));
    assert.throws(() => normalizeSpending({ ...report([]), costCenter: { id: "none" } }, period));
});

test("requests the UTC billing month without narrowing enterprise allocation scope", async () => {
    let request;
    const result = await loadSpending({ enterprise: "example-enterprise", host: "github.com" }, async (path, host) => {
        request = { path, host };
        return report([row(1, 0, 1)]);
    }, new Date("2024-12-31T23:30:00-02:00"));
    assert.equal(request.path, "/enterprises/example-enterprise/settings/billing/ai_credit/usage?year=2025&month=1");
    assert.equal(request.host, "github.com");
    assert.deepEqual(result.period, period);
});

test("user reports require the echoed user filter and an empty user report is not zero", async () => {
    const userReport = (user, items = [row(4, 3, 1)]) => ({ ...report(items), user });
    assert.equal(normalizeSpending(userReport("Sample-User"), period, "sample-user").net, 1);
    for (const echoed of [undefined, "other-user"]) assert.throws(() => normalizeSpending(userReport(echoed), period, "sample-user"), /confirm/);
    assert.throws(() => normalizeSpending({ ...userReport("sample-user"), organization: "example-org" }, period, "sample-user"));
    const empty = normalizeSpending(userReport("sample-user", []), period, "sample-user");
    assert.equal(empty.status, "none_reported");
    assert.equal(empty.net, undefined);
    let path;
    const loaded = await loadUserSpending({ enterprise: "example-enterprise", host: "github.com" }, async value => {
        path = value; return userReport("sample-user");
    }, "sample-user", new Date("2025-01-15T00:00:00Z"));
    assert.equal(path, "/enterprises/example-enterprise/settings/billing/ai_credit/usage?year=2025&month=1&user=sample-user");
    assert.equal(loaded.status, "available");
    const denied = await loadUserSpending({ enterprise: "example-enterprise", host: "github.com" }, async () => {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
    }, "sample-user", new Date("2025-01-15T00:00:00Z"));
    assert.equal(denied.status, "error");
    assert.equal(denied.denied, true);
    assert.equal(denied.net, undefined);
});
