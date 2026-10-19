const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

function activate(context) {
    const outputChannel = vscode.window.createOutputChannel('Lean HTML Debug');
    context.subscriptions.push(outputChannel);
    
    outputChannel.appendLine('[INIT] Lean HTML extension is active and listening.');

    const diagnosticCollection = vscode.languages.createDiagnosticCollection('leanHtmlIncludes');
    context.subscriptions.push(diagnosticCollection);

    const selector = [
        { scheme: 'file', language: 'html-lean' }, 
        { scheme: 'file', language: 'fragment-html' }
    ];
    
    // 1. Completion Provider with Dynamic Schema / Lean-Attrs Extraction & Missing Attribute Suggestions
    const completionProvider = vscode.languages.registerCompletionItemProvider(selector, {
        provideCompletionItems(document, position) {
            const linePrefix = document.lineAt(position).text.substr(0, position.character);
            const completions = [];

            const lastOpen = linePrefix.lastIndexOf('{{');
            const lastClose = linePrefix.lastIndexOf('}}');

            if (lastOpen > lastClose) {
                const keywords = [
                    { label: '#each', snippet: '#each ${1:collection}}\n\t$0\n{{/each}}', doc: 'Handlebars each loop' },
                    { label: '#if', snippet: '#if ${1:condition}}\n\t$0\n{{/if}}', doc: 'Handlebars conditional block' },
                    { label: '#unless', snippet: '#unless ${1:condition}}\n\t$0\n{{/unless}}', doc: 'Handlebars unless block' },
                    { label: '#with', snippet: '#with ${1:context}}\n\t$0\n{{/with}}', doc: 'Handlebars with block' },
                    { label: 'else', snippet: 'else', doc: 'Handlebars else clause' },
                    { label: '/each', snippet: '/each', doc: 'Close each loop' },
                    { label: '/if', snippet: '/if', doc: 'Close if block' },
                    { label: '/unless', snippet: '/unless', doc: 'Close unless block' },
                    { label: '/with', snippet: '/with', doc: 'Close with block' }
                ];

                const exprContent = linePrefix.substring(lastOpen + 2);
                const trimmedExpr = exprContent.trim();
                
                if (trimmedExpr === '' || keywords.some(kw => kw.label.startsWith(trimmedExpr) || `#${kw.label}`.startsWith(trimmedExpr))) {
                    keywords.forEach(kw => {
                        const item = new vscode.CompletionItem(kw.label, vscode.CompletionItemKind.Keyword);
                        item.insertText = new vscode.SnippetString(kw.snippet);
                        item.documentation = new vscode.MarkdownString(kw.doc);
                        completions.push(item);
                    });
                }

                const schemaKeys = extractLeanAttrsKeys(document);
                schemaKeys.forEach(key => {
                    const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Variable);
                    item.documentation = new vscode.MarkdownString(`Custom attribute defined in \`<!--lean-attrs-->\``);
                    completions.push(item);
                });
            }

            if (linePrefix.endsWith('<')) {
                const htmlInclude = new vscode.CompletionItem('html-include', vscode.CompletionItemKind.Snippet);
                htmlInclude.insertText = new vscode.SnippetString('html-include src="sections/${1:name}.html" title="${2:Title}">\n\t<data>\n\t\t{\n\t\t\t"${3:items}": []\n\t\t}\n\t</data>\n</html-include>');
                htmlInclude.documentation = new vscode.MarkdownString('Insert an html-include block with payload data.');
                completions.push(htmlInclude);
            }

            const textUpToPos = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
            const lastHtmlIncludeIndex = textUpToPos.lastIndexOf('<html-include');
            if (lastHtmlIncludeIndex !== -1) {
                const textAfterInclude = textUpToPos.substring(lastHtmlIncludeIndex);
                if (!/>/.test(textAfterInclude)) {
                    const srcMatch = textAfterInclude.match(/\bsrc\s*=\s*["']([^"']+)["']/);
                    if (srcMatch) {
                        const srcValue = srcMatch[1];
                        const fragmentPath = resolveFragmentPath(document.uri, srcValue);
                        if (fragmentPath && fs.existsSync(fragmentPath)) {
                            try {
                                const fragmentContent = fs.readFileSync(fragmentPath, 'utf8');
                                const leanAttrs = getLeanAttrsObject(fragmentContent);
                                if (leanAttrs) {
                                    const presentAttrs = new Set();
                                    const attrRegex = /([a-zA-Z0-9_-]+)\s*=\s*(["'][^"']*["'])/g;
                                    let attrMatch;
                                    while ((attrMatch = attrRegex.exec(textAfterInclude)) !== null) {
                                        presentAttrs.add(attrMatch[1]);
                                    }

                                    for (const rawKey of Object.keys(leanAttrs)) {
                                        const isOptional = rawKey.endsWith('?');
                                        const key = isOptional ? rawKey.slice(0, -1) : rawKey;
                                        const val = leanAttrs[rawKey];

                                        if (key === 'data') {
                                            const isCollection = Array.isArray(val) || (val !== null && typeof val === 'object');
                                            if (isCollection) continue;
                                        }

                                        if (!presentAttrs.has(key)) {
                                            const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
                                            const defaultValStr = typeof val === 'string' ? val : JSON.stringify(val);
                                            item.detail = `Default: ${defaultValStr} (${isOptional ? 'optional' : 'required'})`;
                                            item.documentation = new vscode.MarkdownString(`Attribute defined in fragment \`${srcValue}\` lean-attrs.`);
                                            item.insertText = new vscode.SnippetString(`${key}="\${1:${defaultValStr}}"` );
                                            completions.push(item);
                                        }
                                    }
                                }
                            } catch (e) {
                                // ignore
                            }
                        }
                    }
                }
            }

            return completions;
        }
    }, '{', '<', '#', ' ', '"', '=');

    context.subscriptions.push(completionProvider);

    // 2. Surgical Document Formatter
    const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider(selector, {
        provideDocumentFormattingEdits(document, options) {
            const text = document.getText();
            const tabSize = options.tabSize || 2;
            const indentChar = options.insertSpaces ? ' '.repeat(tabSize) : '\t';

            const dataRegex = /^([ \t]*)(<data\b[^>]*>)([\s\S]*?)(<\/data>)/gim;
            
            let formattedText = text.replace(dataRegex, (match, leadingSpace, openTag, jsonContent, closeTag) => {
                try {
                    const cleanJson = jsonContent.trim();
                    if (!cleanJson) return match;
                    
                    const parsed = JSON.parse(cleanJson);
                    const prettyJson = JSON.stringify(parsed, null, tabSize);
                    
                    const innerIndent = leadingSpace + indentChar;
                    const indentedJson = prettyJson
                        .split('\n')
                        .map(line => (line ? innerIndent + line : ''))
                        .join('\n');
                    
                    return `${leadingSpace}${openTag}\n${indentedJson}\n${leadingSpace}${closeTag}`;
                } catch (e) {
                    return match;
                }
            });

            if (formattedText !== text) {
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(text.length)
                );
                return [vscode.TextEdit.replace(fullRange, formattedText)];
            }
            return [];
        }
    });

    context.subscriptions.push(formattingProvider);

    if (vscode.window.activeTextEditor) {
        validateDocument(vscode.window.activeTextEditor.document, diagnosticCollection, outputChannel);
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            validateDocument(doc, diagnosticCollection, outputChannel);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            validateDocument(event.document, diagnosticCollection, outputChannel);
        }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            diagnosticCollection.delete(doc.uri);
        })
    );
}

