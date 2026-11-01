import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HttpCache } from '@/host/nuget/http-cache';

suite('HttpCache', () => {
    let directory: string;

    setup(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuget-http-cache-'));
    });

    teardown(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('stores and reloads a response', async () => {
        const cache = new HttpCache(directory);
        await cache.SetAsync('https://api.nuget.org/v3/registration/pkg/index.json', { count: 1 });

        const loaded = await new HttpCache(directory).GetAsync<{ count: number }>(
            'https://api.nuget.org/v3/registration/pkg/index.json'
        );
        assert.deepStrictEqual(loaded, { count: 1 });
    });

    test('expires entries after the TTL', async () => {
        let now = 1_000;
        const cache = new HttpCache(directory, 500, () => now);
        await cache.SetAsync('key', { value: true });

        now = 1_400;
        assert.deepStrictEqual(await cache.GetAsync('key'), { value: true });

        now = 1_600;
        assert.strictEqual(await cache.GetAsync('key'), null);
    });

    test('returns null for a missing key and without a directory', async () => {
        const cache = new HttpCache(directory);
        assert.strictEqual(await cache.GetAsync('missing'), null);
        assert.strictEqual(await new HttpCache(null).GetAsync('anything'), null);
    });

    test('clear removes the cache directory', async () => {
        const cache = new HttpCache(directory);
        await cache.SetAsync('key', { value: true });
        assert.ok(fs.existsSync(directory));

        cache.Clear();
        assert.strictEqual(fs.existsSync(directory), false);
    });
});
