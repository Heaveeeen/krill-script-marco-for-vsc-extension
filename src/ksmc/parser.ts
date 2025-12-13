import path, { parse } from 'path';
import fs from 'fs';
import * as vsc from 'vscode';
import { staticAssert, cast } from '../utils';

export interface KsmRange {
    fileAbsDir: string | null,
    vscRange: vsc.Range,
}

export class KsmcCommonPanic extends Error {
    readonly range: KsmRange | null;
    constructor(message: string, range: KsmRange | null) {
        if (range === null) {
            super(
`KSM 编译错误: ${message}
（无位置信息）`
            );
        } else {
            super(
`KSM 编译错误: ${message}
位于 ${range.vscRange.start.line + 1}, ${range.vscRange.start.character} ~ ${range.vscRange.end.line + 1}, ${range.vscRange.end.character}`
            );
        }
        this.range = range;
    }
}

export class KsmcFsPanic extends Error {
    constructor(readonly panic: KsmcCommonPanic, readonly fsErr: unknown) {
        super(`${panic.message}\n${fsErr instanceof Error ? fsErr.message : String(fsErr)}`);
    }
}

export class KsmcNoSuchTokenError extends Error {
    constructor(readonly panic: KsmcCommonPanic) {
        super(panic.message);
    }
}



export type Id<T extends RootNode = RootNode> = string & { __brand: T };

export type IdToken<T extends RootNode = RootNode> = {
    type: "idToken",
    id: Id<T>,
    range: KsmRange,
};

export type Char = {
    type: "char",
    idToken: IdToken<Char>,
    name: string,
    range: KsmRange,
};

export type Clue = {
    type: "clue",
    idToken: IdToken<Clue>,
    desc: string,
    asks: AskPair[],
    range: KsmRange,
};

export type AskPair = {
    type: "askPair",
    charIdToken: IdToken<Char>,
    dialogIdTokenOrDeclareId: IdToken<Dialog> | { type: "askDialogDeclareId", id: Id<Dialog> },
    range: KsmRange,
};

export type Dialog = {
    type: "dialog",
    idToken: IdToken<Dialog>,
    commands: Command[],
    range: KsmRange,
};

export type Command = Say | Note;

export type Say = {
    type: "say",
    charIdToken: IdToken<Char> | null,
    charId: Id<Char>,
    text: string,
    range: KsmRange,
}

export type Note = {
    type: "note",
    targetIdTokenOrDeclareId: IdToken<Char | Clue> | { type: "noteCharOrClueDeclareId", id: Id<Char | Clue> },
    range: KsmRange,
};

export type RootNode = Char | Clue | Dialog;

export const ReservedWords = new Set([`char`, `clue`, `dialog`, `note`, `import`, `角色`, `线索`, `对话`, `笔记`, `导入`]);


interface KsmConfig {
    /** 编译入口文件相对于配置文件所在目录的路径 */ 
    rootFile: string,
    /** 输出文件相当于配置文件所在目录的路径 */
    outFile: string,
    /** @default "panic" */
    handleImportButNoPathError: HandleImportButNoPathErrorConfigs,
    /** @default "panic" */
    handleNewlineInString: HandleNewlineConfigs,
    /** @default "panic" */
    handleInlineNewlines: HandleNewlineConfigs,
    /** @default false */
    allowChineseKeywords: boolean,
}

type HandleImportButNoPathErrorConfigs = "ignore" | "warn-to-console" | "panic";
type HandleNewlineConfigs = "preserve" | "replace-by-backslash-n" | "replace-by-nothing" | "replace-by-space" | "panic";

function getJsonObjFromAbsDir(absDir: string): { json: unknown } | KsmcFsPanic {
    let text: string;
    try {
        text = fs.readFileSync(absDir, "utf-8");
    } catch (err) {
        return new KsmcFsPanic(new KsmcCommonPanic(`无法读取 JSON 文件${absDir}`, null), err);
    }
    try {
        let parseResult: unknown = JSON.parse(text);
        return { json: parseResult };
    } catch (err) {
        return new KsmcFsPanic(new KsmcCommonPanic(`无法解析 JSON 文件${absDir}，可能是出现了语法错误`, null), err);
    }
}

