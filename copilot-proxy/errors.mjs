// errors.mjs — 统一错误响应构建
// 所有对外的错误 body 通过此模块生成，保持与 OpenAI API 格式一致：
//   { error: { message, type, code? } }
// HTTP 状态码由调用方（index.mjs）通过 sendJson 传入。

/**
 * 400 — 请求参数不合法
 * @param {string} message
 * @param {string} [code]   可选子错误码，如 'missing_field', 'unknown_model'
 */
export function badRequest(message, code) {
  return { error: { message, type: 'invalid_request_error', ...(code ? { code } : {}) } };
}

/**
 * 404 — 资源未找到
 * @param {string} message
 */
export function notFound(message) {
  return { error: { message, type: 'not_found_error' } };
}

/**
 * 413 — 请求体超大
 * @param {string} [message]
 */
export function payloadTooLarge(message = 'Request body exceeds size limit') {
  return { error: { message, type: 'invalid_request_error', code: 'payload_too_large' } };
}

/**
 * 500 — 服务器内部错误
 * stack trace 只打日志，不暴露给客户端
 * @param {Error|unknown} err
 */
export function serverError(err) {
  return { error: { message: err?.message ?? String(err), type: 'server_error' } };
}
