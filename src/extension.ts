import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';

// const modulePath = "module";
// const modulePath = "src/game/module";
const modulePathList = ["src"];
const luaFileRegex = /(M|Util)\.lua$/;

interface FunctionParamInfo {
    type: string; // 参数类型
    detail: string; // 参数详情
    text: string; // 参数文本
}

interface FunctionInfo {
    name: string; // 函数名
    title: string; // 函数标题
    detail: string; // 函数详情
    location: vscode.Location; // 函数位置
    params: Map<string, FunctionParamInfo>; // 函数参数注释
    return: FunctionParamInfo[]; // 函数返回值注释
}

interface ModuleInfo {
    name: string; // 模块名
    filePath: string; // 模块文件路径
    functions: Map<string, FunctionInfo>; // 模块中的函数名及其位置
}

class LuaModuleRegistry {
    /** 工作区文件夹 */
    private workspaceFolder: vscode.WorkspaceFolder = null!;
    /** 存储所有模块信息的 Map */
    private modules: Map<string, ModuleInfo> = new Map();
    /** 文件系统监听器 */
    private watcher: fs.FSWatcher[] = [];
    private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    private luaFiles: Set<string> = new Set();

    public init(workspaceFolder: vscode.WorkspaceFolder) {
        this.workspaceFolder = workspaceFolder;
        this.modules.clear(); // 清空模块信息

        // 初始化 Lua 文件列表
        // this.initLuaFiles().then(() => {
        //     console.log("初始化 Lua 文件列表完成");
        //     this.loadModules(); // 加载所有模块信息
        //     this.setupFileWatcher(); // 设置文件监听器
        // });
    }

    /** 初始化 Lua 文件列表 */
    private async initLuaFiles() {
        this.luaFiles.clear();
        for (const modulePath of modulePathList) {
            const directoryPath = path.join(this.workspaceFolder.uri.fsPath, modulePath); // 模块目录
            // console.log("开始加载指定目录", directoryPath);
            this.statusBarItem.text = `加载模块目录..`;
            this.statusBarItem.show();

            // 获取所有 Lua 文件列表
            (await readLuaFiles(directoryPath)).forEach(filePath => this.luaFiles.add(filePath));
            // console.log("完成目录加载", directoryPath);
        }
    }

    /** 加载所有模块信息 */
    private async loadModules() {
        const total = this.luaFiles.size;
        let loadedCnt = 0;

        for (const filePath of this.luaFiles) {
            await this.updateModuleInfo(filePath); // 更新模块信息
            loadedCnt++;

            // 更新进度条信息
            this.statusBarItem.text = `加载模块 (${loadedCnt}/${total})}`;
        }

        this.statusBarItem.hide();
    }

    /** 设置文件监听器 */
    private setupFileWatcher() {
        this.luaFiles.forEach(filePath => {
            // 文件路径
            this.watcher.push(fs.watch(filePath, { persistent: true, recursive: false }, (eventType, filename) => {
                if (filename) {
                    console.log(`更新模块文件: ${filename} ${eventType}`);
                    this.statusBarItem.text = `更新模块 ${path.basename(filePath)}`;
                    this.statusBarItem.show();
                    this.updateModuleInfo(filePath);
                    this.statusBarItem.hide();
                }
            }));
        });
    }

