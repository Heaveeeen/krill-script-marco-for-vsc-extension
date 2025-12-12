import path from 'path';
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



type Id<T extends RootNode = RootNode> = string & { __brand: T };

type IdToken<T extends RootNode = RootNode> = {
    type: "idToken",
    id: Id<T>,
    range: KsmRange,
};

type Char = {
    type: "char",
    idToken: IdToken<Char>,
    name: string,
    range: KsmRange,
};

type Clue = {
    type: "clue",
    idToken: IdToken<Clue>,
    desc: string,
    asks: AskPair[],
    range: KsmRange,
};

type AskPair = {
    type: "askPair",
    charIdToken: IdToken<Char>,
    dialogIdTokenOrDeclareId: IdToken<Dialog> | Id<Dialog>,
    range: KsmRange,
};

type Dialog = {
    type: "dialog",
    idToken: IdToken<Dialog>,
    commands: Command[],
    range: KsmRange,
};

type Command = Say | Note;

type Say = {
    type: "say",
    charIdToken: IdToken<Char> | null,
    charId: Id<Char>,
    text: string,
    range: KsmRange,
}

type Note = {
    type: "note",
    targetIdTokenOrDeclareId: IdToken<Char | Clue> | Id<Char | Clue>,
    range: KsmRange,
};

type RootNode = Char | Clue | Dialog;

const ReservedWords = new Set([`char`, `clue`, `dialog`, `note`, `import`, `角色`, `线索`, `对话`, `笔记`, `导入`]);



const importSrcCodeFromPath = (options: {
    currentFileAbsDir: string,
    importTargetPath: string,
    importedAbsDirs: string[],
    errorRange: KsmRange | null,
}) => {
    const { currentFileAbsDir, importTargetPath, importedAbsDirs, errorRange } = options;
    let importAbsDir;
    try {
        importAbsDir = path.resolve(currentFileAbsDir, "../", importTargetPath);
    } catch (err) {
        return new KsmcCommonPanic(`path.resolve 在尝试解析 ${importTargetPath} 时，出现未知错误。`, errorRange);
    }

    if (importedAbsDirs.includes(importAbsDir)) {
        return { type: "repeatImportedAndIgnore" as const, importAbsDir };
    } else {
        importedAbsDirs.push(importAbsDir);
        let importSrcCode;
        try {
            importSrcCode = fs.readFileSync(importAbsDir, "utf-8");
        } catch (err) {
            return new KsmcFsPanic(new KsmcCommonPanic(
                `fs.readFileSync 在尝试导入 ${importAbsDir} 时，出现未知错误。或许是因为给定的目标路径“${importTargetPath}”不合法。`, errorRange
            ), err);
        }
        return { type: "success" as const, importSrcCode, importAbsDir };
    }
};

export type KsmAst = Record<Id, RootNode>;