export function getKsmConfigFromObj(json: unknown): KsmConfig | null {
    if (typeof json !== "object" || json === null) {
        json = {};
    }

    const rootFile =
        // @ts-expect-error 我说有就有，牛魔
        json?.rootFile as any;
    if (typeof rootFile !== "string") { return null; }
    const outFile =
        // @ts-expect-error 我说有就有，牛魔
        json?.outFile as any;
    if (typeof outFile !== "string") { return null; }
    let handleImportButNoPathError =
        // @ts-expect-error 我说有就有，牛魔
        json?.handleImportButNoPathError as any;
    if (typeof handleImportButNoPathError !== "string" || (
        handleImportButNoPathError !== "ignore" &&
        handleImportButNoPathError !== "warn-to-console"
    )) {
        handleImportButNoPathError = "panic";
    }
    let handleNewlineInString =
        // @ts-expect-error 我说有就有，牛魔
        json?.handleNewlineInString as any;
    if (typeof handleNewlineInString !== "string" || (
        handleNewlineInString !== "preserve" &&
        handleNewlineInString !== "replace-by-backslash-n" &&
        handleNewlineInString !== "replace-by-nothing" &&
        handleNewlineInString !== "replace-by-space"
    )) {
        handleNewlineInString = "panic";
    }
    let handleInlineNewlines =
        // @ts-expect-error 我说有就有，牛魔
        json?.handleInlineNewlines as any;
    if (typeof handleInlineNewlines !== "string" || (
        handleInlineNewlines !== "preserve" &&
        handleInlineNewlines !== "replace-by-backslash-n" &&
        handleInlineNewlines !== "replace-by-nothing" &&
        handleInlineNewlines !== "replace-by-space"
    )) {
        handleInlineNewlines = "panic";
    }
    let allowChineseKeywords =
        // @ts-expect-error 我说有就有，牛魔
        json?.allowChineseKeywords as any;
    if (typeof allowChineseKeywords !== "boolean") {
        allowChineseKeywords = false;
    }

    return {
        rootFile,
        outFile,
        handleImportButNoPathError,
        handleNewlineInString,
        handleInlineNewlines,
        allowChineseKeywords,
    };
}

export const getKsmConfigFromAbsDir = (absDir: string) => {
    const jsonResult = getJsonObjFromAbsDir(absDir);
    if (jsonResult instanceof KsmcFsPanic) {
        return jsonResult;
    }
    return getKsmConfigFromObj(jsonResult.json);
};

export const getSrcCodeFromPath = (options: {
    currentFileAbsDir: string,
    importTargetPath: string,
    importedAbsDirs: string[] | null,
    errorRange: KsmRange | null,
}) => {
    const { currentFileAbsDir, importTargetPath, importedAbsDirs, errorRange } = options;
    let importAbsDir;
    try {
        importAbsDir = path.resolve(currentFileAbsDir, "../", importTargetPath);
    } catch (err) {
        return new KsmcCommonPanic(`path.resolve 在尝试解析 ${importTargetPath} 时，出现未知错误。`, errorRange);
    }

    if (importedAbsDirs?.includes(importAbsDir)) {
        return { type: "repeatImportedAndIgnore" as const, importAbsDir };
    } else {
        importedAbsDirs?.push(importAbsDir);
        let importSrcCode: string;
        const vscTextDocumentResult = vsc.workspace.textDocuments.find(textDocument => textDocument.uri.fsPath === importAbsDir);
        if (vscTextDocumentResult !== undefined) {
            importSrcCode = vscTextDocumentResult.getText();
        } else {
            try {
                importSrcCode = fs.readFileSync(importAbsDir, "utf-8");
            } catch (err) {
                return new KsmcFsPanic(new KsmcCommonPanic(
                    `fs.readFileSync 在尝试导入 ${importAbsDir} 时，出现未知错误。或许是因为给定的目标路径“${importTargetPath}”不合法。`, errorRange
                ), err);
            }
        }
        return { type: "success" as const, importSrcCode, importAbsDir };
    }
};

export type KsmAstNoBrand = Record<Id, RootNode>;

export type KsmAst = KsmAstNoBrand & { __brand: "KsmAst" };

const idBeginReg = /[\p{L}_]/u;
const idBodyReg = /[\p{L}_0-9]/u;

export function getNodeFromAstById<T extends RootNode>(ast: KsmAst, id: Id<T>) {
    return ast[id] as T | undefined ?? null;
}