    /** 更新模块信息 */
    private async updateModuleInfo(filePath: string) {
        try {
            const content = await fs.promises.readFile(filePath, 'utf8'); // 读取文件内容

            const lines = content.split('\n'); // 按行分割文件内容

            // 使用正则表达式匹配 module 语句，获取模块名
            const moduleNameMatch = content.match(/module\(["'](\w+)['"][,\s\w\.]*\)/);
            const moduleName = moduleNameMatch ? moduleNameMatch[1] : '';

            if (!moduleName) {
                return;
            }

            // console.log(`加载模块 ${moduleName} from ${filePath}`);

            // 使用正则表达式匹配所有的 function 语句，并记录它们的位置信息
            const functions = new Map<string, FunctionInfo>();

            let match;
            lines.forEach((line, index) => {
                const functionRegex = /function\s+(\w+)\s*\(/;
                match = functionRegex.exec(line);
                if (!match) {
                    return;
                }

                // 获取函数名
                const functionName = match[1];

                console.log(`发现函数 ${match}`);

                // 函数定义的位置
                const start = match.index + "function ".length;
                const end = start + functionName.length;
                const location = new vscode.Location(
                    vscode.Uri.file(filePath), // 文件的 Uri 对象
                    new vscode.Range(
                        new vscode.Position(index, start), // 起始位置
                        new vscode.Position(index, end) // 结束位置
                    )
                );

                // console.log(`发现函数位置 ${functionName} at ${location.range.start.line + 1}:${location.range.start.character + 1}`);

                // 函数注释
                let detail: string[] = [];
                let paramsList: [string, FunctionParamInfo][] = []; // 函数参数列表
                let returnList: FunctionParamInfo[] = []; // 函数参数列表
                const MAX_LINE_COUNT = 10; // 最大扫描行数
                for (let i = 1; i <= MAX_LINE_COUNT; i++) {
                    const commentLine = lines[index - i]?.trim();
                    if (!commentLine) { break; }
                    if (!commentLine.startsWith('--')) { break; }

                    let line = commentLine.replace(/^[-]+/, "").trimStart();
                    if (line.startsWith("@return")) {
                        // 返回类型
                        let str = line.replace(/^@return/, "").trim();
                        let match = str.match(/^([a-zA-Z\d\.]+)\s+(.*)/);
                        if (match) {
                            returnList.unshift({
                                type: match[1],
                                detail: match[2],
                                text: str,
                            });
                        }
                    } else if (line.startsWith("@param")) {
                        // 参数类型
                        let str = line.replace(/^@param/, "").trim();
                        let match = str.match(/^([a-zA-Z\d\.]+)\s+([a-zA-Z\\.]+)\s+(.*)/);

                        if (match) {
                            let name = match[1];
                            paramsList.unshift([name, {
                                type: match[2],
                                detail: match[3],
                                text: str,
                            }]);
                        }
                    } else {
                        // 函数描述
                        detail.unshift(line);
                    }
                }

                let paramsStr = "";
                if (paramsList.length) {
                    paramsStr = paramsList.map(item => `${item[0]}: ${item[1].type}`).join(", ");
                }

                let returnStr = "";
                if (returnList.length) {
                    returnStr = "\n\t" + returnList.map((item, index) => `->${index + 1}. ${item.type}\t-- ${item.detail}`).join("\n\t");
                }

                functions.set(functionName, {
                    name: functionName,
                    title: `function ${functionName}(${paramsStr})${returnStr}`,
                    detail: detail.join(" "),
                    location: location,
                    params: new Map(paramsList),
                    return: returnList,
                });
            });

            if (moduleName) {
                // 将模块信息存储到全局 Map 中
                this.modules.set(moduleName.toLocaleLowerCase(), { name: moduleName, filePath, functions });
            }
        } catch (error) {
            console.error('Error updating module info:', error);
        }
    }

    /** 获取模块中的所有函数信息 */
    getModuleFunctions(moduleName: string): Map<string, FunctionInfo> | undefined {
        const moduleInfo = this.modules.get(moduleName.toLocaleLowerCase());
        return moduleInfo ? moduleInfo.functions : undefined;
    }

    /** 销毁 */
    deactivate() {
        this.modules.clear(); // 清空模块信息
        this.luaFiles.clear(); // 清空 Lua 文件列表
        this.watcher.forEach(watcher => watcher.close()); // 关闭文件监听器
    }
}

async function readLuaFiles(directoryPath: string): Promise<string[]> {
    const luaFiles: string[] = [];
    const files = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    for (const file of files) {
        const filePath = path.join(directoryPath, file.name);
        if (file.isFile() && path.extname(file.name) === '.lua' && file.name.match(luaFileRegex)) {
            console.log(`发现满足条件的 Lua 文件 ${file.name}`);
            luaFiles.push(filePath);
        } else if (file.isDirectory()) {
            const subFiles = await readLuaFiles(filePath);
            luaFiles.push(...subFiles);
        }
    }
    return luaFiles;
}

/** 获取函数的文档注释 */
function getFunctionComment(functionInfo: FunctionInfo, needSeparator: boolean = true): vscode.MarkdownString {
    let result = new vscode.MarkdownString("", true);

    result.appendCodeblock(functionInfo.title, "lua");

    // 分隔符
    if (needSeparator) {
        result.appendMarkdown("---\n");
    }

    // 描述
    result.appendText(functionInfo.detail);

    // 参数
    let comment = "";
    let isFirst = true;
    let getPrefix = () => {
        if (isFirst) {
            isFirst = false;
            return "";
        }
        return "\n";
    };
    functionInfo.params.forEach(info => {
        comment += `${getPrefix()}@param ` + info.text;
    });
    functionInfo.return.forEach(info => {
        comment += `${getPrefix()}@return ` + info.text;
    });
    result.appendCodeblock(comment, "lua");
    return result;
}

/** 找到当前光标选中的函数信息 */
function findFunctionInfo(document: vscode.TextDocument, position: vscode.Position) {
    const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(position.line, 0), position)); // 获取光标前的文本
    const textCurLine = document.lineAt(position.line).text; // 获取当前行的文本

    // 获取当前光标选中的函数名
    const dotPos = textBeforeCursor.lastIndexOf('.');
    if (dotPos === -1) {
        return undefined;
    }

    const textBeforeDot = textBeforeCursor.substring(0, textBeforeCursor.lastIndexOf('.')); // 获取点前面的文本
    const textAfterDot = textCurLine.substring(dotPos + 1).trim(); // 获取点后面的文本

    // console.log(`获取光标前的文本: ${textBeforeCursor}`);
    // console.log(`获取点前面的文本: ${textBeforeDot}`);
    // console.log(`获取点后面的文本: ${textAfterDot}`);

    // 匹配模块名
    const moduleNameMatch = textBeforeDot.match(/(\w+)$/);
    if (moduleNameMatch) {
        const moduleName = moduleNameMatch[1];
        const functions = registry.getModuleFunctions(moduleName);
        if (functions) {
            const functionNameMatch = textAfterDot.match(/^(\w+)/);
            if (!functionNameMatch) {
                return undefined;
            }

            // 提取函数名
            const functionName = functionNameMatch[1];
            // console.log(`匹配到模块 ${moduleName} 中的函数 ${functionName}`);
            let functionInfo = functions.get(functionName);
            if (!functionInfo) {
                return undefined;
            }

            return {
                moduleName: moduleName,
                functionInfo: functionInfo,
            };
        }
    }
}

