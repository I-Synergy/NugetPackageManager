import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import { CreateDotnetOptions, TaskExecutor } from './task-executor';
import { Logger } from '../../common/logger';

suite('TaskExecutor Tests', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(Logger, 'info');
        sandbox.stub(Logger, 'debug');
        sandbox.stub(Logger, 'error');
    });

    teardown(() => {
        sandbox.restore();
    });

    test('GetProgress returns null when no operation is active', () => {
        const executor = new TaskExecutor();
        assert.strictEqual(executor.GetProgress('nonexistent'), null);
    });

    test('GetProgress returns null for different unknown operation IDs', () => {
        const executor = new TaskExecutor();
        assert.strictEqual(executor.GetProgress(''), null);
        assert.strictEqual(executor.GetProgress('op-abc'), null);
        assert.strictEqual(executor.GetProgress('0'), null);
    });

    test('ExecuteCommand runs the child in the supplied working directory', async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-task-executor-'));
        try {
            const executor = new TaskExecutor();
            await executor.ExecuteCommandAsync(
                process.execPath,
                ['-e', "require('fs').writeFileSync('cwd-probe.txt', process.cwd())"],
                'op-cwd',
                undefined,
                undefined,
                undefined,
                { cwd }
            );

            const written = fs.readFileSync(path.join(cwd, 'cwd-probe.txt'), 'utf8');
            assert.strictEqual(path.resolve(written), path.resolve(cwd));
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });

    test('CreateDotnetOptions uses the directory that owns global.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-task-executor-'));
        try {
            const projectDir = path.join(root, 'src', 'App');
            fs.mkdirSync(projectDir, { recursive: true });
            const projectPath = path.join(projectDir, 'App.csproj');
            fs.writeFileSync(projectPath, '<Project />');
            fs.writeFileSync(path.join(root, 'global.json'), JSON.stringify({ sdk: { version: '10.0.403' } }));

            const options = CreateDotnetOptions(projectPath);

            assert.strictEqual(options.cwd, root);
            assert.strictEqual(options.failureContext?.ProjectPath, projectPath);
            assert.strictEqual(options.failureContext?.Context?.PinnedSdkVersion, '10.0.403');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('ExecuteCommand rejects when dotnet is not found', async () => {
        const executor = new TaskExecutor();
        await assert.rejects(
            () => executor.ExecuteCommandAsync('dotnet-does-not-exist-xyz', [], 'op1'),
            (err: Error) => err instanceof Error
        );
        // Progress is cleaned up after rejection
        assert.strictEqual(executor.GetProgress('op1'), null);
    });
});
