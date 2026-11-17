// Tool calls a model wrote out as TEXT instead of making them (2026-11-17: a chat run with no tools on the wire answered
// with thirty-one <run_command>…</run_command> lines, and markdown italics broke on the underscores in the paths).
// leakedToolCalls(text) -> null, or { count, prose, raw }: count = how many calls were written out, prose = the text
// outside the markup (plain text, never markdown), raw = the whole reply. Pure, no DOM: the chat renders the result.
//
// Recognised: <run_command>/<runcommand>/<execute_command>/<bash>/<shell> blocks, <tool_call>/<tool_use>, <function_calls>
// and <invoke name=…>, <parameter name=…>, <function=name> (two or more), <|tool_call|>-style tokens, and a fenced
// ```tool_call / ```json block holding {"name", "arguments"}. A single mention in a sentence ("use `<invoke>`") inside a
// code span is not a leak.

const BLOCK = /<(run_?command|execute_command|bash|shell|tool_call|tool_use|function_calls|invoke)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;
const FUNC = /<function=[\w.-]+>/gi;
const JSON_CALL = /```(?:tool_call|tool_code|json)?\s*\n\s*\{\s*"(?:name|tool)"\s*:\s*"[\w.-]+"\s*,\s*"(?:arguments|parameters|args|input)"\s*:[\s\S]*?```/gi;

function stripCodeSpans(t) { return String(t).replace(/`[^`\n]*`/g, ''); }

export function leakedToolCalls(text) {
  const raw = String(text == null ? '' : text);
  if (raw.length < 8) return null;
  const scan = stripCodeSpans(raw);
  const blocks = (scan.match(/<(run_?command|execute_command|tool_call|tool_use)\b[^>]*>/gi) || []).length
    + (scan.match(/<(bash|shell)>[\s\S]*?<\/\1>/gi) || []).length;
  const invokes = (scan.match(/<invoke\s+name=/gi) || []).length;
  const params = (scan.match(/<parameter\s+name=/gi) || []).length;
  const tokens = (scan.match(/<\|tool_call(?:_begin)?\|>|<\|tool_calls?_section_begin\|>/gi) || []).length;
  const funcs = (scan.match(FUNC) || []).length;
  const jsons = (raw.match(JSON_CALL) || []).length;
  const count = blocks + invokes || (params ? 1 : 0) || tokens || (funcs >= 2 ? funcs : 0) || jsons;
  if (!count) return null;
  const prose = raw.replace(BLOCK, '\n').replace(JSON_CALL, '\n').replace(/<\/?(function_calls|parameter|invoke|function)[^>]*>/gi, '')
    .replace(/<function=[\w.-]+>[\s\S]*?(<\/function>|$)/gi, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { count, prose, raw };
}