/** 提供代码补全的函数 */
function provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {
    const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(position.line, 0), position)); // 获取光标前的文本
    const moduleNameMatch = textBeforeCursor.match(/(\w+)\./); // 匹配模块名

    if (moduleNameMatch) {
        const moduleName = moduleNameMatch[1]; // 提取模块名
        const functions = registry.getModuleFunctions(moduleName); // 获取模块中的所有函数信息

        if (functions) {
            const items = Array.from(functions.keys()).map(name => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function); // 创建补全项
                // item.detail = `Function in module ${moduleName}`; // 补全项的详细信息
                let functionInfo = functions.get(name)!;

                // 函数的文档注释
                item.documentation = getFunctionComment(functionInfo, false);
                return item;
            });

            return items;
        }
    }

    return []; // 如果没有找到任何补全项，返回空数组
}

/** 提供鼠标悬停的函数 */
function provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
    const result = findFunctionInfo(document, position); // 找到当前光标选中的函数信息
    if (!result) {
        return undefined;
    }

    const { functionInfo } = result;
    const hoverContent = getFunctionComment(functionInfo);
    return new vscode.Hover(hoverContent);
}

/** 提供跳转到定义的函数 */
function provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Location | vscode.Location[]> {
    const result = findFunctionInfo(document, position); // 找到当前光标选中的函数信息
    if (result) {
        return result.functionInfo.location; // 返回函数的定义位置
    }

    return undefined;
}

function convertModuleLine(editBuilder: vscode.TextEditorEdit, line: string, index: number) {
    const moduleNameRegex = /module\(["'](\w+)['"][,\s\w\.]*\);/;
    const moduleMatch = moduleNameRegex.exec(line);
    if (moduleMatch) {
        console.log(`发现模块行 ${moduleMatch[0]}`);

        // 获取模块注册语句位置
        const start = moduleMatch.index;
        const end = start + moduleMatch[0].length;
        const range = new vscode.Range(
            new vscode.Position(index, start), // 起始位置
            new vscode.Position(index, end) // 结束位置
        );

        // 替换为 moduleName = {} 到当前行
        const moduleName = moduleMatch[1];
        const newLine = `${moduleName} = {};`;
        editBuilder.replace(range, newLine);
        return true;
    }
    return false;
}

