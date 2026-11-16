import ts from "typescript-floor";

/** Literal module paths; undefined marks a computed import with an unknown target. */
export function moduleReferences(source: string): readonly (string | undefined)[] {
  const file = ts.createSourceFile(
    "module.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const references: (string | undefined)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        references.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      references.push(argument && ts.isStringLiteralLike(argument) ? argument.text : undefined);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      references.push(node.argument.literal.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      references.push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return references;
}
