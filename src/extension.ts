// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vsc from 'vscode';
import { KsmcCommonPanic, KsmcFsPanic, makeAstFromSrc, KsmAst, makeKsmdListFromAst, KsmRange, getKsmConfigFromAbsDir, getSrcCodeFromPath, IdToken, Char, getNodeFromAstById, Dialog, Clue, writeOrCreateFileByPath } from './ksmc/parser';
import { cast, staticAssert } from './utils';
import path from 'path';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vsc.ExtensionContext) {

	let ast: KsmAst | null = null;
	const hoverProvider = vsc.languages.registerHoverProvider("ksm", {
		provideHover(document, position, token): vsc.Hover | null {
			if (ast === null) { return null; }
			const getCharHover = (node: Char) => {
				const mdstr = new vsc.MarkdownString();
				mdstr.appendCodeblock(`char ${node.idToken.id} ${JSON.stringify(node.name)}`, "ksm");
				return new vsc.Hover(mdstr);
			};
			const getClueHover = (node: Clue) => {
				const mdstr = new vsc.MarkdownString(undefined, true);
				mdstr.appendCodeblock(`clue ${node.idToken.id} ${JSON.stringify(node.desc)}`, "ksm");
				const descLines = node.desc.split("\\n");
				if (descLines.length > 0) { 
					mdstr.appendMarkdown(`*description:* \n\n**${descLines[0]}**\n\n${descLines.slice(1).join("  \n")}`);
				}
				return new vsc.Hover(mdstr);
			};
			const getDialogHover = (node: Dialog) => {
				const mdstr = new vsc.MarkdownString(undefined, true);
				if (node.commands.length === 0) {
					mdstr.appendCodeblock(`dialog ${node.idToken.id} {}`, "ksm");
				} else {
					mdstr.appendCodeblock(`dialog ${node.idToken.id} {\n${
						node.commands.map(command => {
							if (command.type === "say") {
								return `    ${command.charId}: ${command.text}`;
							} else {
								return `    note ${command.targetIdTokenOrDeclareId.id}`;
							}
						}).join("\n")
					}\n}`, "ksm");
				}
				return new vsc.Hover(mdstr);
			};
			for (const node of Object.values(ast)) {
				if (!node.range.vscRange.contains(position)) { continue; }
				if (node.type === "char") {
					if (node.idToken.range.vscRange.contains(position)) {
						// char [马可] "马可"
						return getCharHover(node);
					}
				} else if (node.type === "clue") {
					if (node.idToken.range.vscRange.contains(position)) {
						// clue [血字] "..." { ... }
						return getClueHover(node);
					} else {
						for (const ask of node.asks) {
							if (ask.charIdToken.range.vscRange.contains(position)) {
								// { [詹姆斯]: 对话1 }
								return getCharHover(cast<Char | null, Char>(getNodeFromAstById(ast, ask.charIdToken.id)));
							} else if (ask.dialogIdTokenOrDeclareId.type === "idToken") {
								if (staticAssert<IdToken<Dialog>>(ask.dialogIdTokenOrDeclareId).range.vscRange.contains(position)) {
									// { 詹姆斯: [对话1] }
									return getDialogHover(cast<Dialog | null, Dialog>(getNodeFromAstById(ast, ask.dialogIdTokenOrDeclareId.id)));
								}
							}
						}
					}
				} else if (node.type === "dialog") {
					if (node.idToken.range.vscRange.contains(position)) {
						// dialog [我的对话] { ... }
						return getDialogHover(node);
					} else {
						for (const command of node.commands) {
							if (command.type === "say") {
								if (command.charIdToken?.range.vscRange.contains(position)) {
									return getCharHover(cast<Char | null, Char>(getNodeFromAstById(ast, command.charIdToken.id)));
								}
							} else if (command.type === "note") {
								if (command.targetIdTokenOrDeclareId.type === "idToken") {
									if (staticAssert<IdToken<Char | Clue>>(command.targetIdTokenOrDeclareId).range.vscRange.contains(position)) {
										const target = cast<Char | Clue | null, Char | Clue>(getNodeFromAstById(ast, command.targetIdTokenOrDeclareId.id));
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
			return null;
		},
	});

	{//#region compile
		const compileCommandDisposable = vsc.commands.registerCommand('krill-script-marco.compile', () => {

			const terminal = vsc.window.createTerminal("KST 测试编译");
			terminal.show();
			const print = (text: string) => terminal.sendText(`echo '${text.replaceAll("'", "''")}'`);

			const rootFolder = vsc.workspace.workspaceFolders?.[0];
			if (!rootFolder) { return; }
			const ksmConfigFileAbsDir = path.resolve(rootFolder.uri.fsPath, "./ksmconfig.json");
			const ksmConfig = getKsmConfigFromAbsDir(ksmConfigFileAbsDir);
			if (!ksmConfig) { return; }
			if (ksmConfig instanceof KsmcFsPanic) {
				print(`KSM 编译失败：无法打开配置文件。请确保工作区根目录下存在 ksmconfig.json 。\n${ksmConfig.message}`);
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
				rootNodes: {},
				handleImportButNoPathError: ksmConfig.handleImportButNoPathError,
				handleNewlineInString: ksmConfig.handleNewlineInString,
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
			const writeResult = writeOrCreateFileByPath({
				text: ksmdString,
				ksmConfigFileAbsDir,
				outPath: ksmConfig.outFile,
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
	}//#endregion

	{//#region on change
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
				vsc.window.showErrorMessage(panic.message);
			}
		};

		const updateSyntaxCheck = (() => {
			let timeOut: ReturnType<typeof setTimeout> | null;

			const checkSyntax = () => {
				// 初始化错误报告、悬停等所有提示资源
				diagnosticCollection.clear();

				const rootFolder = vsc.workspace.workspaceFolders?.[0];
				if (!rootFolder) { return; }
				const ksmConfigFileAbsDir = path.resolve(rootFolder.uri.fsPath, "./ksmconfig.json");
				const ksmConfig = getKsmConfigFromAbsDir(ksmConfigFileAbsDir);
				if (!ksmConfig) { return; }
				if (ksmConfig instanceof KsmcFsPanic) {
					reportACommonOrFsPanic(ksmConfig);
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
					rootNodes: {},
					handleImportButNoPathError: ksmConfig.handleImportButNoPathError,
					handleNewlineInString: ksmConfig.handleNewlineInString,
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

}

// This method is called when your extension is deactivated
export function deactivate() { }
