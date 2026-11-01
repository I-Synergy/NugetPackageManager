import '@/web/web-setup';
import * as assert from 'assert';
import * as sinon from 'sinon';
import type { HostAPI, RpcCancel, RpcRequest, RpcResponse } from '@/common/rpc/types';
import { createRpcClient } from '@/common/rpc/rpc-client';
import { RpcHost } from '@/common/rpc/rpc-host';
import { Logger } from '@/common/logger';

suite('RPC transport', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(Logger, 'debug');
        sandbox.stub(Logger, 'info');
        sandbox.stub(Logger, 'warn');
        sandbox.stub(Logger, 'error');
    });

    teardown(() => {
        sandbox.restore();
    });

    function respond(id: number, value: unknown): void {
        const response: RpcResponse = { type: 'rpc-response', id, result: { ok: true, value } };
        window.dispatchEvent(new window.MessageEvent('message', { data: response, origin: window.location.origin }));
    }

    test('resolves an RPC response by id', async () => {
        const sent: RpcRequest[] = [];
        const client = createRpcClient((msg) => sent.push(msg as RpcRequest), 1000);

        const promise = client.getProjectsAsync({});
        assert.strictEqual(sent.length, 1);
        respond(sent[0]!.id, { Projects: [] });

        const result = await promise;
        assert.strictEqual(result.ok, true);
    });

    test('timeout fails the call without cancelling the host operation', async () => {
        const sent: Array<RpcRequest | RpcCancel> = [];
        const client = createRpcClient((msg) => sent.push(msg as RpcRequest | RpcCancel), 20);

        const promise = client.getProjectsAsync({});
        await new Promise((resolve) => setTimeout(resolve, 40));
        const result = await promise;

        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.match(result.error, /still running in the extension host/);
        }
        assert.deepStrictEqual(
            sent.filter((msg) => (msg as RpcCancel).type === 'rpc-cancel'),
            [],
            'a deadline must never abort slow host work'
        );
    });

    test('ignores a late response after the call timed out', async () => {
        const sent: RpcRequest[] = [];
        const client = createRpcClient((msg) => sent.push(msg as RpcRequest), 20);

        const promise = client.getProjectsAsync({});
        await new Promise((resolve) => setTimeout(resolve, 40));
        const result = await promise;

        assert.strictEqual(result.ok, false);
        // The host keeps going and eventually answers; that must not throw or
        // resolve anything a second time.
        respond(sent[0]!.id, { Projects: [] });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.strictEqual(result.ok, false);
    });

    test('aborting the signal posts rpc-cancel', async () => {
        const sent: Array<RpcRequest | RpcCancel> = [];
        const client = createRpcClient((msg) => sent.push(msg as RpcRequest | RpcCancel), 1000);
        const controller = new AbortController();

        const promise = client.getProjectsAsync({}, controller.signal);
        controller.abort();
        const result = await promise;

        assert.strictEqual(result.ok, false);
        assert.ok(sent.some((msg) => (msg as RpcCancel).type === 'rpc-cancel'));
    });

    test('RpcHost aborts the handler and suppresses the response on cancel', async () => {
        let receive: (msg: unknown) => Promise<void> = async () => {};
        const posted: unknown[] = [];
        const webview = {
            onDidReceiveMessage: (handler: (msg: unknown) => Promise<void>) => {
                receive = handler;
                return { dispose: () => {} };
            },
            postMessage: async (msg: unknown) => {
                posted.push(msg);
                return true;
            },
        };

        let observedSignal: AbortSignal | undefined;
        const api = {
            getProjectsAsync: async (_req: unknown, signal?: AbortSignal) => {
                observedSignal = signal;
                await new Promise<void>((resolve) => {
                    signal?.addEventListener('abort', () => resolve(), { once: true });
                });
                return { ok: true as const, value: { Projects: [] } };
            },
        } as unknown as HostAPI;

        const host = new RpcHost(webview as never, api);
        const request: RpcRequest = { type: 'rpc-request', id: 7, method: 'getProjectsAsync', params: {} };
        const handling = receive(request);

        receive({ type: 'rpc-cancel', id: 7 });
        await handling;

        assert.strictEqual(observedSignal?.aborted, true);
        assert.deepStrictEqual(posted, []);
        host.dispose();
    });
});
