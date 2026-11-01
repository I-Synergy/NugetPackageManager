import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import coreProcess from '@/host/nuget/core-process';
import {
    IsValidSdkVersion,
    UpdateGlobalJsonSdkVersionAsync,
} from '@/host/utilities/global-json';

/**
 * The edit itself lives in the core and is pinned by `GlobalJsonTests`; these tests cover the
 * host adapter: the template attempt, and the fallback / never-template rules.
 */
suite('global-json adapter', () => {
    let root: string;
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-global-json-'));
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
        fs.rmSync(root, { recursive: true, force: true });
    });

    function stubCore(result: {
        GlobalJsonPath: string;
        Created: boolean;
        Changed: boolean;
        Notes: string[];
    }) {
        return sandbox.stub(coreProcess, 'CallAsync').resolves(result);
    }

    test('IsValidSdkVersion accepts concrete versions only', () => {
        assert.strictEqual(IsValidSdkVersion('10.0.403'), true);
        assert.strictEqual(IsValidSdkVersion('11.0.100-rc.3.26522.148'), true);
        assert.strictEqual(IsValidSdkVersion('latest'), false);
        assert.strictEqual(IsValidSdkVersion('10.0'), false);
    });

    test('falls back to the core writer when the template is unavailable', async () => {
        const globalJsonPath = path.join(root, 'global.json');
        const stub = stubCore({
            GlobalJsonPath: globalJsonPath,
            Created: true,
            Changed: true,
            Notes: [],
        });

        const result = await UpdateGlobalJsonSdkVersionAsync({
            StartDirectory: root,
            Version: '10.0.403',
            Command: 'dotnet-does-not-exist-xyz',
        });

        assert.strictEqual(result.Source, 'edit');
        assert.strictEqual(result.GlobalJsonPath, globalJsonPath);
        assert.deepStrictEqual(stub.firstCall.args, [
            'updateGlobalJsonSdkVersion',
            { startDirectory: root, version: '10.0.403' },
        ]);
    });

    test('never hands an existing file to the template', async () => {
        const globalJsonPath = path.join(root, 'global.json');
        fs.writeFileSync(globalJsonPath, '{"sdk":{"version":"10.0.403"}}');
        const stub = stubCore({
            GlobalJsonPath: globalJsonPath,
            Created: false,
            Changed: true,
            Notes: ['sdk.rollForward set to disable'],
        });

        const result = await UpdateGlobalJsonSdkVersionAsync({
            StartDirectory: root,
            Version: '10.0.404',
            Command: 'dotnet-does-not-exist-xyz',
        });

        assert.strictEqual(result.Source, 'edit');
        assert.strictEqual(stub.callCount, 1);
        assert.strictEqual(
            (stub.firstCall.args[1] as { version: string }).version,
            '10.0.404'
        );
    });
});
