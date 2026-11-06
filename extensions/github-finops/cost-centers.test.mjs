import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCostCenters, normalizeCenter } from "./cost-centers.mjs";
import { paginateCenters, resourceTypeLabels } from "./ui/pagination.mjs";

const input = { enterprise: "example-enterprise", host: "github.com" };
const center = (fields = {}) => ({
    id: "center-one", name: "Engineering", state: "active",
    resources: [], ai_credit_pool_enabled: false, ...fields,
});

test("loads all cost centers and preserves actual pool/Azure fields without invented defaults", async () => {
    const result = await loadCostCenters(input, async () => ({costCenters: [
        center({id: "center-two", name: "Support", azure_subscription: null}),
        center({ai_credit_pool_enabled: true, ai_credit_pool_state: {target_amount: 20, current_amount: null}}),
    ]}));
    assert.equal(result[0].name, "Engineering");
    assert.equal(result[0].aiCreditPoolEnabled, true);
    assert.equal(result[0].aiCreditPoolState.currentAmount, null);
    assert.equal(result[0].azureSubscription, undefined);
    assert.equal(result[1].azureSubscription, null);
    assert.equal(normalizeCenter(center({ai_credit_pool_enabled: undefined})).aiCreditPoolEnabled, undefined);
});

test("fetches every resource page and deduplicates resources across pages", async () => {
    const calls = [];
    const detail = await loadCostCenters(input, async path => {
        calls.push(path);
        return path.endsWith("page=1")
            ? {...center(), resources: [{type:"User",name:"member-one"}], has_next_page:true}
            : {...center(), resources: [{type:"User",name:"member-one"},{type:"Team",name:"engineering"}], has_next_page:false};
    }, "center-one");
    assert.equal(calls.length, 2);
    assert.match(calls[0], /per_page=100&page=1$/);
    assert.equal(detail.resources.length, 2);
    assert.equal(detail.resourcesComplete, true);
    assert.deepEqual(resourceTypeLabels(detail.resources, detail.resourcesComplete), ["Enterprise team", "User"]);
});

test("classifies all distinct resource types including mixed assignments and future types", () => {
    const resources = ["User", "Org", "Repo", "Team", "User", "organization", "FutureResource"]
        .map(type => ({type, name: "example"}));
    const normalized = normalizeCenter(center({resources}));
    assert.deepEqual(resourceTypeLabels(normalized.resources, normalized.resourcesComplete),
        ["Enterprise team", "FutureResource", "Organization", "Repository", "User"]);
    assert.deepEqual(resourceTypeLabels([{type: "User"}]), ["User"]);
});

test("distinguishes empty, unavailable and incomplete resource assignments", async () => {
    assert.deepEqual(resourceTypeLabels([]), ["No assigned resources"]);
    assert.deepEqual(resourceTypeLabels(undefined), ["Unavailable"]);
    assert.deepEqual(resourceTypeLabels(null), ["Unavailable"]);
    const [partial] = await loadCostCenters(input, async () => ({costCenters: [
        center({resources: [{type: "User", name: "example"}], has_next_page: true}),
    ]}));
    assert.equal(partial.resourcesComplete, false);
    assert.deepEqual(resourceTypeLabels(partial.resources, partial.resourcesComplete), ["Unavailable (partial assignments)"]);
    assert.deepEqual(resourceTypeLabels([] , false), ["Unavailable (partial assignments)"]);
});

test("rejects invalid IDs, incomplete pagination, repeated pages and unexpected detail identity", async () => {
    await assert.rejects(loadCostCenters(input, async () => ({}), "../other"));
    await assert.rejects(loadCostCenters(input, async () => center(), "center-one"), /resource page/);
    await assert.rejects(loadCostCenters(input, async () => ({...center(), has_next_page:true})), /cost center list/);
    await assert.rejects(loadCostCenters(input, async () => ({
        ...center(), resources:[{type:"User",name:"member-one"}], has_next_page:true,
    }), "center-one"), /non-progressing/);
    await assert.rejects(loadCostCenters(input, async () => ({
        ...center({id:"another-center"}), has_next_page:false,
    }), "center-one"), /resource page/);
});

test("visible pages never exceed 25 rows and search covers the full list", () => {
    const centers = Array.from({length:53}, (_,index) => ({
        id:`center-${index}`, name:`Team ${index}`, state:index === 52 ? "deleted" : "active",
    }));
    assert.equal(paginateCenters(centers, "", 1).items.length, 25);
    assert.equal(paginateCenters(centers, "", 2).items.length, 25);
    assert.equal(paginateCenters(centers, "", 3).items.length, 3);
    const search = paginateCenters(centers, "  DELETED ", 3);
    assert.equal(search.total, 1);
    assert.equal(search.page, 1);
    assert.equal(search.items[0].id, "center-52");
    assert.equal(paginateCenters(centers, "center-51", 1).total, 1);
    assert.equal(paginateCenters(centers, "no match", 99).start, 0);
});

test("clamps pages at empty and exact 25-row boundaries", () => {
    for (const size of [0,25,26,50,51]) {
        const centers = Array.from({length:size}, (_,i) => ({name:`Team ${i}`,id:`center-${i}`}));
        const result = paginateCenters(centers, "", 999);
        assert.equal(result.pages, Math.max(1, Math.ceil(size / 25)));
        assert.equal(result.page, result.pages);
        assert.ok(result.items.length <= 25);
        assert.equal(result.end, size);
    }
});
