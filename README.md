# Lean HTML Language Support (`vscode-lean-html`)

Bring powerful syntax support, smart diagnostics, and template tooling to your lightweight HTML and fragment workflows. This extension provides first-class support for custom `*.fragment.html` / `*.hml` files, Handlebars expressions, embedded JSON data payloads, and `<html-include>` components.


## Features

* **HTML Fragments (`*.fragment.html`, `*.hml`)**: Seamlessly highlights HTML combined with Handlebars syntax (`{{#each}}`, `{{#if}}`, variable bindings, etc.).
* **Embedded JSON Highlighting**: Full JSON syntax highlighting inside `<data>` blocks across both regular HTML and fragment files.
* **Smart Autocomplete**:
  * Type `{{` to get instant keyword snippets for Handlebars blocks (`#each`, `#if`, `#unless`, `#with`, `else`).
  * Type `<` to quickly scaffold custom `<html-include>` elements.


* **Real-time Diagnostics & Validation**: Automatically flags common errors in your editor:
  * Missing closing `</data>` tags.
  * Invalid JSON payloads inside `<data>` blocks.
  * Missing mandatory `src` attributes in `<html-include>` tags.


* **Surgical Document Formatter**: Press `Shift+Alt+F` (or `Shift+Option+F`) to automatically prettify and align JSON blocks inside `<data>` tags without altering your surrounding HTML structure or Handlebars indentations.
* **Snippets**: Built-in code snippets to bootstrap component includes quickly (prefix: `html-inc`).


## Requirements

No external dependencies or binaries are required. Works out of the box with standard VS Code installations.


## Extension Settings

This extension works seamlessly with your existing editor configurations and respects your tab size and indentation preferences (`editor.tabSize`, `editor.insertSpaces`).


## Release Notes

### 0.0.1

* Initial release of Lean HTML Support.
* Added support for custom `*.fragment.html` and `*.fragment.hml` file types.
* Added TextMate grammar injection for JSON inside `<data>` tags.
* Added Handlebars syntax highlighting and block autocompletions.
* Added live diagnostic error checking for `<html-include>` and `<data>` blocks.
* Added non-invasive document formatting for embedded JSON payloads.