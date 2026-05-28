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

	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		outfile: 'out/extension.js',
		// 'vscode' is provided by the extension host.
		// 'node-rsa' is a fallback in @microsoft/dev-tunnels-ssh that only loads on old Node
		// versions without built-in RSA key-gen; VS Code's Node is always modern.
		external: ['vscode', 'node-rsa'],
		sourcemap: !production,
		minify: production,
		logLevel: 'silent',
		plugins: [problemMatcher],
	});

	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