export function makeAstFromSrc(options: {
    srcCode: string,
    fileAbsDir: string | null,
    importedAbsDirs: string[],
    rootNodes: KsmAst,
    /** @default "panic" */
    handleImportButNoPathError?: HandleImportButNoPathErrorConfigs,
    /** @default "panic" */
    handleNewlineInString?: HandleNewlineConfigs,
    /** @default false */
    allowChineseKeywords: boolean,
}): { type: "success", validAst: KsmAst } | { type: "panic", panicedAst: KsmAst | null, panics: (KsmcCommonPanic | KsmcFsPanic)[] } {
    const {srcCode, fileAbsDir, importedAbsDirs, rootNodes} = options;
    const panics: (KsmcCommonPanic | KsmcFsPanic)[] = [];
    const handleImportButNoPathError = options.handleImportButNoPathError ?? "panic";
    const handleNewlineInString = options.handleNewlineInString ?? "panic";
    const allowChineseKeywords = options.allowChineseKeywords ?? false;
    const getNodeById = <T extends RootNode>(id: Id<T>) => getNodeFromAstById(rootNodes, id);
    function makeDeclare<T extends RootNode>(node: T) {
        if (rootNodes[node.idToken.id]) {
            return new KsmcCommonPanic(`重复声明了标识符“${node.idToken}”`, node.range);
        } else {
            return rootNodes[node.idToken.id] = node as T;
        }
    };
    let row = 0;
    let col = 0;
    let pos = 0;

    const peek = () => {
        const char = srcCode[pos];
        if (char === "\r" && srcCode[pos + 1] === "\n") {
            return "\r\n";
        } else {
            return char;
        }
    };
    const next = (n: number = 1) => {
        for (let i = 0; i < n; i++) {
            if (peek() === undefined) {
                return undefined;
            }
            if ("\r\n".includes(peek() as string)) {
                row++;
                col = 0;
            } else {
                col++;
            }
            if (peek() === "\r\n") {
                pos++;
            }
            pos++;
        }
        return peek();
    };
    
    const getRange = (beginRow: number, beginCol: number) => { return {
        fileAbsDir,
        vscRange: new vsc.Range(
            new vsc.Position(beginRow, beginCol),
            new vsc.Position(row, col)
        ),
    }; };

    // 所有迭代器遵循一个原则：迭代开始时，光标位于新 token 的第一个字符；迭代结束时，光标位于新 token 的最后一个字符的下一个位置。

    function skip(chars: string) {
        while (peek()) {
            if (chars.includes(peek() as string)) {
                next();
            } else if (srcCode.substring(pos, pos + 2) === "//") {
                // 单行注释
                while (peek() && !"\r\n".includes(peek() as string)) {
                    next();
                }
            } else {
                break;
            }
        }
    }

    const skipWS = () => skip(" \t\r\n");
    const skipInlineWS = () => skip(" \t");

    function nextIdentifier<T extends RootNode = RootNode>(): IdToken<T> | KsmcNoSuchTokenError {
        const beginPos = pos, beginRow = row, beginCol = col;
        if (peek() && idBeginReg.test(peek() as string)) {
            // 匹配名称
            while (next() && idBodyReg.test(peek())) {}
            let id = srcCode.substring(beginPos, pos) as Id<T>;
            if (!ReservedWords.has(id)) {
                return { type: "idToken", id, range: getRange(beginRow, beginCol) };
            }
        }
        const noSuchTokenRange = getRange(beginRow, beginCol);
        pos = beginPos, row = beginRow, col = beginCol;
        return new KsmcNoSuchTokenError(
            new KsmcCommonPanic(`应为标识符。`, noSuchTokenRange)
        );
    }

    function nextString(): string | KsmcNoSuchTokenError | KsmcCommonPanic {
        const beginPos = pos, beginRow = row, beginCol = col;
        if (peek() === '"' || peek() === "'" || peek() === "“") {
            const endsChar = peek() === "“" ? "”" : peek();
            let str = "";
            while (next() !== endsChar) {
                if (!peek()) { // 越界获取到空值
                    return new KsmcCommonPanic(`未闭合的字符串字面量“${str}”`, getRange(beginRow, beginCol));
                }
                if (peek() === "\\") {
                    next();
                    if (peek() === "\\") {
                        str += "\\";
                    /*} else if (peek() === "r") {
                        str += "\\r";*/
                    } else if (peek() === "n") {
                        str += "\\n"; // 鉴于 scratch 的特性，换行符保留转义字符
                    } else if (peek() === "t") {
                        str += "\t";
                    } else if (peek() === '"') {
                        str += '"';
                    } else if (peek() === "'") {
                        str += "'";
                    } else if (peek() === "“") {
                        str += "“";
                    } else if (peek() === "”") {
                        str += "”";
                    } else if ("\r\n".includes(peek() as string)) {
                        // 行末续写符
                    } else {
                        return new KsmcCommonPanic(`字符串字面量包含非法转义序列“\\${peek()}”`, getRange(beginRow, beginCol));
                    }
                } else if ("\r\n".includes(peek() as string)) {
                    if (handleNewlineInString === "panic") {
                        return new KsmcCommonPanic(`字符串字面量不能包含换行符。（该报错可通过配置 handleNewlineInString 以忽略。）`, getRange(beginRow, beginCol));
                    } else if (handleNewlineInString === "preserve") {
                        str += peek();
                    } else if (handleNewlineInString === "replace-by-space") {
                        str += " ";
                    } else if (handleNewlineInString === "replace-by-backslash-n") {
                        str += "\\n";
                    } else {
                        staticAssert<"replace-by-nothing">(handleNewlineInString);
                    }
                } else {
                    str += peek();
                }
            }
            // 到此，光标位于回引号
            next();
            // 光标移到了回引号后的一个字符
            return str;
        } else {
            const noSuchTokenRange = getRange(beginRow, beginCol);
            pos = beginPos, row = beginRow, col = beginCol;
            return new KsmcNoSuchTokenError(
                new KsmcCommonPanic(`应为字符串字面量。`, noSuchTokenRange)
            );
        }
    }

    type Colon = ":" | "：";
    function nextColon(): Colon | KsmcNoSuchTokenError {
        const beginPos = pos, beginRow = row, beginCol = col;
        if (peek() === ":" || peek() === "：") {
            const colon = peek() as Colon;
            next();
            return colon;
        } else {
            const noSuchTokenRange = getRange(beginRow, beginCol);
            pos = beginPos, row = beginRow, col = beginCol;
            return new KsmcNoSuchTokenError(new KsmcCommonPanic(`应为冒号。`, noSuchTokenRange));
        }
    }

    type Dash = "-" | "—"
    function nextDash(): Dash | KsmcNoSuchTokenError {
        const beginPos = pos, beginRow = row, beginCol = col;
        if (peek() === "-" || peek() === "—") {
            while (next() === "-" || peek() === "—") {}
            const dash = srcCode.substring(beginPos, pos) as Dash;
            return dash;
        } else {
            const noSuchTokenRange = getRange(beginRow, beginCol);
            pos = beginPos, row = beginRow, col = beginCol;
            return new KsmcNoSuchTokenError(new KsmcCommonPanic(`应为减号或破折号。`, noSuchTokenRange));
        }
    }

    function nextCharDeclare(): Char | KsmcNoSuchTokenError | KsmcCommonPanic {
        const beginPos = pos, beginRow = row, beginCol = col;
        const beginToken = srcCode.substring(pos, pos + 4) === "char" ? "char" : srcCode.substring(pos, pos + 2) === "角色" ? "角色" : null;
        if (beginToken !== null) {
            next(beginToken.length);
            if (!allowChineseKeywords && beginToken === "角色") {
                return new KsmcCommonPanic(`禁止使用中文关键词。（该报错可通过配置 allowChineseKeywords 以忽略。）`, getRange(beginRow, beginCol));
            }

            skipInlineWS();
            const idResult = nextIdentifier<Char>();
            if (idResult instanceof KsmcCommonPanic) { return idResult; }
            if (idResult instanceof KsmcNoSuchTokenError) { return idResult.panic; }

            skipInlineWS();
            const nameResult = nextString();
            if (nameResult instanceof KsmcCommonPanic) { return nameResult; }
            if (nameResult instanceof KsmcNoSuchTokenError) { return nameResult.panic; }

            return makeDeclare<Char>({ type: "char", idToken: idResult, name: nameResult, range: getRange(beginRow, beginCol) });
        } else {
            const noSuchTokenRange = getRange(beginRow, beginCol);
            pos = beginPos, row = beginRow, col = beginCol;
            return new KsmcNoSuchTokenError(
                new KsmcCommonPanic(`应为角色声明。`, noSuchTokenRange)
            );
        }
    }

    function nextClueDeclare(): Clue | KsmcNoSuchTokenError | KsmcCommonPanic {
        const beginPos = pos, beginRow = row, beginCol = col;
        const beginToken = srcCode.substring(pos, pos + 4) === "clue" ? "clue" : srcCode.substring(pos, pos + 2) === "线索" ? "线索" : null;
        if (beginToken !== null) {
            next(beginToken.length);
            if (!allowChineseKeywords && beginToken === "线索") {
                return new KsmcCommonPanic(`禁止使用中文关键词。（该报错可通过配置 allowChineseKeywords 以忽略。）`, getRange(beginRow, beginCol));
            }

            skipInlineWS();
            const clueIdResult = nextIdentifier<Clue>();
            if (clueIdResult instanceof KsmcCommonPanic) { return clueIdResult; }
            if (clueIdResult instanceof KsmcNoSuchTokenError) { return clueIdResult.panic; }

            skipWS();
            const descResult = nextString();
            if (descResult instanceof KsmcCommonPanic) { return descResult; }
            if (descResult instanceof KsmcNoSuchTokenError) { return descResult.panic; }

            skipWS();
            if (peek() === "{") {
                const asks: AskPair[] = [];
                const addAskByDialogIdToken = (newCharIdToken: IdToken<Char>, newDialogIdToken: IdToken<Dialog>, range: KsmRange) => {
                    if (asks.some(({charIdToken}) => charIdToken.id === newCharIdToken.id)) {
                        return new KsmcCommonPanic(`重复的询问对象“${newCharIdToken}”`, getRange(beginRow, beginCol));
                    } else {
                        asks.push({type: "askPair", charIdToken: newCharIdToken, dialogIdTokenOrDeclareId: newDialogIdToken, range});
                    }
                };
                const addAskByDialogDeclare = (newCharIdToken: IdToken<Char>, newDialogDeclare: Dialog, range: KsmRange) => {
                    if (asks.some(({charIdToken}) => charIdToken.id === newCharIdToken.id)) {
                        return new KsmcCommonPanic(`重复的询问对象“${newCharIdToken}”`, getRange(beginRow, beginCol));
                    } else {
                        asks.push({
                            type: "askPair", charIdToken: newCharIdToken,
                            dialogIdTokenOrDeclareId: { type: "askDialogDeclareId", id: newDialogDeclare.idToken.id },
                            range
                        });
                    }
                };
                next();
                skipWS();
                while (peek() !== "}") {
                    if (peek() === undefined) {
                        return new KsmcCommonPanic(`线索定义缺少右大括号“}”`, getRange(beginRow, beginCol));
                    }
                    const askBeginRow = row, askBeginCol = col;
                    const charIdResult = nextIdentifier();
                    if (charIdResult instanceof KsmcNoSuchTokenError) { return charIdResult.panic; }

                    skipInlineWS();
                    const dashResult = nextDash();
                    if (dashResult instanceof KsmcNoSuchTokenError) { return dashResult.panic; }
                    
                    skipInlineWS();
                    const dialogIdOrDeclareResult = nextAOrB(nextIdentifier, nextDialogDeclare);

                    if (dialogIdOrDeclareResult instanceof KsmcNoSuchTokenError) {
                        return new KsmcCommonPanic(`应为对话标识符或对话声明。`, dialogIdOrDeclareResult.panic.range);
                    } else if (dialogIdOrDeclareResult instanceof KsmcCommonPanic) {
                        return dialogIdOrDeclareResult;
                    } else if (dialogIdOrDeclareResult.type === "idToken") {
                        addAskByDialogIdToken(
                            cast<IdToken, IdToken<Char>>(charIdResult),
                            cast<IdToken, IdToken<Dialog>>(dialogIdOrDeclareResult),
                            getRange(askBeginRow, askBeginCol)
                        ); // FIXME: ASSERT asks (done)
                    } else {
                        addAskByDialogDeclare(
                            cast<IdToken, IdToken<Char>>(charIdResult),
                            dialogIdOrDeclareResult,
                            getRange(askBeginRow, askBeginCol)
                        );
                    }

                    skipWS();
                }
                // 至此，光标位于花括号扩回
                next();

                return makeDeclare<Clue>({ type: "clue", idToken: clueIdResult, desc: descResult, asks, range: getRange(beginRow, beginCol) });
            } else {
                return new KsmcCommonPanic(`线索定义缺少左大括号“{”`, getRange(beginRow, beginCol));
            }
        } else {
            const noSuchTokenRange = getRange(beginRow, beginCol);
            pos = beginPos, row = beginRow, col = beginCol;
            return new KsmcNoSuchTokenError(
                new KsmcCommonPanic(`应为线索声明。`, noSuchTokenRange)
            );
        }
    }

    function nextDialogDeclare(): Dialog | KsmcNoSuchTokenError | KsmcCommonPanic {
        const beginPos = pos, beginRow = row, beginCol = col;
        const beginToken = srcCode.substring(pos, pos + 6) === "dialog" ? "dialog" : srcCode.substring(pos, pos + 2) === "对话" ? "对话" : null;
        if (beginToken !== null) {
            next(beginToken.length);
            if (!allowChineseKeywords && beginToken === "对话") {
                return new KsmcCommonPanic(`禁止使用中文关键词。（该报错可通过配置 allowChineseKeywords 以忽略。）`, getRange(beginRow, beginCol));
            }

            skipInlineWS();
            const dialogIdResult = nextIdentifier<Dialog>();
            if (dialogIdResult instanceof KsmcCommonPanic) { return dialogIdResult; }
            if (dialogIdResult instanceof KsmcNoSuchTokenError) { return dialogIdResult.panic; }

            skipWS();
            if (peek() === "{") {
                const commands: Command[] = [];
                const addCommand = (command: Command) => commands.push(command);
                let lastSayCharId: Id<Char> | null = null;
                next();
                skipWS();
                while (peek() !== "}") {
                    const nextCommandResult = nextAOrB(() => nextSay(lastSayCharId), nextNote);
                    if (nextCommandResult instanceof KsmcNoSuchTokenError) {
                        return new KsmcCommonPanic(`应为说话指令或笔记指令。`, nextCommandResult.panic.range);
                    } else if (nextCommandResult instanceof KsmcCommonPanic) {
                        return nextCommandResult;
                    }
                    addCommand(nextCommandResult);
                    if (nextCommandResult.type === "say") {
                        lastSayCharId = nextCommandResult.charId;
                    }
                    skipWS();
                }
                // 至此，光标位于花括号扩回
                next();

                return makeDeclare<Dialog>({ type: "dialog", idToken: dialogIdResult, commands ,range: getRange(beginRow, beginCol) });
            } else {
                return new KsmcCommonPanic(`对话定义缺少左大括号“{”`, getRange(beginRow, beginCol));
            }
        } else {
            const noSuchTokenRange = getRange(beginRow, beginCol);
            pos = beginPos, row = beginRow, col = beginCol;
            return new KsmcNoSuchTokenError(
                new KsmcCommonPanic(`应为对话声明。`, noSuchTokenRange)
            );
        }
    }

    function nextSay(lastCharId: Id<Char> | null): Say | KsmcNoSuchTokenError | KsmcCommonPanic {
        const beginPos = pos, beginRow = row, beginCol = col;
        let charId: Id<Char> | null;
        let colonResult = nextColon();
        let idTokenResult = null;
        if (typeof colonResult === "string") {
            charId = lastCharId;
        } else {
            // 开头的冒号没找到，现在位于指令开头
            idTokenResult = nextIdentifier();
            if (idTokenResult instanceof KsmcNoSuchTokenError) {
                charId = lastCharId;
                idTokenResult = null;
            } else {
                idTokenResult = cast<IdToken, IdToken<Char>>(idTokenResult); // FIXME: ASSERT say.charId (done)
                charId = idTokenResult.id;
            }
            skipInlineWS();
            colonResult = nextColon();
        }
        staticAssert<IdToken<Char> | null>(idTokenResult);

        if (colonResult instanceof KsmcNoSuchTokenError) {
            const noSuchTokenRange = getRange(beginRow, beginCol);
            pos = beginPos, row = beginRow, col = beginCol;
            return new KsmcNoSuchTokenError(
                new KsmcCommonPanic(`应为说话指令。（未找到冒号）`, noSuchTokenRange)
            );
        }
        staticAssert<Colon>(colonResult);
        if (charId === null) {
            return new KsmcCommonPanic(`不能在此处省略角色标识符，因为没有上一个说话的角色。`, getRange(beginRow, beginCol));
        }

        skipInlineWS();
        let text = "";
        while (peek() && !"\r\n".includes(peek())) {
            if (srcCode.substring(pos, pos + 2) === "//") { break; } // 对话行末尾的注释
            if (peek() === "\\") {
                next();
                if (peek() === "\\") {
                    text += "\\";
                /*} else if (peek() === "r") {
                    text += "\\r";*/
                } else if (peek() === "n") {
                    text += "\\n"; // 鉴于 scratch 的特性，换行符保留转义字符
                } else if (peek() === "t") {
                    text += "\t";
                } else if (peek() === "/") {
                    text += "/";
                } else if ("\r\n".includes(peek() as string)) {
                    // 行末续写符
                } else {
                    return new KsmcCommonPanic(`说话文本包含非法转义序列“\\${peek()}”`, getRange(beginRow, beginCol));
                }
            } else {
                text += peek();
            }
            next();
        }
        return { type: "say", charIdToken: idTokenResult, charId, text, range: getRange(beginRow, beginCol) };
    }

    function nextNote(): Note | KsmcNoSuchTokenError | KsmcCommonPanic {
        const beginPos = pos, beginRow = row, beginCol = col;
        const beginToken = srcCode.substring(pos, pos + 4) === "note" ? "note" : srcCode.substring(pos, pos + 2) === "笔记" ? "笔记" : null;
        if (beginToken !== null) {
            next(beginToken.length);
            if (!allowChineseKeywords && beginToken === "笔记") {
                return new KsmcCommonPanic(`禁止使用中文关键词。（该报错可通过配置 allowChineseKeywords 以忽略。）`, getRange(beginRow, beginCol));
            }

            skipInlineWS();
            const nextTokenResult = nextAOrB(nextIdentifier, () => nextAOrB(nextClueDeclare, nextCharDeclare));
            let targetIdToken;
            if (nextTokenResult instanceof KsmcNoSuchTokenError) {
                return new KsmcCommonPanic(`应为线索或角色的标识符或声明。`, nextTokenResult.panic.range);
            } else if (nextTokenResult instanceof KsmcCommonPanic) {
                return nextTokenResult;
            } else if (nextTokenResult.type === "idToken") {
                return {
                    type: "note",
                    targetIdTokenOrDeclareId: cast<IdToken, IdToken<Clue | Char>>(nextTokenResult),
                    range: getRange(beginRow, beginCol)
                }; // FIXME: ASSERT note.targetId (done)
            } else {
                return {
                    type: "note",
                    targetIdTokenOrDeclareId: {
                        type: "noteCharOrClueDeclareId",
                        id: nextTokenResult.idToken.id
                    },
                    range: getRange(beginRow, beginCol)
                };
            }

        } else {
            const noSuchTokenRange = getRange(beginRow, beginCol);
            pos = beginPos, row = beginRow, col = beginCol;
            return new KsmcNoSuchTokenError(
                new KsmcCommonPanic(`应为笔记指令。`, noSuchTokenRange)
            );
        }
    }

    function nextImport(options: {handleImportButNoPathError: "ignore" | "warn-to-console" | "panic"}): ReturnType<typeof makeAstFromSrc> | KsmcNoSuchTokenError | KsmcCommonPanic | KsmcFsPanic {
        const { handleImportButNoPathError: importButNoPathErrorLevel } = options;
        const beginPos = pos, beginRow = row, beginCol = col;
        const beginToken = srcCode.substring(pos, pos + 6) === "import" ? "import" : srcCode.substring(pos, pos + 2) === "导入" ? "导入" : null;
        if (beginToken !== null) {
            next(beginToken.length);
            if (!allowChineseKeywords && beginToken === "导入") {
                return new KsmcCommonPanic(`禁止使用中文关键词。（该报错可通过配置 allowChineseKeywords 以忽略。）`, getRange(beginRow, beginCol));
            }

            skipInlineWS();
            const importTargetPathResult = nextString();
            if (importTargetPathResult instanceof KsmcCommonPanic) {
                return importTargetPathResult;
            } else if (importTargetPathResult instanceof KsmcNoSuchTokenError) {
                return importTargetPathResult.panic;
            }

            if (fileAbsDir === null) {
                if (importButNoPathErrorLevel === "ignore") {
                    return { type: "success", validAst: rootNodes };
                }
                const panic = new KsmcCommonPanic(`没有已知的源码路径，但源码中包含 import 表达式。`, getRange(beginRow, beginCol));
                if (importButNoPathErrorLevel === "warn-to-console") {
                    console.warn(panic);
                    return { type: "success", validAst: rootNodes };
                } else {
                    staticAssert<"panic">(importButNoPathErrorLevel);
                    return panic;
                }
            }

            const importSrcCodeResult = getSrcCodeFromPath({
                currentFileAbsDir: fileAbsDir,
                importTargetPath: importTargetPathResult,
                importedAbsDirs,
                errorRange: getRange(beginRow, beginCol),
            });
            if (importSrcCodeResult instanceof KsmcCommonPanic || importSrcCodeResult instanceof KsmcFsPanic) {
                return importSrcCodeResult;
            }

            const { importAbsDir } = importSrcCodeResult;
            if (importSrcCodeResult.type === "repeatImportedAndIgnore") {
                console.log(`KSM: 忽略重复导入 ${importAbsDir}`);
                return { type: "success", validAst: rootNodes };
            } else {
                const { importSrcCode } = importSrcCodeResult;
                return makeAstFromSrc({ srcCode: importSrcCode, fileAbsDir: importAbsDir, importedAbsDirs, rootNodes, allowChineseKeywords });
            }
        } else {
            const noSuchTokenRange = getRange(beginRow, beginCol);
            pos = beginPos, row = beginRow, col = beginCol;
            return new KsmcNoSuchTokenError(new KsmcCommonPanic(`应为导入指令。`, noSuchTokenRange));
        }
    }

    function nextAOrB<T, U>(nextAFn: () => T, nextBFn: () => U): T | U {
        const aResult = nextAFn();
        if (aResult instanceof KsmcNoSuchTokenError) {
            return nextBFn();
        } else {
            return aResult;
        }
    }

    skipWS();
    while (peek()) {
        const nextNodeResult = nextAOrB(
            nextCharDeclare, () => nextAOrB(
            nextClueDeclare, () => nextAOrB(
            nextDialogDeclare, () => 
            nextImport({ handleImportButNoPathError })
        )));
        if (nextNodeResult instanceof KsmcCommonPanic || nextNodeResult instanceof KsmcFsPanic || nextNodeResult instanceof KsmcNoSuchTokenError) {
            return {
                type: "panic", panicedAst: null,
                panics: [nextNodeResult instanceof KsmcNoSuchTokenError ? nextNodeResult.panic : nextNodeResult],
            };
        }
        staticAssert<Dialog | Char | Clue | ReturnType<typeof makeAstFromSrc>>(nextNodeResult);
        skipWS();
    }

    // 检验上述的 FIXME ASSERT 断言
    for (const node of Object.values(rootNodes as KsmAstNoBrand)) {
        if (node.type === "clue") {
            for (const ask of node.asks) { // 线索的 问谁：进入啥对话 检验
                const {charIdToken, dialogIdTokenOrDeclareId: dialogToken} = ask;
                { // 问话那人存在吗？
                    const charResult = getNodeById(charIdToken.id);
                    if (charResult === null) { return {
                        type: "panic",
                        panicedAst: rootNodes,
                        panics: [new KsmcCommonPanic(`未知的标识符“${charIdToken.id}”。`, charIdToken.range)],
                    }; }
                    if (charResult.type !== "char") { return {
                        type: "panic",
                        panicedAst: rootNodes,
                        panics: [new KsmcCommonPanic(`“${charIdToken.id}”不是角色标识符。`, charIdToken.range)],
                    }; }
                }
                // 要说的对话存在吗？
                const dialogResult = getNodeById(dialogToken.id);
                if (dialogResult === null) { return {
                    type: "panic",
                    panicedAst: rootNodes,
                    panics: [new KsmcCommonPanic(
                        `未知的标识符“${dialogToken.id}”。`,
                        dialogToken.type === "idToken" ? dialogToken.range : ask.range
                    )],
                };}
                if (dialogResult.type !== "dialog") { return {
                    type: "panic",
                    panicedAst: rootNodes,
                    panics: [new KsmcCommonPanic(
                        `“${dialogToken.id}”不是对话标识符。`,
                        dialogToken.type === "idToken" ? dialogToken.range : ask.range
                    )],
                };}
            };
        } else if (node.type === "dialog") {
            for (const command of node.commands) { // 检验对话中的每一行命令
                if (command.type === "say") { // 说话者存在吗？
                    if (command.charIdToken !== null) {
                        const charResult = getNodeById(command.charIdToken.id);
                        if (charResult === null) { return {
                            type: "panic",
                            panicedAst: rootNodes,
                            panics: [new KsmcCommonPanic(`未知的标识符“${command.charIdToken.id}”。`, command.charIdToken.range)],
                        }; }
                        if (charResult.type !== "char") { return {
                            type: "panic",
                            panicedAst: rootNodes,
                            panics: [new KsmcCommonPanic(`“${command.charIdToken.id}”不是角色标识符。`, command.charIdToken.range)],
                        }; }
                    }
                } else if (command.type === "note") { // 笔记的联络人或线索存在吗？
                    const targetToken = command.targetIdTokenOrDeclareId;
                    const targetResult = getNodeById(targetToken.id);
                    if (targetResult === null) { return { // 不存在该名称
                        type: "panic",
                        panicedAst: rootNodes,
                        panics: [new KsmcCommonPanic(
                            `未知的标识符“${targetToken.id}”。`,
                            targetToken.type === "idToken" ? targetToken.range : command.range
                        )],
                    }; }
                    if (targetResult.type !== "char" && targetResult.type !== "clue") { return { // 该名称类型不对
                        type: "panic",
                        panicedAst: rootNodes,
                        panics: [new KsmcCommonPanic(
                            `“${targetToken.id}”不是线索或角色标识符。`,
                            targetToken.type === "idToken" ? targetToken.range : command.range
                        )],
                    }; }
                }
            };
        }
    }

    return { type: "success", validAst: rootNodes };
}


