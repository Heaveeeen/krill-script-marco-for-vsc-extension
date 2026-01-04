# krill-script-marco README

KSM 是一种 DSL。这种 DSL 仅供自用，没有完备、健壮的语法。

## Features

提供对 KSM 基本的语言支持，包括语法高亮、自动补齐、引用追踪、语法检查等，并集成了一个编译器。

按`Ctrl+Shift+P`打开命令面板，运行`KSM: krill script marco - create ksm configuration file`创建一个 KSM 配置文件以激活 KSM 语法分析和编译功能。

ksmconfig.json 的结构是这样的：

```ts
interface KsmConfig {
    // 编译入口文件相对于配置文件所在目录的路径
    rootFile: string;
    // 输出文件相对于配置文件所在目录的路径
    outFile: string;

    // @default "panic"
    handleImportButNoPathError?: "ignore" | "warn-to-console" | "panic";
    // @default "panic"
    handleNewlineInString?: "preserve" | "replace-by-backslash-n" | "replace-by-nothing" | "replace-by-space" | "panic";
    // @default "panic"
    handleIndentInString?: "preserve" | "remove" | "panic";
    // @default "panic"
    handleInlineNewlines?: "preserve" | "replace-by-backslash-n" | "replace-by-nothing" | "replace-by-space" | "panic";
    // @default false
    allowChineseKeywords?: boolean;
}
```

## Extension Settings

* `krillScriptMarco.showCharRefsOfSayCommands`: 查看角色的引用时，是否应该查找位于说话指令中的引用。有`"none"`和`"all"`两种可选的值。

## Known Issues

通过`language-configuration.json`的`wordPattern`字段配置的分词功能无法正常使用，貌似是因为这个字段的正则表达式不支持 unicode 模式，所以无法依赖中文冒号和引号字符等进行分词，但这些字符在 KSM 的语法中都是合法的分词符。

## Release Notes

### 0.0.1

首个版本，支持基本的语言功能。

### 0.0.2

修复重复声明标识符时，报错信息中包含`[object Object]`的问题。

### 0.0.3

新增处理字符串内缩进的功能。

### 0.0.4

修复字符串缩进的一个小 bug。

为`ksmconfig.json`加入了一些简单的报错机制。

### 0.0.5

把语法中的减号`-`改成了箭头`->`。

部分实现了`combine`语句的语法解析功能，但未完全实现其功能，所以代码中出现`combine`语句会报错。

### 0.0.6

修复了导入文件时提前验证标识符是否已定义，导致出现不该有的报错的问题。

### 0.0.7

更改角色声明语法，加入角色描述。

允许在大纲中隐藏对话内容。

### 0.0.8

悬停提示会显示更多信息。

在编译结果中增加元数据，包括时间戳。

### 0.0.9

加入匿名线索和对话语法。

优化语法提示的一些细节，加入文件链接功能。

---

# KSM 说明

KSM 是一种 DSL，用于开发特定的文字冒险游戏。这种 DSL 仅供自用，没有完备、健壮的语法。

有五种基本的顶级语句：`char`, `clue`, `dialog`, `import`, `combine`，语句靠换行分割。语句外的空白字符会被忽略。

标识符可以包含大小写英文字母、数字、下划线、任何语言中的字母（例如汉字），且不能由数字开头，例如`tom`, `the_king`, `哈姆雷特`, `配角1`。

标识符不能是保留字，保留字有`char`, `clue`, `dialog`, `note`, `import`, `combine`和它们的中文版本`角色`, `线索`, `对话`, `笔记`, `导入`, `组合`（中文版本的关键字可以跟英文版本互换），还有特殊的保留字`_ksm_metadata_desc_`和`_ksm_metadata_build_timestamp_`。所有标识符都是全局的。

`char <标识符> "<角色名>" "<角色描述>"`声明一个角色，例如`char 华盛顿 "乔治·华盛顿" "美国第一任总统"`。

```ksm
clue <标识符> "<线索描述>" {
    <角色标识符>-><对话标识符 | 对话声明语句>
    ...
}
```
声明一条线索。
```ksm
clue 血字 "在尸体旁边发现了一些字……用血写成的。\n可能是凶手的名字。" {
    警官A -> 对话005
    嫌疑人 -> dialog 对话010 {
        主角:对此你想说什么？
        嫌疑人:冤枉！
    }
    警官B -> 对话012
}
线索 由中文版本关键字声明的线索 "这个线索不能问别人，所以后面花括号是空的" {}
```

```ksm
dialog <对话标识符> {
    <<角色标识符>:<说话的内容，任何文本直到行末> | note <线索声明或标识符 | 角色声明或标识符>>
    ...
}
```
声明一场对话。
```ksm
dialog myDialogue {
    马可：你好。
    ：近来身体还行吧？
    詹姆斯：还行……
    ：胃病又犯了。
    note 詹姆斯 // 解锁一个联络人
    詹姆斯：你看报了吗？\n挺吓人的。就那个"黑老大"……
    马可：乐
    马可：好似
    note 报纸线索1 // 获得一个线索
    詹姆斯：你知道贝内特吗？
    笔记 角色 贝内特 "贝内特";
    note clue 新任黑老大 "新任黑老大，贝内特上任了……\n有点蹊跷。" {
        詹姆斯 -> dialog 詹姆斯瑞平贝内特 {
            詹姆斯：牛逼
        }
    }
}
```
对话和线索的标识符都是可省略的，但匿名的对话或线索无法重复引用。

`import "<url>"`用来导入其他文件。每个文件只会导入一次。

`combine {<原因线索1> <原因线索2> <原因线索3>...} -> <结论线索>`用来声明一个组合。组合意味着把多个线索组合起来推理得出一个新线索。当玩家集齐了花括号中的所有原因线索时，自动获得结论线索。

```ksm
combine {
    clue 线索1 "李四被杀了" {}
    clue 线索2 "张三跟李四有仇" {}
} -> clue 结论 "张三有杀人嫌疑" {}
```

`//`直到行末的内容是单行注释。没有多行注释。

KSMC 是 KSM 的编译器。它需要通过一个`ksmconfig.json`文件来配置编译的入口、编译选项等。
