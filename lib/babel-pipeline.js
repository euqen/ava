'use strict';
const fs = require('fs');
const path = require('path');
const writeFileAtomic = require('@ava/write-file-atomic');
const babel = require('@babel/core');
const convertSourceMap = require('convert-source-map');
const md5Hex = require('md5-hex');
const stripBomBuf = require('strip-bom-buf');
const pkg = require('../package.json');
const chalk = require('./chalk').get();

function getSourceMap(filePath, code) {
	let sourceMap = convertSourceMap.fromSource(code);

	if (!sourceMap) {
		const dirPath = path.dirname(filePath);
		sourceMap = convertSourceMap.fromMapFileSource(code, dirPath);
	}

	return sourceMap ? sourceMap.toObject() : undefined;
}

function validate(conf) {
	if (conf === false) {
		return null;
	}

	const defaultOptions = {babelrc: true};

	if (conf === undefined) {
		return {testOptions: defaultOptions};
	}

	if (!conf || typeof conf !== 'object' || !conf.testOptions || typeof conf.testOptions !== 'object' || Array.isArray(conf.testOptions) || Object.keys(conf).length > 1) {
		throw new Error(`Unexpected Babel configuration for AVA. See ${chalk.underline('https://github.com/avajs/ava/blob/master/docs/recipes/babel.md')} for allowed values.`);
	}

	return {
		testOptions: Object.assign({}, defaultOptions, conf.testOptions)
	};
}

function build(projectDir, cacheDir, userOptions, compileEnhancements) {
	if (!userOptions && !compileEnhancements) {
		return null;
	}

	// Note that Babel ignores empty string values, even for NODE_ENV. Here
	// default to 'test' unless NODE_ENV is defined, in which case fall back to
	// Babel's default of 'development' if it's empty.
	const envName = process.env.BABEL_ENV || ('NODE_ENV' in process.env ? process.env.NODE_ENV : 'test') || 'development';

	// Prepare inputs for caching seeds. Compute a seed based on the Node.js
	// version and the project directory. Dependency hashes may vary based on the
	// Node.js version, e.g. with the @ava/stage-4 Babel preset. Certain plugins
	// and presets are provided as absolute paths, which wouldn't necessarily
	// be valid if the project directory changes. Also include `envName`, so
	// options can be cached even if users change BABEL_ENV or NODE_ENV between
	// runs.
	const seedInputs = [process.versions.node, pkg.version, projectDir, envName];

	const partialTestConfig = babel.loadPartialConfig(Object.assign({
		babelrc: false,
		babelrcRoots: [projectDir],
		configFile: false,
		cwd: projectDir
	}, userOptions && userOptions.testOptions, {
		envName,
		sourceMaps: true,
		// Pass a filename to trick Babel into resolving .babelrc and
		// babel.config.js files. See <https://github.com/babel/babel/issues/7919>.
		filename: 'stub.js'
	}));

	// TODO: Check for `partialTestConfig.config` and include a hash of the file
	// content in the cache key. Do the same for `partialTestConfig.babelrc`,
	// though if it's a `package.json` file only include `package.json#babel` in
	// the cache key.

	const {options: testOptions} = partialTestConfig;
	delete testOptions.filename; // Remove stub.js
	// TODO: loadPartialConfig() should be setting this. Remove when it does.
	// See <https://github.com/babel/babel/issues/7922>.
	testOptions.configFile = false;

	// Resolved paths are used to create the config item, rather than the plugin
	// function itself, so Babel can print better error messages.
	// See <https://github.com/babel/babel/issues/7921>.
	const makeValueChecker = ref => {
		const expected = require(ref);
		return ({value}) => value === expected;
	};
	const createConfigItem = (ref, type, options = {}) => babel.createConfigItem([require.resolve(ref), options], {type});
	if (!testOptions.plugins.some(makeValueChecker('@babel/plugin-syntax-async-generators'))) {
		// TODO: Remove once Babel can parse this syntax unaided.
		testOptions.plugins.unshift(createConfigItem('@babel/plugin-syntax-async-generators', 'plugin'));
	}
	if (!testOptions.plugins.some(makeValueChecker('@babel/plugin-syntax-object-rest-spread'))) {
		// TODO: Remove once Babel can parse this syntax unaided.
		testOptions.plugins.unshift(createConfigItem('@babel/plugin-syntax-object-rest-spread', 'plugin'));
	}
	if (userOptions && !testOptions.presets.some(makeValueChecker('../stage-4'))) {
		// Apply last.
		testOptions.presets.unshift(createConfigItem('../stage-4', 'preset'));
	}
	if (compileEnhancements && !testOptions.presets.some(makeValueChecker('@ava/babel-preset-transform-test-files'))) {
		// Apply first.
		testOptions.presets.push(createConfigItem('@ava/babel-preset-transform-test-files', 'preset', {powerAssert: true}));
	}

	// TODO: Take resolved plugin and preset files and compute package hashes for
	// inclusion in the cache key.
	const cacheKey = md5Hex(seedInputs);

	const finalOptions = babel.loadOptions(testOptions);
	return filename => {
		const contents = stripBomBuf(fs.readFileSync(filename));
		const ext = path.extname(filename);
		const hash = md5Hex([cacheKey, contents]);
		const cachePath = path.join(cacheDir, `${hash}${ext}`);

		if (fs.existsSync(cachePath)) {
			return cachePath;
		}

		const inputCode = contents.toString('utf8');
		const {code, map} = babel.transformSync(inputCode, Object.assign({}, finalOptions, {
			inputSourceMap: getSourceMap(filename, inputCode),
			filename
		}));

		// Save source map
		const mapPath = `${cachePath}.map`;
		writeFileAtomic.sync(mapPath, JSON.stringify(map));

		// Append source map comment to transformed code so that other libraries
		// (like nyc) can find the source map.
		const comment = convertSourceMap.generateMapFileComment(mapPath);
		writeFileAtomic.sync(cachePath, `${code}\n${comment}`);
		return cachePath;
	};
}

module.exports = {
	validate,
	build
};
