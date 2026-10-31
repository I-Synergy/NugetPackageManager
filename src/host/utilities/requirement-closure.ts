/**
 * Transitive closure of the requirements a batch selection introduces.
 *
 * A single update can pull in a chain: the new version requires a sibling, that
 * sibling requires a newer `Microsoft.Extensions.*`, and so on. Checking only the
 * first level reports a partial plan, so the closure is computed to a fixpoint —
 * bounded by a package budget — and the caller turns it into a change plan.
 *
 * Pure: the caller supplies dependency metadata per (id, version, TFM).
 */

import { RangeLowerBound } from "../../common/package-range";
import { compareVersions, satisfiesVersionRange } from "./version";

export interface ClosureDependency {
    Id: string;
    Range: string;
}

export interface ClosureConflict {
    /** The package that must be raised. */
    PackageId: string;
    /** Version of the package that declares the requirement. */
    RequiredByVersion: string;
    RequiredBy: string;
    Range: string;
    RequiredVersion: string;
    Tfm: string;
}

export interface ClosureInput {
    Selected: Array<{ Id: string; Version: string }>;
    Tfms: string[];
    /** Currently resolved versions, keyed by lower-case package id. */
    Effective: Map<string, string>;
    GetDependencies: (
        id: string,
        version: string,
        tfm: string
    ) => Promise<ClosureDependency[] | null>;
    /**
     * Whether some reference or pin actually holds `id` at its current version.
     *
     * Only then is a newer requirement a conflict: a package that is purely
     * transitive is resolved upward by NuGet on its own, so reporting it would
     * block updates that restore fine.
     */
    IsConstrained?: (id: string, tfm: string) => boolean;
    /** Safety budget for packages inspected (default 250). */
    MaxInspected?: number;
}

export interface ClosureResult {
    Conflicts: ClosureConflict[];
    /** Effective versions after applying every required version. */
    Planned: Map<string, string>;
}

const DEFAULT_MAX_INSPECTED = 250;

interface ClosureItem {
    id: string;
    version: string;
    tfm: string;
}

interface ClosureState {
    planned: Map<string, string>;
    seen: Set<string>;
    conflicts: ClosureConflict[];
    inspected: number;
    maxInspected: number;
}

export async function ComputeRequirementClosureAsync(
    input: ClosureInput
): Promise<ClosureResult> {
    const planned = BuildInitialPlan(input);
    const queue = BuildInitialQueue(input);
    const state: ClosureState = {
        planned,
        seen: new Set<string>(),
        conflicts: [],
        inspected: 0,
        maxInspected: input.MaxInspected ?? DEFAULT_MAX_INSPECTED,
    };

    while (queue.length > 0 && state.inspected < state.maxInspected) {
        const item = queue.shift()!;
        await InspectItemAsync(input, item, queue, state);
    }

    return { Conflicts: state.conflicts, Planned: planned };
}

/** The graph as planned: what is installed, overlaid with the selection. */
function BuildInitialPlan(input: ClosureInput): Map<string, string> {
    const planned = new Map(input.Effective);
    for (const selected of input.Selected) {
        planned.set(selected.Id.toLowerCase(), selected.Version);
    }
    return planned;
}

function BuildInitialQueue(input: ClosureInput): ClosureItem[] {
    const queue: ClosureItem[] = [];
    for (const selected of input.Selected) {
        for (const tfm of input.Tfms) {
            queue.push({ id: selected.Id, version: selected.Version, tfm });
        }
    }
    return queue;
}

async function InspectItemAsync(
    input: ClosureInput,
    item: ClosureItem,
    queue: ClosureItem[],
    state: ClosureState
): Promise<void> {
    const key = `${item.id.toLowerCase()}@${item.version}|${item.tfm}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    state.inspected++;

    const dependencies = await input.GetDependencies(item.id, item.version, item.tfm);
    if (!dependencies) return;
    for (const dependency of dependencies) {
        VisitDependency(input, item, dependency, queue, state);
    }
}

function VisitDependency(
    input: ClosureInput,
    item: ClosureItem,
    dependency: { Id: string; Range: string },
    queue: ClosureItem[],
    state: ClosureState
): void {
    const dependencyId = dependency.Id.toLowerCase();
    const resolved = state.planned.get(dependencyId);
    if (resolved && satisfiesVersionRange(resolved, dependency.Range)) return;

    const requiredVersion = RangeLowerBound(dependency.Range);
    if (!requiredVersion) return;

    const constrained = input.IsConstrained ? input.IsConstrained(dependency.Id, item.tfm) : true;
    if (constrained) {
        state.conflicts.push({
            PackageId: dependency.Id,
            RequiredBy: item.id,
            RequiredByVersion: item.version,
            Range: dependency.Range,
            RequiredVersion: requiredVersion,
            Tfm: item.tfm,
        });
    }

    const current = state.planned.get(dependencyId);
    if (!current || compareVersions(requiredVersion, current) > 0) {
        state.planned.set(dependencyId, requiredVersion);
    }
    queue.push({ id: dependency.Id, version: requiredVersion, tfm: item.tfm });
}

export interface RequirementOrder {
    /** 0 = nothing it requires must move first; higher = apply later. */
    Order: number;
    /** Packages that must already be at their new version. */
    DependsOn: string[];
}

/**
 * Orders the packages a plan touches so dependencies move first.
 *
 * `RequiredBy requires Package` becomes an edge `Requires -> Dependency`; the
 * order of a package is one more than the deepest package it depends on, so
 * "step 1" never needs something a later step installs. Cycles are tolerated
 * (they collapse to the same step) rather than throwing.
 */
export function OrderRequirements(conflicts: ClosureConflict[]): Map<string, RequirementOrder> {
    const dependencies = new Map<string, Set<string>>();
    const ids = new Set<string>();

    const ensure = (id: string): Set<string> => {
        const existing = dependencies.get(id);
        if (existing) return existing;
        const created = new Set<string>();
        dependencies.set(id, created);
        ids.add(id);
        return created;
    };

    for (const conflict of conflicts) {
        const dependent = conflict.RequiredBy.toLowerCase();
        const dependency = conflict.PackageId.toLowerCase();
        ensure(dependent).add(dependency);
        ensure(dependency);
    }

    const orders = new Map<string, number>();
    const visit = (id: string, stack: Set<string>): number => {
        const known = orders.get(id);
        if (known !== undefined) return known;
        if (stack.has(id)) return 0;
        stack.add(id);
        let order = 0;
        for (const dependency of dependencies.get(id) ?? []) {
            order = Math.max(order, visit(dependency, stack) + 1);
        }
        stack.delete(id);
        orders.set(id, order);
        return order;
    };

    for (const id of ids) visit(id, new Set());
    return new Map(
        [...orders].map(([id, order]) => [id, { Order: order, DependsOn: [...(dependencies.get(id) ?? [])] }])
    );
}
