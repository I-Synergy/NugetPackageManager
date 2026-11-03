namespace NugetPackageManager.Core.Workspace.Infrastructure;

/// <summary>
/// Process-wide admission control for <c>dotnet msbuild</c> spawns.
///
/// <see cref="NugetPackageManager.Core.Workspace.Cpm.CpmEvaluator"/> and
/// <see cref="NugetPackageManager.Core.Workspace.TargetFrameworks.TargetFrameworkResolver"/> each
/// used to hold their own semaphore, so a parallel workspace scan could start twice the machine's
/// worth of MSBuild processes at once and thrash it. Both wait on this gate instead, which caps the
/// combined number of concurrent processes at one shared limit.
///
/// <see cref="Shared"/> defaults to <c>Math.Clamp(ProcessorCount, 2, 8)</c>: a slow repository must
/// not flood the machine with <c>dotnet</c> children while evaluations remain.
///
/// A lease is returned from <see cref="AcquireAsync"/>; disposing it — once — returns the slot.
/// The counters are written with <see cref="Interlocked"/> so they can be read from any thread.
/// </summary>
public sealed class MsBuildProcessGate : IDisposable
{
    private static readonly Lazy<MsBuildProcessGate> sharedGate = new(
        () => new MsBuildProcessGate(Math.Clamp(Environment.ProcessorCount, 2, 8)),
        LazyThreadSafetyMode.ExecutionAndPublication);

    private readonly SemaphoreSlim slots;
    private int peakConcurrency;
    private int totalAcquisitions;
    private int currentConcurrency;

    /// <summary>
    /// The gate every evaluator uses unless a caller injects another one. It is owned by the
    /// process and must never be disposed; see <see cref="Dispose"/>.
    /// </summary>
    public static MsBuildProcessGate Shared => sharedGate.Value;

    /// <summary>
    /// Creates a gate that admits at most <paramref name="maxConcurrency"/> concurrent holders.
    /// </summary>
    /// <param name="maxConcurrency">Number of slots; must be greater than zero.</param>
    /// <exception cref="ArgumentOutOfRangeException">
    /// <paramref name="maxConcurrency"/> is zero or negative.
    /// </exception>
    public MsBuildProcessGate(int maxConcurrency)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxConcurrency);

        Capacity = maxConcurrency;
        slots = new SemaphoreSlim(maxConcurrency, maxConcurrency);
    }

    /// <summary>Number of slots the gate was created with.</summary>
    public int Capacity { get; }

    /// <summary>Highest number of simultaneous holders observed since the gate was created.</summary>
    public int PeakConcurrency => Volatile.Read(ref peakConcurrency);

    /// <summary>Number of leases handed out since the gate was created.</summary>
    public int TotalAcquisitions => Volatile.Read(ref totalAcquisitions);

    /// <summary>Number of leases currently held.</summary>
    public int CurrentConcurrency => Volatile.Read(ref currentConcurrency);

    /// <summary>
    /// Waits for a free slot and returns the lease that holds it. Disposing the lease — once —
    /// returns the slot; a second dispose is a no-op, so callers may use <c>using</c> freely.
    /// Cancelling the wait releases nothing, because no slot was taken yet.
    /// </summary>
    /// <param name="cancellationToken">Cancels the wait for a slot.</param>
    public async Task<IDisposable> AcquireAsync(CancellationToken cancellationToken)
    {
        await slots.WaitAsync(cancellationToken).ConfigureAwait(false);

        var held = Interlocked.Increment(ref currentConcurrency);
        Interlocked.Increment(ref totalAcquisitions);
        RecordPeak(held);

        return new Lease(this);
    }

    private void Release()
    {
        Interlocked.Decrement(ref currentConcurrency);

        try
        {
            slots.Release();
        }
        catch (ObjectDisposedException)
        {
            // The gate was disposed underneath an outstanding lease; the lease has still been
            // given up, which is all the caller can observe.
        }
    }

    private void RecordPeak(int held)
    {
        var observed = Volatile.Read(ref peakConcurrency);
        while (held > observed)
        {
            var prior = Interlocked.CompareExchange(ref peakConcurrency, held, observed);
            if (prior == observed)
            {
                return;
            }

            observed = prior;
        }
    }

    /// <summary>
    /// Releases the semaphore backing this gate. Only a gate a caller created itself may be
    /// disposed; <see cref="Shared"/> lives for the whole process and must be left alone.
    /// </summary>
    public void Dispose() => slots.Dispose();

    private sealed class Lease(MsBuildProcessGate gate) : IDisposable
    {
        private MsBuildProcessGate? owner = gate;

        public void Dispose() => Interlocked.Exchange(ref owner, null)?.Release();
    }
}