const hasNlReg = /[\r\n]/;
export function makeKsmdListFromAst(opitons: {
    ast: KsmAst,
    /** @default "panic" */
    handleInlineNewlines?: HandleNewlineConfigs
}): string[] | KsmcCommonPanic {
    const { ast } = opitons;
    const handleInlineNewlines = opitons.handleInlineNewlines ?? "panic";
    const ksmdList: string[] = [];
    const add = <T extends RootNode>(...texts: [`@${Id<T>}`, T["type"],  ...string[]]) => {
        for (const txt of texts) {
            if (handleInlineNewlines !== "preserve" && hasNlReg.test(txt)) {
                if (handleInlineNewlines === "panic") {
                    return new KsmcCommonPanic(`编译所得的 KSMD 中包含行内换行符：${txt}\n（该报错可通过配置 handleInlineNewlines 以忽略。）`, null);
                } else if (handleInlineNewlines === "replace-by-nothing") {
                    ksmdList.push(txt.replaceAll(hasNlReg, ""));
                } else if (handleInlineNewlines === "replace-by-space") {
                    ksmdList.push(txt.replaceAll("\r\n", "").replaceAll("\r", "").replaceAll("\n", ""));
                } else if (handleInlineNewlines === "replace-by-backslash-n") {
                    ksmdList.push(txt.replaceAll("\r\n", "\\n").replaceAll("\r", "\\n").replaceAll("\n", "\\n"));
                } else {
                    staticAssert<never>(handleInlineNewlines);
                }
            } else {
                ksmdList.push(txt);
            }
        }
    };
    for (const node of Object.values(ast as KsmAstNoBrand)) {
        let result: KsmcCommonPanic | undefined;
        if (node.type === "char") {
            result = add<Char>(
                `@${node.idToken.id}`,
                "char",
                node.name,
            );
        } else if (node.type === "clue") {
            result = add<Clue>(
                `@${node.idToken.id}`,
                "clue",
                node.desc,
                ...node.asks.flatMap(({charIdToken, dialogIdTokenOrDeclareId}) => [
                    charIdToken.id,
                    dialogIdTokenOrDeclareId.id,
                ]),
            );
        } else if (node.type === "dialog") {
            result = add<Dialog>(
                `@${node.idToken.id}`,
                "dialog",
                ...node.commands.flatMap((command) =>
                    command.type === "say" ? [command.charId, command.text] : [
                        "note", 
                        command.targetIdTokenOrDeclareId.id,
                    ]
                ),
            );
        } else {
            staticAssert<never>(node);
        }
        if (result instanceof KsmcCommonPanic) {
            return result;
        }
        staticAssert<undefined>(result);
    }
    return ksmdList;
}