function parseLeanAttrs(content) {
    try {
        const jsonMatch = content.match(/(\{[\s\S]*\})/);
        if (!jsonMatch) return null;
        let jsStr = jsonMatch[1];
        jsStr = jsStr.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
        let cleaned = jsStr
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/([{\s,]\s*)([a-zA-Z0-9_$-]+)(\?)?(\s*):/g, '$1"$2$3"$4:');
        return JSON.parse(cleaned);
    } catch (e) {
        return null;
    }
}

function extractLeanAttrsKeys(document) {
    const text = document.getText();
    const match = text.match(/<!--lean-attrs([\s\S]*?)-->/i);
    if (!match) return [];

    const content = match[1];
    const keys = new Set();

    const propRegex = /@property\s+(?:\{[^}]+\}\s+)?([a-zA-Z0-9_.-]+)/g;
    let propMatch;
    while ((propMatch = propRegex.exec(content)) !== null) {
        keys.add(propMatch[1]);
    }

    const parsed = parseLeanAttrs(content);
    if (parsed) {
        extractKeysRecursive(parsed, '', keys);
    }

    return Array.from(keys);
}

function extractKeysRecursive(obj, prefix, keys) {
    if (!obj || typeof obj !== 'object') return;
    for (const rawK of Object.keys(obj)) {
        const cleanK = rawK.endsWith('?') ? rawK.slice(0, -1) : rawK;
        const fullKey = prefix ? `${prefix}.${cleanK}` : cleanK;
        keys.add(fullKey);
        keys.add(cleanK);
        if (Array.isArray(obj[rawK])) {
            if (obj[rawK].length > 0 && typeof obj[rawK][0] === 'object') {
                extractKeysRecursive(obj[rawK][0], fullKey, keys);
            }
        } else {
            extractKeysRecursive(obj[rawK], fullKey, keys);
        }
    }
}