const idBeginReg = /[\p{L}_]/u;
const idBodyReg = /[\p{L}_0-9]/u;
export function makeAstFromSrc(options: {
    srcCode: string,
    fileAbsDir: string | null,
    importedAbsDirs: string[],
    rootNodes: KsmAst,
    /** @default "panic" */
    handleImportButNoPathError?: "ignore" | "warn-to-console" | "panic",
    /** @default "panic" */
    handleNewlineInString?: "preserve" | "replace-by-backslash-n" | "replace-by-nothing" | "replace-by-space" | "panic",
}): KsmAst | KsmcCommonPanic | KsmcFsPanic {
    const {srcCode, fileAbsDir, importedAbsDirs, rootNodes} = options;
    const handleImportButNoPathError = options.handleImportButNoPathError ?? "panic";
    const handleNewlineInString = options.handleNewlineInString ?? "panic";
    function getNodeById<T extends RootNode>(id: Id<T>) {
        return rootNodes[id] as T | undefined ?? null;
    }
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
        if (idBeginReg.test(peek() as string)) {
            // 匹配名称
            let beginPos = pos;
            // @ts-expect-error 这里传 undefined 也无所谓
            while (idBodyReg.test(next())) {}
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
                    } else if (peek() === "r") {
                        str += "\\r"; // 鉴于 scratch 的特性，换行符保留转义字符
                    } else if (peek() === "n") {
                        str += "\\n";
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

    function nextCharDeclare(): Char | KsmcNoSuchTokenError | KsmcCommonPanic {
        const beginPos = pos, beginRow = row, beginCol = col;
        if (srcCode.substring(pos, pos + 4) === "char") {
            next(); next(); next(); next();

            skipInlineWS();
            const idResult = nextIdentifier<Char>();
            if (idResult instanceof KsmcCommonPanic) { return idResult; }
            if (idResult instanceof KsmcNoSuchTokenError) { return idResult.panic; }

            skipWS();
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
        if (srcCode.substring(pos, pos + 4) === "clue") {
            next(); next(); next(); next();

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
                        asks.push({type: "askPair", charIdToken: newCharIdToken, dialogIdTokenOrDeclareId: newDialogDeclare.idToken.id, range});
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
                    const colonResult = nextColon();
                    if (colonResult instanceof KsmcNoSuchTokenError) { return colonResult.panic; }
                    
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
        if (srcCode.substring(pos, pos + 6) === "dialog") {
            next(); next(); next(); next(); next(); next();

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
            idTokenResult = nextIdentifier();
            if (idTokenResult instanceof KsmcNoSuchTokenError) {
                charId = lastCharId;
                idTokenResult = null;
            } else {
                idTokenResult = cast<IdToken, IdToken<Char>>(idTokenResult); // FIXME: ASSERT say.charId (done)
                charId = idTokenResult.id;
            }
            colonResult = nextColon();
        }
        staticAssert<IdToken<Char> | null>(idTokenResult);

        skipInlineWS();
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
                } else if (peek() === "r") {
                    text += "\\r"; // 鉴于 scratch 的特性，换行符保留转义字符
                } else if (peek() === "n") {
                    text += "\\n";
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
        if (srcCode.substring(pos, pos + 4) === "note") {
            next(); next(); next(); next();

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
                    targetIdTokenOrDeclareId: nextTokenResult.idToken.id,
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

    function nextImport(options: {handleImportButNoPathError: "ignore" | "warn-to-console" | "panic"}): KsmAst | KsmcNoSuchTokenError | KsmcCommonPanic | KsmcFsPanic {
        const { handleImportButNoPathError: importButNoPathErrorLevel } = options;
        const beginPos = pos, beginRow = row, beginCol = col;
        if (srcCode.substring(pos, pos + 6) === "import") {
            next(); next(); next(); next(); next(); next();

            skipInlineWS();
            const importTargetPathResult = nextString();
            if (importTargetPathResult instanceof KsmcCommonPanic) {
                return importTargetPathResult;
            } else if (importTargetPathResult instanceof KsmcNoSuchTokenError) {
                return importTargetPathResult.panic;
            }

            if (fileAbsDir === null) {
                if (importButNoPathErrorLevel === "ignore") {
                    return rootNodes;
                }
                const panic = new KsmcCommonPanic(`没有已知的源码路径，但源码中包含 import 表达式。`, getRange(beginRow, beginCol));
                if (importButNoPathErrorLevel === "warn-to-console") {
                    console.warn(panic);
                    return rootNodes;
                } else {
                    staticAssert<"panic">(importButNoPathErrorLevel);
                    return panic;
                }
            }

            const importSrcCodeResult = importSrcCodeFromPath({
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
                return rootNodes;
            } else {
                const { importSrcCode } = importSrcCodeResult;
                return makeAstFromSrc({ srcCode: importSrcCode, fileAbsDir: importAbsDir, importedAbsDirs, rootNodes });
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
        if (nextNodeResult instanceof KsmcCommonPanic || nextNodeResult instanceof KsmcFsPanic) {
            return nextNodeResult;
        } else if (nextNodeResult instanceof KsmcNoSuchTokenError) {
            return nextNodeResult.panic;
        }
        staticAssert<Dialog | Char | Clue | KsmAst>(nextNodeResult);
        skipWS();
    }

    // 检验上述的 FIXME ASSERT 断言
    for (const node of Object.values(rootNodes)) {
        if (node.type === "clue") {
            node.asks.forEach(({charIdToken, dialogIdTokenOrDeclareId}) => {
                {
                    const charResult = getNodeById(charIdToken.id);
                    if (charResult === null) { return new KsmcCommonPanic(`未知的标识符“${charIdToken.id}”。`, charIdToken.range); }
                    if (charResult.type !== "char") { return new KsmcCommonPanic(`“${charIdToken.id}”不是角色标识符。`, charIdToken.range); }
                }
                if (typeof dialogIdTokenOrDeclareId === "string" ) {
                    // 在 asks 中立即声明对话的，理应不涉及标识符错误的问题，这里姑且断言
                } else {
                    const dialogResult = getNodeById(dialogIdTokenOrDeclareId.id);
                    if (dialogResult === null) { return new KsmcCommonPanic(`未知的标识符“${dialogIdTokenOrDeclareId.id}”。`, dialogIdTokenOrDeclareId.range); }
                    if (dialogResult.type !== "dialog") { return new KsmcCommonPanic(`“${dialogIdTokenOrDeclareId.id}”不是对话标识符。`, dialogIdTokenOrDeclareId.range); }
                }
            });
        } else if (node.type === "dialog") {
            node.commands.forEach(command => {
                if (command.type === "say") {
                    if (command.charIdToken !== null) {
                        const charResult = getNodeById(command.charIdToken.id);
                        if (charResult === null) { return new KsmcCommonPanic(`未知的标识符“${command.charIdToken.id}”。`, command.charIdToken.range); }
                        if (charResult.type !== "char") { return new KsmcCommonPanic(`“${command.charIdToken.id}”不是角色标识符。`, command.charIdToken.range); }
                    }
                } else if (command.type === "note") {
                    if (typeof command.targetIdTokenOrDeclareId === "string" ) {
                        // 在 note 中立即声明对象的，理应不涉及标识符错误的问题，这里姑且断言
                    } else {
                        const targetResult = getNodeById(command.targetIdTokenOrDeclareId.id);
                        if (targetResult === null) { return new KsmcCommonPanic(`未知的标识符“${command.targetIdTokenOrDeclareId.id}”。`, command.targetIdTokenOrDeclareId.range); }
                        if (targetResult.type !== "char" && targetResult.type !== "clue") {
                            return new KsmcCommonPanic(`“${command.targetIdTokenOrDeclareId.id}”不是线索或角色标识符。`, command.targetIdTokenOrDeclareId.range);
                        }
                    }
                }
            });
        }
    }

    return rootNodes;
}


const hasNlReg = /[\r\n]/;
export function makeKsmdListFromAst(opitons: {
    ast: KsmAst,
    /** @default "panic" */
    handleInlineNewlines?: "preserve" | "replace-by-backslash-n" | "replace-by-nothing" | "replace-by-space" | "panic"
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
    for (const node of Object.values(ast)) {
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
                    typeof dialogIdTokenOrDeclareId === "string" ? dialogIdTokenOrDeclareId : dialogIdTokenOrDeclareId.id
                ]),
            );
        } else if (node.type === "dialog") {
            result = add<Dialog>(
                `@${node.idToken.id}`,
                "dialog",
                ...node.commands.flatMap((command) =>
                    command.type === "say" ? [command.charId, command.text] : [
                        "note", 
                        typeof command.targetIdTokenOrDeclareId === "string" ? command.targetIdTokenOrDeclareId : command.targetIdTokenOrDeclareId.id
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