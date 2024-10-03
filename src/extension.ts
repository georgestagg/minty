import * as vscode from 'vscode';
import OpenAI from 'openai';
import * as path from 'path';

let diagnosticCollection: vscode.DiagnosticCollection;
let extensionContext: vscode.ExtensionContext;
let openai: OpenAI | undefined;

// Add an interface for our enhanced diagnostic type
interface LinterDiagnostic {
  lineNumber: number;
  problematicText: string;
  message: string;
  severity: string;
  fix?: {
    title: string;
    replacement: string;
  };
}

interface MintyDiagnostic extends vscode.Diagnostic {
  data?: {
    fix: {
      title: string;
      edits: string;
    }
  };
}

const readFileTool = {
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Read the contents of a file relative to the current file",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The path of the file to read, relative to the current file"
        }
      },
      required: ["filePath"]
    }
  }
};

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  diagnosticCollection = vscode.languages.createDiagnosticCollection("minty");
  context.subscriptions.push(diagnosticCollection);

  // Register the code action provider
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider('*', new LinterActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
  );

  // Add event listener for document save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
      await lintDocument(document);
    })
  );

  // Always register the lintCurrentFile command
  let disposable = vscode.commands.registerCommand('minty.lintCurrentFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await lintDocument(editor.document);
    } else {
      vscode.window.showInformationMessage('No active editor found');
    }
  });

  context.subscriptions.push(disposable);

  // Register the setApiKey command
  context.subscriptions.push(
    vscode.commands.registerCommand('minty.setApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your OpenAI API Key',
        password: true
      });
      if (apiKey) {
        await extensionContext.secrets.store('minty-openai-api-key', apiKey);
        vscode.window.showInformationMessage('API Key updated successfully.');
        initializeOpenAI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('minty.clearApiKey', async () => {
      await extensionContext.secrets.delete('minty-openai-api-key');
      vscode.window.showInformationMessage('API Key has been cleared.');
      openai = undefined;
    })
  );

  // Initialize OpenAI client
  await initializeOpenAI();
}

async function initializeOpenAI() {
  const apiKey = await extensionContext.secrets.get('minty-openai-api-key');

  if (!apiKey) {
    vscode.window.showWarningMessage('OpenAI API Key is not set. Please set it using the "Minty: Set OpenAI API Key" command.');
  } else {
    openai = new OpenAI({ apiKey });
  }
}

// Add the CodeActionProvider class
class LinterActionProvider implements vscode.CodeActionProvider {
  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Loop through each diagnostic
    for (const diagnostic of context.diagnostics) {
      // Check if this diagnostic has a fix (stored in the data property)
      const mintyDiagnostic = diagnostic as MintyDiagnostic;
      const fix = mintyDiagnostic.data?.fix;
      if (fix) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, diagnostic.range, fix.edits);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        actions.push(action);
      }
    }

    return actions;
  }
}

function cleanResponse(response: string): string {
  return response.replace(/```json\n?|\n?```/g, '').trim();
}

async function readFile(filePath: string, currentFilePath: string): Promise<string | null> {
  const currentDir = path.dirname(currentFilePath);
  const fullPath = path.join(currentDir, filePath);
  const uri = vscode.Uri.file(fullPath);

  try {
    const content = await vscode.workspace.fs.readFile(uri);
    return content.toString();
  } catch (error) {
    // Instead of logging the error, we'll just return null
    return null;
  }
}

async function lintDocument(document: vscode.TextDocument) {
  const fileName = document.fileName;
  const lineHints = getLineHints(document);

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Minty: Linting document...",
    cancellable: false
  }, async (progress) => {
    try {
      const diagnostics = await getLintingDiagnostics(fileName, lineHints);
      applyDiagnostics(document, diagnostics);
    } catch (error) {
      handleLintingError(error);
    }
  });
}

function getLineHints(document: vscode.TextDocument): string {
  const lines = document.getText().split('\n');
  return lines.map((line, i) => `${i}: ${line}`).join('\n');
}

async function getLintingDiagnostics(fileName: string, lineHints: string): Promise<LinterDiagnostic[]> {
  if (!openai) {
    throw new Error('OpenAI client is not initialized. Please set your API key.');
  }

  const messages = await conductConversationWithLLM(fileName, lineHints);
  const finalResponse = extractFinalResponse(messages);
  return parseLintingResponse(finalResponse);
}

async function conductConversationWithLLM(fileName: string, lineHints: string): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: getSystemPrompt() },
    { role: "user", content: `Filename: ${fileName}\n\nContent:\n${lineHints}` }
  ];

  let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined;

  do {
    const completion = await openai!.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      tools: [readFileTool],
      tool_choice: "auto",
      temperature: 0.1,
    });

    const lastMessage = completion.choices[0].message;
    messages.push(lastMessage as OpenAI.Chat.ChatCompletionMessageParam);

    toolCalls = lastMessage.tool_calls;

    if (toolCalls) {
      const toolResponses = await handleToolCalls(toolCalls, fileName);
      messages.push(...toolResponses as OpenAI.Chat.ChatCompletionMessageParam[]);
    }
  } while (toolCalls && toolCalls.length > 0);

  return messages;
}