function getLeanAttrsObject(documentText) {
    const match = documentText.match(/<!--lean-attrs([\s\S]*?)-->/i);
    if (!match) return null;
    return parseLeanAttrs(match[1]);
}

function resolveFragmentPath(currentDocUri, srcValue) {
    const currentDir = path.dirname(currentDocUri.fsPath);
    const candidate1 = path.resolve(currentDir, srcValue);
    if (fs.existsSync(candidate1)) return candidate1;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentDocUri);
    if (workspaceFolder) {
        const candidate2 = path.resolve(workspaceFolder.uri.fsPath, srcValue);
        if (fs.existsSync(candidate2)) return candidate2;
    }
    return null;
}

function validateDocument(document, diagnosticCollection, outputChannel) {
    if (document.uri.scheme !== 'file') return;

    const languageId = document.languageId;
    const fileName = document.fileName;
    const isLeanHtml = languageId === 'html-lean' || fileName.endsWith('.html');
    const isFragment = fileName.endsWith('.fragment.html') || fileName.endsWith('.fragment.hml');

    if (!isLeanHtml && !isFragment) return;

    const diagnostics = [];
    const text = document.getText();

    const dataRegex = /<data\b[^>]*>([\s\S]*?)(?:<\/data>|$)/gi;
    let match;
    while ((match = dataRegex.exec(text)) !== null) {
        const fullMatch = match[0];
        if (!fullMatch.endsWith('</data>')) {
            const startPos = document.positionAt(match.index);
            const endPos = document.positionAt(match.index + fullMatch.length);
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(startPos, endPos),
                '[vite-plugin-html-include] Missing closing </data> tag.',
                vscode.DiagnosticSeverity.Error
            ));
        } else {
            try {
                const jsonContent = match[1].trim();
                if (jsonContent) JSON.parse(jsonContent);
            } catch (e) {
                const jsonStartIndex = match.index + match[0].indexOf(match[1]);
                const startPos = document.positionAt(jsonStartIndex);
                const endPos = document.positionAt(jsonStartIndex + match[1].length);
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(startPos, endPos),
                    `[vite-plugin-html-include] Invalid JSON inside <data> tag: ${e.message}`,
                    vscode.DiagnosticSeverity.Error
                ));
            }
        }
    }

    const includeRegex = /<html-include\s+([^>]+)(?:\/>|>([\s\S]*?)<\/html-include>)/g;
    while ((match = includeRegex.exec(text)) !== null) {
        const attrString = match[1];
        const innerContent = match[2] || '';

        const srcMatch = attrString.match(/\bsrc\s*=\s*["']([^"']+)["']/);
        if (!srcMatch) {
            const startPos = document.positionAt(match.index);
            const endPos = document.positionAt(match.index + match[0].length);
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(startPos, endPos),
                '[vite-plugin-html-include] <html-include> is missing a required "src" attribute.',
                vscode.DiagnosticSeverity.Error
            ));
        } else {
            const srcValue = srcMatch[1];
            const fragmentPath = resolveFragmentPath(document.uri, srcValue);
            if (fragmentPath && fs.existsSync(fragmentPath)) {
                try {
                    const fragmentContent = fs.readFileSync(fragmentPath, 'utf8');
                    const leanAttrs = getLeanAttrsObject(fragmentContent);
                    if (leanAttrs) {
                        validateIncludeAgainstAttrs(document, match.index, match[0], attrString, innerContent, leanAttrs, diagnostics);
                    }
                } catch (err) {
                    // ignore
                }
            }
        }
    }

    if (isFragment) {
        const validKeys = new Set(extractLeanAttrsKeys(document));
        const builtins = new Set(['else', 'this', '@index', '@key', '@first', '@last']);

        const hbRegex = /\{\{\{?([\s\S]*?)\}?\}\}/g;
        let hbMatch;
        while ((hbMatch = hbRegex.exec(text)) !== null) {
            const fullExpr = hbMatch[0];
            const innerContent = hbMatch[1].trim();
            
            let cleanExpr = innerContent
                .replace(/^#\s*(each|if|unless|object|with)\b/, '')
                .replace(/^\/\s*(each|if|unless|object|with)\b/, '')
                .trim();

            if (!cleanExpr || builtins.has(cleanExpr)) continue;

            const tokens = cleanExpr.split(/\s+/);
            const pathToken = tokens[0];

            if (pathToken && !builtins.has(pathToken)) {
                const parts = pathToken.split('.');
                let isValid = true;
                if (!validKeys.has(pathToken)) {
                    let currentValid = true;
                    let accumulated = '';
                    for (const part of parts) {
                        accumulated = accumulated ? `${accumulated}.${part}` : part;
                        if (!validKeys.has(accumulated) && !validKeys.has(part)) {
                            currentValid = false;
                            break;
                        }
                    }
                    isValid = currentValid;
                }

                if (!isValid) {
                    const startPos = document.positionAt(hbMatch.index);
                    const endPos = document.positionAt(hbMatch.index + fullExpr.length);
                    diagnostics.push(new vscode.Diagnostic(
                        new vscode.Range(startPos, endPos),
                        `[lean-html] Unknown property "${pathToken}" not defined in lean-attrs.`,
                        vscode.DiagnosticSeverity.Error
                    ));
                }
            }
        }
    }

    diagnosticCollection.set(document.uri, diagnostics);
}

