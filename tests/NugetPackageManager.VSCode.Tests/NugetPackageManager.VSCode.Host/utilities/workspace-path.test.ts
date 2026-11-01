import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findPathOutsideWorkspaceAsync, isPathInWorkspaceAsync, isPathInside } from '@/host/utilities/workspace-path';

suite('workspace-path Tests', () => {
    let tmpDir: string;
    let workspace: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-path-test-'));
        workspace = path.join(tmpDir, 'workspace');
        fs.mkdirSync(path.join(workspace, 'src', 'App'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'src', 'App', 'App.csproj'), '<Project />');
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('accepts a path inside the workspace', async () => {
        const candidate = path.join(workspace, 'src', 'App', 'App.csproj');
        assert.strictEqual(await isPathInWorkspaceAsync(candidate, [workspace]), true);
    });

    test('accepts the workspace root itself', async () => {
        assert.strictEqual(await isPathInWorkspaceAsync(workspace, [workspace]), true);
    });

    test('rejects a path outside the workspace', async () => {
        const candidate = path.join(tmpDir, 'outside', 'App.csproj');
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        fs.writeFileSync(candidate, '<Project />');
        assert.strictEqual(await isPathInWorkspaceAsync(candidate, [workspace]), false);
    });

    test('rejects a parent traversal', async () => {
        const candidate = path.join(workspace, '..', 'outside', 'App.csproj');
        assert.strictEqual(await isPathInWorkspaceAsync(candidate, [workspace]), false);
        assert.strictEqual(isPathInside(workspace, path.join(workspace, '..')), false);
    });

    test('rejects a sibling whose name shares the workspace prefix', async () => {
        const sibling = `${workspace}-evil`;
        fs.mkdirSync(sibling, { recursive: true });
        fs.writeFileSync(path.join(sibling, 'App.csproj'), '<Project />');
        assert.strictEqual(
            await isPathInWorkspaceAsync(path.join(sibling, 'App.csproj'), [workspace]),
            false
        );
    });

    test('rejects every path when no workspace roots are supplied', async () => {
        assert.strictEqual(
            await isPathInWorkspaceAsync(path.join(workspace, 'src', 'App', 'App.csproj'), []),
            false
        );
    });

    test('checks multiple workspace roots', async () => {
        const second = path.join(tmpDir, 'second');
        fs.mkdirSync(second, { recursive: true });
        const candidate = path.join(second, 'App.csproj');
        fs.writeFileSync(candidate, '<Project />');

        assert.strictEqual(await isPathInWorkspaceAsync(candidate, [workspace, second]), true);
    });

    test('findPathOutsideWorkspace returns the first offender', async () => {
        const inside = path.join(workspace, 'src', 'App', 'App.csproj');
        const outside = path.join(tmpDir, 'outside', 'App.csproj');
        fs.mkdirSync(path.dirname(outside), { recursive: true });
        fs.writeFileSync(outside, '<Project />');

        assert.strictEqual(await findPathOutsideWorkspaceAsync([inside], [workspace]), null);
        assert.strictEqual(await findPathOutsideWorkspaceAsync([inside, outside], [workspace]), outside);
    });
});