/** 转换模块文件 */
async function convertModule() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('请先打开一个文件');
        return;
    }

    const filePath = editor.document.fileName;
    const fileName = path.basename(filePath);
    let content = editor.document.getText();

    // 使用正则表达式匹配 module 语句，获取模块名
    const moduleNameRegex = /module\(["'](\w+)['"][,\s\w\.]*\);/;
    const moduleNameMatch = content.match(moduleNameRegex);
    const moduleName = moduleNameMatch ? moduleNameMatch[1] : '';

    if (!moduleName) {
        vscode.window.showInformationMessage(`[${fileName}]不需要修改`);
        return;
    }

    console.log(`模块名: ${moduleName}`);

    // 使用正则表达式匹配所有的 function 语句，并记录它们的位置信息
    const functions = new Set<string>();
    const overwriteLines = new Set<number>();

    let match;
    const lines = content.split('\n'); // 按行分割文件内容
    await editor.edit(editBuilder => {
        // 先预处理模块和函数定义语句
        lines.forEach((line, index) => {
            // 处理模块注册语句
            if (convertModuleLine(editBuilder, line, index)) {
                overwriteLines.add(index);
                return;
            }

            const functionRegex = /^function\s+(\w+)\s*\(/;
            match = functionRegex.exec(line);
            if (!match) {
                return;
            }

            overwriteLines.add(index);

            // 获取函数名
            const functionName = match[1];

            console.log(`发现函数 ${functionName}`);

            functions.add(functionName);

            // 函数定义的位置
            const start = match.index + "function ".length;
            const end = start + functionName.length;
            const location = new vscode.Location(
                vscode.Uri.file(filePath), // 文件的 Uri 对象
                new vscode.Range(
                    new vscode.Position(index, start), // 起始位置
                    new vscode.Position(index, end) // 结束位置
                )
            );

            // 将函数定义移动到模块的函数表中
            const newFuncName = `${moduleName}.${functionName}`;
            editBuilder.replace(location.range, newFuncName);
        });

        // 再处理模块内调用自有函数的语句
        let functionNameStr = Array.from(functions).join('|');
        lines.forEach((line, index) => {
            if (overwriteLines.has(index)) {
                return;
            }

            const functionCallRegex = new RegExp(`[^a-zA-Z\\.:](${functionNameStr})\\(`, "g");
            while (match = functionCallRegex.exec(line)) {
                // 获取函数名
                const functionName = match[1];
                const resultTxt = match[0];

                console.log(`发现函数[${functionName}]调用, 文本 = ${resultTxt}`);

                // 函数定义的位置
                const start = match.index;
                const end = start + resultTxt.length;
                const location = new vscode.Location(
                    vscode.Uri.file(filePath), // 文件的 Uri 对象
                    new vscode.Range(
                        new vscode.Position(index, start), // 起始位置
                        new vscode.Position(index, end) // 结束位置
                    )
                );

                // 文件内替换原本直接调用函数的地方，修改为 ${moduleName}.${functionName}
                const newFuncName = resultTxt.replace(functionName, `${moduleName}.${functionName}`);;
                editBuilder.replace(location.range, newFuncName);
            }
        });

        // 在文件后面添加模块的导出语句
        const exportStr = `\nreturn ${moduleName};\n`;
        const lastLine = lines[lines.length - 1];
        if (lastLine.trim() === '') {
            editBuilder.insert(new vscode.Position(lines.length - 1, 0), exportStr);
        } else {
            editBuilder.insert(new vscode.Position(lines.length, 0), '\n' + exportStr);
        }

        // const saved = await editor.document.save();
        // if (!saved) {
        //     vscode.window.showErrorMessage('Failed to save the document.');
        // }
    });
}

const registry: LuaModuleRegistry = new LuaModuleRegistry();

// 导出激活函数
export function activate(context: vscode.ExtensionContext) {
    // 假定只有一个工作区文件夹
    const workspaceFolder = vscode.workspace.workspaceFolders![0];
    registry.init(workspaceFolder);

    // 注册lua模块文件转换的命令
    context.subscriptions.push(vscode.commands.registerCommand("LuaModuleConverter.convertModule", convertModule));

    // // 注册代码补全提供者
    // context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ scheme: 'file', language: 'lua' }, {
    //     provideCompletionItems,
    // }, '.', '"'));

    // // 注册鼠标悬浮提示提供者
    // context.subscriptions.push(vscode.languages.registerHoverProvider({ scheme: 'file', language: 'lua' }, {
    //     provideHover,
    // }));

    // // 注册跳转到定义的提供者
    // context.subscriptions.push(vscode.languages.registerDefinitionProvider({ scheme: 'file', language: 'lua' }, {
    //     provideDefinition,
    // }));

    // vscode.window.showInformationMessage('LuaModuleConverter 插件已启动!');
}

// 导出销毁函数
export function deactivate() {
    registry.deactivate();
}
