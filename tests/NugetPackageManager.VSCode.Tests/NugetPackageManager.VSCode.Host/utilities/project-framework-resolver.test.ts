import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ProjectFrameworkResolver from '@/host/utilities/project-framework-resolver';
import { Logger } from '@/common/logger';

suite('ProjectFrameworkResolver Tests', () => {
    let tmpDir: string;
    const originalDebug = Logger.debug;
    const originalError = Logger.error;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-resolver-test-'));
        Logger.debug = () => {};
        Logger.error = () => {};
        ProjectFrameworkResolver.SetEvaluatorForTests(null);
        ProjectFrameworkResolver.ClearCache();
    });

    teardown(() => {
        Logger.debug = originalDebug;
        Logger.error = originalError;
        ProjectFrameworkResolver.SetEvaluatorForTests(null);
        ProjectFrameworkResolver.ClearCache();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('uses the MSBuild evaluator and caches the result', async () => {
        const projectPath = path.join(tmpDir, 'App.csproj');
        fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk" />');

        let calls = 0;
        ProjectFrameworkResolver.SetEvaluatorForTests(async () => {
            calls++;
            return ['net10.0', 'net11.0'];
        });

        const first = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);
        const second = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);

        assert.deepStrictEqual(first.Frameworks, ['net10.0', 'net11.0']);
        assert.strictEqual(first.Source, 'msbuild');
        assert.deepStrictEqual(second.Frameworks, ['net10.0', 'net11.0']);
        assert.strictEqual(calls, 1, 'second call should be served from cache');
    });

    test('uses a single unconditional literal TFM without MSBuild or assets', async () => {
        const projectPath = path.join(tmpDir, 'App.csproj');
        fs.writeFileSync(
            projectPath,
            '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net10.0;net11.0</TargetFrameworks></PropertyGroup></Project>'
        );

        let calls = 0;
        ProjectFrameworkResolver.SetEvaluatorForTests(async () => {
            calls++;
            return ['should-not-be-used'];
        });

        const info = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);
        assert.deepStrictEqual(info.Frameworks, ['net10.0', 'net11.0']);
        assert.strictEqual(info.Source, 'xml');
        assert.strictEqual(calls, 0);
    });

    test('does not use literal XML when TFM declarations are conditional', async () => {
        const projectPath = path.join(tmpDir, 'App.csproj');
        fs.writeFileSync(
            projectPath,
            '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net10.0</TargetFrameworks><TargetFrameworks Condition="true">$(TargetFrameworks);net11.0</TargetFrameworks></PropertyGroup></Project>'
        );

        let calls = 0;
        ProjectFrameworkResolver.SetEvaluatorForTests(async () => {
            calls++;
            return ['net10.0', 'net11.0'];
        });

        const info = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);
        assert.deepStrictEqual(info.Frameworks, ['net10.0', 'net11.0']);
        assert.strictEqual(info.Source, 'msbuild');
        assert.strictEqual(calls, 1);
    });

    test('uses project.assets.json without invoking MSBuild', async () => {
        const projectPath = path.join(tmpDir, 'App.csproj');
        fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        fs.mkdirSync(path.join(tmpDir, 'obj'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'obj', 'project.assets.json'),
            JSON.stringify({ targets: { 'net10.0': {}, 'net11.0': {} } })
        );

        let calls = 0;
        ProjectFrameworkResolver.SetEvaluatorForTests(async () => {
            calls++;
            return ['should-not-be-used'];
        });

        const info = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);
        assert.deepStrictEqual(info.Frameworks, ['net10.0', 'net11.0']);
        assert.strictEqual(info.Source, 'assets');
        assert.strictEqual(calls, 0, 'assets should avoid a dotnet msbuild process');
    });

    test('falls back to literal XML when MSBuild evaluation throws', async () => {
        const projectPath = path.join(tmpDir, 'App.csproj');
        fs.writeFileSync(
            projectPath,
            '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net9.0;net10.0</TargetFrameworks></PropertyGroup></Project>'
        );

        ProjectFrameworkResolver.SetEvaluatorForTests(async () => {
            throw new Error('dotnet not found');
        });

        const info = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);
        assert.deepStrictEqual(info.Frameworks, ['net9.0', 'net10.0']);
        assert.strictEqual(info.Source, 'xml');
    });

    test('marks the XML fallback when MSBuild evaluation fails', async () => {
        const projectPath = path.join(tmpDir, 'Broken.csproj');
        fs.writeFileSync(
            projectPath,
            '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>$(BaseTfms);net10.0</TargetFrameworks></PropertyGroup></Project>'
        );

        ProjectFrameworkResolver.SetEvaluatorForTests(async () => {
            throw new Error('error MSB4242: SDK Resolver Failure');
        });

        const info = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);

        assert.strictEqual(info.Source, 'xml');
        assert.strictEqual(
            info.EvaluationFailed,
            true,
            'a failed evaluation must be distinguishable from literal XML'
        );
    });

    test('fallback ignores unresolved MSBuild property expressions', async () => {
        const projectPath = path.join(tmpDir, 'App.csproj');
        fs.writeFileSync(
            projectPath,
            '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>$(SampleTargetFramework)</TargetFramework></PropertyGroup></Project>'
        );

        ProjectFrameworkResolver.SetEvaluatorForTests(async () => {
            throw new Error('dotnet not found');
        });

        const info = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);
        assert.deepStrictEqual(info.Frameworks, []);
        assert.strictEqual(info.Source, 'xml');
    });

    test('merges override frameworks without duplicates', async () => {
        const projectPath = path.join(tmpDir, 'App.csproj');
        fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk" />');

        ProjectFrameworkResolver.SetEvaluatorForTests(async () => ['net10.0']);

        const info = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath, [
            'net10.0',
            'net11.0',
        ]);
        assert.deepStrictEqual(info.Frameworks, ['net10.0', 'net11.0']);
    });

    test('Inactive/invalidated project is re-evaluated', async () => {
        const projectPath = path.join(tmpDir, 'App.csproj');
        fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk" />');

        let calls = 0;
        ProjectFrameworkResolver.SetEvaluatorForTests(async () => {
            calls++;
            return [`net1${calls}.0`];
        });

        const first = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);
        ProjectFrameworkResolver.InvalidateProject(projectPath);
        const second = await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);

        assert.deepStrictEqual(first.Frameworks, ['net11.0']);
        assert.deepStrictEqual(second.Frameworks, ['net12.0']);
    });

    test('cache key changes when a build props file changes', async () => {
        const projectPath = path.join(tmpDir, 'App.csproj');
        const propsPath = path.join(tmpDir, 'Directory.Build.props');
        fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk" />');
        fs.writeFileSync(propsPath, '<Project />');

        let calls = 0;
        ProjectFrameworkResolver.SetEvaluatorForTests(async () => {
            calls++;
            return ['net10.0'];
        });

        await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);
        assert.strictEqual(calls, 1);

        const future = new Date(Date.now() + 5000);
        fs.utimesSync(propsPath, future, future);

        await ProjectFrameworkResolver.GetTargetFrameworksAsync(projectPath);
        assert.strictEqual(calls, 2, 'changing Directory.Build.props should invalidate the cache');
    });

    test('ParseMsBuildOutput handles TargetFrameworks and TargetFramework', () => {
        assert.deepStrictEqual(
            ProjectFrameworkResolver.ParseMsBuildOutput(
                '{"Properties":{"TargetFrameworks":"net10.0;net11.0","TargetFramework":""}}'
            ),
            ['net10.0', 'net11.0']
        );
        assert.deepStrictEqual(
            ProjectFrameworkResolver.ParseMsBuildOutput(
                '{"Properties":{"TargetFramework":"net10.0-windows10.0.26100.0"}}'
            ),
            ['net10.0-windows10.0.26100.0']
        );
        assert.deepStrictEqual(ProjectFrameworkResolver.ParseMsBuildOutput('not json'), []);
    });

    test('batch resolution returns an entry for every project', async () => {
        const a = path.join(tmpDir, 'A.csproj');
        const b = path.join(tmpDir, 'B.csproj');
        fs.writeFileSync(a, '<Project Sdk="Microsoft.NET.Sdk" />');
        fs.writeFileSync(b, '<Project Sdk="Microsoft.NET.Sdk" />');

        ProjectFrameworkResolver.SetEvaluatorForTests(async (projectPath) =>
            projectPath.endsWith('A.csproj') ? ['net10.0'] : ['net11.0']
        );

        const result = await ProjectFrameworkResolver.GetTargetFrameworksBatchAsync([a, b], [], 2);
        assert.deepStrictEqual(result.get(a)?.Frameworks, ['net10.0']);
        assert.deepStrictEqual(result.get(b)?.Frameworks, ['net11.0']);
    });
});
