const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig([
	{
		label: 'unitTests',
		files: 'out/tests/**/*.test.js',
		version: 'stable',
		workspaceFolder: '.',
		mocha: {
			ui: 'tdd',
			timeout: 20000,
			require: ['./test-path-register.cjs']
		},
		coverage: {
			include: ['src/**/*.ts'],
			exclude: ['src/**/__fixtures__/**'],
			includeAll: true
		},
		launchArgs: [
			'--disable-gpu',
			'--disable-workspace-trust',
			'--disable-telemetry'
		],
		env: {
			VSCODE_NUGET_GALLERY_TEST: 'true',
			OTEL_TRACES_EXPORTER: 'none'
		}
	}
]);
