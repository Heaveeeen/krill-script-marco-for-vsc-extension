// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { KsmcCommonPanic, KsmcFsPanic, makeAstFromSrc, KsmAst, makeKsmdListFromAst } from './ksmc/parser';
import { staticAssert } from './utils';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "krill-script-marco" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('krill-script-marco.test_compile', () => {
		let textEditor = vscode.window.activeTextEditor;
		if (!textEditor) {
			vscode.window.showErrorMessage("当前没有正在活动的文本编辑器。");
			return;
		}
		let terminal = vscode.window.createTerminal("KST 测试编译");
		terminal.show();
		const print = (text: string) => terminal.sendText(`echo '${text.replaceAll("'", "''")}'`);

		print(`生成 AST ...`);
		let filePath = textEditor.document.uri.fsPath;
		let astResult = makeAstFromSrc({ srcCode: textEditor.document.getText(), fileAbsDir: filePath, importedAbsDirs: [], rootNodes: {} });
		if (astResult instanceof KsmcCommonPanic || astResult instanceof KsmcFsPanic) {
			print(`生成AST出现错误。`);
			console.error(astResult);
			if (astResult instanceof KsmcFsPanic) {
				console.error(astResult.fsErr);
			}
			print(astResult.message);
			return;
		}
		staticAssert<KsmAst>(astResult);
		console.log("astResult: ", astResult);

		print(`生成 KSMD ...`);
		let ksmdListResult = makeKsmdListFromAst({ast: astResult});
		if (ksmdListResult instanceof KsmcCommonPanic) {
			print(`生成 KSMD 出现错误。`);
			console.error(ksmdListResult);
			print(ksmdListResult.message);
			return;
		}

		const KsmdString = ksmdListResult.join("\r\n");

		console.log(KsmdString);
		print(`已成功生成KSMD，请打开控制台查看。`);
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
