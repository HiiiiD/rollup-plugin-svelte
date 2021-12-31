const path = require('path');
const relative = require('require-relative');
const { createFilter } = require('@rollup/pluginutils');
const { compile, preprocess } = require('svelte/compiler');
const fs = require('fs');

const PREFIX = '[rollup-plugin-svelte]';
const pkg_export_errors = new Set();

const plugin_options = new Set([
	'emitCss',
	'exclude',
	'extensions',
	'include',
	'onwarn',
	'preprocess'
]);

/**
 * @param [options] {Partial<import('.').Options>}
 * @returns {import('rollup').Plugin}
 */
module.exports = function (options = {}) {
	const { compilerOptions={}, ...rest } = options;
	const extensions = rest.extensions || ['.svelte'];
	const filter = createFilter(rest.include, rest.exclude);

	compilerOptions.format = 'esm';

	for (const key in rest) {
		if (plugin_options.has(key)) continue;
		console.warn(`${PREFIX} Unknown "${key}" option. Please use "compilerOptions" for any Svelte compiler configuration.`);
	}

	// [filename]:[chunk]
	const cache_emit = new Map;
	const { onwarn, emitCss=true } = rest;

	if (emitCss) {
		if (compilerOptions.css) {
			console.warn(`${PREFIX} Forcing \`"compilerOptions.css": false\` because "emitCss" was truthy.`);
		}
		compilerOptions.css = false;
	}

	let allSubComponents = [];

	return {
		name: 'svelte',

		/**
		 * Resolve an import's full filepath.
		 */
		resolveId(importee, importer) {
			if (cache_emit.has(importee)) return importee;
			if (!importer || importee[0] === '.' || importee[0] === '\0' || path.isAbsolute(importee)) return null;

			// if this is a bare import, see if there's a valid pkg.svelte
			const parts = importee.split('/');

			let dir, pkg, name = parts.shift();
			if (name && name[0] === '@') {
				name += `/${parts.shift()}`;
			}
			try {
				const file = `${name}/package.json`;
				const resolved = relative.resolve(file, path.dirname(importer));
				dir = path.dirname(resolved);
				pkg = require(resolved);
			} catch (err) {
				if (err.code === 'MODULE_NOT_FOUND') return null;
				if (err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
					pkg_export_errors.add(name);
					return null;
				}
				throw err;
			}

			// use pkg.svelte
			if (parts.length === 0 && pkg.svelte) {
				return path.resolve(dir, pkg.svelte);
			}
		},

		/**
		 * Returns CSS contents for a file, if ours
		 */
		load(id) {
			return cache_emit.get(id) || null;
		},

		/**
		 * Transforms a `.svelte` file into a `.js` file.
		 * NOTE: If `emitCss`, append static `import` to virtual CSS file.
		 */
		async transform(code, id) {
			if (!filter(id)) return null;

			const extension = path.extname(id);
			if (!~extensions.indexOf(extension)) return null;

			const dependencies = [];
			const filename = path.relative(process.cwd(), id);
			const svelte_options = { ...compilerOptions, filename };

			if (rest.preprocess) {
				const processed = await preprocess(code, rest.preprocess, { filename });
				if (processed.dependencies) dependencies.push(...processed.dependencies);
				if (processed.map) svelte_options.sourcemap = processed.map;
				code = processed.code;
			}

			// compile subcomponents
			const subComponentNames = new Set();
			const subComponentShortNames = new Set();
			code = code.replace(/{#component(.*?)}(.*?){\/component}/sg, (fullMatch, attributes, subComponentCode, ...restArgs) => {
				const subName = attributes.trim();
				if (subName.match(/[A-Z]\w*/) == null) {
					throw new Error(`Invalid subcomponent name: ${subName}`); // TODO is this raised? use this.warn()
				}
				const subComponentFileName = filename.replace(/(\.svelte)$/, '__' + subName + '$1');

				const subComponent = {
					code: subComponentCode,
					filename: subComponentFileName
				};
				

				allSubComponents.push(subComponent);
				fs.writeFileSync(subComponentFileName, subComponentCode, { encoding: 'utf-8' });
				const splittedName = subComponentFileName.split('\\');
				subComponentNames.add(subComponentFileName);
				subComponentShortNames.add(`${splittedName[splittedName.length - 1]}`);
				return '';
			});

			if (subComponentNames.size > 0) {
				const subComponentsJoined = [...subComponentShortNames].map(subComp => {
					const subComponentName = subComp.replace('.svelte', '').split('__')[1];
					return `import ${subComponentName} from './${subComp}'`;
				}).join(';');
				code = code.replace('\r\n', '\n');
				const scriptIdx = code.indexOf('<script');
				const slicedCode = code.slice(scriptIdx);
				const newLineIdx = slicedCode.indexOf('\n');
				const importIdx = scriptIdx + newLineIdx;
				code = `${code.slice(0, importIdx)}${subComponentsJoined}\n${code.slice(importIdx + 1)}`;
			}

			const compiled = compile(code, svelte_options);

			(compiled.warnings || []).forEach(warning => {
				if (!emitCss && warning.code === 'css-unused-selector') return;
				if (onwarn) onwarn(warning, this.warn);
				else this.warn(warning);
			});

			if (emitCss && compiled.css.code) {
				const fname = id.replace(new RegExp(`\\${extension}$`), '.css');
				compiled.js.code += `\nimport ${JSON.stringify(fname)};\n`;
				cache_emit.set(fname, compiled.css);
			}

			if (this.addWatchFile) {
				dependencies.forEach(this.addWatchFile);
			} else {
				compiled.js.dependencies = dependencies;
			}
			compiled.js.dependencies = dependencies;
			return compiled.js;
		},

		/**
		 * All resolutions done; display warnings wrt `package.json` access.
		 */
		generateBundle() {
			if (pkg_export_errors.size > 0) {
				console.warn(`\n${PREFIX} The following packages did not export their \`package.json\` file so we could not check the "svelte" field. If you had difficulties importing svelte components from a package, then please contact the author and ask them to export the package.json file.\n`);
				console.warn(Array.from(pkg_export_errors, s => `- ${s}`).join('\n') + '\n');
			}
		},

		buildStart() {
			for (const comp of allSubComponents) {
				fs.writeFileSync(comp.filename, comp.code, { encoding: 'utf-8' });
			}
		},
		moduleParsed({ id }) {
			//If a module is a subcomponent, then delete it
			if (/\w*__\w*.svelte/.test(id)) {
				fs.unlinkSync(path.relative(process.cwd(), id));
			}
		}
	};
};
