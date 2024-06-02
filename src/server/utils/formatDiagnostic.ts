import { Diagnostic, DiagnosticSeverity } from "coc.nvim";
import { formatDiagnostic as formatDiagnosticIntoMarkdown } from "pretty-ts-errors-markdown";

/** Replace backticks in text, but not in code blocks */
function replaceBackticksExceptCodeBlocks(text: string) {
  const codeBlockRegex = /```[\s\S]*?```/g;
  const backtickRegex = /`([^`]+)`/g;

  const codeBlocks: string[] = [];
  const textWithPlaceholders = text.replace(codeBlockRegex, (match: string) => {
    codeBlocks.push(match);
    return "\0";
  });

  const replacedText = textWithPlaceholders
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(backtickRegex, "\u001b[1;34m$1\u001b[0m");

  const finalText = replacedText.replace(/\0/g, () => codeBlocks.shift() || "");

  return finalText;
}

const error = (str: string) => {
  return `\u001b[1;31m${str}\u001b[0m`;
};

const warning = (str: string) => {
  return `\u001b[1;32m${str}\u001b[0m`;
};

const info = (str: string) => {
  return `\u001b[1;36m${str}\u001b[0m`;
};

const renderType = {
  [DiagnosticSeverity.Error]: error,
  [DiagnosticSeverity.Warning]: warning,
  [DiagnosticSeverity.Information]: info,
  [DiagnosticSeverity.Hint]: info,
} as const;

type formatOptions = {
  showLink: boolean;
  codeBlockHighlightType: "prettytserr" | "typescript";
};

export const formatDiagnostic = (diagnostics: Diagnostic[]): Diagnostic[] => {
  return format(diagnostics, {
    showLink: false,
    codeBlockHighlightType: "prettytserr",
  });
};

const format = (_diagnostics: Diagnostic[], opt: formatOptions) => {
  const diagnostics = _diagnostics.map((diagnostic) => {
    const formatted = replaceBackticksExceptCodeBlocks(
      formatDiagnosticIntoMarkdown(diagnostic)
    )
      .split("\n")
      .map((line, index) => {
        if (index === 0) {
          line = renderType[diagnostic.severity || DiagnosticSeverity.Error](
            line.substring(3, line.length)
          );
        }
        line = line.replace(
          /(\['?)([^' ]+)('?.+?📄\])/g,
          (_match, _p1, target) => `[${target} 📄]`
        );
        if (opt.showLink === false) {
          line = line.replace(/\[(🔗|🌐)\]\(.*\)/g, "");
        }
        if (opt.codeBlockHighlightType === "prettytserr") {
          line = line.replace(/(?<=(^\s*```))typescript/, "prettytserr");
        } else {
          const match = line.match(/^(\s*)```typescript.*/);
          const spaceCount = match?.[1].length || 0;
          line = line.replace(
            /(?<=(^\s*```))typescript/,
            `typescript\n${"\u0020".repeat(spaceCount)}type Type =`
          );
        }
        return line;
      })
      .join("\n");
    return {
      ...diagnostic,
      message: `${formatted}\n\n`,
      filetype: "markdown",
      // source: NAMESPACE,
    };
  });
  return diagnostics;
};
