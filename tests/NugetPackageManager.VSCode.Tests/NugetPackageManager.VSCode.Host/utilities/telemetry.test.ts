import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * Smoke test for the OpenTelemetry pipeline `Logger` builds: the same
 * constructors and entry points, so a dependency bump that changes the API
 * fails here instead of at extension activation.
 *
 * The version guard pins `@opentelemetry/core` at or above the release that
 * fixes the W3C Baggage unbounded-allocation advisory (GHSA-8988-4f7v-96qf,
 * patched in 2.8.0). That advisory is *moderate*, so the `--audit-level=high`
 * gate in CI would not catch a regression back onto 2.6.x on its own.
 */
suite('telemetry pipeline', () => {
    test('records a span with the resource attributes Logger configures', () => {
        const finishedSpans = new InMemorySpanExporter();
        const provider = new BasicTracerProvider({
            resource: resourceFromAttributes({
                [ATTR_SERVICE_NAME]: 'nugetpackagemanager',
                'extension.id': 'I-Synergy.nugetpackagemanager',
            }),
            spanProcessors: [new SimpleSpanProcessor(finishedSpans)],
        });

        const span = provider.getTracer('nugetpackagemanager-test').startSpan('restore');
        span.setAttribute('package.count', 3);
        span.end();

        const spans = finishedSpans.getFinishedSpans();
        assert.strictEqual(spans.length, 1);
        assert.strictEqual(spans[0]?.name, 'restore');
        assert.strictEqual(spans[0]?.attributes['package.count'], 3);
        assert.strictEqual(spans[0]?.resource.attributes[ATTR_SERVICE_NAME], 'nugetpackagemanager');
    });

    test('constructs the OTLP exporter from an endpoint', async () => {
        const exporter = new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' });
        // The bumped package must still expose the lifecycle Logger relies on;
        // a rename or a changed signature fails here instead of at activation.
        assert.strictEqual(typeof exporter.export, 'function');
        assert.strictEqual(typeof exporter.forceFlush, 'function');
        await exporter.shutdown();
    });

    test('resolves @opentelemetry/core at or above the patched 2.8.0', () => {
        const manifest = ReadPackageManifest('@opentelemetry/core');
        const [major = 0, minor = 0] = manifest.version
            .split('.')
            .map((part) => Number.parseInt(part, 10));

        assert.ok(
            major > 2 || (major === 2 && minor >= 8),
            `@opentelemetry/core ${manifest.version} is below 2.8.0, which fixes GHSA-8988-4f7v-96qf`
        );
    });
});

/** Reads a dependency's manifest without relying on its `exports` map. */
function ReadPackageManifest(packageName: string): { version: string } {
    // Resolve the entry point, then walk up to the directory holding the manifest.
    const segments = packageName.split('/');
    const rootMarker = segments.length === 2 ? path.join(segments[0]!, segments[1]!) : segments[0]!;
    const entry = require.resolve(packageName);
    const root = entry.slice(0, entry.lastIndexOf(rootMarker) + rootMarker.length);
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
}
