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

export async function ComputeRequirementClosureAsync(
    input: ClosureInput
): Promise<ClosureResult> {
    const planned = new Map(input.Effective);
    for (const selected of input.Selected) {
        planned.set(selected.Id.toLowerCase(), selected.Version);
    }

    const queue: Array<{ id: string; version: string; tfm: string }> = [];
    for (const selected of input.Selected) {
        for (const tfm of input.Tfms) {
            queue.push({ id: selected.Id, version: selected.Version, tfm });
        }
    }

    const seen = new Set<string>();
    const conflicts: ClosureConflict[] = [];
    const maxInspected = input.MaxInspected ?? DEFAULT_MAX_INSPECTED;
    let inspected = 0;

    while (queue.length > 0 && inspected < maxInspected) {
        const item = queue.shift()!;
        const key = `${item.id.toLowerCase()}@${item.version}|${item.tfm}`;
        if (seen.has(key)) continue;
        seen.add(key);
        inspected++;

        const dependencies = await input.GetDependencies(item.id, item.version, item.tfm);
        if (!dependencies) continue;

        for (const dependency of dependencies) {
            const dependencyId = dependency.Id.toLowerCase();
            const resolved = planned.get(dependencyId);
            if (resolved && satisfiesVersionRange(resolved, dependency.Range)) continue;

            const requiredVersion = RangeLowerBound(dependency.Range);
            if (!requiredVersion) continue;

            const constrained = input.IsConstrained ? input.IsConstrained(dependency.Id, item.tfm) : true;
            if (constrained) {
                conflicts.push({
                    PackageId: dependency.Id,
                    RequiredBy: item.id,
                    RequiredByVersion: item.version,
                    Range: dependency.Range,
                    RequiredVersion: requiredVersion,
                    Tfm: item.tfm,
                });
            }

            const current = planned.get(dependencyId);
            if (!current || compareVersions(requiredVersion, current) > 0) {
                planned.set(dependencyId, requiredVersion);
            }
            queue.push({ id: dependency.Id, version: requiredVersion, tfm: item.tfm });
        }
    }

    return { Conflicts: conflicts, Planned: planned };
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
