const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyCodicons() {
	const src = path.join('node_modules', '@vscode', 'codicons', 'dist');
	const dst = path.join('out', 'codicons');
	fs.mkdirSync(dst, { recursive: true });
	for (const f of ['codicon.css', 'codicon.ttf']) {
		fs.copyFileSync(path.join(src, f), path.join(dst, f));
	}
}

const problemMatcher = {
	name: 'problem-matcher',
	setup(build) {
		build.onStart(() => console.log('[esbuild] build started'));
		build.onEnd((result) => {
			for (const { text, location } of result.errors) {
				console.error(`[esbuild] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}`);
				}
			}
			console.log(`[esbuild] build finished (${result.errors.length} errors)`);
		});
	},
};

async function main() {
	copyCodicons();

	// Options shared by both bundles; per-context keys override below.
	const shared = {
		bundle: true,
		sourcemap: !production,
		minify: production,
		logLevel: 'silent',
		alias: { '@': path.resolve(__dirname, 'src') },
		plugins: [problemMatcher],
	};

	const extensionCtx = await esbuild.context({
		...shared,
		entryPoints: ['src/extension.ts'],
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		outfile: 'out/extension.js',
		external: ['vscode', 'node-rsa'],
	});

	// One bundle per sidebar view; each gets its own root and is loaded by data-view-less HTML keyed on the view name.
	const webviewCtx = await esbuild.context({
		...shared,
		entryPoints: [
			'src/ui/webviews/sessions.tsx',
			'src/ui/webviews/hosts.tsx',
			'src/ui/webviews/stats.tsx',
			'src/ui/webviews/summary.tsx',
		],
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		outdir: 'out',
		jsx: 'automatic',
		jsxImportSource: 'preact',
	});

	if (watch) {
		await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
	} else {
		await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
		await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
