import * as assert from 'assert';
import * as sinon from 'sinon';
import coreProcess from '@/host/nuget/core-process';
import CpmWriter from '@/host/utilities/cpm-writer';

suite('cpm-writer', () => {
    let sandbox: sinon.SinonSandbox;
    let callStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        callStub = sandbox.stub(coreProcess, 'CallAsync');
    });

    teardown(() => {
        sandbox.restore();
    });

    suite('UpdateCpmVersionsAsync', () => {
        test('sends both arrays and returns changedFiles', async () => {
            callStub.resolves({ applied: 1, changedFiles: ['/ws/Directory.Build.props'] });

            const changed = await CpmWriter.UpdateCpmVersionsAsync(
                '/ws/Directory.Packages.props',
                [{ packageId: 'Foo.Bar', version: '1.2.3', scope: 'all' }],
                ['/ws/App.csproj'],
                ['/ws']
            );

            assert.deepStrictEqual(changed, ['/ws/Directory.Build.props']);
            assert.deepStrictEqual(callStub.firstCall.args[0], 'updateCpmVersions');
            assert.deepStrictEqual(callStub.firstCall.args[1], {
                propsFilePath: '/ws/Directory.Packages.props',
                changes: [{ packageId: 'Foo.Bar', version: '1.2.3', scope: 'all' }],
                projectPaths: ['/ws/App.csproj'],
                workspaceRoots: ['/ws'],
            });
        });

        test('forwards condition when present', async () => {
            callStub.resolves({ applied: 1, changedFiles: [] });

            await CpmWriter.UpdateCpmVersionsAsync(
                '/ws/Directory.Packages.props',
                [{ packageId: 'Foo.Bar', version: '1.2.3', condition: 'net8.0', scope: 'group' }]
            );

            assert.deepStrictEqual(callStub.firstCall.args[1], {
                propsFilePath: '/ws/Directory.Packages.props',
                changes: [
                    { packageId: 'Foo.Bar', version: '1.2.3', condition: 'net8.0', scope: 'group' },
                ],
                projectPaths: [],
                workspaceRoots: [],
            });
        });

        test('defaults changedFiles to an empty array when the core omits it', async () => {
            callStub.resolves({ applied: 1 });

            const changed = await CpmWriter.UpdateCpmVersionsAsync('/ws/Directory.Packages.props', [
                { packageId: 'Foo.Bar', version: '1.2.3' },
            ]);

            assert.deepStrictEqual(changed, []);
        });

        test('does not call the core for an empty change set', async () => {
            const changed = await CpmWriter.UpdateCpmVersionsAsync('/ws/Directory.Packages.props', []);

            assert.deepStrictEqual(changed, []);
            assert.strictEqual(callStub.called, false);
        });
    });

    suite('ResolveWriteTargetsAsync', () => {
        test('sends the exact payload and returns files', async () => {
            callStub.resolves({ files: ['/ws/Directory.Packages.props', '/ws/Directory.Build.props'] });

            const files = await CpmWriter.ResolveWriteTargetsAsync(
                '/ws/Directory.Packages.props',
                [{ packageId: 'Foo.Bar', version: '1.2.3', scope: 'all' }],
                ['/ws/App.csproj'],
                ['/ws']
            );

            assert.deepStrictEqual(files, [
                '/ws/Directory.Packages.props',
                '/ws/Directory.Build.props',
            ]);
            assert.deepStrictEqual(callStub.firstCall.args[0], 'resolveCpmWriteTargets');
            assert.deepStrictEqual(callStub.firstCall.args[1], {
                propsFilePath: '/ws/Directory.Packages.props',
                changes: [{ packageId: 'Foo.Bar', version: '1.2.3', scope: 'all' }],
                projectPaths: ['/ws/App.csproj'],
                workspaceRoots: ['/ws'],
            });
        });

        test('defaults files to an empty array when the core omits it', async () => {
            callStub.resolves({});

            const files = await CpmWriter.ResolveWriteTargetsAsync(
                '/ws/Directory.Packages.props',
                [{ packageId: 'Foo.Bar', version: '1.2.3' }],
                [],
                []
            );

            assert.deepStrictEqual(files, []);
        });

        test('does not call the core for an empty change set', async () => {
            const files = await CpmWriter.ResolveWriteTargetsAsync(
                '/ws/Directory.Packages.props',
                [],
                ['/ws/App.csproj'],
                ['/ws']
            );

            assert.deepStrictEqual(files, []);
            assert.strictEqual(callStub.called, false);
        });
    });

    suite('UpdatePackageVersionAsync', () => {
        test('sends condition, scope and workspaceRoots', async () => {
            callStub.resolves({ updated: true });

            await CpmWriter.UpdatePackageVersionAsync(
                '/ws/App.csproj',
                'Foo.Bar',
                '1.2.3',
                'net8.0',
                'group',
                ['/ws']
            );

            assert.deepStrictEqual(callStub.firstCall.args[0], 'updatePackageVersion');
            assert.deepStrictEqual(callStub.firstCall.args[1], {
                projectPath: '/ws/App.csproj',
                packageId: 'Foo.Bar',
                version: '1.2.3',
                condition: 'net8.0',
                scope: 'group',
                workspaceRoots: ['/ws'],
            });
        });

        test('defaults workspaceRoots to an empty array', async () => {
            callStub.resolves({ updated: true });

            await CpmWriter.UpdatePackageVersionAsync('/ws/App.csproj', 'Foo.Bar', '1.2.3');

            assert.deepStrictEqual(callStub.firstCall.args[1], {
                projectPath: '/ws/App.csproj',
                packageId: 'Foo.Bar',
                version: '1.2.3',
                workspaceRoots: [],
            });
        });
    });
});
