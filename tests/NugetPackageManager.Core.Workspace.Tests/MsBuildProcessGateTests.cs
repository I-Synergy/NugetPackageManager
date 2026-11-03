// File: tests/NugetPackageManager.Core.Workspace.Tests/MsBuildProcessGateTests.cs
// Traces: .ai/plans/large-workspace-scan-performance.md, Phase 2 — one shared gate caps the
// combined `dotnet msbuild` spawn count of CpmEvaluator and TargetFrameworkResolver.

using NugetPackageManager.Core.Workspace.Infrastructure;

namespace NugetPackageManager.Core.Workspace.Tests;

[TestClass]
public class MsBuildProcessGateTests
{
    private int exceededCapacity;

    [TestMethod]
    [TestCategory("Unit")]
    public async Task AcquireAsync_ParallelLeases_NeverExceedCapacity()
    {
        // Arrange
        using var gate = new MsBuildProcessGate(3);

        // Act — 24 callers fight over 3 slots.
        await Task.WhenAll(Enumerable.Range(0, 24).Select(_ => Task.Run(async () =>
        {
            using var lease = await gate.AcquireAsync(CancellationToken.None).ConfigureAwait(false);
            if (gate.CurrentConcurrency > gate.Capacity)
            {
                exceededCapacity = 1;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(5)).ConfigureAwait(false);
        }))).ConfigureAwait(false);

        // Assert
        Assert.AreEqual(0, exceededCapacity);
        Assert.IsTrue(
            gate.PeakConcurrency <= gate.Capacity,
            $"peak {gate.PeakConcurrency} exceeded capacity {gate.Capacity}.");
        Assert.AreEqual(24, gate.TotalAcquisitions);
        Assert.AreEqual(0, gate.CurrentConcurrency);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task AcquireAsync_MoreCallersThanSlots_WaitsForARelease()
    {
        // Arrange
        using var gate = new MsBuildProcessGate(2);
        var first = await gate.AcquireAsync(CancellationToken.None);
        var second = await gate.AcquireAsync(CancellationToken.None);

        // Act — a third caller cannot enter while both slots are taken.
        var third = gate.AcquireAsync(CancellationToken.None);
        await Task.Delay(TimeSpan.FromMilliseconds(50)).ConfigureAwait(false);

        // Assert
        Assert.IsFalse(third.IsCompleted);
        Assert.AreEqual(2, gate.CurrentConcurrency);
        Assert.AreEqual(2, gate.PeakConcurrency);

        // Act — releasing one slot lets the waiter through.
        first.Dispose();
        using var thirdLease = await third.ConfigureAwait(false);

        // Assert
        Assert.AreEqual(2, gate.CurrentConcurrency);
        Assert.AreEqual(3, gate.TotalAcquisitions);

        second.Dispose();
        Assert.AreEqual(1, gate.CurrentConcurrency);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Lease_DisposedTwice_ReleasesOneSlot()
    {
        // Arrange
        using var gate = new MsBuildProcessGate(1);
        var lease = await gate.AcquireAsync(CancellationToken.None);
        Assert.AreEqual(1, gate.CurrentConcurrency);

        // Act — the second dispose must not return the slot again.
        lease.Dispose();
        Assert.AreEqual(0, gate.CurrentConcurrency);
        ReleaseAgain(lease);

        // Assert — the counter and the semaphore still agree, so the slot is reusable exactly once.
        Assert.AreEqual(0, gate.CurrentConcurrency);
        Assert.AreEqual(1, gate.TotalAcquisitions);

        using var replacement = await gate.AcquireAsync(CancellationToken.None);
        Assert.AreEqual(1, gate.CurrentConcurrency);
        Assert.AreEqual(2, gate.TotalAcquisitions);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task CancelledWait_DoesNotLeakASlot()
    {
        // Arrange — one slot held, one caller waiting with a token that cancels shortly.
        using var gate = new MsBuildProcessGate(1);
        var holder = await gate.AcquireAsync(CancellationToken.None);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));

        // Act
        var cancelled = false;
        IDisposable? unexpected = null;
        try
        {
            unexpected = await gate.AcquireAsync(cancellation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            cancelled = true;
        }
        finally
        {
            unexpected?.Dispose();
        }

        // Assert — the abandoned wait never took a slot.
        Assert.IsTrue(cancelled, "the waiting acquisition should have been cancelled.");
        Assert.AreEqual(1, gate.CurrentConcurrency);
        Assert.AreEqual(1, gate.TotalAcquisitions);

        holder.Dispose();
        Assert.AreEqual(0, gate.CurrentConcurrency);

        using var replacement = await gate.AcquireAsync(CancellationToken.None);
        Assert.AreEqual(1, gate.CurrentConcurrency);
        Assert.AreEqual(2, gate.TotalAcquisitions);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Constructor_NonPositiveCapacity_Throws()
    {
        Assert.ThrowsExactly<ArgumentOutOfRangeException>(() => new MsBuildProcessGate(0));
        Assert.ThrowsExactly<ArgumentOutOfRangeException>(() => new MsBuildProcessGate(-1));
    }

    /// <summary>Releases a lease a second time from a separate frame, on purpose.</summary>
    private static void ReleaseAgain(IDisposable lease) => lease.Dispose();
}
