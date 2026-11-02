# C# harness template

Two files, both templates:

| File | Copy to | Change |
|---|---|---|
| `Program.cs.template` | `Program.cs` | the three `ADAPT` blocks (parse/resolve entry points, dump shape, resolution fields) |
| `cs-harness.csproj.template` | `cs-harness.csproj` | replace `__PROJECT_REF__` with the absolute path of the product project |

```bash
cd cs-harness
dotnet build -c Release
./bin/Release/net8.0/cs-harness.exe ../work/bench.props bench
./bin/Release/net8.0/cs-harness.exe ../work/bench.props dump   # parity input
./bin/Release/net8.0/cs-harness.exe ../work/bench.props idle   # process baseline RSS
```

Notes

- Do not add the harness to the product solution. A throwaway console project referencing the
  product `.csproj` keeps the repository untouched and still JITs the same code.
- The dump shape must match `ts-bench.mjs`'s `toWire` byte-for-byte after key sorting; otherwise
  the parity gate compares formatting instead of behaviour.
- The project reference builds the product in `Release` into its own `bin/` — that is expected and
  is the artifact you should measure.
- `RollForward=LatestMajor` lets a `net8.0` harness run on a newer installed runtime. Note the
  runtime that actually ran in the report.
