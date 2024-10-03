import * as vscode from 'vscode';
import OpenAI from 'openai';

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

async function lintDocument(document: vscode.TextDocument) {
  const text = document.getText();
  const fileName = document.fileName;

  const lines = text.split('\n');
  const lineHints = lines.map((line, i) => `${i}: ${line}`).join('\n');

  const systemPrompt = String.raw`
    You are a code linter. You understand code written in many different programming languages.

    IMPORTANT: When reporting diagnostic ranges, use 0-based line positions.
    
    The code will be provided with line numbers prefixed to help you accurately report positions.
    For example, if you see:
    0: function hello() {
    1:   console.log("world")
    2: }

    Analyze the given code and return a JSON array of diagnostics. Each diagnostic should have:
    - lineNumber (0-based line number where the issue occurs)
    - problematicText (the exact substring that is problematic)
    - message (description of the issue)
    - severity (error, warning, information, or hint)
    - fix (optional) containing:
      - title (short description of the fix)
      - replacement (the text to replace the problematic substring with)
    
    Example diagnostic with a fix:
    {
      "lineNumber": 0,
      "problematicText": "function hello",
      "message": "Function name should be in camelCase",
      "severity": "warning",
      "fix": {
        "title": "Convert to camelCase",
        "replacement": "function sayHello"
      }
    }
    
    If there are no problems in the given code, just return an empty JSON array.

    IMPORTANT: Respond ONLY with the JSON array, without any additional text or formatting.
  `;

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Minty: Linting document...",
    cancellable: false
  }, async (progress) => {
    try {
      if (!openai) {
        vscode.window.showWarningMessage('OpenAI client is not initialized. Please set your API key.');
        return;
      }
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Filename: ${fileName}\n\nContent:\n${lineHints}` }
        ],
        temperature: 0.1,
      });
  
      const responseContent = completion.choices[0].message.content;
      if (!responseContent) {
        throw new Error('Empty response from OpenAI API');
      }
  
      let diagnosticsData: LinterDiagnostic[];
      const cleanedResponse = cleanResponse(responseContent);
      console.log('Raw response:', cleanedResponse);
      try {
        diagnosticsData = JSON.parse(cleanedResponse);
      } catch (parseError) {
        console.error('Error parsing OpenAI response:', parseError);
        throw new Error('Failed to parse OpenAI response');
      }
  
      const diagnostics: MintyDiagnostic[] = diagnosticsData.map((item: LinterDiagnostic) => {
        const line = document.lineAt(item.lineNumber);
        const startIndex = line.text.indexOf(item.problematicText);
        
        // Ensure startIndex is non-negative
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
    } catch (error) {
      console.error('Error calling OpenAI API:', error);
      vscode.window.showErrorMessage('Error occurred while linting the file.');
    }
  });
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
