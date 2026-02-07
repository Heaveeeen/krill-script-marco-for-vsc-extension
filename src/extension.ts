import * as vsc from 'vscode';
import { KsmcCommonPanic, KsmcFsPanic, makeAstFromSrc, makeKsmdListFromAst, KsmRange, getKsmConfigFromAbsDir, getSrcCodeFromPath, IdToken, Char, getNodeFromAstById, Dialog, Clue, writeFileByPath, NamedNode, KsmAst, ReservedWords, Command, writeFileByAbsDir, makeEmptyAst, Keywords, isMagic, isAno } from './ksmc/parser';
import { cast, staticAssert } from './utils';
import path from 'path';

export function activate(context: vsc.ExtensionContext) {

	let ast: KsmAst | null = null;

	/*const wordPattern = /[^`~!@#%\^&\*\(\)\-=\+\[\{\]\}\\\|;:'",\.<>\/\?\s：“”]+/gu;;
	const sematicTokensProvider = vsc.languages.registerDocumentSemanticTokensProvider("ksm", {
		async provideDocumentSemanticTokens(document, token): Promise<vsc.SemanticTokens | null> {
			const builder = new vsc.SemanticTokensBuilder();
			const text = document.getText();
			for (const match of text.matchAll(wordPattern)) {
				const startPos = document.positionAt(match.index);
				const endPos = document.positionAt(match.index + match[0].length);
				builder.push(
					startPos.line,
					startPos.character,
					endPos.character - startPos.character,
					0,
					0
				);
			}
			return builder.build();
		},
	}, {
		tokenTypes: [],
		tokenModifiers: [],
	});*/
	
	const hoverProvider = vsc.languages.registerHoverProvider("ksm", {
		async provideHover(document, position, token): Promise<vsc.Hover | null> {
			if (ast === null) { return null; }
			const isHover = (range: KsmRange) => document.uri.fsPath === range.fileAbsDir && range.vscRange.contains(position);
			const getCharHover = (node: Char) => {
				const mdstr = new vsc.MarkdownString();
				mdstr.appendCodeblock(`char ${node.idToken.id} ${JSON.stringify(node.name)} ${JSON.stringify(node.desc)}`, "ksm");
				const descLines = node.desc.split("\\n");
				if (descLines.length > 0) { 
					mdstr.appendMarkdown(descLines.join("  \n"));
				}
				return new vsc.Hover(mdstr);
			};
			const getClueHover = (node: Clue) => {
				const mdstr = new vsc.MarkdownString(undefined, true);
				mdstr.appendCodeblock(`clue ${node.idToken.id} ${JSON.stringify(node.desc)}`, "ksm");
				const descLines = node.desc.split("\\n");
				if (descLines.length > 0) { 
					mdstr.appendMarkdown(
`**${descLines[0]}**

${descLines.slice(1).join("  \n")}

\`\`\`
${node.asks.map(ask => `${ask.charIdToken.id} -> ${ask.dialog.id}`).join("  \n")}
\`\`\``
					);
				}
				return new vsc.Hover(mdstr);
			};
			const getDialogHover = (node: Dialog) => {
				const mdstr = new vsc.MarkdownString(``, true);
				if (node.commands.length === 0) {
					mdstr.appendCodeblock(`dialog<${[...node.speakers].sort().join(", ")}> ${node.idToken.id} {}`, "ksm");
				} else {
					mdstr.appendCodeblock(`dialog<${[...node.speakers].sort().join(", ")}> ${node.idToken.id} {\n${
						node.commands.map(command => {
							if (command.type === "say") {
								return `    ${command.charId}: ${command.text}`;
							} else {
								return `    note ${command.target.id}`;
							}
						}).join("\n")
					}\n}`, "ksm");
				}
				return new vsc.Hover(mdstr);
			};
			for (const node of Object.values(ast.symbols)) {
				if (!isHover(node.range)) { continue; }
				if (node.type === "char") {
					if (isHover(node.kwToken.range) || isHover(node.idToken.range)) {
						// [char] [马可] "马可"
						return getCharHover(node);
					}
				} else if (node.type === "clue") {
					if (isHover(node.kwToken.range) || isHover(node.idToken.range)) {
						// [clue] [血字] "..." { ... }
						return getClueHover(node);
					} else {
						for (const ask of node.asks) {
							if (isHover(ask.charIdToken.range)) {
								// { [詹姆斯]: 对话1 }
								return getCharHover(cast<Char | null, Char>(getNodeFromAstById(ast, ask.charIdToken.id)));
							} else if (ask.dialog.type === "idToken") {
								if (isHover(staticAssert<IdToken<Dialog>>(ask.dialog).range)) {
									// { 詹姆斯: [对话1] }
									return getDialogHover(cast<Dialog | null, Dialog>(getNodeFromAstById(ast, ask.dialog.id)));
								}
							}
						}
					}
				} else if (node.type === "dialog") {
					if (isHover(node.kwToken.range) || isHover(node.idToken.range)) {
						// [dialog] [我的对话] { ... }
						return getDialogHover(node);
					} else {
						for (const command of node.commands) {
							if (command.type === "say") {
								if (command.charIdToken !== null && isHover(command.charIdToken.range)) {
									return getCharHover(cast<Char | null, Char>(getNodeFromAstById(ast, command.charIdToken.id)));
								}
							} else if (command.type === "note") {
								if (command.target.type === "idToken") {
									if (isHover(staticAssert<IdToken<Char | Clue>>(command.target).range)) {
										const target = cast<Char | Clue | null, Char | Clue>(getNodeFromAstById(ast, command.target.id));
										if (target.type === "char") {
											return getCharHover(target);
										} else {
											return getClueHover(target);
										}
									}
								}
							}
						}
					}
				} else {
					staticAssert<never>(node);
				}
			}
			for (const combine of ast.combines) {
				if (!isHover(combine.range)) { continue; }
				for (const reason of combine.reasons) {
					if (reason.type === "idToken") {
						if (isHover(reason.range)) {
							const reasonClue = cast<Clue | null, Clue>(getNodeFromAstById(ast, reason.id));
							return getClueHover(reasonClue);
						}
					}
				}
				if (combine.infer.type === "idToken") {
					if (isHover(combine.infer.range)) {
						const inferClue = cast<Clue | null, Clue>(getNodeFromAstById(ast, combine.infer.id));
						return getClueHover(inferClue);
					}
				}
			}
			return null;
		},
	});

	const definitionProvider = vsc.languages.registerDefinitionProvider("ksm", {
		async provideDefinition(document, position, token): Promise<vsc.Location | null> {
			if (ast === null) { return null; }
			const isHover = (range: KsmRange) => document.uri.fsPath === range.fileAbsDir && range.vscRange.contains(position);
			const getLocation = (range: KsmRange) => range.fileAbsDir !== null ? new vsc.Location(vsc.Uri.file(range.fileAbsDir), range.vscRange) : null;
			for (const node of Object.values(ast.symbols)) {
				if (node.type === "char") {
					if (isHover(node.idToken.range)) {
						// char [马可] "马可"
						return getLocation(node.idToken.range);
					}
				} else if (node.type === "clue") {
					if (isHover(node.idToken.range)) {
						// clue [血字] "..." { ... }
						return getLocation(node.idToken.range);
					} else {
						for (const ask of node.asks) {
							if (isHover(ask.charIdToken.range)) {
								// { [詹姆斯]: 对话1 }
								return getLocation(cast<Char | null, Char>(getNodeFromAstById(ast, ask.charIdToken.id)).idToken.range);
							} else if (ask.dialog.type === "idToken") {
								if (isHover(staticAssert<IdToken<Dialog>>(ask.dialog).range)) {
									// { 詹姆斯: [对话1] }
									return getLocation(cast<Dialog | null, Dialog>(getNodeFromAstById(ast, ask.dialog.id)).idToken.range);
								}
							}
						}
					}
				} else if (node.type === "dialog") {
					if (isHover(node.idToken.range)) {
						// dialog [我的对话] { ... }
						return getLocation(node.idToken.range);
					} else {
						for (const command of node.commands) {
							if (command.type === "say") {
								if (command.charIdToken !== null && isHover(command.charIdToken.range)) {
									return getLocation(cast<Char | null, Char>(getNodeFromAstById(ast, command.charIdToken.id)).idToken.range);
								}
							} else if (command.type === "note") {
								if (command.target.type === "idToken") {
									if (isHover(staticAssert<IdToken<Char | Clue>>(command.target).range)) {
										const target = cast<Char | Clue | null, Char | Clue>(getNodeFromAstById(ast, command.target.id));
										return getLocation(target.idToken.range);
									}
								}
							}
						}
					}
				} else {
					staticAssert<never>(node);
				}
			}
			for (const combine of ast.combines) {
				if (!isHover(combine.range)) { continue; }
				for (const reason of combine.reasons) {
					if (reason.type === "idToken") {
						if (isHover(reason.range)) {
							const reasonClue = cast<Clue | null, Clue>(getNodeFromAstById(ast, reason.id));
							return getLocation(reasonClue.range);
						}
					}
				}
				if (combine.infer.type === "idToken") {
					if (isHover(combine.infer.range)) {
						const inferClue = cast<Clue | null, Clue>(getNodeFromAstById(ast, combine.infer.id));
						return getLocation(inferClue.range);
					}
				}
			}
			return null;
		},
	});

	type RefType = "char-declare" |
		"clue-declare" | "ask-char" | "ask-dialog" |
		"dialog-declare" | "say-char" | "note-char" | "note-clue" |
		"combine-reason" | "combine-infer";

	function forEachRefOfHoverRanges(opitons: {
		ast: KsmAst
		includeDeclaration: boolean,
		isHover: (range: KsmRange) => boolean,
		callback: (range: KsmRange, type: RefType) => void,
	}): void {
		const { ast, includeDeclaration, isHover, callback } = opitons;
		// 获取当前的焦点
		let hoverIdToken: IdToken | null = null;
		for (const node of Object.values(ast.symbols)) {
			if (node.type === "char") {
				if (isHover(node.idToken.range)) {
					// char [马可] "马可"
					hoverIdToken = node.idToken;
				}
			} else if (node.type === "clue") {
				if (isHover(node.idToken.range)) {
					// clue [血字] "..." { ... }
					hoverIdToken = node.idToken;
				} else {
					for (const ask of node.asks) {
						if (isHover(ask.charIdToken.range)) {
							// { [詹姆斯]: 对话1 }
							hoverIdToken = cast<Char | null, Char>(getNodeFromAstById(ast, ask.charIdToken.id)).idToken;
						} else if (ask.dialog.type === "idToken") {
							if (isHover(staticAssert<IdToken<Dialog>>(ask.dialog).range)) {
								// { 詹姆斯: [对话1] }
								hoverIdToken = cast<Dialog | null, Dialog>(getNodeFromAstById(ast, ask.dialog.id)).idToken;
							}
						}
					}
				}
			} else if (node.type === "dialog") {
				if (isHover(node.idToken.range)) {
					// dialog [我的对话] { ... }
					hoverIdToken = node.idToken;
				} else {
					for (const command of node.commands) {
						if (command.type === "say") {
							if (command.charIdToken !== null && isHover(command.charIdToken.range)) {
								hoverIdToken = cast<Char | null, Char>(getNodeFromAstById(ast, command.charIdToken.id)).idToken;
							}
						} else if (command.type === "note") {
							if (command.target.type === "idToken") {
								if (isHover(staticAssert<IdToken<Char | Clue>>(command.target).range)) {
									const target = cast<Char | Clue | null, Char | Clue>(getNodeFromAstById(ast, command.target.id));
									hoverIdToken = target.idToken;
								}
							}
						}
					}
				}
			} else {
				staticAssert<never>(node);
			}
		}
		for (const combine of ast.combines) {
			if (!isHover(combine.range)) { continue; }
			for (const reason of combine.reasons) {
				if (reason.type === "idToken") {
					if (isHover(reason.range)) {
						hoverIdToken = reason;
					}
				}
			}
			if (combine.infer.type === "idToken") {
				if (isHover(combine.infer.range)) {
					const inferClue = cast<Clue | null, Clue>(getNodeFromAstById(ast, combine.infer.id));
					hoverIdToken = combine.infer;
				}
			}
		}
		if (hoverIdToken === null) { return; }
		// 到此处，已经获取到了有一个带有引用的焦点
		const hoverId = hoverIdToken.id;
		const hoverDeclare = cast<NamedNode | null, NamedNode>(getNodeFromAstById(ast, hoverId));
		for (const node of Object.values(ast.symbols)) {
			if (node.type === "char") {
				if (includeDeclaration) {
					if (hoverDeclare.type === "char" && hoverId ===  node.idToken.id) {
						callback(node.idToken.range, "char-declare");
					}
				}
			} else if (node.type === "clue") {
				if (includeDeclaration) {
					if (hoverDeclare.type === "clue" && hoverId ===  node.idToken.id) {
						callback(node.idToken.range, "clue-declare");
					}
				}
				for (const ask of node.asks) {
					if (hoverDeclare.type === "char" && hoverId === ask.charIdToken.id) {
						callback(ask.charIdToken.range, "ask-char");
					}
					if (hoverDeclare.type === "dialog" && hoverId === ask.dialog.id) {
						if (ask.dialog.type === "idToken") {
							callback(ask.dialog.range, "ask-dialog");
						}
					}
				}
			} else if (node.type === "dialog") {
				if (includeDeclaration) {
					if (hoverDeclare.type === "dialog" && hoverId ===  node.idToken.id) {
						callback(node.idToken.range, "dialog-declare");
					}
				}
				for (const command of node.commands) {
					if (command.type === "say") {
						if (command.charIdToken !== null && hoverDeclare.type === "char" && hoverId === command.charIdToken.id) {
							callback(command.charIdToken.range, "say-char");
						}
					} else {
						staticAssert<"note">(command.type);
						if (command.target.type === "idToken") {
							const noteTarget = cast<Char | Clue | null, Char | Clue>(getNodeFromAstById(ast, command.target.id));
							if (hoverDeclare.type === noteTarget.type && hoverId === command.target.id) {
								callback(command.target.range, noteTarget.type === "char" ? "note-char" : "note-clue");
							}
						}
					}
				}
			} else {
				staticAssert<never>(node);
			}
		}
		for (const combine of ast.combines) {
			if (!isHover(combine.range)) { continue; }
			for (const reason of combine.reasons) {
				if (reason.type === "idToken") {
					callback(reason.range, "combine-reason");
				}
			}
			if (combine.infer.type === "idToken") {
				callback(combine.infer.range, "combine-infer");
			}
		}
	};

	const referenceProvider = vsc.languages.registerReferenceProvider("ksm", {
		async provideReferences(document, position, context, token): Promise<vsc.Location[] | null> {
			if (ast === null) { return null; }
			const isHover = (range: KsmRange) => document.uri.fsPath === range.fileAbsDir && range.vscRange.contains(position);
			const getLocation = (range: KsmRange) => range.fileAbsDir !== null ? new vsc.Location(vsc.Uri.file(range.fileAbsDir), range.vscRange) : null;
			const refs: vsc.Location[] = [];
			let showCharRefsOfSayCommands = vsc.workspace.getConfiguration("krillScriptMarco").get("showCharRefsOfSayCommands");
			if (
				showCharRefsOfSayCommands !== "none" &&
				showCharRefsOfSayCommands !== "all"
			) {
				showCharRefsOfSayCommands = "none";
			}
			const add = (range: KsmRange, type: RefType) => {
				const location = getLocation(range);
				if (location !== null) {
					if (showCharRefsOfSayCommands === "all" || type !== "say-char") {
						refs.push(location);
					}
				}
			};
			forEachRefOfHoverRanges({
				ast,
				includeDeclaration: context.includeDeclaration,
				isHover,
				callback: add,
			});
			return refs;
		},
	});

	function prepareRenameOrNot(document: vsc.TextDocument, position: vsc.Position, token: vsc.CancellationToken): { ok: true, range: vsc.Range } | { ok: false, message?: string } {
		if (ast === null) { return { ok: false, message: "未获取到 AST" }; }
		const isHover = (range: KsmRange) => document.uri.fsPath === range.fileAbsDir && range.vscRange.contains(position);
		for (const node of Object.values(ast.symbols)) {
			if (!isHover(node.range)) { continue; }
			if (node.type === "char") {
				if (isHover(node.idToken.range)) {
					return {ok: true, range: node.idToken.range.vscRange };
				}
			} else if (node.type === "clue") {
				if (isHover(node.idToken.range)) {
					return {ok: true, range: node.idToken.range.vscRange };
				} else {
					for (const ask of node.asks) {
						if (isHover(ask.charIdToken.range)) {
							return {ok: true, range: ask.charIdToken.range.vscRange };
						} else if (ask.dialog.type === "idToken" && isHover(ask.dialog.range)) {
							return {ok: true, range: ask.dialog.range.vscRange };
						}
					}
				}
			} else if (node.type === "dialog") {
				if (isHover(node.idToken.range)) {
					return {ok: true, range: node.idToken.range.vscRange };
				} else {
					for (const command of node.commands) {
						if (command.type === "say") {
							if (command.charIdToken !== null && isHover(command.charIdToken.range)) {
								return {ok: true, range: command.charIdToken.range.vscRange };
							}
						} else {
							if (command.target.type === "idToken" && isHover(command.target.range)) {
								return {ok: true, range: command.target.range.vscRange };
							}
						}
					}
				}
			} else {
				staticAssert<never>(node);
			}
		}
		return { ok: false, message: "无法重命名该位置。" };
	};

	const renameProvider = vsc.languages.registerRenameProvider("ksm", {
		async prepareRename(document, position, token): Promise<vsc.Range> {
			const prepareRenameResult = prepareRenameOrNot(document, position, token);
			if (prepareRenameResult.ok) {
				return prepareRenameResult.range;
			} else {
				throw new Error(prepareRenameResult.message);
				// 狗屎设计👍不能重命名的位置不能提供返回值，必须抛出异常👍此程序基于错误运行👍vsc是这个👍👍👍👍
			}
		},
		async provideRenameEdits(document, position, newName, token): Promise<vsc.WorkspaceEdit | null> {
			if (ast === null) { return null; }
			if (ReservedWords.has(newName)) { throw new SyntaxError("不能把标识符命名为保留字。"); }
			const isHover = (range: KsmRange) => document.uri.fsPath === range.fileAbsDir && range.vscRange.contains(position);
			const edit = new vsc.WorkspaceEdit();
			const addRename = (range: KsmRange) => {
				if (range.fileAbsDir === null) { return; }
				edit.replace(vsc.Uri.file(range.fileAbsDir), range.vscRange, newName);
			};
			forEachRefOfHoverRanges({
				ast,
				includeDeclaration: true,
				isHover,
				callback: addRename,
			});
			return edit;
		},
	});

	const completionProvider = vsc.languages.registerCompletionItemProvider("ksm", {
		async provideCompletionItems(document, position, token, context): Promise<vsc.CompletionItem[] | null> {
			if (ast === null) { return null; }
			const compItems: vsc.CompletionItem[] = [];

			Keywords.forEach(word => compItems.push(new vsc.CompletionItem(word, vsc.CompletionItemKind.Keyword)));
			for (const node of Object.values(ast.symbols)) {
				if (isMagic<NamedNode>(node.idToken.id)) { continue; }
				const label: vsc.CompletionItemLabel = {
					label: node.idToken.id,
					//detail: `${node.type} ${node.idToken.id}`,
				};
				let kind: vsc.CompletionItemKind;
				if (node.type === "char") {
					label.description = `char ${node.idToken.id} ${JSON.stringify(node.name)}`;
					kind = vsc.CompletionItemKind.EnumMember;
				} else if (node.type === "clue") {
					label.description = `clue ${node.idToken.id} ${JSON.stringify(node.desc)}`;
					const descLines = node.desc.split("\\n");
					if (descLines.length > 0) { 
						label.description += `*描述:* \n\n**${descLines[0]}**\n\n${descLines.slice(1).join("  \n")}`;
					}
					kind = vsc.CompletionItemKind.Variable;
				} else {
					staticAssert<"dialog">(node.type);
					let txt = "";
					if (node.commands.length > 0) {
						txt = `\n${
							node.commands.map(command => {
								if (command.type === "say") {
									return `    ${command.charId}: ${command.text}`;
								} else {
									return `    note ${command.target.id}`;
								}
							}).join("\n")
						}\n`;
					}
					label.description = `dialog ${node.idToken.id} {${txt}}`;
					kind = vsc.CompletionItemKind.Function;
				}
				compItems.push(new vsc.CompletionItem(label, kind));
			}

			return compItems;
		},
	});

	const nullRange = new vsc.Range(new vsc.Position(0, 0), new vsc.Position(0, 0));

	const symbolProvider = vsc.languages.registerDocumentSymbolProvider("ksm", {
		async provideDocumentSymbols(document, token): Promise<vsc.DocumentSymbol[] | null> {
			if (ast === null) { return null; }
			let dialogCommandMaxCount: number;
			{
				let cfg = vsc.workspace.getConfiguration("krillScriptMarco").get("showDialogCommandsInOutline");
				if (cfg === "none") {
					dialogCommandMaxCount = 0;
				} else if (cfg === "all") {
					dialogCommandMaxCount = Infinity;
				} else {
					cfg = "limited";
					dialogCommandMaxCount = 3;
				}
			}
			let showAnoDeclares: "all" | "warp" | "none";
			{
				let cfg = vsc.workspace.getConfiguration("krillScriptMarco").get("showAnonymousDeclaresInOutline");
				if (cfg === "all" || cfg === "warp" || cfg === "none") {
					showAnoDeclares = cfg;
				} else {
					showAnoDeclares = "warp";
				}
			}

			const symbols: vsc.DocumentSymbol[] = [];
			const getCommandDesc = (command: Command) => command.type === "say" ?
				`${command.charId}：${command.text}` :
				`note ${command.target.id}`;
			const anos = new vsc.DocumentSymbol("[anonymous]", "", vsc.SymbolKind.Namespace, nullRange, nullRange);
			const chars = new vsc.DocumentSymbol("[characters]", "", vsc.SymbolKind.Enum, nullRange, nullRange);
			for (const node of Object.values(ast.symbols)) {
				if (showAnoDeclares === "none" && isAno<NamedNode>(node.idToken.id)) { continue; }
				if (document.uri.fsPath !== node.range.fileAbsDir) { continue; }
				if (node.type === "char") {
					chars.children.push(new vsc.DocumentSymbol(
						node.idToken.id,
						node.desc ? `${node.name} - ${node.desc}` : node.name,
						vsc.SymbolKind.EnumMember,
						node.range.vscRange,
						node.idToken.range.vscRange,
					));
				} else if (node.type === "clue") {
					const clue = new vsc.DocumentSymbol(
						node.idToken.id,
						node.desc.split("\\n")[0],
						vsc.SymbolKind.Variable,
						node.range.vscRange,
						node.idToken.range.vscRange
					);
					if (showAnoDeclares === "warp" && isAno<NamedNode>(node.idToken.id)) {
						anos.children.push(clue);
					} else {
						symbols.push(clue);
					}
					for (const ask of node.asks) {
						clue.children.push(new vsc.DocumentSymbol(
							`${ask.charIdToken.id} -> ${ask.dialog.id}`,
							"ask",
							vsc.SymbolKind.Event,
							ask.range.vscRange,
							ask.range.vscRange,
						));
					}
				} else if (node.type === "dialog") {
					const dialog = new vsc.DocumentSymbol(
						node.idToken.id,
						node.commands.length === 0 ? "[empty dialog]" : getCommandDesc(node.commands[0]),
						vsc.SymbolKind.Function,
						node.range.vscRange,
						node.idToken.range.vscRange
					);
					if (showAnoDeclares === "warp" && isAno<NamedNode>(node.idToken.id)) {
						anos.children.push(dialog);
					} else {
						symbols.push(dialog);
					}
					let i = 0;
					for (const command of node.commands) {
						if (i >= dialogCommandMaxCount) { break; }
						dialog.children.push(new vsc.DocumentSymbol(
							getCommandDesc(command),
							command.type,
							vsc.SymbolKind.String,
							command.range.vscRange,
							command.range.vscRange
						));
						i++;
					}
				} else {
					staticAssert<never>(node);
				}
			}
			if (chars.children.length > 0) {
				chars.detail = `[${chars.children.length}]`;
				symbols.push(chars);
			}
			if (anos.children.length > 0) {
				anos.detail = `[${anos.children.length}]`;
				symbols.push(anos);
			}
			return symbols;
		},
	}, {});

	const documentLinkProvider = vsc.languages.registerDocumentLinkProvider("ksm", {
		async provideDocumentLinks(document, token): Promise<vsc.DocumentLink[] | null> {
			if (ast === null) { return null; }

			const links: vsc.DocumentLink[] = [];
			for (const imp of ast.imports) {
				if (document.uri.fsPath !== imp.range.fileAbsDir) { continue; }
				links.push(new vsc.DocumentLink(
					imp.pathStringToken.range.vscRange,
					vsc.Uri.file(imp.importAbsDir)
				));
			}
			return links;
		},
	});

	const inlayHintProvider = vsc.languages.registerInlayHintsProvider("ksm", {
		async provideInlayHints(document, range, token): Promise<vsc.InlayHint[] | null> {
			if (ast === null) { return null; }

			let showOmittedCharIds: "none" | "all";
			{
				let cfg = vsc.workspace.getConfiguration("krillScriptMarco").get("showOmittedCharIds");
				if (cfg === "all" || cfg === "none") {
					showOmittedCharIds = cfg;
				} else {
					showOmittedCharIds = "none";
				}
			}

			let showDialogInfoAtDeclare: "none" | "all";
			{
				let cfg = vsc.workspace.getConfiguration("krillScriptMarco").get("showDialogInfoAtDeclare");
				if (cfg === "all" || cfg === "none") {
					showDialogInfoAtDeclare = cfg;
				} else {
					showDialogInfoAtDeclare = "none";
				}
			}


			const inlayHints: vsc.InlayHint[] = [];
			for (const node of Object.values(ast.symbols)) {
				if (document.uri.fsPath !== node.range.fileAbsDir) { continue; }
				if (node.type !== "dialog") { continue; }

				// 显示对话的所有参与者
				if (showDialogInfoAtDeclare) {
					if (node.speakers.size > 0) {
						const part = new vsc.InlayHintLabelPart(`<${[...node.speakers].sort().join(", ")}>`);
						inlayHints.push(new vsc.InlayHint(
							node.kwToken.range.vscRange.end,
							[part]
						));
					}
				}

				// 显示隐藏的说话者
				if (showOmittedCharIds === "all") {
					for (const command of node.commands) {
						if (command.type === "say" && command.isOmittedCharId) {
							const part = new vsc.InlayHintLabelPart(command.charId);
							inlayHints.push(new vsc.InlayHint(
								command.range.vscRange.start,
								[part]
							));
						}
					}
				}
			}
			return inlayHints;
		},
	});

	//#region compile
	{
		const compileCommandDisposable = vsc.commands.registerCommand('krill-script-marco.compile', () => {

			const terminal = vsc.window.createTerminal("KSM 编译");
			terminal.show();
			const print = (text: string) => terminal.sendText(`echo '${text.replaceAll("'", "''")}'`);

			const rootFolder = vsc.workspace.workspaceFolders?.[0];
			if (!rootFolder) { return; }
			const ksmConfigFileAbsDir = path.resolve(rootFolder.uri.fsPath, "./ksmconfig.json");
			const ksmConfig = getKsmConfigFromAbsDir(ksmConfigFileAbsDir);
			if (ksmConfig instanceof KsmcFsPanic) {
				print(`KSM 编译失败：无法打开配置文件。请确保工作区根目录下存在 ksmconfig.json 。\n${ksmConfig.message}`);
				return;
			} else if (ksmConfig instanceof KsmcCommonPanic) {
				print(`KSM 编译失败：ksmconfig.json 配置文件出现错误。\n${ksmConfig.message}`);
				return;
			}

			const getSrcCodeResult = getSrcCodeFromPath({
				currentFileAbsDir: ksmConfigFileAbsDir,
				importTargetPath: ksmConfig.rootFile,
				importedAbsDirs: null,
				errorRange: null,
			});
			if (getSrcCodeResult instanceof KsmcCommonPanic || getSrcCodeResult instanceof KsmcFsPanic) {
				print(getSrcCodeResult.message);
				return;
			} else if (getSrcCodeResult.type === "repeatImportedAndIgnore") {
				// 此处理应不可达
				return;
			}

			print(`生成 AST ...`);
			const astResult = makeAstFromSrc({
				srcCode: getSrcCodeResult.importSrcCode,
				fileAbsDir: getSrcCodeResult.importAbsDir,
				importedAbsDirs: [],
				ast: makeEmptyAst(),
				handleImportButNoPathError: ksmConfig.handleImportButNoPathError,
				handleNewlineInString: ksmConfig.handleNewlineInString,
				handleIndentInString: ksmConfig.handleIndentInString,
				allowChineseKeywords: ksmConfig.allowChineseKeywords,
				allowUndefinedIds: false,
			});
			if (astResult.type === "panic") {
				print(`生成AST出现错误。`);
				astResult.panics.forEach(panic => {
					console.error(panic);
					if (panic instanceof KsmcFsPanic) {
						console.error(panic.fsErr);
					}
					print(panic.message);
				});
				return;
			}

			const ast: KsmAst = astResult.validAst;

			console.log("astResult: ", astResult);
			print(`生成 AST 成功。`);
			//terminal.sendText("echo '按任意键退出。'; $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown'); exit");
			
			print(`生成 KSMD ...`);
			let ksmdListResult = makeKsmdListFromAst({ast, handleInlineNewlines: ksmConfig.handleInlineNewlines});
			if (ksmdListResult instanceof KsmcCommonPanic) {
				print(`生成 KSMD 出现错误。`);
				console.error(ksmdListResult);
				print(ksmdListResult.message);
				return;
			}
			const ksmdString = ksmdListResult.join("\r\n");
			print(`生成 KSMD 成功。`);

			print(`写入编译输出文件……`);
			const writeResult = writeFileByPath({
				text: ksmdString,
				rootAbsDir: ksmConfigFileAbsDir,
				outPath: ksmConfig.outFile,
				flag: "w",
			});
			if (writeResult.type === "panic") {
				print(`写入编译输出文件出现错误。`);
				console.error(writeResult.panic);
				console.error(writeResult.panic.fsErr);
				print(writeResult.panic.message);
				return;
			}
			print(`成功将编译结果写入到输出文件：${writeResult.outAbsDir}`);
			terminal.sendText("pause; exit;");
		});

		context.subscriptions.push(compileCommandDisposable);
	}
	//#endregion

	//#region create ksm config file
	{
		const createConfigCommandDisposable = vsc.commands.registerCommand("krill-script-marco.create-ksm-config-file", () => {
			const rootAbsDir = vsc.workspace.workspaceFolders?.[0].uri.fsPath;
			if (rootAbsDir === undefined) {
				vsc.window.showErrorMessage(`无法创建配置文件，未检测到有效的工作区文件夹。`);
				return;
			}
			const configAbsDir = path.resolve(rootAbsDir, "./ksmconfig.json");
			const writeResult = writeFileByAbsDir({
				text: `{
    "rootFile": "./my_index_file.ksm",
    "outFile": "./dist/my_out_file.ksmd.txt",

    "handleImportButNoPathError": "panic",
    "handleNewlineInString": "panic",
    "handleIndentInString": "panic",
    "handleInlineNewlines": "panic",
    "allowChineseKeywords": true
}`,
				absDir: configAbsDir,
				flag: "wx",
			});

			if (writeResult.type === "success") {
				vsc.window.showInformationMessage(`已成功在 ${configAbsDir} 创建 KSM 默认配置文件`);
			} else {
				vsc.window.showErrorMessage(`${writeResult.panic.message}\n\n可能是因为已经存在配置文件。`);
			}
		});
	}
	//#endregion

	//#region on change
	{
		const diagnosticCollection = vsc.languages.createDiagnosticCollection();

		const reportACommonOrFsPanic = (commonOrFsPanic: KsmcCommonPanic | KsmcFsPanic) => {
			const panic = commonOrFsPanic instanceof KsmcCommonPanic ? commonOrFsPanic : commonOrFsPanic.panic;
			if (typeof panic.range?.fileAbsDir === "string") {
				const range = panic.range;
				const uri = vsc.Uri.file(panic.range.fileAbsDir);

				const diagnostic = new vsc.Diagnostic(range.vscRange, panic.message, vsc.DiagnosticSeverity.Error);
				diagnosticCollection.set(uri, [diagnostic]);
			} else {
				console.error(panic);
				if (commonOrFsPanic instanceof KsmcFsPanic) {
					console.error(commonOrFsPanic.fsErr);
				}
				vsc.window.showErrorMessage(panic.message);
			}
		};

		const updateSyntaxCheck = (() => {
			let timeOut: ReturnType<typeof setTimeout> | null;

			const checkSyntax = async () => {
				// 初始化错误报告、悬停等所有提示资源
				diagnosticCollection.clear();

				const rootFolder = vsc.workspace.workspaceFolders?.[0];
				if (!rootFolder) { return; }
				const ksmConfigFileAbsDir = path.resolve(rootFolder.uri.fsPath, "./ksmconfig.json");
				const ksmConfig = getKsmConfigFromAbsDir(ksmConfigFileAbsDir);
				if (ksmConfig instanceof KsmcFsPanic || ksmConfig instanceof KsmcCommonPanic) {
					let isKsmConfigFileExist: boolean;
					try {
						await vsc.workspace.fs.stat(vsc.Uri.file(ksmConfigFileAbsDir));
						isKsmConfigFileExist = true;
					} catch {
						isKsmConfigFileExist = false;
					}
					if (isKsmConfigFileExist) {
						reportACommonOrFsPanic(ksmConfig);
					}
					return;
				}

				const getSrcCodeResult = getSrcCodeFromPath({
					currentFileAbsDir: ksmConfigFileAbsDir,
					importTargetPath: ksmConfig.rootFile,
					importedAbsDirs: null,
					errorRange: null,
				});
				if (getSrcCodeResult instanceof KsmcCommonPanic || getSrcCodeResult instanceof KsmcFsPanic) {
					reportACommonOrFsPanic(getSrcCodeResult);
					return;
				} else if (getSrcCodeResult.type === "repeatImportedAndIgnore") {
					return;
				}
				const astResult = makeAstFromSrc({
					srcCode: getSrcCodeResult.importSrcCode,
					fileAbsDir: getSrcCodeResult.importAbsDir,
					importedAbsDirs: [],
					ast: makeEmptyAst(),
					handleImportButNoPathError: ksmConfig.handleImportButNoPathError,
					handleNewlineInString: ksmConfig.handleNewlineInString,
					handleIndentInString: ksmConfig.handleIndentInString,
					allowChineseKeywords: ksmConfig.allowChineseKeywords,
					allowUndefinedIds: false,
				});
				if (astResult.type === "panic") {
					astResult.panics.forEach(panic => reportACommonOrFsPanic(panic));
				} else {
					ast = astResult.validAst;
				}
			};

			return () => {
				if (timeOut !== null) {
					clearTimeout(timeOut);
					timeOut = null;
				}
				timeOut = setTimeout(() => {
					checkSyntax();
					timeOut = null;
				}, 500);
			};
		})();
		updateSyntaxCheck();
		vsc.workspace.onDidChangeTextDocument(updateSyntaxCheck);
		vsc.workspace.onDidChangeWorkspaceFolders(updateSyntaxCheck);
		vsc.workspace.onDidDeleteFiles(updateSyntaxCheck);
		vsc.workspace.onDidRenameFiles(updateSyntaxCheck);
	}
	//#endregion

}

export function deactivate() { }
