
namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>Dependency metadata for one concrete package version and framework.</summary>
public delegate Task<IReadOnlyList<ClosureDependency>?> DependencyLookup(
    string id,
    string version,
    string tfm,
    CancellationToken cancellationToken);

/// <summary>
/// Transitive closure of the requirements a batch selection introduces.
///
/// A single update can pull in a chain: the new version requires a sibling, that sibling
/// requires a newer <c>Microsoft.Extensions.*</c>, and so on. Checking only the first level
/// reports a partial plan, so the closure is computed to a fixpoint — bounded by a package
/// budget — and the caller turns it into a change plan.
/// </summary>
public static class RequirementClosure
{
    public const int DefaultMaxInspected = 250;

    /// <param name="selected">Packages the user is moving.</param>
    /// <param name="tfms">Target frameworks the selection applies to.</param>
    /// <param name="effective">Currently resolved versions, keyed by lower-case package id.</param>
    /// <param name="getDependencies">Dependency metadata for one (id, version, TFM).</param>
    /// <param name="isConstrained">
    /// Whether some reference or pin actually holds the package at its current version. Only
    /// then is a newer requirement a conflict: a purely transitive package is resolved upward
    /// by NuGet on its own, so reporting it would block updates that restore fine.
    /// </param>
    /// <param name="maxInspected">Safety budget for packages inspected.</param>
    /// <param name="cancellationToken">Cancels the metadata lookups and the walk.</param>
    public static async Task<ClosureResult> ComputeAsync(
        IReadOnlyList<SelectedPackage> selected,
        IReadOnlyList<string> tfms,
        IReadOnlyDictionary<string, string> effective,
        DependencyLookup getDependencies,
        Func<string, string, bool> isConstrained,
        int maxInspected,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(selected);
        ArgumentNullException.ThrowIfNull(tfms);
        ArgumentNullException.ThrowIfNull(effective);
        ArgumentNullException.ThrowIfNull(getDependencies);
        ArgumentNullException.ThrowIfNull(isConstrained);

        var planned = new Dictionary<string, string>(effective, StringComparer.OrdinalIgnoreCase);

        foreach (var package in selected)
        {
            planned[package.Id.ToLowerInvariant()] = package.Version;
        }

        var queue = new Queue<ClosureItem>(
            from package in selected
            from tfm in tfms
            select new ClosureItem(package.Id, package.Version, tfm));

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var conflicts = new List<ClosureConflict>();
        var inspected = 0;
        var budget = maxInspected > 0 ? maxInspected : DefaultMaxInspected;

        while (queue.Count > 0 && inspected < budget)
        {
            var item = queue.Dequeue();
            var key = $"{item.Id.ToLowerInvariant()}@{item.Version}|{item.Tfm}";
            if (!seen.Add(key))
            {
                continue;
            }

            inspected++;

            var dependencies = await getDependencies(item.Id, item.Version, item.Tfm, cancellationToken)
                .ConfigureAwait(false);
            if (dependencies is null)
            {
                continue;
            }

            foreach (var dependency in dependencies)
            {
                VisitDependency(dependency, item, planned, conflicts, queue, isConstrained);
            }
        }

        return new ClosureResult
        {
            Conflicts = conflicts,
            Planned = planned,
        };
    }

    /// <summary>
    /// Orders the packages a plan touches so dependencies move first.
    ///
    /// <c>RequiredBy requires Package</c> becomes an edge <c>Requires -> Dependency</c>; the
    /// order of a package is one more than the deepest package it depends on, so "step 1"
    /// never needs something a later step installs. Cycles collapse to the same step instead
    /// of throwing.
    /// </summary>
    public static IReadOnlyDictionary<string, RequirementOrder> Order(
        IReadOnlyList<ClosureConflict> conflicts)
    {
        ArgumentNullException.ThrowIfNull(conflicts);

        var dependencies = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

        HashSet<string> Ensure(string id)
        {
            if (dependencies.TryGetValue(id, out var existing))
            {
                return existing;
            }

            var created = new HashSet<string>(StringComparer.Ordinal);
            dependencies[id] = created;
            return created;
        }

        foreach (var conflict in conflicts)
        {
            Ensure(conflict.RequiredBy.ToLowerInvariant()).Add(conflict.PackageId.ToLowerInvariant());
            Ensure(conflict.PackageId.ToLowerInvariant());
        }

        var orders = new Dictionary<string, int>(StringComparer.Ordinal);

        int Visit(string id, HashSet<string> stack)
        {
            if (orders.TryGetValue(id, out var known))
            {
                return known;
            }

            if (!stack.Add(id))
            {
                return 0;
            }

            var order = 0;
            foreach (var dependency in dependencies[id])
            {
                order = Math.Max(order, Visit(dependency, stack) + 1);
            }

            stack.Remove(id);
            orders[id] = order;
            return order;
        }

        // The keys are every package named by a conflict, in insertion order.
        foreach (var id in dependencies.Keys)
        {
            Visit(id, []);
        }

        return orders.ToDictionary(
            entry => entry.Key,
            entry => new RequirementOrder
            {
                Order = entry.Value,
                DependsOn = [.. dependencies[entry.Key]],
            },
            StringComparer.Ordinal);
    }

    private static void VisitDependency(
        ClosureDependency dependency,
        ClosureItem item,
        Dictionary<string, string> planned,
        List<ClosureConflict> conflicts,
        Queue<ClosureItem> queue,
        Func<string, string, bool> isConstrained)
    {
        var dependencyId = dependency.Id.ToLowerInvariant();

        if (planned.TryGetValue(dependencyId, out var resolved)
            && VersionSemantics.Satisfies(resolved, dependency.Range))
        {
            return;
        }

        var requiredVersion = VersionSemantics.RangeLowerBound(dependency.Range);
        if (requiredVersion is null)
        {
            return;
        }

        if (isConstrained(dependency.Id, item.Tfm))
        {
            conflicts.Add(new ClosureConflict
            {
                PackageId = dependency.Id,
                RequiredBy = item.Id,
                RequiredByVersion = item.Version,
                Range = dependency.Range,
                RequiredVersion = requiredVersion,
                Tfm = item.Tfm,
            });
        }

        if (!planned.TryGetValue(dependencyId, out var current)
            || VersionSemantics.Compare(requiredVersion, current) > 0)
        {
            planned[dependencyId] = requiredVersion;
        }

        queue.Enqueue(new ClosureItem(dependency.Id, requiredVersion, item.Tfm));
    }

    private sealed record ClosureItem(string Id, string Version, string Tfm);
}