export function writeFileByPath(opitons: {
    text: string, rootAbsDir: string, outPath: string, flag: string,
}): { type: "success", outAbsDir: string } | { type: "panic", panic: KsmcFsPanic } {
    const { text, rootAbsDir, outPath, flag } = opitons;
    let outAbsDir: string;
    try {
        outAbsDir = path.resolve(rootAbsDir, "../", outPath);
    } catch (err) {
        return { type: "panic", panic: new KsmcFsPanic(
            new KsmcCommonPanic(`尝试写入文件时，解析目标相对路径 ${rootAbsDir} -> ${outPath} 出现未知错误。`, null), err
        ), };
    }
    
    const writeResult = writeFileByAbsDir({text, absDir: outAbsDir, flag});

    if (writeResult.type === "success") {
        return { type: "success", outAbsDir };
    } else {
        return writeResult;
    }
}


export function writeFileByAbsDir(opitons: {
    text: string, absDir: string, flag: string,
}): { type: "success" } | { type: "panic", panic: KsmcFsPanic } {
    const { text, absDir, flag } = opitons;
    try {
        fs.writeFileSync(absDir, text, { encoding: "utf-8", flag });
    } catch (err) {
        return { type: "panic", panic: new KsmcFsPanic(
            new KsmcCommonPanic(`尝试向 ${absDir} 写入文件时，出现未知错误。`, null), err
        ), };
    }

    return { type: "success" };
}
