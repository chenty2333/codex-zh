const REASONS = new Map([
  ['DeepSeek response was not completed', '翻译响应未完成'],
  ['DeepSeek response stream is empty', '翻译响应流为空'],
  ['DeepSeek translation was incomplete or failed', '翻译接口报告生成未完成或失败'],
  ['DeepSeek stream reported an error', '翻译接口在响应流中报告了错误'],
  ['DeepSeek translation exceeded the response size limit', '翻译响应超过了大小上限'],
  ['DeepSeek stream ended without response.completed', '翻译响应流提前结束'],
  ['DeepSeek response too large', '翻译响应超过了大小上限'],
]);

// Only fixed classifications and an HTTP status may reach the UI. Raw error
// messages can contain response text, credentials, or other private data.
export function translationFailureReason(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const status = /^DeepSeek Responses API returned HTTP ([1-5]\d{2})$/.exec(message)?.[1];
  if (status) return `翻译接口返回 HTTP ${status}`;
  if (message === 'DeepSeek translation timed out' || error?.name === 'TimeoutError') return '翻译请求超时';
  if (message === 'fetch failed') return '翻译网络请求失败';
  if (error?.name === 'AbortError') return '翻译请求已取消';
  return REASONS.get(message) || '未识别的翻译错误';
}
