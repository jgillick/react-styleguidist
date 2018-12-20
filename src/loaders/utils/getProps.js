const path = require('path');
const fs = require('fs');
const reactDocs = require('react-docgen');
const highlightCodeInMarkdown = require('./highlightCodeInMarkdown');
const removeDoclets = require('./removeDoclets');
const requireIt = require('./requireIt');
const getNameFromFilePath = require('./getNameFromFilePath');
const doctrine = require('doctrine');
const _ = require('lodash');
const logger = require('glogg')('rsg');
const parseExample = require('./parseExample');

const examplesLoader = path.resolve(__dirname, '../examples-loader.js');

const JS_DOC_METHOD_PARAM_TAG_SYNONYMS = ['param', 'arg', 'argument'];
const JS_DOC_METHOD_RETURN_TAG_SYNONYMS = ['return', 'returns'];
const JS_DOC_ALL_SYNONYMS = [
	...JS_DOC_METHOD_PARAM_TAG_SYNONYMS,
	...JS_DOC_METHOD_RETURN_TAG_SYNONYMS,
];

// HACK: We have to make sure that doclets is a proper object with correct prototype to
// work around an issue in react-docgen that breaks the build if a component has JSDoc tags
// like @see in its description, see https://github.com/reactjs/react-docgen/issues/155
// and https://github.com/styleguidist/react-styleguidist/issues/298
const getDocletsObject = string => {
	return Object.assign({}, reactDocs.utils.docblock.getDoclets(string));
};

const getDoctrineTags = documentation => {
	return _.groupBy(documentation.tags, 'title');
};

const doesExternalExampleFileExist = (componentPath, exampleFile) => {
	const exampleFilepath = path.resolve(path.dirname(componentPath), exampleFile);
	const doesFileExist = fs.existsSync(exampleFilepath);

	return doesFileExist;
};

const getMergedTag = (tags, names) => {
	return names.reduce((params, name) => [...params, ...(tags[name] || [])], []);
};

/**
 * 1. Remove non-public methods.
 * 2. Extract doclets.
 * 3. Highlight code in descriptions.
 * 4. Extract @example doclet (load linked file with examples-loader).
 *
 * @param {object} doc
 * @param {string} filepath
 * @returns {object}
 */
module.exports = function getProps(doc, filepath) {
	// Keep only public methods
	doc.methods = (doc.methods || []).filter(method => {
		const doclets = method.docblock && reactDocs.utils.docblock.getDoclets(method.docblock);
		return doclets && doclets.public;
	});

	// Parse the docblock of the remaining methods with doctrine to retrieve
	// the JSDoc tags
	doc.methods = doc.methods.map(method => {
		const allTags = getDoctrineTags(
			doctrine.parse(method.docblock, { sloppy: true, unwrap: true })
		);

		// Merge with react-docgen information about arguments and return value
		// with information from JSDoc

		const paramTags = getMergedTag(allTags, JS_DOC_METHOD_PARAM_TAG_SYNONYMS);
		const params =
			method.params &&
			method.params.map(param =>
				Object.assign(param, paramTags.find(tagParam => tagParam.name === param.name))
			);

		const returnTags = getMergedTag(allTags, JS_DOC_METHOD_RETURN_TAG_SYNONYMS);
		const returns = method.returns || returnTags[0];

		// Remove tag synonyms
		const tags = _.omit(allTags, JS_DOC_ALL_SYNONYMS);

		return Object.assign(method, returns && { returns }, params && { params }, { tags });
	});

	if (doc.description) {
		// Read doclets from the description and remove them
		doc.doclets = getDocletsObject(doc.description);

		const documentation = doctrine.parse(doc.description);
		doc.tags = getDoctrineTags(documentation);

		doc.description = highlightCodeInMarkdown(removeDoclets(doc.description));

		// Process inline examples
		if (doc.doclets.example && doc.tags.example && doc.tags.example.length) {
			doc.examples = doc.examples || [];
			const examples = doc.tags.example
				.map(tag => tag.description.trim())
				.filter(example => example !== '');

			examples.forEach(example => {
				const exampleFileExists = doesExternalExampleFileExist(filepath, example);
				const mayHaveCodeBlock = /```/.test(example);

				if (exampleFileExists) {
					let exampleFile = example;
					if (typeof exampleFile === 'string') {
						exampleFile = exampleFile.trim();
					}
					const src = requireIt(`!!${examplesLoader}!${exampleFile}`);

					//doc.examples.push(src);
					doc.example = src;
					delete doc.doclets.example;
				} else if (mayHaveCodeBlock) {
					const lines = example.match(/[^\r\n]+/g);
					const header = lines[1].trim().replace(/^```/, '');
					lines.splice(0, 2);
					const content = lines.join('\n');
					const parsedExample = parseExample(content, header);

					if (parsedExample.settings.render) {
						doc.examples.push(example);
						delete doc.doclets.example;
					} else {
						logger.warn(
							`An inline example defined in ${filepath} is missing the required \`render\` modifier.`
						);
					}
				} else {
					logger.warn(`An example file ${example} defined in ${filepath} component not found.`);
				}
			});
		}
	} else {
		doc.doclets = {};
	}

	if (doc.props) {
		// Read doclets of props
		Object.keys(doc.props).forEach(propName => {
			const prop = doc.props[propName];
			const doclets = getDocletsObject(prop.description);

			// When a prop is listed in defaultProps but not in props the prop.description is undefined
			const documentation = doctrine.parse(prop.description || '');

			// documentation.description is the description without tags
			doc.props[propName].description = documentation.description;
			doc.props[propName].tags = getDoctrineTags(documentation);

			// Remove ignored props
			if (doclets && doclets.ignore) {
				delete doc.props[propName];
			}
		});
	}

	if (!doc.displayName && filepath) {
		// Guess the exported component's display name based on the file path
		doc.displayName = getNameFromFilePath(filepath);
	}

	if (doc.doclets && doc.doclets.visibleName) {
		doc.visibleName = doc.doclets.visibleName;

		// Custom tag is added both to doclets and tags
		// Removing from both locations
		delete doc.doclets.visibleName;
		if (doc.tags) {
			delete doc.tags.visibleName;
		}
	}

	return doc;
};