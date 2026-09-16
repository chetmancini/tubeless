import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion): boolean {
  let current: ESTree.Node = node;
  while (true) {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some((comment) => comment.end <= node.start && /\bSAFETY\s*:/u.test(comment.value))
    ) {
      return true;
    }
    if (commentOwnerKinds.has(current.type)) {
      if (
        current.parent.type === "ExportNamedDeclaration" ||
        current.parent.type === "ExportDefaultDeclaration"
      ) {
        current = current.parent;
        continue;
      }
      return false;
    }
    if (current.parent.type === "Program") return false;
    current = current.parent;
  }
}

/** Keep the unchecked invariant behind every non-const assertion visible to reviewers. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require non-const type assertions to document the invariant TypeScript cannot verify.",
    },
    messages: {
      missingSafetyComment:
        "This assertion suppresses an assignability check without a `SAFETY:` justification. Document the verified invariant immediately before it.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node) || hasSafetyComment(context.sourceCode, node)) return;
      context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
