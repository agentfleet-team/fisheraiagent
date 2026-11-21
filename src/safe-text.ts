// SafeText is the only brand of text that may reach a person: a Discord
// reply (channel or ephemeral) or an HTTP error body. Values exist only as
// string literals wrapped at their definition by safeText() or as entries
// of the fixed code-to-message tables — there is no function that turns an
// arbitrary `string` into SafeText, so caught, request-derived or remote
// text cannot reach one of these sinks.

declare const safeTextBrand: unique symbol;

export type SafeText = string & { readonly [safeTextBrand]: 'safe' };

// A generic parameter constrained to `string` still infers a literal type
// for literal arguments; `string extends Literal` is true only for a plain
// `string` (or `any`), which collapses the parameter to `never` and is
// rejected. Only compile-time-fixed text therefore fits.
type LiteralOnly<Literal extends string> = string extends Literal ? never : Literal;

// Wraps a string literal at its definition. The implementation signature
// is not callable; callers see only the literal-only overload.
export function safeText<Literal extends string>(text: LiteralOnly<Literal>): SafeText;
export function safeText(text: string): string {
  return text;
}
