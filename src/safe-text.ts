// SafeText is the only brand of text that may reach a person: a Discord
// reply (channel or ephemeral), a reaction, or an HTTP error body. Every
// SafeText value lives in the frozen MESSAGES table below, keyed by a fixed
// code — including the texts that used to be literals at call sites. Other
// modules can only look a message up by code; there is no function that
// turns an arbitrary `string` into SafeText, so caught, request-derived or
// remote text cannot reach one of these sinks.

declare const safeTextBrand: unique symbol;

export type SafeText = string & { readonly [safeTextBrand]: 'safe' };

// Brands a table literal at its definition. Module-private, so SafeText
// values exist only as MESSAGES entries. A generic parameter still infers
// the literal type for literal arguments; `string extends Literal` is true
// only for a plain `string` (or `any`), which collapses the parameter to
// `never` and is rejected even inside this module. The implementation
// signature is not callable; the table sees only the literal-only overload.
type LiteralOnly<Literal extends string> = string extends Literal ? never : Literal;

function brand<Literal extends string>(text: LiteralOnly<Literal>): SafeText;
function brand(text: string): string {
  return text;
}

const MESSAGES = Object.freeze({
  // HTTP error bodies; these codes are also the wire `error.code` values.
  invalid_url: brand('not a usable YouTube URL or video id'),
  video_unavailable: brand('the video is unavailable or cannot be transcribed'),
  missing_key: brand('a Gemini API key is required'),
  key_rejected: brand('the Gemini API key was rejected'),
  quota_exceeded: brand('the Gemini API key is out of quota'),
  upstream_timeout: brand('the upstream request timed out'),
  upstream_rejected: brand('the upstream service rejected the request'),
  model_not_found: brand('the configured model was not found'),
  bad_model_output: brand('the model returned output in an unexpected format'),
  invalid_config: brand('the service configuration is invalid'),
  invalid_request: brand('request body must be JSON with a "url" string'),
  unauthorized: brand('Authorization: Bearer <SERVICE_TOKEN> is required'),
  not_found: brand('unknown route or job_id'),
  internal_error: brand('unexpected server error'),
  save_failed: brand(
    'the transcript could not be saved to the configured destination — for a Drive folder, check it is shared with the service account email',
  ),
  save_unauthorized: brand('the caller is not allowed to save to that destination'),
  no_tenant: brand('this sign-in is not allowlisted for any tenant, so nothing was saved'),
  rate_limited: brand('too many jobs in the last hour — try again later'),
  video_too_long: brand('the video is longer than the limit for this destination'),
  // Discord replies: the 'bot.error.<LogCode>' entries answer a failed
  // transcript job, the rest are the fixed setup and progress texts.
  'bot.error.invalid_url': brand("That doesn't look like a usable YouTube link."),
  'bot.error.video_unavailable': brand('This video is unavailable — it may be private, deleted, or blocked for transcription.'),
  'bot.error.missing_key': brand('The service received no Gemini key. An admin can set one with `/transcript set-key`.'),
  'bot.error.key_rejected': brand('The Gemini key set for this server was rejected. An admin can replace it with `/transcript set-key`.'),
  'bot.error.quota_exceeded': brand("This server's Gemini key is out of quota. Try again later or set a different key."),
  'bot.error.upstream_timeout': brand('Transcription timed out upstream. Try again.'),
  'bot.error.upstream_rejected': brand('The upstream service rejected the transcription request. Try again later.'),
  'bot.error.model_not_found': brand('The transcript service is configured with a model that does not exist.'),
  'bot.error.bad_model_output': brand('The model returned unusable output. Try again.'),
  'bot.error.invalid_config': brand('The transcript service is misconfigured.'),
  'bot.error.unauthorized': brand("The transcript service rejected this bot's service token."),
  'bot.error.invalid_request': brand('The transcript service rejected the request.'),
  'bot.error.not_found': brand('The transcript service did not recognize that request.'),
  'bot.error.api_unreachable': brand('The transcript service is unreachable. Try again later.'),
  'bot.error.job_lost': brand('The transcript service restarted and lost the job. Try again.'),
  'bot.error.job_timeout': brand('Timed out waiting for the transcript. Try again.'),
  'bot.error.internal_error': brand('Something went wrong inside the transcript service. Try again.'),
  'bot.error.rate_limited': brand('This channel has hit its hourly job limit. Try again later.'),
  'bot.error.video_too_long': brand('This video is longer than the limit set for this channel.'),
  'bot.need_manage_server': brand('You need the **Manage Server** permission to set up the transcript bot.'),
  'bot.key_prompt': brand('Provide the Gemini API key: `/transcript set-key`.'),
  'bot.key_saved': brand('Gemini key saved for this server. Enable a channel with `/transcript enable`.'),
  'bot.key_removed': brand('Gemini key removed for this server.'),
  'bot.enabled': brand('Transcript bot enabled here. Post a YouTube link and the transcript lands in this channel or thread.'),
  'bot.disabled': brand('Transcript bot disabled here.'),
  'bot.no_key': brand('No Gemini key is set for this server. A server admin can add one with `/transcript set-key`.'),
  'bot.react_pending': brand('⏳'),
  'bot.transcript_ready': brand('Transcript ready — the .txt and .srt files are attached.'),
  'bot.transcript_save_failed': brand(
    "Transcript ready — couldn't save it to the configured destination (for a Drive folder, share it with the service account email). The .txt and .srt files are attached.",
  ),
  'bot.dm_unsupported': brand('The transcript bot is set up per server, not in DMs.'),
  'bot.unknown_subcommand': brand('Unknown transcript subcommand.'),
});

// A message code is exactly a key of the fixed table: the only parameter
// the lookup accepts, so no computed or arbitrary string can produce
// SafeText.
export type MessageCode = keyof typeof MESSAGES;

// The only exported source of SafeText: look a fixed table entry up by code.
export function safeText(code: MessageCode): SafeText {
  return MESSAGES[code];
}

// Whether a code names a table entry; for guards that fold an unvalidated
// code into a fallback before looking it up.
export function hasMessage(code: string): code is MessageCode {
  return Object.hasOwn(MESSAGES, code);
}
