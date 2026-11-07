export function indexRelationships(db, namespace, key, snapshot) {
    if (!["cost-centers", "cost-center-detail", "budgets", "budget-detail"].includes(snapshot?.kind)) return;
    const isCenter = snapshot.kind === "cost-centers" || snapshot.kind === "cost-center-detail";
    const items = snapshot.kind === "cost-centers" || snapshot.kind === "budgets" ? snapshot.data : [snapshot.data];
    const payload = isCenter ? items.map(({id, name}) => ({id, name})) : items;
    const kind = snapshot.complete === false && snapshot.kind === "cost-centers" ? "cost-center-partial" :
        snapshot.complete === false && snapshot.kind === "budgets" ? "budget-partial" : snapshot.kind;
    const sourceKey = kind.endsWith("-partial") ? `${key}:partial` : key;
    const encoded = JSON.stringify(payload);
    const previous = db.prepare("SELECT fetched_at, payload, kind FROM relationship_sources WHERE namespace = ? AND snapshot_key = ?").get(namespace, sourceKey);
    if (previous?.fetched_at === snapshot.fetchedAt && previous.payload === encoded && previous.kind === kind) return;
    const revision = db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM relationship_sources WHERE namespace = ?").get(namespace).revision;
    db.prepare(`
        INSERT INTO relationship_sources VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, snapshot_key) DO UPDATE SET kind = excluded.kind,
            fetched_at = excluded.fetched_at, revision = excluded.revision, payload = excluded.payload
    `).run(namespace, sourceKey, kind, snapshot.fetchedAt, revision, encoded);
    db.prepare("DELETE FROM relationship_centers WHERE namespace = ?").run(namespace);
    db.prepare("DELETE FROM relationship_budgets WHERE namespace = ?").run(namespace);
    db.prepare("DELETE FROM budget_cost_centers WHERE namespace = ?").run(namespace);
    const center = db.prepare(`
        INSERT INTO relationship_centers VALUES (?, ?, ?, ?)
        ON CONFLICT(namespace, id) DO UPDATE SET name = excluded.name, fetched_at = excluded.fetched_at
    `);
    const budget = db.prepare(`
        INSERT INTO relationship_budgets VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, id) DO UPDATE SET scope = excluded.scope, target = excluded.target,
            payload = excluded.payload, fetched_at = excluded.fetched_at
    `);
    // Replay complete lists and newer details in order so old detail caches cannot resurrect removals.
    for (const source of db.prepare("SELECT * FROM relationship_sources WHERE namespace = ? ORDER BY fetched_at, revision").all(namespace)) {
        if (source.kind === "cost-centers") db.prepare("DELETE FROM relationship_centers WHERE namespace = ?").run(namespace);
        if (source.kind === "budgets") db.prepare("DELETE FROM relationship_budgets WHERE namespace = ?").run(namespace);
        for (const item of JSON.parse(source.payload)) {
            if (source.kind.startsWith("cost-center")) {
                center.run(namespace, item.id, item.name, source.fetched_at);
            } else {
                budget.run(namespace, item.id, item.scope, item.entity ?? null, JSON.stringify(item), source.fetched_at);
            }
        }
    }
    db.prepare(`
        INSERT INTO budget_cost_centers
        SELECT b.namespace, b.id, c.id, 'id' FROM relationship_budgets b
        JOIN relationship_centers c ON c.namespace = b.namespace AND c.id = b.target
        WHERE b.namespace = ? AND b.scope IN ('cost_center', 'multi_user_cost_center')
    `).run(namespace);
    const completeCenters = db.prepare("SELECT 1 FROM relationship_sources WHERE namespace = ? AND kind = 'cost-centers' LIMIT 1").get(namespace);
    if (completeCenters) {
        db.prepare(`
            INSERT INTO budget_cost_centers
            SELECT b.namespace, b.id, c.id, 'exact_unique_name' FROM relationship_budgets b
            JOIN relationship_centers c ON c.namespace = b.namespace AND c.name = b.target
            WHERE b.namespace = ? AND b.scope IN ('cost_center', 'multi_user_cost_center')
              AND NOT EXISTS (SELECT 1 FROM budget_cost_centers e WHERE e.namespace = b.namespace AND e.budget_id = b.id)
              AND (SELECT COUNT(*) FROM relationship_centers other WHERE other.namespace = b.namespace AND other.name = b.target) = 1
        `).run(namespace);
    }
}

export function readRelationships(db, namespace) {
    const centers = db.prepare("SELECT id, name, fetched_at AS fetchedAt FROM relationship_centers WHERE namespace = ?").all(namespace);
    const budgets = db.prepare("SELECT payload, fetched_at FROM relationship_budgets WHERE namespace = ?").all(namespace)
        .map(row => ({...JSON.parse(row.payload), fetchedAt: row.fetched_at}));
    const links = db.prepare("SELECT budget_id AS budgetId, center_id AS centerId, matched_by AS matchedBy FROM budget_cost_centers WHERE namespace = ?").all(namespace);
    const coverage = kind => db.prepare(`
        SELECT r.fetched_at AS fetchedAt, s.last_error AS error FROM relationship_sources r
        LEFT JOIN snapshots s ON s.cache_key = r.snapshot_key
        WHERE r.namespace = ? AND r.kind = ? ORDER BY r.fetched_at DESC, r.revision DESC LIMIT 1
    `).get(namespace, kind) ?? null;
    const lists = {centers: coverage("cost-centers"), budgets: coverage("budgets")};
    const unresolved = budgets.filter(budget => ["cost_center", "multi_user_cost_center"].includes(budget.scope) &&
        !links.some(link => link.budgetId === budget.id)).map(budget => ({
        budgetId: budget.id,
        reason: !budget.entity ? "entity_unavailable" : !lists.centers ? "centers_not_loaded" :
            centers.filter(center => center.name === budget.entity).length > 1 ? "ambiguous_name" : "unmatched",
    }));
    return {centers, budgets, links, lists, unresolved};
}