function validateIncludeAgainstAttrs(document, matchIndex, fullMatchText, attrString, innerContent, leanAttrs, diagnostics) {
    const presentAttrs = new Set();
    const attrRegex = /([a-zA-Z0-9_-]+)\s*=\s*(["'][^"']*["'])/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrString)) !== null) {
        presentAttrs.add(attrMatch[1]);
    }

    const hasDataTag = /<data\b[^>]*>[\s\S]*?<\/data>/i.test(innerContent);

    for (const rawKey of Object.keys(leanAttrs)) {
        const isOptional = rawKey.endsWith('?');
        const key = isOptional ? rawKey.slice(0, -1) : rawKey;
        const val = leanAttrs[rawKey];

        if (key === 'data') {
            const isCollection = Array.isArray(val) || (val !== null && typeof val === 'object');
            if (isCollection) {
                if (!hasDataTag && !isOptional) {
                    const startPos = document.positionAt(matchIndex);
                    const endPos = document.positionAt(matchIndex + fullMatchText.length);
                    diagnostics.push(new vscode.Diagnostic(
                        new vscode.Range(startPos, endPos),
                        `[lean-html] Fragment expects a <data> block because 'data' in lean-attrs is a collection/object.`,
                        vscode.DiagnosticSeverity.Error
                    ));
                }
            } else {
                if (hasDataTag) {
                    const startPos = document.positionAt(matchIndex);
                    const endPos = document.positionAt(matchIndex + fullMatchText.length);
                    diagnostics.push(new vscode.Diagnostic(
                        new vscode.Range(startPos, endPos),
                        `[lean-html] Fragment expects 'data' attribute (string/scalar) on <html-include>, not a <data> tag.`,
                        vscode.DiagnosticSeverity.Error
                    ));
                }
                if (!presentAttrs.has('data') && !isOptional) {
                    const startPos = document.positionAt(matchIndex);
                    const endPos = document.positionAt(matchIndex + fullMatchText.length);
                    diagnostics.push(new vscode.Diagnostic(
                        new vscode.Range(startPos, endPos),
                        `[lean-html] <html-include> is missing required attribute "data" defined in fragment's lean-attrs.`,
                        vscode.DiagnosticSeverity.Error
                    ));
                }
            }
        } else {
            if (!presentAttrs.has(key) && !isOptional) {
                const startPos = document.positionAt(matchIndex);
                const endPos = document.positionAt(matchIndex + fullMatchText.length);
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(startPos, endPos),
                    `[lean-html] <html-include> is missing required attribute "${key}" defined in fragment's lean-attrs.`,
                    vscode.DiagnosticSeverity.Error
                ));
            }
        }
    }
}

function deactivate() {}

module.exports = { activate, deactivate };