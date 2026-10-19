const vscode = require('vscode');

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
    
    // 1. Completion Provider
    const completionProvider = vscode.languages.registerCompletionItemProvider(selector, {
        provideCompletionItems(document, position) {
            const linePrefix = document.lineAt(position).text.substr(0, position.character);
            const completions = [];

            if (linePrefix.endsWith('{{')) {
                const keywords = [
                    { label: '#each', snippet: '#each ${1:collection}}\n\t$0\n{{/each}}', doc: 'Handlebars each loop' },
                    { label: '#if', snippet: '#if ${1:condition}}\n\t$0\n{{/if}}', doc: 'Handlebars conditional block' },
                    { label: '#unless', snippet: '#unless ${1:condition}}\n\t$0\n{{/unless}}', doc: 'Handlebars unless block' },
                    { label: '#with', snippet: '#with ${1:context}}\n\t$0\n{{/with}}', doc: 'Handlebars with block' },
                    { label: 'else', snippet: 'else', doc: 'Handlebars else clause' },
                    { label: '/each', snippet: '/each', doc: 'Close each loop' },
                    { label: '/if', snippet: '/if', doc: 'Close if block' }
                ];

                keywords.forEach(kw => {
                    const item = new vscode.CompletionItem(kw.label, vscode.CompletionItemKind.Keyword);
                    item.insertText = new vscode.SnippetString(kw.snippet);
                    item.documentation = new vscode.MarkdownString(kw.doc);
                    completions.push(item);
                });
            }

            if (linePrefix.endsWith('<')) {
                const htmlInclude = new vscode.CompletionItem('html-include', vscode.CompletionItemKind.Snippet);
                htmlInclude.insertText = new vscode.SnippetString('html-include src="sections/${1:name}.html" title="${2:Title}">\n\t<data>\n\t\t{\n\t\t\t"${3:items}": []\n\t\t}\n\t</data>\n</html-include>');
                htmlInclude.documentation = new vscode.MarkdownString('Insert an html-include block with payload data.');
                completions.push(htmlInclude);
            }

            return completions;
        }
    }, '{', '<');

    context.subscriptions.push(completionProvider);

    // 2. Surgical Document Formatter (Formats JSON data blocks & leaves HTML/Handlebars untouched)
    const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider(selector, {
        provideDocumentFormattingEdits(document, options) {
            const text = document.getText();
            const tabSize = options.tabSize || 2;
            const indentChar = options.insertSpaces ? ' '.repeat(tabSize) : '\t';

            // Match <data> ... </data> blocks, capturing the exact leading whitespace of the <data> line
            const dataRegex = /^([ \t]*)(<data\b[^>]*>)([\s\S]*?)(<\/data>)/gim;
            
            let formattedText = text.replace(dataRegex, (match, leadingSpace, openTag, jsonContent, closeTag) => {
                try {
                    const cleanJson = jsonContent.trim();
                    if (!cleanJson) return match;
                    
                    const parsed = JSON.parse(cleanJson);
                    const prettyJson = JSON.stringify(parsed, null, tabSize);
                    
                    // Indent the JSON payload one level deeper relative to the <data> tag's indentation
                    const innerIndent = leadingSpace + indentChar;
                    const indentedJson = prettyJson
                        .split('\n')
                        .map(line => (line ? innerIndent + line : ''))
                        .join('\n');
                    
                    return `${leadingSpace}${openTag}\n${indentedJson}\n${leadingSpace}${closeTag}`;
                } catch (e) {
                    // If JSON has syntax errors, leave it untouched so diagnostics flag it properly
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

    // Diagnostics validation
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

    const includeRegex = /<html-include\s+([^>]+)(?:\/>|>[\s\S]*?<\/html-include>)/g;
    while ((match = includeRegex.exec(text)) !== null) {
        const attrString = match[1];
        if (!/\bsrc\s*=\s*["'][^"']+["']/.test(attrString)) {
            const startPos = document.positionAt(match.index);
            const endPos = document.positionAt(match.index + match[0].length);
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(startPos, endPos),
                '[vite-plugin-html-include] <html-include> is missing a required "src" attribute.',
                vscode.DiagnosticSeverity.Error
            ));
        }
    }

    diagnosticCollection.set(document.uri, diagnostics);
}

function deactivate() {}

module.exports = { activate, deactivate };