async function handleToolCalls(toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[], fileName: string): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  return Promise.all(toolCalls.map(async (toolCall) => {
    if (toolCall.function.name === "read_file") {
      return handleReadFileTool(toolCall, fileName);
    } else {
      console.log(`Unknown tool call: ${toolCall.function.name}`);
      return { role: "tool", tool_call_id: toolCall.id, content: `Error: Unknown tool ${toolCall.function.name}` } as const;
    }
  }));
}

async function handleReadFileTool(
  toolCall: OpenAI.Chat.ChatCompletionMessageToolCall,
  currentFileName: string
): Promise<OpenAI.Chat.ChatCompletionMessageParam> {
  const { filePath } = JSON.parse(toolCall.function.arguments);
  console.log(`Tool call: read_file - Requested file: ${filePath}`);
  const fileContent = await readFile(filePath, currentFileName);

  let responseContent: string;

  if (fileContent !== null) {
    console.log(`Processed tool call: read_file - File: ${filePath}`);
    responseContent = `
Current file being linted: ${currentFileName}
Requested file: ${filePath}
Content of ${filePath}:

${fileContent}
`;
  } else {
    console.log(`File not found or unreadable: ${filePath}`);
    responseContent = `
Current file being linted: ${currentFileName}
Requested file: ${filePath}

The file "${filePath}" could not be read. It may not exist or may not be accessible.
`;
  }

  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: responseContent.trim()
  } as const;
}

function extractFinalResponse(messages: OpenAI.Chat.ChatCompletionMessageParam[]): string {
  const finalMessage = messages[messages.length - 1];
  if (finalMessage.role !== 'assistant') {
    throw new Error('Unexpected final message from OpenAI API');
  }

  if (typeof finalMessage.content === 'string') {
    return finalMessage.content;
  } else if (Array.isArray(finalMessage.content)) {
    return finalMessage.content
      .filter(part => part.type === 'text')
      .map(part => (part as { text: string }).text)
      .join('');
  } else {
    throw new Error('Unexpected content format in final message');
  }
}

function parseLintingResponse(response: string): LinterDiagnostic[] {
  const cleanedResponse = cleanResponse(response);
  console.log('Raw response:', cleanedResponse);
  try {
    return JSON.parse(cleanedResponse);
  } catch (parseError) {
    console.error('Error parsing OpenAI response:', parseError);
    throw new Error('Failed to parse OpenAI response');
  }
}

function applyDiagnostics(document: vscode.TextDocument, diagnosticsData: LinterDiagnostic[]) {
  const diagnostics: MintyDiagnostic[] = diagnosticsData.map((item: LinterDiagnostic) => {
    const line = document.lineAt(item.lineNumber);
    const startIndex = line.text.indexOf(item.problematicText);

    if (startIndex === -1) {
      console.warn(`Problematic text "${item.problematicText}" not found on line ${item.lineNumber}`);
      return null;
    }

    const endIndex = startIndex + item.problematicText.length;
    const range = new vscode.Range(
      new vscode.Position(item.lineNumber, startIndex),
      new vscode.Position(item.lineNumber, endIndex)
    );

    const diagnostic: MintyDiagnostic = new vscode.Diagnostic(
      range,
      item.message,
      convertSeverity(item.severity)
    );

    if (item.fix) {
      diagnostic.data = {
        fix: {
          title: item.fix.title,
          edits: item.fix.replacement
        }
      };
    }

    return diagnostic;
  }).filter((diagnostic): diagnostic is MintyDiagnostic => diagnostic !== null);

  diagnosticCollection.set(document.uri, diagnostics);
}

function handleLintingError(error: unknown) {
  console.error('Error during linting:', error);
  vscode.window.showErrorMessage('Error occurred while linting the file.');
}

function getSystemPrompt(): string {
  return String.raw`
    You are a code linter. You understand code written in many different programming languages.

    IMPORTANT: When reporting diagnostic ranges, use 0-based line positions.
    
    The code will be provided with line numbers prefixed to help you accurately report positions.
    For example, if you see:
    0: function hello() {
    1:   console.log("world")
    2: }

    You can request to read additional files for context using the read_file function. This might
    be useful for reading additional included or sourced files.

    You may return multiple unrelated linting problems in the same response.

    Analyze the given code and return a JSON array of diagnostics. Each diagnostic should have:
    - lineNumber (0-based line number where the issue occurs)
    - problematicText (the exact substring that is problematic)
    - message (description of the issue)
    - severity (error, warning, information, or hint)
    - fix (optional) containing:
      - title (short description of the fix)
      - replacement (the text to replace the problematic substring with)
    
    If there are no problems in the given code, just return an empty JSON array.

    IMPORTANT: Respond ONLY with the JSON array, without any additional text or formatting.
  `;
}

function convertSeverity(severity: string): vscode.DiagnosticSeverity {
  switch (severity.toLowerCase()) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'information':
      return vscode.DiagnosticSeverity.Information;
    case 'hint':
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

export function deactivate() { }
